/**
 * wallet-pnl-tracker.ts
 *
 * Windowed Wallet PnL Tracker — calculates exact realized PnL, unrealized PnL,
 * and fees for any tracked wallet over an arbitrary time window using the
 * two-snapshot delta approach.
 *
 * DESIGN: buildPnlSnapshot() is a pure function that takes events + marks →
 * snapshot. calculateWindowedPnl() is the DB-backed entry point.
 */

import { type PolymarketDataPort } from '@copytrader/polymarket-adapter';

import { normalizeMoney } from '../lib/money-utils.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { createPolymarketDataAdapter } from './polymarket.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EPSILON = 1e-9;

const TRADE_LIKE_TYPES = new Set([
  'BUY',
  'SELL',
  'TRADE',
  'INCREASE',
  'REDUCE',
  'CLOSE',
  'REDEEM',
]);

const SELL_LIKE_TYPES = new Set(['SELL', 'REDUCE', 'CLOSE', 'REDEEM']);

// ─── Public types ─────────────────────────────────────────────────────────────

export type FeeMode = 'ACTUAL' | 'REALISTIC' | 'NONE';

export type WindowPreset = '5M' | '15M' | '1H' | '4H' | '24H' | '7D' | '30D' | 'ALL';

export type WindowInput = WindowPreset | { from: string; to: string };

export type CalculateWindowedPnlInput = {
  walletId: string;
  window: WindowInput;
  feeMode: FeeMode;
  useLiveMarks: boolean;
};

export type SnapshotPublic = {
  timestamp: string;
  openPositionCount: number;
  openMarketValue: number;
  unrealizedPnl: number;
  cumulativeRealizedGross: number;
  cumulativeFees: number;
};

export type PositionDelta = {
  key: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string;

  startShares: number;
  startAvgEntry: number;
  startUnrealizedPnl: number;
  startMarkPrice: number | null;

  endShares: number;
  endAvgEntry: number;
  endUnrealizedPnl: number;
  endMarkPrice: number | null;

  sharesDelta: number;
  realizedInWindow: number;
  unrealizedDelta: number;
  feesInWindow: number;
  netDelta: number;

  buysInWindow: number;
  sellsInWindow: number;
  volumeInWindow: number;

  openedInWindow: boolean;
  closedInWindow: boolean;
};

export type WindowedPnlConfidence = {
  level: 'HIGH' | 'PARTIAL' | 'LOW';
  totalEventsInWindow: number;
  totalEventsBeforeWindow: number;
  hasFullHistory: boolean;
  missingFeeCount: number;
  inferredFeeCount: number;
  missingMarkCount: number;
  staleMarkCount: number;
  warnings: string[];
};

export type WindowedPnlResponse = {
  walletId: string;
  walletAddress: string;
  walletLabel: string;

  window: {
    label: string;
    from: string;
    to: string;
    durationMs: number;
  };

  feeMode: FeeMode;

  pnl: {
    realizedGross: number;
    unrealizedDelta: number;
    fees: number;
    netPnl: number;
  };

  snapshotStart: SnapshotPublic;
  snapshotEnd: SnapshotPublic;

  positionDeltas: PositionDelta[];

  confidence: WindowedPnlConfidence;

  computeMetrics: {
    totalEventsReplayed: number;
    computeTimeMs: number;
  };
};

// ─── Internal types ───────────────────────────────────────────────────────────

/** Normalised event shape consumed by the pure reducer. */
export type PnlEvent = {
  id: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  side: 'BUY' | 'SELL' | null;
  effectiveSide: 'BUY' | 'SELL' | null;
  eventType: string;
  price: number | null;
  shares: number | null;
  notional: number | null;
  fee: number | null;
  feeIsInferred: boolean;
  eventTimestamp: Date;
};

/** Internal position accumulator. */
type PosState = {
  key: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string;
  netShares: number;
  avgEntryPrice: number;
  /** Cumulative realized gross PnL for this position across all events up to snapshot. */
  cumulativeRealizedGross: number;
};

/** Full internal snapshot with position map (for delta computation). */
export type SnapshotInternal = {
  timestamp: Date;
  positionsByKey: Map<string, PosState>;
  cumulativeRealizedGross: number;
  cumulativeFees: number;
  /** Cumulative fees paid per position key. */
  positionFeesByKey: Map<string, number>;
  missingFeeCount: number;
  inferredFeeCount: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safely coerce Prisma Decimal / number / null to a JS number. */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeMarketKey(conditionId: string | null, marketId: string): string {
  const cId = String(conditionId ?? '').trim();
  return cId.length > 0 ? cId : String(marketId).trim();
}

function normalizeOutcome(outcome: string | null | undefined): string {
  const v = String(outcome ?? '')
    .trim()
    .toUpperCase();
  return v.length > 0 ? v : 'UNKNOWN';
}

function clonePositionsByKey(src: Map<string, PosState>): Map<string, PosState> {
  const out = new Map<string, PosState>();
  for (const [k, v] of src) {
    out.set(k, { ...v });
  }
  return out;
}

// ─── Exported pure helpers (testable) ────────────────────────────────────────

/** Resolve the trade side from an event (identical logic to tracked-wallet-performance). */
export function resolveEventSide(event: PnlEvent): 'BUY' | 'SELL' | null {
  const direct = event.effectiveSide ?? event.side;
  if (direct === 'BUY' || direct === 'SELL') return direct;
  const t = event.eventType.toUpperCase();
  if (!TRADE_LIKE_TYPES.has(t)) return null;
  return SELL_LIKE_TYPES.has(t) ? 'SELL' : 'BUY';
}

/**
 * Resolve the fee for one event according to the chosen fee mode.
 * Matches the fee-resolution spec:
 *   NONE    → fee = 0 always
 *   ACTUAL  → use explicit fee if present, else fee = 0 and missing = true
 *   REALISTIC → use explicit fee if present, else infer 2% of notional
 */
export function resolveFee(
  fee: number | null,
  feeIsInferred: boolean,
  feeMode: FeeMode,
  notional: number | null,
): { fee: number; inferred: boolean; missing: boolean } {
  if (feeMode === 'NONE') return { fee: 0, inferred: false, missing: false };

  // Explicit (or already-inferred during ingestion) fee present
  if (fee !== null && Number.isFinite(fee) && fee >= 0) {
    return { fee, inferred: feeIsInferred, missing: false };
  }

  // Fee truly missing from event
  if (feeMode === 'REALISTIC' && notional !== null && notional > 0) {
    return { fee: normalizeMoney(notional * 0.02), inferred: true, missing: false };
  }

  return { fee: 0, inferred: false, missing: true };
}

// ─── Window resolver ──────────────────────────────────────────────────────────

function resolveWindow(
  input: WindowInput,
  now: Date,
): { from: Date; to: Date; label: string } {
  if (typeof input === 'object') {
    return {
      from: new Date(input.from),
      to: new Date(input.to),
      label: 'CUSTOM',
    };
  }
  const to = now;
  const ms = (n: number) => new Date(to.getTime() - n);
  switch (input) {
    case '5M':
      return { from: ms(5 * 60_000), to, label: '5M' };
    case '15M':
      return { from: ms(15 * 60_000), to, label: '15M' };
    case '1H':
      return { from: ms(60 * 60_000), to, label: '1H' };
    case '4H':
      return { from: ms(4 * 60 * 60_000), to, label: '4H' };
    case '24H':
      return { from: ms(24 * 60 * 60_000), to, label: '24H' };
    case '7D':
      return { from: ms(7 * 24 * 60 * 60_000), to, label: '7D' };
    case '30D':
      return { from: ms(30 * 24 * 60 * 60_000), to, label: '30D' };
    case 'ALL':
      return { from: new Date(0), to, label: 'ALL' };
  }
}

// ─── Core pure reducer ────────────────────────────────────────────────────────

/**
 * Replay all events with eventTimestamp <= cutoff and return a portfolio
 * snapshot at that point in time.
 *
 * This function is intentionally pure (no I/O). Mark prices are provided
 * externally so both start and end snapshots can use the same live marks.
 */
export function buildPnlSnapshot(
  events: PnlEvent[],
  cutoff: Date,
  feeMode: FeeMode,
): SnapshotInternal {
  // Filter to all events with eventTimestamp <= cutoff, maintaining order
  const relevant = events
    .filter((e) => e.eventTimestamp <= cutoff)
    .sort((a, b) => {
      const dt = a.eventTimestamp.getTime() - b.eventTimestamp.getTime();
      if (dt !== 0) return dt;
      return a.id.localeCompare(b.id);
    });

  const positionsByKey = new Map<string, PosState>();
  const positionFeesByKey = new Map<string, number>();
  const seenIds = new Set<string>();
  let cumulativeRealizedGross = 0;
  let cumulativeFees = 0;
  let missingFeeCount = 0;
  let inferredFeeCount = 0;

  for (const event of relevant) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);

    const t = event.eventType.toUpperCase();
    if (!TRADE_LIKE_TYPES.has(t)) continue;

    const side = resolveEventSide(event);
    if (side === null) continue;

    const marketKey = normalizeMarketKey(event.conditionId, event.marketId);
    const outcome = normalizeOutcome(event.outcome);
    const posKey = `${marketKey}:${outcome}`;

    const price = toNum(event.price);
    let shares = toNum(event.shares);
    const notional = toNum(event.notional);

    // Infer shares from notional/price if missing (mirrors applyBuy inference)
    if (
      (shares === null || shares <= EPSILON) &&
      notional !== null &&
      price !== null &&
      price > EPSILON
    ) {
      shares = notional / price;
    }

    // Per-event notional for fee inference
    const effectiveNotional =
      notional ??
      (shares !== null && price !== null && Number.isFinite(shares * price)
        ? shares * price
        : null);

    const { fee, inferred, missing } = resolveFee(
      event.fee,
      event.feeIsInferred,
      feeMode,
      effectiveNotional,
    );
    if (missing) missingFeeCount += 1;
    if (inferred) inferredFeeCount += 1;

    if (side === 'BUY') {
      if (shares === null || price === null || shares <= EPSILON) continue;

      let pos = positionsByKey.get(posKey);
      if (!pos) {
        pos = {
          key: posKey,
          marketId: event.marketId,
          conditionId: event.conditionId,
          marketQuestion: event.marketQuestion,
          outcome,
          netShares: 0,
          avgEntryPrice: 0,
          cumulativeRealizedGross: 0,
        };
        positionsByKey.set(posKey, pos);
      }

      const prevShares = pos.netShares;
      const newShares = normalizeMoney(prevShares + shares);
      // Weighted average cost basis (identical to applyBuy in tracked-wallet-performance)
      pos.avgEntryPrice =
        newShares > EPSILON
          ? (prevShares * pos.avgEntryPrice + shares * price) / newShares
          : pos.avgEntryPrice;
      pos.netShares = newShares;
      pos.marketQuestion = event.marketQuestion ?? pos.marketQuestion;

      cumulativeFees = normalizeMoney(cumulativeFees + fee);
      positionFeesByKey.set(posKey, normalizeMoney((positionFeesByKey.get(posKey) ?? 0) + fee));
    } else {
      // SELL-like event
      if (outcome === 'UNKNOWN') {
        // Unknown outcome: find the largest open position for the same market
        const candidates = Array.from(positionsByKey.values())
          .filter((p) => p.marketId === event.marketId && p.netShares > EPSILON)
          .sort((a, b) => b.netShares - a.netShares);

        for (const pos of candidates) {
          if (shares === null || shares <= EPSILON) {
            shares = pos.netShares;
          }
          const closeShares = Math.min(pos.netShares, shares);
          if (closeShares <= EPSILON) continue;

          let exitPrice = price;
          if (exitPrice === null && notional !== null && closeShares > EPSILON) {
            exitPrice = notional / closeShares;
          }
          exitPrice = exitPrice ?? 0;

          const realized = normalizeMoney(closeShares * (exitPrice - pos.avgEntryPrice));
          pos.cumulativeRealizedGross = normalizeMoney(pos.cumulativeRealizedGross + realized);
          pos.netShares = normalizeMoney(pos.netShares - closeShares);

          cumulativeRealizedGross = normalizeMoney(cumulativeRealizedGross + realized);
          cumulativeFees = normalizeMoney(cumulativeFees + fee);
          positionFeesByKey.set(
            pos.key,
            normalizeMoney((positionFeesByKey.get(pos.key) ?? 0) + fee),
          );
          break; // one position per unknown-outcome event
        }
        continue;
      }

      const pos = positionsByKey.get(posKey);
      if (!pos || pos.netShares <= EPSILON) continue;

      // Infer shares from open inventory if missing (mirrors applySell inference)
      if (shares === null || shares <= EPSILON) {
        shares = pos.netShares;
      }

      // Clamp to held shares (never sell more than held)
      const closeShares = Math.min(pos.netShares, shares);
      if (closeShares <= EPSILON) continue;

      // Infer price for REDEEM/CLOSE with null price
      let exitPrice = price;
      if (exitPrice === null && notional !== null && closeShares > EPSILON) {
        exitPrice = notional / closeShares;
      }
      // REDEEM/CLOSE with no price and no notional → losing close at 0
      exitPrice = exitPrice ?? 0;

      const realized = normalizeMoney(closeShares * (exitPrice - pos.avgEntryPrice));
      pos.cumulativeRealizedGross = normalizeMoney(pos.cumulativeRealizedGross + realized);
      pos.netShares = normalizeMoney(pos.netShares - closeShares);

      cumulativeRealizedGross = normalizeMoney(cumulativeRealizedGross + realized);
      cumulativeFees = normalizeMoney(cumulativeFees + fee);
      positionFeesByKey.set(posKey, normalizeMoney((positionFeesByKey.get(posKey) ?? 0) + fee));
    }
  }

  return {
    timestamp: cutoff,
    positionsByKey,
    cumulativeRealizedGross,
    cumulativeFees,
    positionFeesByKey,
    missingFeeCount,
    inferredFeeCount,
  };
}

// ─── Mark price resolution ────────────────────────────────────────────────────

/**
 * Fetch live mark prices for a set of unique conditionId/marketId keys.
 * Uses Promise.allSettled so one failed fetch never blocks the rest.
 *
 * For binary markets (YES/NO): YES = midpoint, NO = 1 - midpoint.
 */
async function fetchLiveMarks(
  keys: Array<{ marketKey: string; outcome: string; conditionId: string | null }>,
  dataAdapter: PolymarketDataPort,
): Promise<{
  markPriceByKey: Map<string, number>;
  missingMarkCount: number;
  staleMarkCount: number;
}> {
  const markPriceByKey = new Map<string, number>();
  let missingMarkCount = 0;
  const staleMarkCount = 0; // live marks are fresh; stale would come from fallback

  // Deduplicate by marketKey
  const uniqueMarketKeys = Array.from(new Set(keys.map((k) => k.marketKey)));

  const results = await Promise.allSettled(
    uniqueMarketKeys.map((mk) => dataAdapter.getMarket(mk)),
  );

  const midpointByMarketKey = new Map<string, number>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const mk = uniqueMarketKeys[i]!;
    if (r.status === 'fulfilled' && r.value !== null) {
      midpointByMarketKey.set(mk, r.value.midpoint);
    }
  }

  for (const { marketKey, outcome, conditionId: _ } of keys) {
    const posKey = `${marketKey}:${outcome}`;
    const midpoint = midpointByMarketKey.get(marketKey);
    // Treat missing or zero/negative midpoint as missing — a 0 midpoint means no
    // liquidity data was returned, not a genuine $0 market price.
    if (midpoint === undefined || midpoint <= 0) {
      missingMarkCount += 1;
      continue;
    }

    const outNorm = outcome.toUpperCase();
    if (outNorm === 'YES') {
      markPriceByKey.set(posKey, midpoint);
    } else if (outNorm === 'NO') {
      const noPrice = normalizeMoney(1 - midpoint);
      // If NO price is also zero/negative, skip
      if (noPrice <= 0) {
        missingMarkCount += 1;
        continue;
      }
      markPriceByKey.set(posKey, noPrice);
    } else {
      // Non-binary outcome — use midpoint directly as best estimate
      markPriceByKey.set(posKey, midpoint);
    }
  }

  return { markPriceByKey, missingMarkCount, staleMarkCount };
}

/**
 * Fallback: fetch mark prices from the wallet positions API.
 * Returns a key → currentPrice map.
 */
async function fetchPositionMarks(
  walletAddress: string,
  dataAdapter: PolymarketDataPort,
): Promise<Map<string, number>> {
  try {
    const positions = await dataAdapter.getWalletPositions(walletAddress, 'OPEN');
    const out = new Map<string, number>();
    for (const pos of positions) {
      if (pos.currentPrice > 0) {
        // WalletPosition has conditionId (string, always present).
        // normalizeMarketKey uses conditionId when present, so keying by conditionId
        // is the correct match for the keys in markKeyList.
        const outcome = String(pos.outcome ?? '').trim().toUpperCase();
        const key = `${String(pos.conditionId).trim()}:${outcome}`;
        out.set(key, pos.currentPrice);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

// ─── Snapshot → public shape ──────────────────────────────────────────────────

function applyMarksToSnapshot(
  snap: SnapshotInternal,
  markPriceByKey: Map<string, number>,
): {
  publicSnap: SnapshotPublic;
  unrealizedByKey: Map<string, number>;
  markByKey: Map<string, number | null>;
} {
  let unrealizedPnl = 0;
  let openMarketValue = 0;
  let openPositionCount = 0;
  const unrealizedByKey = new Map<string, number>();
  const markByKey = new Map<string, number | null>();

  for (const pos of snap.positionsByKey.values()) {
    if (pos.netShares <= EPSILON) {
      markByKey.set(pos.key, null);
      continue;
    }

    openPositionCount += 1;
    const mark = markPriceByKey.get(pos.key) ?? null;
    markByKey.set(pos.key, mark);

    // Treat null OR zero/negative mark as missing — conservative: no gain/loss when mark is unavailable
    const effectiveMark = (mark !== null && mark > EPSILON) ? mark : pos.avgEntryPrice;
    const posUnrealized = normalizeMoney(pos.netShares * (effectiveMark - pos.avgEntryPrice));
    unrealizedByKey.set(pos.key, posUnrealized);
    unrealizedPnl = normalizeMoney(unrealizedPnl + posUnrealized);
    openMarketValue = normalizeMoney(openMarketValue + pos.netShares * effectiveMark);
  }

  return {
    publicSnap: {
      timestamp: snap.timestamp.toISOString(),
      openPositionCount,
      openMarketValue,
      unrealizedPnl,
      cumulativeRealizedGross: normalizeMoney(snap.cumulativeRealizedGross),
      cumulativeFees: normalizeMoney(snap.cumulativeFees),
    },
    unrealizedByKey,
    markByKey,
  };
}

// ─── Position delta computation ───────────────────────────────────────────────

function buildPositionDeltas(
  snapStart: SnapshotInternal,
  snapEnd: SnapshotInternal,
  markPriceByKey: Map<string, number>,
  unrealizedStartByKey: Map<string, number>,
  unrealizedEndByKey: Map<string, number>,
  markStartByKey: Map<string, number | null>,
  markEndByKey: Map<string, number | null>,
  windowEvents: PnlEvent[],
): PositionDelta[] {
  // Collect all keys that appear in either snapshot
  const allKeys = new Set<string>([
    ...snapStart.positionsByKey.keys(),
    ...snapEnd.positionsByKey.keys(),
  ]);

  // Pre-compute per-position window activity
  type PerPosActivity = { buys: number; sells: number; volume: number };
  const activityByKey = new Map<string, PerPosActivity>();

  for (const event of windowEvents) {
    const t = event.eventType.toUpperCase();
    if (!TRADE_LIKE_TYPES.has(t)) continue;
    const side = resolveEventSide(event);
    if (side === null) continue;

    const mk = normalizeMarketKey(event.conditionId, event.marketId);
    const out = normalizeOutcome(event.outcome);
    const key = `${mk}:${out}`;

    const existing = activityByKey.get(key) ?? { buys: 0, sells: 0, volume: 0 };
    const shares = toNum(event.shares) ?? 0;
    const price = toNum(event.price) ?? 0;
    if (side === 'BUY') {
      existing.buys += 1;
      existing.volume = normalizeMoney(existing.volume + shares * price);
    } else {
      existing.sells += 1;
      existing.volume = normalizeMoney(existing.volume + shares * price);
    }
    activityByKey.set(key, existing);
  }

  const deltas: PositionDelta[] = [];

  for (const key of allKeys) {
    const startPos = snapStart.positionsByKey.get(key);
    const endPos = snapEnd.positionsByKey.get(key);

    const startShares = normalizeMoney(startPos?.netShares ?? 0);
    const endShares = normalizeMoney(endPos?.netShares ?? 0);

    // If both sides are effectively zero, skip — not relevant
    if (startShares <= EPSILON && endShares <= EPSILON) {
      const activity = activityByKey.get(key);
      if (!activity || (activity.buys === 0 && activity.sells === 0)) continue;
    }

    const startAvgEntry = startPos?.avgEntryPrice ?? 0;
    const endAvgEntry = endPos?.avgEntryPrice ?? 0;
    const startUnrealized = unrealizedStartByKey.get(key) ?? 0;
    const endUnrealized = unrealizedEndByKey.get(key) ?? 0;
    const startMark = markStartByKey.get(key) ?? null;
    const endMark = markEndByKey.get(key) ?? null;

    const startFees = snapStart.positionFeesByKey.get(key) ?? 0;
    const endFees = snapEnd.positionFeesByKey.get(key) ?? 0;
    const feesInWindow = normalizeMoney(endFees - startFees);

    const startRealized = startPos?.cumulativeRealizedGross ?? 0;
    const endRealized = endPos?.cumulativeRealizedGross ?? 0;
    const realizedInWindow = normalizeMoney(endRealized - startRealized);

    const unrealizedDelta = normalizeMoney(endUnrealized - startUnrealized);
    const netDelta = normalizeMoney(realizedInWindow + unrealizedDelta - feesInWindow);

    const activity = activityByKey.get(key) ?? { buys: 0, sells: 0, volume: 0 };

    // A representative position object for metadata (prefer end, fallback to start)
    const refPos = endPos ?? startPos!;

    deltas.push({
      key,
      marketId: refPos.marketId,
      conditionId: refPos.conditionId,
      marketQuestion: refPos.marketQuestion,
      outcome: refPos.outcome,

      startShares,
      startAvgEntry: normalizeMoney(startAvgEntry),
      startUnrealizedPnl: normalizeMoney(startUnrealized),
      startMarkPrice: startMark,

      endShares: normalizeMoney(endShares),
      endAvgEntry: normalizeMoney(endAvgEntry),
      endUnrealizedPnl: normalizeMoney(endUnrealized),
      endMarkPrice: endMark,

      sharesDelta: normalizeMoney(endShares - startShares),
      realizedInWindow: normalizeMoney(realizedInWindow),
      unrealizedDelta,
      feesInWindow: normalizeMoney(feesInWindow),
      netDelta,

      buysInWindow: activity.buys,
      sellsInWindow: activity.sells,
      volumeInWindow: normalizeMoney(activity.volume),

      openedInWindow: startShares <= EPSILON && endShares > EPSILON,
      closedInWindow: startShares > EPSILON && endShares <= EPSILON,
    });
  }

  // Sort: positions with activity first, then by abs net delta descending
  return deltas.sort(
    (a, b) =>
      b.buysInWindow +
      b.sellsInWindow -
      (a.buysInWindow + a.sellsInWindow) ||
      Math.abs(b.netDelta) - Math.abs(a.netDelta),
  );
}

// ─── Confidence model ─────────────────────────────────────────────────────────

function buildConfidence(input: {
  hasFullHistory: boolean;
  missingFeeCount: number;
  inferredFeeCount: number;
  missingMarkCount: number;
  staleMarkCount: number;
  totalEventsInWindow: number;
  totalEventsBeforeWindow: number;
}): WindowedPnlConfidence {
  const warnings: string[] = [];

  if (!input.hasFullHistory) warnings.push('history-truncated');
  if (input.missingFeeCount > 0) warnings.push('missing-fees');
  if (input.inferredFeeCount > 0) warnings.push('inferred-fees');
  if (input.missingMarkCount > 0) warnings.push('missing-mark-prices');
  if (input.staleMarkCount > 0) warnings.push('stale-mark-prices');

  let level: 'HIGH' | 'PARTIAL' | 'LOW';
  if (!input.hasFullHistory || input.missingMarkCount > 0) {
    level = 'LOW';
  } else if (input.missingFeeCount === 0 && input.inferredFeeCount === 0 && input.staleMarkCount === 0) {
    level = 'HIGH';
  } else {
    level = 'PARTIAL';
  }

  return {
    level,
    totalEventsInWindow: input.totalEventsInWindow,
    totalEventsBeforeWindow: input.totalEventsBeforeWindow,
    hasFullHistory: input.hasFullHistory,
    missingFeeCount: input.missingFeeCount,
    inferredFeeCount: input.inferredFeeCount,
    missingMarkCount: input.missingMarkCount,
    staleMarkCount: input.staleMarkCount,
    warnings,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function calculateWindowedPnl(
  input: CalculateWindowedPnlInput,
): Promise<WindowedPnlResponse> {
  const startTime = Date.now();

  // ── 1. Resolve wallet ──────────────────────────────────────────────────────
  const wallet = await prisma.watchedWallet.findUniqueOrThrow({
    where: { id: input.walletId },
    select: { id: true, address: true, label: true },
  });

  // ── 2. Resolve time window ─────────────────────────────────────────────────
  const now = new Date();
  const { from: tStart, to: tEnd, label: windowLabel } = resolveWindow(input.window, now);

  // ── 3. Fetch all events up to T_end ───────────────────────────────────────
  const dbRows = await prisma.walletActivityEvent.findMany({
    where: {
      trackedWalletId: input.walletId,
      eventTimestamp: { lte: tEnd },
    },
    orderBy: [{ eventTimestamp: 'asc' }, { id: 'asc' }],
  });

  // ── 4. Normalise DB rows to PnlEvent ───────────────────────────────────────
  const events: PnlEvent[] = dbRows.map((row) => {
    const raw = row.rawPayloadJson as Record<string, unknown> | null;
    const ingestionInferred = raw?.feeIsInferred === true;
    const fee = toNum(row.fee);
    return {
      id: row.id,
      marketId: row.marketId,
      conditionId: row.conditionId,
      marketQuestion: row.marketQuestion,
      outcome: row.outcome,
      side: row.side as 'BUY' | 'SELL' | null,
      effectiveSide: row.effectiveSide as 'BUY' | 'SELL' | null,
      eventType: row.eventType,
      price: toNum(row.price),
      shares: toNum(row.shares),
      notional: toNum(row.notional),
      fee,
      feeIsInferred: ingestionInferred || (fee !== null && ingestionInferred),
      eventTimestamp: row.eventTimestamp,
    };
  });

  // ── 5. Build snapshots ────────────────────────────────────────────────────
  const snapStart = buildPnlSnapshot(events, tStart, input.feeMode);
  const snapEnd = buildPnlSnapshot(events, tEnd, input.feeMode);

  // ── 6. Collect open positions from BOTH snapshots for mark fetching ────────
  const markKeysSet = new Set<string>();
  const markKeyList: Array<{ marketKey: string; outcome: string; conditionId: string | null }> = [];

  for (const snap of [snapStart, snapEnd]) {
    for (const pos of snap.positionsByKey.values()) {
      if (pos.netShares > EPSILON && !markKeysSet.has(pos.key)) {
        markKeysSet.add(pos.key);
        markKeyList.push({
          marketKey: normalizeMarketKey(pos.conditionId, pos.marketId),
          outcome: pos.outcome,
          conditionId: pos.conditionId,
        });
      }
    }
  }

  // ── 7. Fetch mark prices ───────────────────────────────────────────────────
  let markPriceByKey = new Map<string, number>();
  let missingMarkCount = 0;
  let staleMarkCount = 0;

  if (markKeyList.length > 0) {
    const dataAdapter = createPolymarketDataAdapter();

    if (input.useLiveMarks) {
      const liveResult = await fetchLiveMarks(markKeyList, dataAdapter);
      markPriceByKey = liveResult.markPriceByKey;
      missingMarkCount = liveResult.missingMarkCount;
      staleMarkCount = liveResult.staleMarkCount;

      // Fill in any missing marks from positions API
      if (missingMarkCount > 0) {
        const fallbackMarks = await fetchPositionMarks(wallet.address, dataAdapter);
        let fallbackFilled = 0;
        for (const item of markKeyList) {
          const k = `${item.marketKey}:${item.outcome}`;
          if (!markPriceByKey.has(k)) {
            const fb = fallbackMarks.get(k);
            if (fb !== undefined) {
              markPriceByKey.set(k, fb);
              fallbackFilled += 1;
              staleMarkCount += 1; // fallback source = stale
            }
          }
        }
        missingMarkCount = Math.max(0, missingMarkCount - fallbackFilled);
      }
    } else {
      // useLiveMarks = false: use positions API only
      const fallbackMarks = await fetchPositionMarks(wallet.address, dataAdapter);
      for (const item of markKeyList) {
        const k = `${item.marketKey}:${item.outcome}`;
        const fb = fallbackMarks.get(k);
        if (fb !== undefined) {
          markPriceByKey.set(k, fb);
          staleMarkCount += 1;
        } else {
          missingMarkCount += 1;
        }
      }
    }
  }

  // ── 8. Apply marks to both snapshots ──────────────────────────────────────
  const {
    publicSnap: snapshotStart,
    unrealizedByKey: unrealizedStartByKey,
    markByKey: markStartByKey,
  } = applyMarksToSnapshot(snapStart, markPriceByKey);

  const {
    publicSnap: snapshotEnd,
    unrealizedByKey: unrealizedEndByKey,
    markByKey: markEndByKey,
  } = applyMarksToSnapshot(snapEnd, markPriceByKey);

  // ── 9. Compute window-level PnL deltas ─────────────────────────────────────
  const windowRealizedGross = normalizeMoney(
    snapEnd.cumulativeRealizedGross - snapStart.cumulativeRealizedGross,
  );
  const windowFees = normalizeMoney(snapEnd.cumulativeFees - snapStart.cumulativeFees);
  const windowUnrealizedDelta = normalizeMoney(
    snapshotEnd.unrealizedPnl - snapshotStart.unrealizedPnl,
  );
  const windowNetPnl = normalizeMoney(windowRealizedGross + windowUnrealizedDelta - windowFees);

  // ── 10. Events in window (for metrics + per-position activity) ────────────
  const windowEvents = events.filter(
    (e) => e.eventTimestamp > tStart && e.eventTimestamp <= tEnd,
  );
  const eventsBeforeWindow = events.filter((e) => e.eventTimestamp <= tStart);

  // ── 11. Build per-position deltas ─────────────────────────────────────────
  const positionDeltas = buildPositionDeltas(
    snapStart,
    snapEnd,
    markPriceByKey,
    unrealizedStartByKey,
    unrealizedEndByKey,
    markStartByKey,
    markEndByKey,
    windowEvents,
  );

  // ── 12. Check sync cursor history status ──────────────────────────────────
  const syncCursor = await prisma.walletSyncCursor.findFirst({
    where: { trackedWalletId: input.walletId },
    orderBy: { updatedAt: 'desc' },
    select: { lastErrorClass: true },
  });
  const hasFullHistory = syncCursor?.lastErrorClass !== 'HISTORY_TRUNCATED';

  // ── 13. Aggregate missing/inferred fee counts across both snapshots ────────
  // Use end snapshot totals (they include everything); start snapshot is a subset
  const totalMissingFeeCount = snapEnd.missingFeeCount;
  const totalInferredFeeCount = snapEnd.inferredFeeCount;

  // ── 14. Build confidence ──────────────────────────────────────────────────
  const confidence = buildConfidence({
    hasFullHistory,
    missingFeeCount: totalMissingFeeCount,
    inferredFeeCount: totalInferredFeeCount,
    missingMarkCount,
    staleMarkCount,
    totalEventsInWindow: windowEvents.length,
    totalEventsBeforeWindow: eventsBeforeWindow.length,
  });

  const computeTimeMs = Date.now() - startTime;

  logger.debug(
    {
      walletId: input.walletId,
      windowLabel,
      totalEvents: events.length,
      computeTimeMs,
    },
    'wallet-pnl-tracker: computed windowed PnL',
  );

  return {
    walletId: wallet.id,
    walletAddress: wallet.address,
    walletLabel: wallet.label,

    window: {
      label: windowLabel,
      from: tStart.toISOString(),
      to: tEnd.toISOString(),
      durationMs: tEnd.getTime() - tStart.getTime(),
    },

    feeMode: input.feeMode,

    pnl: {
      realizedGross: windowRealizedGross,
      unrealizedDelta: windowUnrealizedDelta,
      fees: windowFees,
      netPnl: windowNetPnl,
    },

    snapshotStart,
    snapshotEnd,

    positionDeltas,

    confidence,

    computeMetrics: {
      totalEventsReplayed: events.length,
      computeTimeMs,
    },
  };
}
