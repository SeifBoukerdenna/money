/**
 * money-utils.ts — Epsilon-based money normalization.
 * Prevents +$0.00 / -$0.00 from floating-point drift.
 */

export const MONEY_EPSILON = 1e-9;

export function normalizeMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value) < MONEY_EPSILON ? 0 : value;
}

export type CloseClassification = 'WIN' | 'LOSS' | 'BREAKEVEN';

export function classifyClose(realizedPnl: number): CloseClassification {
  const n = normalizeMoney(realizedPnl);
  if (n > 0) return 'WIN';
  if (n < 0) return 'LOSS';
  return 'BREAKEVEN';
}
