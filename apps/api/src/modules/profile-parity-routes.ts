/**
 * profile-parity-routes.ts — apps/api/src/modules/profile-parity-routes.ts
 *
 * INTEGRATION — add two lines to apps/api/src/routes.ts:
 *
 *   import { registerProfileParityRoutes } from './modules/profile-parity-routes.js';
 *   import { processWalletPoll } from './modules/ingestion.js';
 *
 *   // Inside registerRoutes(), after the existing wallet routes block:
 *   registerProfileParityRoutes(app, { prisma, dataAdapter, processWalletPoll });
 *
 * BUG FIXES IN THIS REVISION:
 *
 *   1. CLOSED POSITIONS TOTAL TRADED = 0 / "No buy data"
 *      Root cause: REDEEM events in WalletActivityEvent often have outcome=null,
 *      which gets stored as 'UNKNOWN'. BUY events have outcome='UP' or 'DOWN' or 'YES'.
 *      The join key `conditionId:UNKNOWN` never matches `conditionId:UP`, so cost
 *      basis lookup always returns 0.
 *      Fix: buildCostBasisMaps() stores cost data under BOTH the outcome-specific key
 *      AND the conditionId-only key (no outcome). Lookup tries:
 *        1. exact: conditionId:OUTCOME
 *        2. conditionId-only fallback (sum of all outcomes for that market)
 *        3. marketId variants of both
 *      This ensures REDEEM groups with null/UNKNOWN outcome still find their buys.
 *
 *   2. ACTIVITY NOT IN PROPER DATE ORDER (most recent first)
 *      Root cause: same-millisecond events (multiple buys at same second) sorted
 *      non-deterministically because id-based tie-break doesn't match Polymarket order.
 *      Fix: merged list preserves live-adapter insertion order for same-timestamp
 *      events (they come in API order which is newest-first), then DB events fill
 *      gaps. Final sort: eventTimestamp DESC → (live before db for same ts) → sourceEventId DESC.
 */

import { z } from 'zod';
import {
  buildProfileSummary,
  buildPnlChart,
  normalizePosition,
  sortAndFilterPositions,
  normalizeActivity,
  type PnlRange,
  type NormalizedPosition,
  type NormalizedActivity,
} from './profile-parity.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PnlSummaryResponse = {
  walletId: string;
  range: '1D' | '7D' | '30D' | 'ALL';
  since: string | null;
  from: string | null;
  to: string | null;
  netPnl: number;
  totalWon: number;
  totalLost: number;
  totalVolumeTraded: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
};

export function registerProfileParityRoutes(
  app: any,
  deps: {
    prisma: any;
    dataAdapter: any;
    processWalletPoll?: (walletId: string, address: string) => Promise<void>;
  },
): void {
  const { prisma, dataAdapter, processWalletPoll } = deps;

  // ───────────────────────────────────────────────────────────────────────────
  // GET /wallets/:id/profile-summary
  // ───────────────────────────────────────────────────────────────────────────
  app.get('/wallets/:id/profile-summary', async (req: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({
      where: { id },
      select: { address: true },
    });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    let livePositionsValueUsd = 0;
    try {
      const livePositions: Array<Record<string, unknown>> = await dataAdapter.getWalletPositions(
        wallet.address,
        'OPEN',
        200,
      );
      for (const p of livePositions) {
        livePositionsValueUsd +=
          Number(p.size ?? 0) * Number(p.currentPrice ?? p.curPrice ?? p.price ?? 0);
      }
    } catch {
      /* non-fatal */
    }

    return buildProfileSummary(id, livePositionsValueUsd);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /wallets/:id/pnl-chart?range=1D|1W|1M|ALL
  // ───────────────────────────────────────────────────────────────────────────
  app.get('/wallets/:id/pnl-chart', async (req: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { range } = z
      .object({ range: z.enum(['1D', '1W', '1M', 'ALL']).default('1D') })
      .parse(req.query ?? {});
    const wallet = await prisma.watchedWallet.findUnique({ where: { id }, select: { id: true } });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');
    return buildPnlChart(id, range as PnlRange);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /wallets/:id/positions-v2
  // ───────────────────────────────────────────────────────────────────────────
  app.get('/wallets/:id/positions-v2', async (req: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        status: z.enum(['OPEN', 'CLOSED']).default('OPEN'),
        search: z.string().optional(),
        sortBy: z.string().optional(),
        sortDir: z.enum(['asc', 'desc']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});

    const wallet = await prisma.watchedWallet.findUnique({
      where: { id },
      select: { address: true },
    });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    let normalized: NormalizedPosition[] = [];

    if (query.status === 'OPEN') {
      let raw: Array<Record<string, unknown>> = [];
      try {
        raw = await dataAdapter.getWalletPositions(wallet.address, 'OPEN', 500);
      } catch (err) {
        throw app.httpErrors.badRequest(
          err instanceof Error ? err.message : 'Failed to load positions',
        );
      }

      normalized = raw.map((p) =>
        normalizePosition({
          id: String(p.id ?? p.conditionId ?? ''),
          conditionId: String(p.conditionId ?? ''),
          title: String(p.title ?? ''),
          slug: String(p.slug ?? p.conditionId ?? ''),
          outcome: String(p.outcome ?? 'UNKNOWN'),
          size: Number(p.size ?? 0),
          avgPrice: Number(p.avgPrice ?? p.price ?? 0),
          currentPrice: Number(p.currentPrice ?? p.curPrice ?? p.price ?? 0),
          side: String(p.side ?? 'BUY'),
          status: 'OPEN',
          icon: p.icon ? String(p.icon) : null,
          eventSlug: p.eventSlug ? String(p.eventSlug) : null,
          updatedAt: p.updatedAt ? String(p.updatedAt) : new Date().toISOString(),
          totalTraded: p.totalTraded != null ? Number(p.totalTraded) : null,
        }),
      );
    } else {
      // CLOSED: try adapter first, fall back to DB derivation
      let adapterPositions: Array<Record<string, unknown>> = [];
      try {
        adapterPositions = await dataAdapter.getWalletPositions(wallet.address, 'CLOSED', 500);
      } catch {
        /* fall through */
      }

      if (adapterPositions.length > 0) {
        normalized = adapterPositions.map((p) =>
          normalizePosition({
            id: String(p.id ?? p.conditionId ?? ''),
            conditionId: String(p.conditionId ?? ''),
            title: String(p.title ?? ''),
            slug: String(p.slug ?? p.conditionId ?? ''),
            outcome: String(p.outcome ?? 'UNKNOWN'),
            size: Number(p.size ?? p.amountWon ?? 0),
            avgPrice: Number(p.avgPrice ?? p.price ?? 0),
            currentPrice: Number(
              p.currentPrice ?? p.curPrice ?? (p.amountWon && p.totalTraded ? 1 : 0),
            ),
            side: String(p.side ?? 'BUY'),
            status: 'CLOSED',
            icon: p.icon ? String(p.icon) : null,
            eventSlug: p.eventSlug ? String(p.eventSlug) : null,
            updatedAt: p.updatedAt ? String(p.updatedAt) : new Date().toISOString(),
            totalTraded: p.totalTraded != null ? Number(p.totalTraded) : null,
          }),
        );
      } else {
        normalized = await deriveClosedPositionsFromDb(prisma, id);
      }
    }

    const { items, total } = sortAndFilterPositions(normalized, {
      status: query.status,
      search: query.search,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      walletId: id,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
      total,
      items,
    };
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /wallets/:id/activity-v2
  //
  // Page 1 (no filters): merges live adapter data with DB.
  // All other pages: DB only.
  // ───────────────────────────────────────────────────────────────────────────
  app.get('/wallets/:id/activity-v2', async (req: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
        eventType: z.string().optional(),
        search: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(req.query ?? {});

    const wallet = await prisma.watchedWallet.findUnique({
      where: { id },
      select: { id: true, address: true },
    });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    const where: Record<string, unknown> = { trackedWalletId: id };
    if (query.eventType && query.eventType !== 'ALL') where.eventType = query.eventType;
    if (query.search?.trim())
      where.marketQuestion = { contains: query.search.trim(), mode: 'insensitive' };
    if (query.from || query.to) {
      const ts: Record<string, Date> = {};
      if (query.from) ts.gte = new Date(query.from);
      if (query.to) ts.lte = new Date(query.to);
      where.eventTimestamp = ts;
    }

    const isFirstPageNoFilters =
      query.page === 1 && !query.eventType && !query.search && !query.from && !query.to;

    if (isFirstPageNoFilters) {
      const merged = await fetchAndMergeActivity(
        prisma,
        dataAdapter,
        id,
        wallet.address,
        where,
        query.pageSize,
      );
      const total = await prisma.walletActivityEvent.count({ where });
      return {
        page: 1,
        pageSize: query.pageSize,
        total: Math.max(total, merged.length),
        items: merged,
        _source: 'live+db',
      };
    }

    const [total, rows] = await Promise.all([
      prisma.walletActivityEvent.count({ where }),
      prisma.walletActivityEvent.findMany({
        where,
        orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: ACT_SELECT,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: (rows as any[]).map(rowToNormalizedActivity),
      _source: 'db',
    };
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /wallets/:id/pnl-summary?range=1D|7D|30D|ALL
  //
  // Aggregates realized P&L from closed trades in the time window.
  //
  // Method:
  //   REDEEM / CLOSE events: payout = notional (Polymarket pays $1/share for winners)
  //   SELL events:           pnl = (sellPrice - wacpAtSell) × shares
  //                          wacp computed from all BUY events for the same market
  //
  // Returns: netPnl, totalWon, totalLost, tradeCount, winCount, lossCount, winRate
  // ───────────────────────────────────────────────────────────────────────────
  app.get('/wallets/:id/pnl-summary', async (req: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        range: z.enum(['1D', '7D', '30D', 'ALL']).default('1D'),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(req.query ?? {});
    return calculateWalletPnlSummary(prisma, id, {
      range: query.range,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // POST /wallets/:id/force-sync
  //
  // Immediately triggers a wallet poll (same as the existing /sync endpoint
  // but registered here so it's available in the parity routes module).
  //
  // INTEGRATION NOTE: Pass processWalletPoll in deps so this actually polls:
  //   registerProfileParityRoutes(app, { prisma, dataAdapter, processWalletPoll });
  //
  // If processWalletPoll is not passed, falls back to setting nextPollAt=now
  // so the scheduler picks it up within its next cycle.
  // ───────────────────────────────────────────────────────────────────────────
  app.post('/wallets/:id/force-sync', async (req: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({
      where: { id },
      select: { id: true, address: true },
    });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    if (processWalletPoll) {
      // Immediately run full poll — same as POST /wallets/:id/sync
      await processWalletPoll(wallet.id, wallet.address);
    } else {
      // Fallback: mark for next scheduler cycle
      await prisma.watchedWallet.update({
        where: { id },
        data: { nextPollAt: new Date(), syncStatus: 'SYNCING', lastSyncError: null },
      });
    }

    return { synced: true, message: 'Force sync complete.' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACT_SELECT = {
  id: true,
  eventType: true,
  marketId: true,
  marketQuestion: true,
  outcome: true,
  side: true,
  price: true,
  shares: true,
  notional: true,
  sourceTxHash: true,
  txHash: true,
  orderId: true,
  sourceEventId: true,
  externalEventId: true,
  sourceCursor: true,
  blockNumber: true,
  logIndex: true,
  eventTimestamp: true,
} as const;

function rowToNormalizedActivity(row: any): NormalizedActivity {
  return normalizeActivity({
    id: row.id,
    eventType: row.eventType,
    marketId: row.marketId,
    marketQuestion: row.marketQuestion,
    outcome: row.outcome,
    side: row.side,
    price: row.price,
    shares: row.shares,
    notional: row.notional,
    sourceTxHash: row.sourceTxHash,
    txHash: row.txHash,
    orderId: row.orderId,
    sourceEventId: row.sourceEventId ?? row.externalEventId,
    sourceCursor: row.sourceCursor,
    blockNumber: row.blockNumber,
    eventTimestamp: row.eventTimestamp,
  });
}

/**
 * Dedup key for activity items.
 * Fine-grained enough to distinguish two separate buys at the same market
 * at the same second with different amounts.
 */
function actDedupKey(a: NormalizedActivity): string {
  // Most specific: Polymarket's own stable event ID
  if (a.sourceEventId) return `eid:${a.sourceEventId}`;

  const rs = a.shares != null ? Math.round(a.shares * 100) : 'ns'; // 2dp precision
  const rp = a.price != null ? Math.round(a.price * 100) : 'np'; // cents

  // On-chain: txHash + logIndex is fully unique per EVM event
  // We include price+shares too because we can't access logIndex here
  if (a.txHash) {
    const bn = a.blockNumber != null ? a.blockNumber : 'nb';
    return `tx:${a.txHash}:${bn}:${a.type}:${a.outcome ?? ''}:${rs}:${rp}`;
  }

  // OrderId is unique per Polymarket order
  if (a.orderId) return `ord:${a.orderId}:${rs}:${rp}`;

  // Fallback: timestamp-to-second + market + type + price + shares
  // This is fine-grained enough to distinguish same-market same-second trades
  // with different amounts
  const tsSec = Math.floor(new Date(a.eventTimestamp).getTime() / 1000);
  return `ts:${tsSec}:${a.market}:${a.type}:${a.outcome ?? ''}:${rs}:${rp}`;
}

async function fetchAndMergeActivity(
  prisma: any,
  dataAdapter: any,
  walletId: string,
  address: string,
  dbWhere: Record<string, unknown>,
  pageSize: number,
): Promise<NormalizedActivity[]> {
  // Fetch 3× pageSize from DB ordered newest first
  const dbRows = await prisma.walletActivityEvent.findMany({
    where: dbWhere,
    orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }],
    take: pageSize * 3,
    select: ACT_SELECT,
  });
  const dbNormalized: NormalizedActivity[] = (dbRows as any[]).map(rowToNormalizedActivity);

  // Live fetch — most recent 100 events in API order (already newest first)
  let liveNormalized: NormalizedActivity[] = [];
  try {
    const liveEvents = await dataAdapter.getWalletActivityFeed(address, { limit: 100, offset: 0 });
    liveNormalized = (liveEvents as Array<Record<string, unknown>>).map((ev, idx) => {
      const item = normalizeActivity({
        id: String(ev.id ?? ev.externalEventId ?? `live-${idx}`),
        eventType: String(ev.eventType ?? ''),
        marketId: String(ev.marketId ?? ''),
        marketQuestion: ev.marketQuestion ? String(ev.marketQuestion) : null,
        outcome: ev.outcome ? String(ev.outcome) : null,
        side: ev.side ? String(ev.side) : null,
        price: ev.price != null ? Number(ev.price) : null,
        shares: ev.shares != null ? Number(ev.shares) : null,
        notional: ev.notional != null ? Number(ev.notional) : null,
        sourceTxHash: ev.txHash ? String(ev.txHash) : null,
        txHash: ev.txHash ? String(ev.txHash) : null,
        orderId: ev.orderId ? String(ev.orderId) : null,
        sourceEventId: ev.externalEventId ? String(ev.externalEventId) : null,
        sourceCursor: ev.sourceCursor ? String(ev.sourceCursor) : null,
        blockNumber: ev.blockNumber != null ? Number(ev.blockNumber) : null,
        eventTimestamp: String(ev.eventTimestamp ?? new Date().toISOString()),
      });
      return item;
    });
  } catch {
    /* live fetch failed — DB-only is fine */
  }

  // Deduplicate: live events win on key collision (fresher relativeTime)
  const seen = new Set<string>();
  const merged: NormalizedActivity[] = [];

  for (const item of liveNormalized) {
    const k = actDedupKey(item);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(item);
    }
  }
  for (const item of dbNormalized) {
    const k = actDedupKey(item);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(item);
    }
  }

  // Sort: newest eventTimestamp first.
  // For events at the exact same millisecond, preserve the order they arrived
  // in the merged array (live events first = API order = already newest-first
  // within the same second). We achieve this by tagging each item with its
  // position before sorting and using it as a stable tie-breaker.
  const tagged = merged.map((item, pos) => ({
    item,
    pos,
    tsMs: new Date(item.eventTimestamp).getTime(),
  }));
  tagged.sort((a, b) => {
    const diff = b.tsMs - a.tsMs;
    if (diff !== 0) return diff;
    // Same timestamp: lower pos = came first in merged = live events before DB = API order
    return a.pos - b.pos;
  });

  return tagged.slice(0, pageSize).map((t) => t.item);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost basis helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build cost basis maps from all BUY/TRADE events for a set of conditionIds.
 *
 * RETURNS two maps for each key type:
 *   costBasisMap:  conditionId:OUTCOME → total notional spent
 *   buySharesMap:  conditionId:OUTCOME → total shares bought
 *
 * ALSO stores a "conditionId-only" key (no outcome suffix) that aggregates
 * across ALL outcomes for that market. This is critical because REDEEM events
 * often have outcome=null, so the group key ends up as `conditionId:UNKNOWN`.
 * Without the outcome-agnostic key, lookups always miss.
 *
 * Lookup order in deriveClosedPositionsFromDb:
 *   1. conditionId:OUTCOME (exact — best case)
 *   2. conditionId:*       (outcome-agnostic — handles null-outcome REDEEMs)
 *   3. marketId:OUTCOME    (fallback when conditionId ≠ marketId in DB)
 *   4. marketId:*          (fully agnostic fallback)
 */
export async function buildCostBasisMaps(
  prisma: any,
  walletId: string,
  conditionIds: string[],
): Promise<{
  costBasisMap: Map<string, number>;
  buySharesMap: Map<string, number>;
}> {
  const costBasisMap = new Map<string, number>();
  const buySharesMap = new Map<string, number>();

  if (conditionIds.length === 0) return { costBasisMap, buySharesMap };

  const buyRows: Array<{
    marketId: string;
    conditionId: string | null;
    outcome: string | null;
    shares: unknown;
    notional: unknown;
    price: unknown;
  }> = await prisma.walletActivityEvent.findMany({
    where: {
      trackedWalletId: walletId,
      eventType: { in: ['BUY', 'TRADE'] },
      // Match on conditionId OR marketId since either could hold the market key
      OR: [{ conditionId: { in: conditionIds } }, { marketId: { in: conditionIds } }],
    },
    select: {
      marketId: true,
      conditionId: true,
      outcome: true,
      shares: true,
      notional: true,
      price: true,
    },
  });

  function addToMaps(key: string, notional: number, shares: number): void {
    costBasisMap.set(key, (costBasisMap.get(key) ?? 0) + notional);
    buySharesMap.set(key, (buySharesMap.get(key) ?? 0) + shares);
  }

  for (const row of buyRows) {
    const condId = (row.conditionId || row.marketId || '').trim();
    const mktId = (row.marketId || '').trim();
    const outcome = (row.outcome ?? '').toUpperCase().trim();
    const shares = row.shares != null ? Math.abs(Number(row.shares)) : 0;
    const notional = row.notional != null ? Math.abs(Number(row.notional)) : 0;
    const price = row.price != null ? Number(row.price) : null;
    const effNotional =
      notional > 0 ? notional : price != null && price > 0 && shares > 0 ? price * shares : 0;

    if (effNotional <= 0 && shares <= 0) continue;

    // 1. Exact outcome key: conditionId:OUTCOME
    if (condId && outcome) addToMaps(`${condId}:${outcome}`, effNotional, shares);
    // 2. Outcome-agnostic key: conditionId:* (crucial for null-outcome REDEEM match)
    if (condId) addToMaps(`${condId}:*`, effNotional, shares);
    // 3. marketId variants (in case conditionId != marketId in DB)
    if (mktId && mktId !== condId) {
      if (outcome) addToMaps(`${mktId}:${outcome}`, effNotional, shares);
      addToMaps(`${mktId}:*`, effNotional, shares);
    }
  }

  return { costBasisMap, buySharesMap };
}

/**
 * Look up cost basis using the priority order documented on buildCostBasisMaps.
 * Returns { totalTraded, buyShares } — both 0 if no match found.
 */
function lookupCostBasis(
  costBasisMap: Map<string, number>,
  buySharesMap: Map<string, number>,
  conditionId: string,
  marketId: string,
  outcome: string,
): { totalTraded: number; buyShares: number } {
  const oc = outcome.toUpperCase();
  const candidates = [
    `${conditionId}:${oc}`, // 1. exact conditionId + outcome
    `${conditionId}:*`, // 2. conditionId, any outcome
    `${marketId}:${oc}`, // 3. marketId + outcome
    `${marketId}:*`, // 4. marketId, any outcome
  ];

  for (const key of candidates) {
    const totalTraded = costBasisMap.get(key);
    const buyShares = buySharesMap.get(key);
    if (totalTraded != null && totalTraded > 0) {
      return { totalTraded, buyShares: buyShares ?? 0 };
    }
  }

  return { totalTraded: 0, buyShares: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB fallback: derive CLOSED positions from ingested REDEEM/CLOSE events
// ─────────────────────────────────────────────────────────────────────────────

export async function deriveClosedPositionsFromDb(
  prisma: any,
  walletId: string,
): Promise<NormalizedPosition[]> {
  const redeemRows: Array<{
    marketId: string;
    conditionId: string | null;
    marketQuestion: string | null;
    outcome: string | null;
    shares: unknown;
    notional: unknown;
    price: unknown;
    eventTimestamp: Date;
  }> = await prisma.walletActivityEvent.findMany({
    where: { trackedWalletId: walletId, eventType: { in: ['REDEEM', 'CLOSE'] } },
    select: {
      marketId: true,
      conditionId: true,
      marketQuestion: true,
      outcome: true,
      shares: true,
      notional: true,
      price: true,
      eventTimestamp: true,
    },
    orderBy: { eventTimestamp: 'desc' },
  });

  if (redeemRows.length === 0) {
    return deriveClosedFromSellEvents(prisma, walletId);
  }

  // Group REDEEM events by (conditionId, outcome).
  // Use conditionId if set; fall back to marketId.
  // NOTE: outcome may be null → stored as empty string, group.outcome = 'UNKNOWN'.
  type RedeemGroup = {
    marketId: string;
    conditionId: string;
    outcome: string; // 'UNKNOWN' when original was null
    marketQuestion: string | null;
    totalShares: number;
    totalAmountWon: number;
    latestTs: Date;
  };
  const groups = new Map<string, RedeemGroup>();

  for (const row of redeemRows) {
    const condId = (row.conditionId || row.marketId).trim();
    const outcome = (row.outcome ?? '').toUpperCase().trim();
    const key = `${condId}:${outcome}`;
    const shares = row.shares != null ? Math.abs(Number(row.shares)) : 0;
    const notional = row.notional != null ? Math.abs(Number(row.notional)) : 0;
    const price = row.price != null ? Number(row.price) : null;
    const effNotional =
      notional > 0 ? notional : price != null && price > 0 && shares > 0 ? price * shares : 0;

    const existing = groups.get(key);
    if (existing) {
      existing.totalShares += shares;
      existing.totalAmountWon += effNotional;
      if (row.eventTimestamp > existing.latestTs) {
        existing.latestTs = row.eventTimestamp;
        if (row.marketQuestion) existing.marketQuestion = row.marketQuestion;
      }
    } else {
      groups.set(key, {
        marketId: row.marketId,
        conditionId: condId,
        outcome: outcome || 'UNKNOWN',
        marketQuestion: row.marketQuestion ?? null,
        totalShares: shares,
        totalAmountWon: effNotional,
        latestTs: row.eventTimestamp,
      });
    }
  }

  // Build cost basis maps using outcome-agnostic fallback keys
  const conditionIds = [
    ...new Set([...groups.values()].flatMap((g) => [g.conditionId, g.marketId])),
  ];
  const { costBasisMap, buySharesMap } = await buildCostBasisMaps(prisma, walletId, conditionIds);

  const positions: NormalizedPosition[] = [];

  for (const group of groups.values()) {
    const { totalTraded, buyShares } = lookupCostBasis(
      costBasisMap,
      buySharesMap,
      group.conditionId,
      group.marketId,
      group.outcome,
    );

    const avgPrice = buyShares > 0 && totalTraded > 0 ? totalTraded / buyShares : 0;
    const size = group.totalShares > 0 ? group.totalShares : buyShares;
    if (size <= 0 && group.totalAmountWon <= 0) continue;

    // currentPrice: infer from payout
    // WON: amountWon ≈ shares (paid $1/share) → currentPrice ≈ 1
    // LOST: amountWon = 0 → currentPrice = 0
    const currentPrice =
      size > 0 && group.totalAmountWon > 0
        ? Math.min(1, group.totalAmountWon / size)
        : group.totalAmountWon > 0
          ? 1.0
          : 0.0;

    const hasBuyData = totalTraded > 0;

    positions.push(
      normalizePosition({
        // FIX: use conditionId:outcome:timestamp as unique id to prevent duplicate React keys
        // when the same market has multiple closed positions (UP vs DOWN, or same outcome at
        // different times). Previously used bare conditionId which caused collisions.
        id: `${group.conditionId}:${group.outcome}:${group.latestTs.getTime()}`,
        conditionId: group.conditionId,
        title: group.marketQuestion ?? group.conditionId,
        slug: group.conditionId,
        outcome: group.outcome,
        size,
        avgPrice,
        currentPrice,
        side: 'BUY',
        status: 'CLOSED',
        icon: null,
        eventSlug: null,
        updatedAt: group.latestTs.toISOString(),
        totalTraded: hasBuyData ? totalTraded : null,
        noCostBasis: !hasBuyData,
      }),
    );
  }

  return positions;
}

export async function calculateWalletPnlSummary(
  prisma: any,
  walletId: string,
  opts?: {
    range?: '1D' | '7D' | '30D' | 'ALL';
    from?: string;
    to?: string;
  },
): Promise<PnlSummaryResponse> {
  const range = opts?.range ?? '1D';
  const wallet = await prisma.watchedWallet.findUnique({
    where: { id: walletId },
    select: { id: true },
  });
  if (!wallet) throw new Error('Wallet not found');

  const now = Date.now();
  const HOUR = 3600_000;
  const sinceMs: number | null =
    range === '1D'
      ? now - 24 * HOUR
      : range === '7D'
        ? now - 7 * 24 * HOUR
        : range === '30D'
          ? now - 30 * 24 * HOUR
          : null;

  const fromDate = opts?.from ? new Date(opts.from) : sinceMs ? new Date(sinceMs) : null;
  const toDate = opts?.to ? new Date(opts.to) : null;
  const window =
    fromDate || toDate
      ? {
          ...(fromDate ? { gte: fromDate } : {}),
          ...(toDate ? { lte: toDate } : {}),
        }
      : null;

  const exitRows: Array<{
    eventType: string;
    outcome: string | null;
    side: string | null;
    price: unknown;
    shares: unknown;
    notional: unknown;
    marketId: string;
    conditionId: string | null;
  }> = await prisma.walletActivityEvent.findMany({
    where: {
      trackedWalletId: walletId,
      eventType: { in: ['SELL', 'REDEEM', 'CLOSE', 'TRADE'] },
      ...(window ? { eventTimestamp: window } : {}),
    },
    select: {
      eventType: true,
      outcome: true,
      side: true,
      price: true,
      shares: true,
      notional: true,
      marketId: true,
      conditionId: true,
    },
    orderBy: { eventTimestamp: 'asc' },
  });

  const sells = exitRows.filter((r) => {
    const et = r.eventType.toUpperCase();
    const sd = (r.side ?? '').toUpperCase();
    return et === 'REDEEM' || et === 'CLOSE' || et === 'SELL' || (et === 'TRADE' && sd === 'SELL');
  });

  const marketIds = [...new Set(sells.map((s) => s.conditionId ?? s.marketId).filter(Boolean))];
  const avgPriceMap = new Map<string, { size: number; avgPrice: number }>();

  if (marketIds.length > 0) {
    const buys: Array<{
      marketId: string;
      conditionId: string | null;
      outcome: string | null;
      shares: unknown;
      price: unknown;
    }> = await prisma.walletActivityEvent.findMany({
      where: {
        trackedWalletId: walletId,
        eventType: { in: ['BUY', 'TRADE'] },
        side: 'BUY',
        OR: [{ conditionId: { in: marketIds } }, { marketId: { in: marketIds } }],
      },
      select: {
        marketId: true,
        conditionId: true,
        outcome: true,
        shares: true,
        price: true,
      },
      orderBy: { eventTimestamp: 'asc' },
    });

    for (const b of buys) {
      const condId = (b.conditionId || b.marketId || '').trim();
      const mktId = (b.marketId || '').trim();
      const oc = (b.outcome ?? '').toUpperCase().trim();
      const sz = Math.abs(Number(b.shares ?? 0));
      const px = Number(b.price ?? 0);
      if (sz <= 0 || px <= 0) continue;
      const keys = [
        ...(condId && oc ? [`${condId}:${oc}`] : []),
        ...(condId ? [`${condId}:*`] : []),
        ...(mktId && mktId !== condId && oc ? [`${mktId}:${oc}`] : []),
        ...(mktId && mktId !== condId ? [`${mktId}:*`] : []),
      ];
      for (const key of keys) {
        const cur = avgPriceMap.get(key) ?? { size: 0, avgPrice: 0 };
        const newSize = cur.size + sz;
        if (newSize > 0) {
          avgPriceMap.set(key, {
            size: newSize,
            avgPrice: (cur.size * cur.avgPrice + sz * px) / newSize,
          });
        }
      }
    }
  }

  let totalWon = 0;
  let totalLost = 0;
  let tradeCount = 0;
  let winCount = 0;
  let lossCount = 0;

  for (const sell of sells) {
    const et = sell.eventType.toUpperCase();
    const condId = (sell.conditionId || sell.marketId || '').trim();
    const mktId = (sell.marketId || '').trim();
    const outcome = (sell.outcome ?? '').toUpperCase().trim();
    const sz = Math.abs(Number(sell.shares ?? 0));
    const px = Number(sell.price ?? 0);
    const notional = Math.abs(Number(sell.notional ?? 0));

    if (et === 'REDEEM' || et === 'CLOSE') {
      const payout = notional > 0 ? notional : sz > 0 && px > 0 ? sz * px : sz > 0 ? sz : 0;
      if (payout > 0) {
        totalWon += payout;
        winCount += 1;
        tradeCount += 1;
      } else if (sz > 0 || notional === 0) {
        const entry =
          avgPriceMap.get(`${condId}:${outcome}`) ??
          avgPriceMap.get(`${condId}:*`) ??
          avgPriceMap.get(`${mktId}:${outcome}`) ??
          avgPriceMap.get(`${mktId}:*`);
        const cost = (entry?.size ?? sz) * (entry?.avgPrice ?? 0);
        if (cost > 0) {
          totalLost += cost;
          lossCount += 1;
          tradeCount += 1;
        }
      }
      continue;
    }

    if (sz <= 0) continue;
    const entry =
      avgPriceMap.get(`${condId}:${outcome}`) ??
      avgPriceMap.get(`${condId}:*`) ??
      avgPriceMap.get(`${mktId}:${outcome}`) ??
      avgPriceMap.get(`${mktId}:*`);
    const avgBuyPrice = entry?.avgPrice ?? 0;
    const pnl = avgBuyPrice > 0 ? (px - avgBuyPrice) * sz : notional > 0 ? notional : sz * px;
    tradeCount += 1;
    if (pnl >= 0) {
      totalWon += pnl;
      winCount += 1;
    } else {
      totalLost += Math.abs(pnl);
      lossCount += 1;
    }
  }

  let totalVolumeTraded = 0;
  const buyVolumeRows: Array<{ notional: unknown; shares: unknown; price: unknown }> =
    await prisma.walletActivityEvent.findMany({
      where: {
        trackedWalletId: walletId,
        eventType: { in: ['BUY', 'TRADE'] },
        side: 'BUY',
        ...(window ? { eventTimestamp: window } : {}),
      },
      select: { notional: true, shares: true, price: true },
    });

  for (const b of buyVolumeRows) {
    const notional = Math.abs(Number(b.notional ?? 0));
    const sz = Math.abs(Number(b.shares ?? 0));
    const px = Number(b.price ?? 0);
    totalVolumeTraded += notional > 0 ? notional : sz > 0 && px > 0 ? sz * px : 0;
  }

  const netPnl = totalWon - totalLost;
  return {
    walletId,
    range,
    since: sinceMs ? new Date(sinceMs).toISOString() : null,
    from: fromDate ? fromDate.toISOString() : null,
    to: toDate ? toDate.toISOString() : null,
    netPnl: Math.round(netPnl * 100) / 100,
    totalWon: Math.round(totalWon * 100) / 100,
    totalLost: Math.round(totalLost * 100) / 100,
    totalVolumeTraded: Math.round(totalVolumeTraded * 100) / 100,
    tradeCount,
    winCount,
    lossCount,
    winRate: tradeCount > 0 ? Math.round((winCount / tradeCount) * 10000) / 100 : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Secondary fallback: derive closed positions from BUY/SELL pairs (net ≈ 0)
// Used when no REDEEM events exist at all.
// ─────────────────────────────────────────────────────────────────────────────

async function deriveClosedFromSellEvents(
  prisma: any,
  walletId: string,
): Promise<NormalizedPosition[]> {
  const rows: Array<{
    marketId: string;
    conditionId: string | null;
    marketQuestion: string | null;
    outcome: string | null;
    side: string | null;
    shares: unknown;
    notional: unknown;
    price: unknown;
    eventTimestamp: Date;
  }> = await prisma.walletActivityEvent.findMany({
    where: {
      trackedWalletId: walletId,
      eventType: { in: ['BUY', 'SELL', 'TRADE'] },
      side: { in: ['BUY', 'SELL'] },
    },
    select: {
      marketId: true,
      conditionId: true,
      marketQuestion: true,
      outcome: true,
      side: true,
      shares: true,
      notional: true,
      price: true,
      eventTimestamp: true,
    },
    orderBy: { eventTimestamp: 'asc' },
  });

  type St = {
    marketId: string;
    conditionId: string;
    outcome: string;
    marketQuestion: string | null;
    netShares: number;
    totalBuyNotional: number;
    totalBuyShares: number;
    totalSellNotional: number;
    totalSellShares: number;
    avgPrice: number;
    lastTs: Date;
  };
  const positions = new Map<string, St>();

  for (const row of rows) {
    const condId = (row.conditionId || row.marketId).trim();
    const outcome = (row.outcome ?? '').toUpperCase().trim();
    const key = `${condId}:${outcome}`;
    const shares = row.shares != null ? Math.abs(Number(row.shares)) : 0;
    const notional = row.notional != null ? Math.abs(Number(row.notional)) : 0;
    const price = row.price != null ? Number(row.price) : null;
    const effNotional =
      notional > 0 ? notional : price != null && price > 0 && shares > 0 ? price * shares : 0;

    let st = positions.get(key);
    if (!st) {
      st = {
        marketId: row.marketId,
        conditionId: condId,
        outcome: outcome || 'UNKNOWN',
        marketQuestion: row.marketQuestion ?? null,
        netShares: 0,
        totalBuyNotional: 0,
        totalBuyShares: 0,
        totalSellNotional: 0,
        totalSellShares: 0,
        avgPrice: 0,
        lastTs: row.eventTimestamp,
      };
      positions.set(key, st);
    }

    if (row.side === 'BUY') {
      const newShares = st.totalBuyShares + shares;
      if (newShares > 0)
        st.avgPrice = (st.totalBuyShares * st.avgPrice + shares * (price ?? 0)) / newShares;
      st.netShares += shares;
      st.totalBuyShares = newShares;
      st.totalBuyNotional += effNotional;
    } else {
      st.netShares = Math.max(0, st.netShares - shares);
      st.totalSellShares += shares;
      st.totalSellNotional += effNotional;
    }
    if (row.eventTimestamp > st.lastTs) {
      st.lastTs = row.eventTimestamp;
      if (row.marketQuestion) st.marketQuestion = row.marketQuestion;
    }
  }

  return [...positions.values()]
    .filter((st) => st.netShares < 0.01 && st.totalBuyShares > 0)
    .map((st) => {
      const avgSellPrice = st.totalSellShares > 0 ? st.totalSellNotional / st.totalSellShares : 0;
      return normalizePosition({
        id: `${st.conditionId}:${st.outcome}:${st.lastTs.getTime()}`,
        conditionId: st.conditionId,
        title: st.marketQuestion ?? st.conditionId,
        slug: st.conditionId,
        outcome: st.outcome,
        size: st.totalBuyShares,
        avgPrice: st.avgPrice,
        currentPrice: Math.max(0, Math.min(1, avgSellPrice)),
        side: 'BUY',
        status: 'CLOSED',
        icon: null,
        eventSlug: null,
        updatedAt: st.lastTs.toISOString(),
        totalTraded: st.totalBuyNotional,
        noCostBasis: st.totalBuyNotional <= 0,
      });
    });
}
