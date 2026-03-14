import { decideCopyOrder } from '@copytrader/risk-engine';
import { type RiskConfig, type TradeEvent } from '@copytrader/shared';

export type BacktestInput = {
  strategyId: string;
  riskConfig: RiskConfig;
  bankrollStart: number;
  events: TradeEvent[];
  marketById: Record<
    string,
    {
      bestBid: number;
      bestAsk: number;
      midpoint: number;
      spreadBps: number;
      liquidity: number;
      active: boolean;
      question: string;
      slug: string;
    }
  >;
};

export type BacktestResult = {
  totalReturn: number;
  maxDrawdown: number;
  sharpeLike: number;
  hitRate: number;
  averageHoldMinutes: number;
  bestMarket: string | null;
  worstMarket: string | null;
  executed: number;
  skipped: number;
};

export function runBacktest(input: BacktestInput): BacktestResult {
  let bankroll = input.bankrollStart;
  let equityPeak = bankroll;
  let maxDrawdown = 0;
  const pnlSeries: number[] = [];
  const marketPnL = new Map<string, number>();
  let wins = 0;
  let losses = 0;
  let executed = 0;
  let skipped = 0;
  let totalHoldMinutes = 0;

  for (const event of input.events) {
    const market = input.marketById[event.marketId];
    if (!market) {
      skipped += 1;
      continue;
    }
    const decision = decideCopyOrder({
      strategyId: input.strategyId,
      riskConfig: input.riskConfig,
      event,
      market: {
        id: event.marketId,
        slug: market.slug,
        question: market.question,
        active: market.active,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        midpoint: market.midpoint,
        liquidity: market.liquidity,
        spreadBps: market.spreadBps,
      },
      bankroll,
      currentExposure: 0,
      perMarketExposure: 0,
      dailyPnl: 0,
    });

    if (decision.action === 'SKIP') {
      skipped += 1;
      continue;
    }

    executed += 1;
    const edge = event.side === 'BUY' ? market.bestAsk - event.price : event.price - market.bestBid;
    const pnl = decision.orderSize * edge;
    bankroll += pnl;
    pnlSeries.push(pnl);
    totalHoldMinutes += 30;
    marketPnL.set(event.marketId, (marketPnL.get(event.marketId) ?? 0) + pnl);
    if (pnl >= 0) {
      wins += 1;
    } else {
      losses += 1;
    }
    equityPeak = Math.max(equityPeak, bankroll);
    const drawdown = equityPeak > 0 ? (equityPeak - bankroll) / equityPeak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const totalReturn =
    input.bankrollStart > 0 ? (bankroll - input.bankrollStart) / input.bankrollStart : 0;
  const hitRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const avg = pnlSeries.length > 0 ? pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length : 0;
  const variance =
    pnlSeries.length > 0 ? pnlSeries.reduce((a, b) => a + (b - avg) ** 2, 0) / pnlSeries.length : 0;
  const std = Math.sqrt(variance);
  const sharpeLike = std > 0 ? avg / std : 0;

  let bestMarket: string | null = null;
  let worstMarket: string | null = null;
  let bestValue = -Infinity;
  let worstValue = Infinity;
  for (const [marketId, pnl] of marketPnL.entries()) {
    if (pnl > bestValue) {
      bestValue = pnl;
      bestMarket = marketId;
    }
    if (pnl < worstValue) {
      worstValue = pnl;
      worstMarket = marketId;
    }
  }

  return {
    totalReturn,
    maxDrawdown,
    sharpeLike,
    hitRate,
    averageHoldMinutes: executed > 0 ? totalHoldMinutes / executed : 0,
    bestMarket,
    worstMarket,
    executed,
    skipped,
  };
}
