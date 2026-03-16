/**
 * paper-ledger.ts — Pure, deterministic ledger math for paper copy-trading.
 *
 * This module is the canonical source of truth for:
 *   - Position reduction (net shares from a sequence of trades)
 *   - Weighted average entry price
 *   - Realized PnL
 *   - Unrealized PnL
 *   - Cash / bankroll accounting
 *   - Portfolio valuation
 *
 * DESIGN PRINCIPLES:
 *   1. No database dependency — operates on plain arrays/objects
 *   2. Deterministic — same inputs always produce same outputs
 *   3. Append-only ledger as source of truth
 *   4. Positions are DERIVED from the ledger, never mutated directly
 *   5. All invariants are checkable and reportable
 *
 * ROUNDING:
 *   - Shares are rounded to 8 decimal places (sub-cent precision)
 *   - Prices are kept at full precision
 *   - Dollar amounts are rounded to 2 decimal places for display only
 *
 * AUDIT FIXES APPLIED:
 *   - FIX-1: computeCash now clamps sells to held shares (prevents phantom cash credit)
 *   - FIX-2: reducePosition resets closedAt/openedAt on position re-open
 *   - FIX-3: computePortfolio inherits both fixes via composition
 *   - FIX-4: reconcile uses fixed computeCash
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TradeSide = 'BUY' | 'SELL';

export interface LedgerEntry {
  id: string;
  sourceEventId: string | null;
  marketId: string;
  outcome: string;
  side: TradeSide;
  action: string; // BUY, SELL, INCREASE, REDUCE, CLOSE, REDEEM, BOOTSTRAP, RECONCILE_CLOSE
  shares: number;
  price: number;
  notional: number;
  fee: number;
  slippage: number;
  timestamp: Date;
}

export interface ReducedPosition {
  marketId: string;
  outcome: string;
  netShares: number;
  avgEntryPrice: number;
  totalCostBasis: number;
  realizedPnl: number;
  status: 'OPEN' | 'CLOSED';
  openedAt: Date | null;
  closedAt: Date | null;
}

export interface PortfolioState {
  cash: number;
  positions: ReducedPosition[];
  openPositions: ReducedPosition[];
  closedPositions: ReducedPosition[];
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalFees: number;
  grossExposure: number;
  netLiquidationValue: number;
  netPnl: number;
  totalPnl: number;
}

export interface ReconciliationResult {
  valid: boolean;
  errors: string[];
  cashExpected: number;
  cashActual: number;
  positionMismatches: Array<{
    marketId: string;
    outcome: string;
    ledgerShares: number;
    positionShares: number;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHARE_PRECISION = 8;
const EPSILON = 1e-8;

export function roundShares(shares: number): number {
  return Math.round(shares * 10 ** SHARE_PRECISION) / 10 ** SHARE_PRECISION;
}

// ---------------------------------------------------------------------------
// Copy ratio scaling
// ---------------------------------------------------------------------------

/**
 * Scale source shares by copy ratio.
 *
 * Copy ratio scales SHARES, not dollars.
 * Result is rounded to SHARE_PRECISION decimal places.
 */
export function scaleShares(sourceShares: number, copyRatio: number): number {
  return roundShares(sourceShares * copyRatio);
}

// ---------------------------------------------------------------------------
// Position Reducer
// ---------------------------------------------------------------------------

/**
 * Reduce a sequence of ledger entries for a single market+outcome
 * into a ReducedPosition.
 *
 * This is the core accounting function.
 *
 * Rules:
 *   - BUY-like actions (side=BUY) increase net shares
 *   - SELL-like actions (side=SELL) decrease net shares
 *   - Average entry price uses weighted average cost
 *   - Realized PnL = (sell_price - avg_entry_price) * shares_sold (gross, before fees)
 *   - Net shares cannot go below zero (clamped with warning)
 *   - Position is CLOSED when net shares reach zero
 *
 * FIX-2: When a position is fully closed (netShares=0) and a new BUY arrives,
 *         openedAt is reset to the new BUY timestamp and closedAt is cleared.
 *         This ensures re-opened positions have accurate lifecycle metadata.
 */
export function reducePosition(
  marketId: string,
  outcome: string,
  entries: LedgerEntry[],
): ReducedPosition {
  let netShares = 0;
  let avgEntryPrice = 0;
  let totalCostBasis = 0;
  let realizedPnl = 0;
  let openedAt: Date | null = null;
  let closedAt: Date | null = null;

  for (const entry of entries) {
    if (entry.side === 'BUY') {
      // FIX-2: If position was closed and we're re-opening, reset lifecycle timestamps.
      // This prevents stale closedAt from a previous close persisting on a re-opened position,
      // and ensures openedAt reflects when the current (re-opened) position was established.
      if (netShares <= EPSILON && closedAt !== null) {
        openedAt = entry.timestamp;
        closedAt = null;
      }

      const newTotal = netShares + entry.shares;
      if (newTotal > 0) {
        // Weighted average: (old_shares * old_avg + new_shares * new_price) / total
        avgEntryPrice = (netShares * avgEntryPrice + entry.shares * entry.price) / newTotal;
      }
      netShares = roundShares(newTotal);
      totalCostBasis += entry.shares * entry.price;

      if (openedAt === null) {
        openedAt = entry.timestamp;
      }
    } else {
      // SELL
      const closeShares = Math.min(netShares, entry.shares);
      if (closeShares <= EPSILON) continue;

      // Realized PnL is gross trading edge before fees.
      realizedPnl += closeShares * (entry.price - avgEntryPrice);
      netShares = roundShares(Math.max(0, netShares - closeShares));

      if (netShares <= EPSILON) {
        netShares = 0;
        closedAt = entry.timestamp;
      }
    }
  }

  return {
    marketId,
    outcome,
    netShares,
    avgEntryPrice,
    totalCostBasis,
    realizedPnl,
    status: netShares > EPSILON ? 'OPEN' : 'CLOSED',
    openedAt,
    closedAt,
  };
}

// ---------------------------------------------------------------------------
// Cash Accounting
// ---------------------------------------------------------------------------

/**
 * Compute the expected cash balance from starting cash and a full trade ledger.
 *
 * Rules:
 *   BUY:  cash -= (shares * price) + fee
 *   SELL: cash += (clamped_shares * price) - fee
 *
 * This is the canonical cash computation. The DB value of currentCash must
 * match this at all times. If it doesn't, we have a reconciliation error.
 *
 * FIX-1: Sells are now clamped to held shares per market:outcome.
 *
 * PREVIOUS BUG: The old implementation used `entry.notional` for sells without
 * clamping to the held position. If a sell entry had more shares than held
 * (e.g., BUY 100 then SELL 120), the old code credited cash for all 120 shares,
 * creating phantom money. The position reducer correctly clamped to 100, but
 * cash accounting did not, causing a divergence between position PnL and cash.
 *
 * EXAMPLE:
 *   BUY 100 @ 0.50, SELL 120 @ 0.60
 *   OLD: cash = start - 50 + 72 = start + 22  (WRONG: 120 * 0.60 = 72)
 *   NEW: cash = start - 50 + 60 = start + 10  (CORRECT: clamp to 100, 100 * 0.60 = 60)
 */
export function computeCash(startingCash: number, entries: LedgerEntry[]): number {
  let cash = startingCash;

  // Track net shares per market:outcome to correctly clamp sell notional.
  // This mirrors the position reducer's clamping logic exactly.
  const positionShares = new Map<string, number>();

  for (const entry of entries) {
    const key = `${entry.marketId}:${entry.outcome}`;
    const held = positionShares.get(key) ?? 0;

    if (entry.side === 'BUY') {
      cash -= entry.shares * entry.price + entry.fee;
      positionShares.set(key, roundShares(held + entry.shares));
    } else {
      // SELL: clamp to held shares — cannot sell more than we own
      const closeShares = Math.min(held, entry.shares);
      if (closeShares <= EPSILON) continue;

      cash += closeShares * entry.price - entry.fee;
      positionShares.set(key, roundShares(Math.max(0, held - closeShares)));
    }
  }

  return cash;
}

// ---------------------------------------------------------------------------
// Unrealized PnL
// ---------------------------------------------------------------------------

/**
 * Compute unrealized PnL for a single position given a mark price.
 */
export function unrealizedPnl(position: ReducedPosition, markPrice: number): number {
  if (position.netShares <= EPSILON) return 0;
  return position.netShares * (markPrice - position.avgEntryPrice);
}

// ---------------------------------------------------------------------------
// Portfolio Valuation
// ---------------------------------------------------------------------------

/**
 * Compute full portfolio state from starting cash, ledger entries,
 * and current mark prices.
 *
 * markPrices: Map of "marketId:outcome" -> current price
 *
 * FIX-3: Uses fixed computeCash (clamp-aware) and fixed reducePosition (re-open aware).
 */
export function computePortfolio(
  startingCash: number,
  entries: LedgerEntry[],
  markPrices: Map<string, number>,
): PortfolioState {
  // 1. Group entries by market+outcome
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.marketId}:${entry.outcome}`;
    const arr = groups.get(key) ?? [];
    arr.push(entry);
    groups.set(key, arr);
  }

  // 2. Reduce each group into a position (uses fixed reducePosition with re-open handling)
  const positions: ReducedPosition[] = [];
  for (const [key, groupEntries] of groups) {
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) continue;
    const marketId = key.slice(0, separatorIndex);
    const outcome = key.slice(separatorIndex + 1);
    positions.push(reducePosition(marketId, outcome, groupEntries));
  }

  // 3. Compute cash (uses fixed computeCash with sell clamping)
  const cash = computeCash(startingCash, entries);

  // 4. Separate open vs closed
  const openPositions = positions.filter((p) => p.status === 'OPEN');
  const closedPositions = positions.filter((p) => p.status === 'CLOSED');

  // 5. Compute unrealized PnL from mark prices
  let totalUnrealizedPnl = 0;
  let grossExposure = 0;
  for (const pos of openPositions) {
    const key = `${pos.marketId}:${pos.outcome}`;
    const mark = markPrices.get(key) ?? pos.avgEntryPrice;
    totalUnrealizedPnl += unrealizedPnl(pos, mark);
    grossExposure += Math.abs(pos.netShares * mark);
  }

  // 6. Aggregate realized PnL
  const totalRealizedPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const totalFees = entries.reduce((sum, entry) => sum + entry.fee, 0);

  // 7. Net liquidation value
  const openMarketValue = openPositions.reduce((sum, pos) => {
    const key = `${pos.marketId}:${pos.outcome}`;
    const mark = markPrices.get(key) ?? pos.avgEntryPrice;
    return sum + pos.netShares * mark;
  }, 0);
  const netLiquidationValue = cash + openMarketValue;
  const netPnl = totalRealizedPnl + totalUnrealizedPnl - totalFees;
  const totalPnl = netPnl;

  return {
    cash,
    positions,
    openPositions,
    closedPositions,
    totalRealizedPnl,
    totalUnrealizedPnl,
    totalFees,
    grossExposure,
    netLiquidationValue,
    netPnl,
    totalPnl,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile ledger-derived state against externally-held state.
 *
 * FIX-4: Uses fixed computeCash (clamp-aware) so reconciliation
 * results are consistent with position state.
 *
 * @param startingCash  Original bankroll
 * @param entries       Full ordered trade ledger
 * @param actualCash    Cash value as stored in the DB
 * @param actualPositions  Position rows as stored in the DB
 */
export function reconcile(
  startingCash: number,
  entries: LedgerEntry[],
  actualCash: number,
  actualPositions: Array<{ marketId: string; outcome: string; netShares: number }>,
): ReconciliationResult {
  const errors: string[] = [];

  // 1. Compute expected cash from ledger (uses fixed computeCash)
  const cashExpected = computeCash(startingCash, entries);
  const cashDiff = Math.abs(cashExpected - actualCash);
  if (cashDiff > 0.01) {
    errors.push(
      `Cash mismatch: ledger expects ${cashExpected.toFixed(4)} but DB has ${actualCash.toFixed(4)} (delta: ${cashDiff.toFixed(4)})`,
    );
  }

  // 2. Compute expected positions from ledger (uses fixed reducePosition)
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.marketId}:${entry.outcome}`;
    const arr = groups.get(key) ?? [];
    arr.push(entry);
    groups.set(key, arr);
  }

  const expectedPositions = new Map<string, ReducedPosition>();
  for (const [key, groupEntries] of groups) {
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) continue;
    const marketId = key.slice(0, separatorIndex);
    const outcome = key.slice(separatorIndex + 1);
    const pos = reducePosition(marketId, outcome, groupEntries);
    if (pos.netShares > EPSILON) {
      expectedPositions.set(key, pos);
    }
  }

  // 3. Compare positions
  const positionMismatches: ReconciliationResult['positionMismatches'] = [];

  // Check actual positions against expected
  const actualByKey = new Map(actualPositions.map((p) => [`${p.marketId}:${p.outcome}`, p]));

  for (const [key, expected] of expectedPositions) {
    const actual = actualByKey.get(key);
    if (!actual) {
      positionMismatches.push({
        marketId: expected.marketId,
        outcome: expected.outcome,
        ledgerShares: expected.netShares,
        positionShares: 0,
      });
      errors.push(
        `Position ${key}: ledger expects ${expected.netShares.toFixed(8)} shares but DB has no record`,
      );
    } else {
      const diff = Math.abs(expected.netShares - actual.netShares);
      if (diff > EPSILON) {
        positionMismatches.push({
          marketId: expected.marketId,
          outcome: expected.outcome,
          ledgerShares: expected.netShares,
          positionShares: actual.netShares,
        });
        errors.push(
          `Position ${key}: ledger expects ${expected.netShares.toFixed(8)} shares but DB has ${actual.netShares.toFixed(8)}`,
        );
      }
    }
  }

  // Check for DB positions that shouldn't exist
  for (const [key, actual] of actualByKey) {
    if (actual.netShares > EPSILON && !expectedPositions.has(key)) {
      positionMismatches.push({
        marketId: actual.marketId,
        outcome: actual.outcome,
        ledgerShares: 0,
        positionShares: actual.netShares,
      });
      errors.push(
        `Position ${key}: DB has ${actual.netShares.toFixed(8)} shares but ledger expects 0`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    cashExpected,
    cashActual: actualCash,
    positionMismatches,
  };
}

// ---------------------------------------------------------------------------
// Per-Market Trade History (NEW — supports UI position history popup)
// ---------------------------------------------------------------------------

export interface MarketTradeHistoryEntry {
  id: string;
  timestamp: Date;
  action: string;
  side: TradeSide;
  shares: number;
  price: number;
  fee: number;
  realizedPnl: number;
  netSharesAfter: number;
  avgEntryPriceAfter: number;
}

/**
 * Compute a detailed per-trade history for a single market:outcome position.
 *
 * Each row shows:
 *   - timestamp, action, side, shares, price
 *   - realized PnL for that specific trade
 *   - running position state (netShares, avgEntryPrice) after the trade
 *
 * This powers the position history popup in the UI.
 */
export function computeMarketTradeHistory(
  marketId: string,
  outcome: string,
  entries: LedgerEntry[],
): MarketTradeHistoryEntry[] {
  const history: MarketTradeHistoryEntry[] = [];
  let netShares = 0;
  let avgEntryPrice = 0;

  for (const entry of entries) {
    let tradeRealizedPnl = 0;

    if (entry.side === 'BUY') {
      // Re-open handling
      if (netShares <= EPSILON) {
        avgEntryPrice = 0;
      }
      const newTotal = netShares + entry.shares;
      if (newTotal > 0) {
        avgEntryPrice = (netShares * avgEntryPrice + entry.shares * entry.price) / newTotal;
      }
      netShares = roundShares(newTotal);
    } else {
      const closeShares = Math.min(netShares, entry.shares);
      if (closeShares > EPSILON) {
        tradeRealizedPnl = closeShares * (entry.price - avgEntryPrice);
        netShares = roundShares(Math.max(0, netShares - closeShares));
        if (netShares <= EPSILON) {
          netShares = 0;
        }
      }
    }

    history.push({
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.action,
      side: entry.side,
      shares: entry.shares,
      price: entry.price,
      fee: entry.fee,
      realizedPnl: tradeRealizedPnl,
      netSharesAfter: netShares,
      avgEntryPriceAfter: avgEntryPrice,
    });
  }

  return history;
}

// ---------------------------------------------------------------------------
// Per-Market Performance Summary (NEW — supports history view)
// ---------------------------------------------------------------------------

export interface MarketPerformanceSummary {
  marketId: string;
  outcome: string;
  totalInvested: number;
  totalReturned: number;
  realizedPnl: number;
  fees: number;
  currentNetShares: number;
  avgEntryPrice: number;
  status: 'OPEN' | 'CLOSED';
  tradeCount: number;
  buyCount: number;
  sellCount: number;
}

/**
 * Compute per-market performance summaries for all positions in a ledger.
 *
 * Each summary shows:
 *   - total $ invested (sum of buy notionals + fees)
 *   - total $ returned (sum of sell notionals - fees)
 *   - realized PnL (gross, before fees)
 *   - total fees paid
 *   - current position size
 *   - trade counts
 *
 * This powers the history view in the UI.
 */
export function computeMarketSummaries(entries: LedgerEntry[]): MarketPerformanceSummary[] {
  // Group entries by market+outcome
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.marketId}:${entry.outcome}`;
    const arr = groups.get(key) ?? [];
    arr.push(entry);
    groups.set(key, arr);
  }

  const summaries: MarketPerformanceSummary[] = [];

  for (const [key, groupEntries] of groups) {
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) continue;
    const marketId = key.slice(0, separatorIndex);
    const outcome = key.slice(separatorIndex + 1);

    const pos = reducePosition(marketId, outcome, groupEntries);

    let totalInvested = 0;
    let totalReturned = 0;
    let fees = 0;
    let buyCount = 0;
    let sellCount = 0;
    let posTracker = 0; // track shares for clamping

    for (const entry of groupEntries) {
      if (entry.side === 'BUY') {
        totalInvested += entry.shares * entry.price + entry.fee;
        fees += entry.fee;
        posTracker = roundShares(posTracker + entry.shares);
        buyCount++;
      } else {
        const closeShares = Math.min(posTracker, entry.shares);
        if (closeShares > EPSILON) {
          totalReturned += closeShares * entry.price - entry.fee;
          posTracker = roundShares(Math.max(0, posTracker - closeShares));
        }
        fees += entry.fee;
        sellCount++;
      }
    }

    summaries.push({
      marketId,
      outcome,
      totalInvested,
      totalReturned,
      realizedPnl: pos.realizedPnl,
      fees,
      currentNetShares: pos.netShares,
      avgEntryPrice: pos.avgEntryPrice,
      status: pos.status,
      tradeCount: groupEntries.length,
      buyCount,
      sellCount,
    });
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Paper Fill Simulation (unchanged — re-exported for backward compatibility)
// ---------------------------------------------------------------------------

export interface PaperFillInput {
  strategyId: string;
  marketId: string;
  outcome: string;
  side: TradeSide;
  shares: number;
  price: number;
  fee?: number;
  slippage?: number;
  sourceEventId?: string | null;
}

export interface PaperFillResult {
  feePaid: number;
  realizedDelta: number;
}

/**
 * Apply a paper fill. This is called by the execution module.
 * The actual DB persistence is handled by the caller.
 * This function only computes the fee and realized delta.
 */
export async function applyPaperFill(input: PaperFillInput): Promise<PaperFillResult> {
  const fee = input.fee ?? 0;
  // For BUY, realized delta is always 0 (we're opening/increasing a position)
  // For SELL, the realized delta is computed by the caller after position reduction
  return {
    feePaid: fee,
    realizedDelta: 0,
  };
}
