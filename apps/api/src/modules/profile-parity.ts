/**
 * profile-parity.ts — apps/api/src/modules/profile-parity.ts
 *
 * Parity contract: see full table in profile-parity-routes.ts header.
 *
 * Changes in this revision:
 *   - NormalizedPosition gains `noCostBasis: boolean` flag so the frontend
 *     knows to suppress P/L % when we have no buy-side data (REDEEM fallback).
 *   - sortAndFilterPositions: adds 'date' sort key (updatedAt DESC) for the
 *     "Most Recent" dropdown option on closed positions.
 *   - normalizePosition: outcome 'UNKNOWN' → '' so subtitle doesn't say
 *     "1506 Unknown at 0¢"; falls back gracefully.
 */

import { prisma } from '../lib/prisma.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PnlRange = '1D' | '1W' | '1M' | 'ALL';

export interface ProfileSummary {
  walletId: string;
  address: string;
  handle: string;
  joinedAt: string;
  joinedAtNote: 'tracking_start';
  positionsValueUsd: number;
  biggestWinUsd: number;
  predictionsCount: number;
  realizedPnlUsd: number;
  snapshotAt: string | null;
}

export interface PnlChartPoint {
  t: string;
  v: number;
}

export interface PnlChartResponse {
  walletId: string;
  range: PnlRange;
  totalPnl: number;
  isPositive: boolean;
  points: PnlChartPoint[];
  parityNote: string;
}

export interface PositionsQueryOptions {
  status: 'OPEN' | 'CLOSED';
  search?: string;
  /**
   * OPEN:   'value' (default) | 'pnl_usd' | 'pnl_pct' | 'market'
   * CLOSED: 'won_first' (default) | 'lost_first' | 'pnl_usd' | 'market' | 'date'
   */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface NormalizedPosition {
  id: string;
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  /** shares × currentPrice — gross payout / AMOUNT WON line 1 */
  valueUsd: number;
  /** (currentPrice − avgPrice) × shares — net P/L / AMOUNT WON line 2 */
  pnlUsd: number;
  /** (currentPrice − avgPrice) / avgPrice × 100 — AMOUNT WON % */
  pnlPct: number;
  /** avgPrice × shares — cost basis / TOTAL TRADED column */
  totalTraded: number;
  side: string;
  status: 'OPEN' | 'CLOSED';
  resolution: 'WON' | 'LOST' | 'PENDING' | null;
  /**
   * true when no BUY events were found to compute cost basis.
   * Frontend should suppress P/L% display and show 'N/A' for TOTAL TRADED.
   */
  noCostBasis: boolean;
  icon: string | null;
  eventSlug: string | null;
  updatedAt: string;
}

export interface NormalizedActivity {
  id: string;
  type: string;
  market: string;
  outcome: string | null;
  side: string | null;
  amountUsd: number | null;
  shares: number | null;
  price: number | null;
  eventTimestamp: string;
  relativeTime: string;
  txHash: string | null;
  orderId: string | null;
  sourceEventId: string | null;
  sourceCursor: string | null;
  blockNumber: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile Summary
// ─────────────────────────────────────────────────────────────────────────────

export async function buildProfileSummary(
  walletId: string,
  livePositionsValueUsd: number,
): Promise<ProfileSummary> {
  const wallet = await prisma.watchedWallet.findUnique({
    where: { id: walletId },
    select: { id: true, address: true, label: true, createdAt: true },
  });
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);

  const snapshot = await prisma.walletAnalyticsSnapshot.findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { realizedPnl: true, bestTrade: true, createdAt: true },
  });

  let realizedPnlUsd: number;
  let biggestWinUsd: number;

  if (snapshot) {
    realizedPnlUsd = round2(Number(snapshot.realizedPnl));
    biggestWinUsd = round2(Math.max(0, Number(snapshot.bestTrade)));
  } else {
    const fallback = await computeRealizedPnlFromTrades(walletId);
    realizedPnlUsd = fallback.totalRealizedPnl;
    biggestWinUsd = fallback.bestTrade;
  }

  const distinctMarkets = await prisma.tradeEvent.groupBy({
    by: ['marketId'],
    where: { walletId },
  });

  return {
    walletId: wallet.id,
    address: wallet.address,
    handle: wallet.label || shortenAddress(wallet.address),
    joinedAt: wallet.createdAt.toISOString(),
    joinedAtNote: 'tracking_start',
    positionsValueUsd: round2(livePositionsValueUsd),
    biggestWinUsd,
    predictionsCount: distinctMarkets.length,
    realizedPnlUsd,
    snapshotAt: snapshot?.createdAt.toISOString() ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P/L Chart
// ─────────────────────────────────────────────────────────────────────────────

export async function buildPnlChart(walletId: string, range: PnlRange): Promise<PnlChartResponse> {
  const now = Date.now();
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const WEEK_MS = 7 * DAY_MS;

  let sinceMs: number;
  let bucketMs: number;

  switch (range) {
    case '1D':
      sinceMs = now - DAY_MS;
      bucketMs = HOUR_MS;
      break;
    case '1W':
      sinceMs = now - WEEK_MS;
      bucketMs = 4 * HOUR_MS;
      break;
    case '1M':
      sinceMs = now - 30 * DAY_MS;
      bucketMs = DAY_MS;
      break;
    case 'ALL':
    default:
      sinceMs = 0;
      bucketMs = WEEK_MS;
      break;
  }

  const since = sinceMs > 0 ? new Date(sinceMs) : null;

  const trades = await prisma.tradeEvent.findMany({
    where: { walletId, ...(since ? { tradedAt: { gte: since } } : {}) },
    orderBy: { tradedAt: 'asc' },
    select: { marketId: true, outcome: true, side: true, size: true, price: true, tradedAt: true },
  });

  if (trades.length === 0) {
    return {
      walletId,
      range,
      totalPnl: 0,
      isPositive: true,
      points: [],
      parityNote: 'realized_pnl_only_excludes_unrealized',
    };
  }

  const positions = new Map<string, { size: number; avgPrice: number }>();
  if (since) {
    const priorBuys = await prisma.tradeEvent.findMany({
      where: { walletId, side: 'BUY', tradedAt: { lt: since } },
      orderBy: { tradedAt: 'asc' },
      select: { marketId: true, outcome: true, size: true, price: true },
    });
    for (const t of priorBuys) {
      const key = `${t.marketId}:${t.outcome}`;
      const cur = positions.get(key) ?? { size: 0, avgPrice: 0 };
      const sz = Number(t.size);
      const px = Number(t.price);
      const newSize = cur.size + sz;
      if (newSize > 0) {
        positions.set(key, {
          size: newSize,
          avgPrice: (cur.size * cur.avgPrice + sz * px) / newSize,
        });
      }
    }
  }

  const firstTradeMs = trades[0].tradedAt.getTime();
  const lastTradeMs = trades[trades.length - 1].tradedAt.getTime();
  const windowStart = sinceMs > 0 ? sinceMs : firstTradeMs;
  const bucketStart0 = floorToBucket(windowStart, bucketMs);
  const bucketEnd = floorToBucket(now, bucketMs) + bucketMs;
  const maxBuckets = range === 'ALL' ? 200 : Math.ceil((bucketEnd - bucketStart0) / bucketMs) + 2;

  const buckets: number[] = [];
  for (
    let i = 0, t = bucketStart0;
    i < maxBuckets && t <= lastTradeMs + bucketMs;
    i++, t += bucketMs
  ) {
    buckets.push(t);
  }
  if (buckets.length === 0) buckets.push(bucketStart0);

  let cumulativePnl = 0;
  const bucketValues = new Map<number, number>();
  let tradeIdx = 0;

  for (const bStart of buckets) {
    const bEnd = bStart + bucketMs;
    while (tradeIdx < trades.length && trades[tradeIdx].tradedAt.getTime() < bEnd) {
      const trade = trades[tradeIdx];
      const key = `${trade.marketId}:${trade.outcome}`;
      const sz = Number(trade.size);
      const px = Number(trade.price);
      if (trade.side === 'BUY') {
        const cur = positions.get(key) ?? { size: 0, avgPrice: 0 };
        const newSize = cur.size + sz;
        if (newSize > 0) {
          positions.set(key, {
            size: newSize,
            avgPrice: (cur.size * cur.avgPrice + sz * px) / newSize,
          });
        }
      } else {
        const cur = positions.get(key) ?? { size: 0, avgPrice: 0 };
        const closeSize = Math.min(cur.size, sz);
        if (closeSize > 0) cumulativePnl += closeSize * (px - cur.avgPrice);
        positions.set(key, { size: Math.max(0, cur.size - closeSize), avgPrice: cur.avgPrice });
      }
      tradeIdx++;
    }
    bucketValues.set(bStart, round2(cumulativePnl));
  }

  const points: PnlChartPoint[] = buckets.map((b) => ({
    t: new Date(b).toISOString(),
    v: bucketValues.get(b) ?? round2(cumulativePnl),
  }));

  const firstV = points[0]?.v ?? 0;
  const lastV = points[points.length - 1]?.v ?? 0;
  return {
    walletId,
    range,
    totalPnl: round2(lastV - firstV),
    isPositive: round2(lastV - firstV) >= 0,
    points,
    parityNote: 'realized_pnl_only_excludes_unrealized',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Position normalization
// ─────────────────────────────────────────────────────────────────────────────

const WIN_THRESHOLD = 0.95;
const LOSE_THRESHOLD = 0.05;

/**
 * Normalize a raw adapter position to Polymarket-parity shape.
 *
 * noCostBasis = true when avgPrice === 0 and no totalTraded override.
 * This happens for REDEEM-fallback positions where we have no BUY history.
 * The frontend uses this flag to suppress "TOTAL TRADED" and "P/L %" columns.
 */
export function normalizePosition(raw: {
  id: string;
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  side: string;
  status: 'OPEN' | 'CLOSED';
  icon: string | null;
  eventSlug: string | null;
  updatedAt?: string;
  totalTraded?: number | null;
  /** Set true explicitly when caller knows cost basis is unavailable */
  noCostBasis?: boolean;
}): NormalizedPosition {
  // Suppress 'UNKNOWN' outcome — show empty string so the subtitle reads
  // "1,506.1 at 0¢" instead of "1,506.1 Unknown at 0¢"
  const outcome = raw.outcome === 'UNKNOWN' ? '' : raw.outcome;

  const valueUsd = round2(raw.size * raw.currentPrice);
  const pnlUsd = round2((raw.currentPrice - raw.avgPrice) * raw.size);
  const pnlPct =
    raw.avgPrice > 0 ? round2(((raw.currentPrice - raw.avgPrice) / raw.avgPrice) * 100) : null; // null = no cost basis, frontend shows '—'

  const hasCostBasis =
    raw.noCostBasis !== true &&
    (raw.totalTraded != null ? Number(raw.totalTraded) > 0 : raw.avgPrice > 0);
  const totalTraded =
    raw.totalTraded != null ? round2(Number(raw.totalTraded)) : round2(raw.avgPrice * raw.size);

  let resolution: NormalizedPosition['resolution'] = null;
  if (raw.status === 'CLOSED') {
    if (raw.currentPrice >= WIN_THRESHOLD) resolution = 'WON';
    else if (raw.currentPrice <= LOSE_THRESHOLD) resolution = 'LOST';
    else resolution = 'PENDING';
  }

  return {
    id: raw.id,
    conditionId: raw.conditionId,
    title: raw.title,
    slug: raw.slug,
    outcome,
    shares: roundShares(raw.size),
    avgPrice: round4(raw.avgPrice),
    currentPrice: round4(raw.currentPrice),
    valueUsd,
    pnlUsd,
    pnlPct: pnlPct ?? 0, // keep numeric for sort; frontend checks noCostBasis
    totalTraded,
    side: raw.side,
    status: raw.status,
    resolution,
    noCostBasis: !hasCostBasis,
    icon: raw.icon,
    eventSlug: raw.eventSlug,
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * Sort, filter, and paginate normalized positions.
 *
 * OPEN sort keys:
 *   'value'    → valueUsd DESC  (default)
 *   'pnl_usd'  → pnlUsd DESC
 *   'pnl_pct'  → pnlPct DESC
 *   'market'   → title ASC
 *
 * OPEN sort keys (matches Polymarket Active tab — from screenshot):
 *   'value'        → valueUsd DESC          (default, "Value")
 *   'pnl_usd'      → pnlUsd DESC            ("Profit/Loss $")
 *   'pnl_pct'      → pnlPct DESC            ("Profit/Loss %")
 *   'traded'       → totalTraded DESC       ("Traded")
 *   'alphabetically'→ title ASC             ("Alphabetically")
 *   'avg_price'    → avgPrice DESC          ("Average Price")
 *   'cur_price'    → currentPrice DESC      ("Current Price")
 *
 * CLOSED sort keys:
 *   'won_first'    → WON, LOST, PENDING     (default, "Profit/Loss")
 *   'lost_first'   → LOST, WON, PENDING     ("Losses first")
 *   'pnl_usd'      → pnlUsd DESC            ("P/L $")
 *   'market'       → title ASC              ("Alphabetically")
 *   'date'         → updatedAt DESC         ("Most Recent") — always newest first
 *
 * NOTE: 'date' is ALWAYS DESC (newest first) regardless of sortDir.
 * Tie-break: stable secondary by conditionId ASC.
 */
export function sortAndFilterPositions(
  positions: NormalizedPosition[],
  opts: PositionsQueryOptions,
): { items: NormalizedPosition[]; total: number } {
  const search = (opts.search ?? '').toLowerCase().trim();
  const filtered = search
    ? positions.filter(
        (p) =>
          p.title.toLowerCase().includes(search) ||
          p.outcome.toLowerCase().includes(search) ||
          p.conditionId.toLowerCase().includes(search),
      )
    : positions;

  const defaultSort = opts.status === 'OPEN' ? 'value' : 'won_first';
  const sortBy = opts.sortBy ?? defaultSort;
  const sortDir = opts.sortDir ?? 'desc';
  const dir = sortDir === 'asc' ? 1 : -1;
  const wonFirstOrder: Record<string, number> = { WON: 0, LOST: 1, PENDING: 2 };
  const lostFirstOrder: Record<string, number> = { LOST: 0, WON: 1, PENDING: 2 };

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'value':
        cmp = (a.valueUsd - b.valueUsd) * dir;
        break;
      case 'pnl_usd':
        cmp = (a.pnlUsd - b.pnlUsd) * dir;
        break;
      case 'pnl_pct':
        cmp = (a.pnlPct - b.pnlPct) * dir;
        break;
      case 'traded':
        cmp = (a.totalTraded - b.totalTraded) * dir;
        break;
      case 'alphabetically':
      case 'market':
        cmp = a.title.localeCompare(b.title) * dir;
        break;
      case 'avg_price':
        cmp = (a.avgPrice - b.avgPrice) * dir;
        break;
      case 'cur_price':
        cmp = (a.currentPrice - b.currentPrice) * dir;
        break;
      case 'date':
        // Always newest-first — ignore sortDir for this key
        cmp = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        break;
      case 'won_first': {
        const ao = wonFirstOrder[a.resolution ?? ''] ?? 3;
        const bo = wonFirstOrder[b.resolution ?? ''] ?? 3;
        cmp = ao - bo;
        break;
      }
      case 'lost_first': {
        const ao = lostFirstOrder[a.resolution ?? ''] ?? 3;
        const bo = lostFirstOrder[b.resolution ?? ''] ?? 3;
        cmp = ao - bo;
        break;
      }
      default:
        cmp = b.valueUsd - a.valueUsd;
    }
    if (cmp === 0) cmp = a.conditionId.localeCompare(b.conditionId);
    return cmp;
  });

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, opts.pageSize ?? 50));
  const total = sorted.length;
  const items = sorted.slice((page - 1) * pageSize, page * pageSize);
  return { items, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity normalization
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeActivity(row: {
  id: string;
  eventType: string;
  marketId: string;
  marketQuestion: string | null;
  outcome: string | null;
  side: string | null;
  price: string | number | null;
  shares: string | number | null;
  notional: string | number | null;
  sourceTxHash: string | null;
  txHash: string | null;
  orderId: string | null;
  sourceEventId: string | null;
  sourceCursor: string | null;
  blockNumber: number | null;
  eventTimestamp: Date | string;
}): NormalizedActivity {
  const eventTs =
    row.eventTimestamp instanceof Date ? row.eventTimestamp : new Date(row.eventTimestamp);
  const price = row.price != null ? Number(row.price) : null;
  const shares = row.shares != null ? Number(row.shares) : null;
  const notionalRaw = row.notional != null ? Number(row.notional) : null;

  let amountUsd: number | null = null;
  if (notionalRaw != null && notionalRaw > 0) {
    amountUsd = round2(notionalRaw);
  } else if (price != null && shares != null) {
    amountUsd = round2(price * shares);
  }

  return {
    id: row.id,
    type: formatActivityType(row.eventType, row.side),
    market: row.marketQuestion || row.marketId,
    outcome: row.outcome ?? null,
    side: row.side ?? null,
    amountUsd,
    shares: shares != null ? roundShares(shares) : null,
    price: price != null ? round4(price) : null,
    eventTimestamp: eventTs.toISOString(),
    relativeTime: formatRelativeTime(eventTs),
    txHash: row.txHash ?? row.sourceTxHash ?? null,
    orderId: row.orderId ?? null,
    sourceEventId: row.sourceEventId ?? null,
    sourceCursor: row.sourceCursor ?? null,
    blockNumber: row.blockNumber ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting utilities
// ─────────────────────────────────────────────────────────────────────────────

export function formatUsd(value: number, decimals = 2): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function formatPct(value: number): string {
  const sign = value < 0 ? '-' : value > 0 ? '+' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

export function formatPrice(value: number): string {
  return `${Math.round(value * 100)}¢`;
}

export function formatShares(value: number): string {
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return value.toFixed(4).replace(/\.?0+$/, '') || '0';
}

export function formatRelativeTime(ts: Date | string): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatActivityType(eventType: string, side: string | null): string {
  const et = (eventType ?? '').toUpperCase();
  const sd = (side ?? '').toUpperCase();
  if (et === 'BUY' || (et === 'TRADE' && sd === 'BUY')) return 'Buy';
  if (et === 'SELL' || (et === 'TRADE' && sd === 'SELL')) return 'Sell';
  if (et === 'REDEEM') return 'Redeem';
  if (et === 'MERGE') return 'Merge';
  if (et === 'SPLIT') return 'Split';
  if (et === 'CONVERT') return 'Convert';
  if (et === 'DEPOSIT') return 'Deposit';
  if (et === 'WITHDRAW') return 'Withdraw';
  if (eventType) return eventType.charAt(0).toUpperCase() + eventType.slice(1).toLowerCase();
  return '—';
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
function roundShares(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}
function floorToBucket(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}
function shortenAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function computeRealizedPnlFromTrades(
  walletId: string,
): Promise<{ totalRealizedPnl: number; bestTrade: number }> {
  const trades = await prisma.tradeEvent.findMany({
    where: { walletId },
    orderBy: { tradedAt: 'asc' },
    select: { marketId: true, outcome: true, side: true, size: true, price: true },
  });

  const positions = new Map<string, { size: number; avgPrice: number }>();
  let totalRealizedPnl = 0;
  let bestTrade = 0;

  for (const t of trades) {
    const key = `${t.marketId}:${t.outcome}`;
    const sz = Number(t.size);
    const px = Number(t.price);
    const cur = positions.get(key) ?? { size: 0, avgPrice: 0 };

    if (t.side === 'BUY') {
      const newSize = cur.size + sz;
      const newAvg = newSize > 0 ? (cur.size * cur.avgPrice + sz * px) / newSize : px;
      positions.set(key, { size: newSize, avgPrice: newAvg });
    } else {
      const closeSize = Math.min(cur.size, sz);
      const pnl = closeSize * (px - cur.avgPrice);
      totalRealizedPnl += pnl;
      if (pnl > bestTrade) bestTrade = pnl;
      positions.set(key, { size: Math.max(0, cur.size - closeSize), avgPrice: cur.avgPrice });
    }
  }

  return { totalRealizedPnl: round2(totalRealizedPnl), bestTrade: round2(bestTrade) };
}
