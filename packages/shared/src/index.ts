import { z } from 'zod';

export const appModeSchema = z.enum(['PAPER', 'LIVE']);
export type AppMode = z.infer<typeof appModeSchema>;

export const sideSchema = z.enum(['BUY', 'SELL']);
export type Side = z.infer<typeof sideSchema>;

export const fillStrategySchema = z.enum([
  'AGGRESSIVE_LIMIT',
  'PASSIVE_LIMIT',
  'MIDPOINT_FALLBACK',
]);
export type FillStrategy = z.infer<typeof fillStrategySchema>;

export const walletSchema = z.object({
  id: z.string().uuid(),
  address: z.string().min(4),
  label: z.string().min(1),
  enabled: z.boolean(),
});
export type Wallet = z.infer<typeof walletSchema>;

export const marketSchema = z.object({
  id: z.string(),
  slug: z.string(),
  question: z.string(),
  active: z.boolean(),
  bestBid: z.number().nonnegative(),
  bestAsk: z.number().nonnegative(),
  midpoint: z.number().nonnegative(),
  liquidity: z.number().nonnegative(),
  spreadBps: z.number().nonnegative(),
});
export type Market = z.infer<typeof marketSchema>;

export const positionSchema = z.object({
  id: z.string().uuid(),
  strategyId: z.string().uuid(),
  walletAddress: z.string(),
  marketId: z.string(),
  outcome: z.string(),
  size: z.number(),
  avgPrice: z.number().nonnegative(),
  realizedPnl: z.number(),
  unrealizedPnl: z.number(),
});
export type Position = z.infer<typeof positionSchema>;

export const tradeEventSchema = z.object({
  id: z.string().uuid(),
  sourceEventId: z.string(),
  sourceWalletAddress: z.string(),
  marketId: z.string(),
  outcome: z.string(),
  side: sideSchema,
  size: z.number().positive(),
  price: z.number().nonnegative(),
  tradedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
});
export type TradeEvent = z.infer<typeof tradeEventSchema>;

export const riskConfigSchema = z.object({
  id: z.string().uuid(),
  strategyId: z.string().uuid(),
  fixedDollar: z.number().nonnegative().nullable(),
  pctSourceSize: z.number().min(0).max(1).nullable(),
  pctBankroll: z.number().min(0).max(1).nullable(),
  maxExposure: z.number().nonnegative(),
  perMarketMaxAllocation: z.number().nonnegative(),
  dailyLossCap: z.number().nonnegative(),
  maxSlippageBps: z.number().nonnegative(),
  minLiquidity: z.number().nonnegative(),
  maxSpreadBps: z.number().nonnegative(),
  inverseMode: z.boolean(),
  copyBuys: z.boolean(),
  copySells: z.boolean(),
  cooldownSeconds: z.number().int().nonnegative(),
  fillStrategy: fillStrategySchema,
});
export type RiskConfig = z.infer<typeof riskConfigSchema>;

export const decisionReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
  data: z.record(z.any()).optional(),
});
export type DecisionReason = z.infer<typeof decisionReasonSchema>;

export const copyOrderDecisionSchema = z.object({
  id: z.string().uuid(),
  strategyId: z.string().uuid(),
  eventId: z.string().uuid(),
  action: z.enum(['EXECUTE', 'SKIP']),
  side: sideSchema,
  orderSize: z.number().nonnegative(),
  limitPrice: z.number().nonnegative(),
  reasons: z.array(decisionReasonSchema),
  idempotencyKey: z.string(),
  createdAt: z.string().datetime(),
});
export type CopyOrderDecision = z.infer<typeof copyOrderDecisionSchema>;

export const executionSchema = z.object({
  id: z.string().uuid(),
  decisionId: z.string().uuid(),
  mode: appModeSchema,
  status: z.enum(['SUBMITTED', 'FILLED', 'FAILED', 'SKIPPED']),
  externalOrderId: z.string().nullable(),
  filledSize: z.number().nonnegative(),
  avgFillPrice: z.number().nonnegative(),
  feePaid: z.number().nonnegative(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Execution = z.infer<typeof executionSchema>;

export const portfolioSnapshotSchema = z.object({
  id: z.string().uuid(),
  strategyId: z.string().uuid(),
  mode: appModeSchema,
  bankroll: z.number(),
  exposure: z.number(),
  realizedPnl: z.number(),
  unrealizedPnl: z.number(),
  openPositions: z.number().int().nonnegative(),
  copiedTradesToday: z.number().int().nonnegative(),
  skippedTradesToday: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;

export type MetricsEvent = {
  name: string;
  value: number;
  labels?: Record<string, string>;
};
