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
  grossExposure: number;
  netLiquidationValue: number;
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
 *   - Realized PnL = (sell_price - avg_entry_price) * shares_sold - fees_on_sell
 *   - Net shares cannot go below zero (clamped with warning)
 *   - Position is CLOSED when net shares reach zero
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
      const newTotal = netShares + entry.shares;
      if (newTotal > 0) {
        // Weighted average: (old_shares * old_avg + new_shares * new_price) / total
        avgEntryPrice = (netShares * avgEntryPrice + entry.shares * entry.price) / newTotal;
      }
      netShares = roundShares(newTotal);
      totalCostBasis += entry.shares * entry.price + entry.fee;

      if (openedAt === null) {
        openedAt = entry.timestamp;
      }
    } else {
      // SELL
      const closeShares = Math.min(netShares, entry.shares);
      if (closeShares <= EPSILON) continue;

      // Realized PnL: (sell_price - avg_entry) * shares - fee
      realizedPnl += closeShares * (entry.price - avgEntryPrice) - entry.fee;
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
 *   SELL: cash += (shares * price) - fee
 *
 * This is the canonical cash computation. The DB value of currentCash must
 * match this at all times. If it doesn't, we have a reconciliation error.
 */
export function computeCash(startingCash: number, entries: LedgerEntry[]): number {
  let cash = startingCash;
  for (const entry of entries) {
    if (entry.side === 'BUY') {
      cash -= entry.notional + entry.fee;
    } else {
      cash += entry.notional - entry.fee;
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

  // 2. Reduce each group into a position
  const positions: ReducedPosition[] = [];
  for (const [key, groupEntries] of groups) {
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) continue;
    const marketId = key.slice(0, separatorIndex);
    const outcome = key.slice(separatorIndex + 1);
    positions.push(reducePosition(marketId, outcome, groupEntries));
  }

  // 3. Compute cash
  const cash = computeCash(startingCash, entries);

  // 4. Separate open vs closed
  const openPositions = positions.filter((p) => p.status === 'OPEN');
  const closedPositions = positions.filter((p) => p.status === 'CLOSED');

  // 5. Compute PnL
  const totalRealizedPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0);

  let totalUnrealizedPnl = 0;
  let grossExposure = 0;
  for (const pos of openPositions) {
    const key = `${pos.marketId}:${pos.outcome}`;
    const mark = markPrices.get(key) ?? pos.avgEntryPrice;
    const uPnl = unrealizedPnl(pos, mark);
    totalUnrealizedPnl += uPnl;
    grossExposure += Math.abs(pos.netShares * mark);
  }

  // 6. Net liquidation value
  const openMarketValue = openPositions.reduce((sum, pos) => {
    const key = `${pos.marketId}:${pos.outcome}`;
    const mark = markPrices.get(key) ?? pos.avgEntryPrice;
    return sum + pos.netShares * mark;
  }, 0);
  const netLiquidationValue = cash + openMarketValue;
  const totalPnl = netLiquidationValue - startingCash;

  return {
    cash,
    positions,
    openPositions,
    closedPositions,
    totalRealizedPnl,
    totalUnrealizedPnl,
    grossExposure,
    netLiquidationValue,
    totalPnl,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Check invariants between a stored portfolio state and the ledger.
 *
 * Invariants:
 *   1. Cash = startingCash - Σ(buy outflows) + Σ(sell inflows) - Σ(fees)
 *   2. Each position's net shares = ledger-reduced shares
 *   3. NLV = cash + Σ(open_shares * mark_price)
 *   4. Closed positions have net_shares = 0
 */
export function reconcile(
  startingCash: number,
  entries: LedgerEntry[],
  storedCash: number,
  storedPositions: Array<{ marketId: string; outcome: string; netShares: number; status: string }>,
): ReconciliationResult {
  const errors: string[] = [];

  // 1. Check cash
  const expectedCash = computeCash(startingCash, entries);
  if (Math.abs(expectedCash - storedCash) > 0.01) {
    errors.push(
      `Cash mismatch: expected $${expectedCash.toFixed(4)}, stored $${storedCash.toFixed(4)}, diff $${(expectedCash - storedCash).toFixed(4)}`,
    );
  }

  // 2. Check positions
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.marketId}:${entry.outcome}`;
    const arr = groups.get(key) ?? [];
    arr.push(entry);
    groups.set(key, arr);
  }

  const positionMismatches: ReconciliationResult['positionMismatches'] = [];

  for (const stored of storedPositions) {
    const key = `${stored.marketId}:${stored.outcome}`;
    const groupEntries = groups.get(key) ?? [];
    const reduced = reducePosition(stored.marketId, stored.outcome, groupEntries);

    if (Math.abs(reduced.netShares - stored.netShares) > 0.0001) {
      positionMismatches.push({
        marketId: stored.marketId,
        outcome: stored.outcome,
        ledgerShares: reduced.netShares,
        positionShares: stored.netShares,
      });
      errors.push(
        `Position ${stored.marketId}/${stored.outcome}: ledger has ${reduced.netShares.toFixed(4)} shares, stored has ${stored.netShares.toFixed(4)}`,
      );
    }

    // Check status consistency
    if (reduced.netShares <= EPSILON && stored.status === 'OPEN') {
      errors.push(
        `Position ${stored.marketId}/${stored.outcome}: has zero shares but status is OPEN`,
      );
    }
    if (reduced.netShares > EPSILON && stored.status === 'CLOSED') {
      errors.push(
        `Position ${stored.marketId}/${stored.outcome}: has ${reduced.netShares.toFixed(4)} shares but status is CLOSED`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    cashExpected: expectedCash,
    cashActual: storedCash,
    positionMismatches,
  };
}
