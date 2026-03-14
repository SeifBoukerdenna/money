import {
  type CopyOrderDecision,
  type DecisionReason,
  type Market,
  type PortfolioSnapshot,
  type RiskConfig,
  type TradeEvent,
} from '@copytrader/shared';

export type DecisionInput = {
  strategyId: string;
  riskConfig: RiskConfig;
  market: Market;
  event: TradeEvent;
  bankroll: number;
  currentExposure: number;
  perMarketExposure: number;
  dailyPnl: number;
  lastTradeAtIso?: string;
};

function resolveOrderSize(input: DecisionInput): number {
  const { riskConfig, event, bankroll } = input;
  const options = [
    riskConfig.fixedDollar ?? 0,
    riskConfig.pctSourceSize ? event.size * riskConfig.pctSourceSize * event.price : 0,
    riskConfig.pctBankroll ? bankroll * riskConfig.pctBankroll : 0,
  ].filter((value) => value > 0);
  const notional = options.length > 0 ? Math.min(...options) : 0;
  return event.price > 0 ? notional / event.price : 0;
}

function determineLimitPrice(input: DecisionInput): number {
  const { riskConfig, market, event } = input;
  const slippageMultiplier = riskConfig.maxSlippageBps / 10000;
  if (riskConfig.fillStrategy === 'PASSIVE_LIMIT') {
    return event.side === 'BUY' ? market.bestBid : market.bestAsk;
  }
  if (riskConfig.fillStrategy === 'MIDPOINT_FALLBACK') {
    return market.midpoint > 0 ? market.midpoint : event.price;
  }
  return event.side === 'BUY'
    ? Math.min(1, market.bestAsk * (1 + slippageMultiplier))
    : Math.max(0, market.bestBid * (1 - slippageMultiplier));
}

export function decideCopyOrder(input: DecisionInput): CopyOrderDecision {
  const now = new Date();
  const reasons: DecisionReason[] = [];
  const side = input.riskConfig.inverseMode
    ? input.event.side === 'BUY'
      ? 'SELL'
      : 'BUY'
    : input.event.side;

  if (input.event.side === 'BUY' && !input.riskConfig.copyBuys) {
    reasons.push({ code: 'COPY_BUYS_DISABLED', message: 'Strategy does not copy buys' });
  }
  if (input.event.side === 'SELL' && !input.riskConfig.copySells) {
    reasons.push({ code: 'COPY_SELLS_DISABLED', message: 'Strategy does not copy sells' });
  }
  if (!input.market.active) {
    reasons.push({ code: 'MARKET_INACTIVE', message: 'Market is not tradable' });
  }
  if (input.market.liquidity < input.riskConfig.minLiquidity) {
    reasons.push({ code: 'LOW_LIQUIDITY', message: 'Market liquidity below threshold' });
  }
  if (input.market.spreadBps > input.riskConfig.maxSpreadBps) {
    reasons.push({ code: 'WIDE_SPREAD', message: 'Market spread exceeds allowed bps' });
  }
  if (-input.dailyPnl > input.riskConfig.dailyLossCap) {
    reasons.push({ code: 'DAILY_LOSS_CAP', message: 'Daily loss cap reached' });
  }

  if (input.lastTradeAtIso) {
    const lastTradeAt = new Date(input.lastTradeAtIso).getTime();
    if (Number.isFinite(lastTradeAt)) {
      const elapsed = Math.floor((now.getTime() - lastTradeAt) / 1000);
      if (elapsed < input.riskConfig.cooldownSeconds) {
        reasons.push({ code: 'COOLDOWN', message: 'Strategy cooldown active', data: { elapsed } });
      }
    }
  }

  const orderSize = resolveOrderSize(input);
  const limitPrice = determineLimitPrice(input);
  const notional = orderSize * limitPrice;

  if (orderSize <= 0 || !Number.isFinite(orderSize)) {
    reasons.push({ code: 'SIZE_ZERO', message: 'Calculated order size is zero' });
  }
  if (input.currentExposure + notional > input.riskConfig.maxExposure) {
    reasons.push({ code: 'MAX_EXPOSURE', message: 'Max strategy exposure exceeded' });
  }
  if (input.perMarketExposure + notional > input.riskConfig.perMarketMaxAllocation) {
    reasons.push({ code: 'PER_MARKET_CAP', message: 'Per-market cap exceeded' });
  }
  if (notional > input.bankroll) {
    reasons.push({ code: 'INSUFFICIENT_BUYING_POWER', message: 'Not enough bankroll' });
  }

  return {
    id: crypto.randomUUID(),
    strategyId: input.strategyId,
    eventId: input.event.id,
    action: reasons.length > 0 ? 'SKIP' : 'EXECUTE',
    side,
    orderSize,
    limitPrice,
    reasons,
    idempotencyKey: `${input.strategyId}:${input.event.sourceEventId}`,
    createdAt: now.toISOString(),
  };
}

export function summarizePortfolio(snapshot: PortfolioSnapshot): string {
  return [
    `bankroll=${snapshot.bankroll.toFixed(2)}`,
    `exposure=${snapshot.exposure.toFixed(2)}`,
    `realized=${snapshot.realizedPnl.toFixed(2)}`,
    `unrealized=${snapshot.unrealizedPnl.toFixed(2)}`,
  ].join(' ');
}
