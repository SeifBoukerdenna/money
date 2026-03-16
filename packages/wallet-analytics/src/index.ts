export type WalletTrade = {
  walletId: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fee?: number;
  tradedAt: string;
};

export const WIN_RATE_DEFINITION = 'NET_OF_FEES_PER_CLOSED_POSITION' as const;

export type WalletAnalytics = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossWinRate: number;
  winRateDefinition: string;
  averageEntryPrice: number;
  averageExitPrice: number;
  averageHoldTimeSeconds: number;
  profitFactor: number;
  realizedPnl: number;
  unrealizedPnl: number;
  maxDrawdown: number;
  bestTrade: number;
  worstTrade: number;
  marketDiversification: number;
  tradeFrequencyPerDay: number;
  avgTradeSize: number;
  marketsTraded: number;
  sharpeLike: number;
  tradeAccuracy: number;
};

type PositionState = {
  size: number;
  avgPrice: number;
  openAt: number;
};

export function computeWalletAnalytics(trades: WalletTrade[]): WalletAnalytics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      grossWinRate: 0,
      winRateDefinition: WIN_RATE_DEFINITION,
      averageEntryPrice: 0,
      averageExitPrice: 0,
      averageHoldTimeSeconds: 0,
      profitFactor: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      maxDrawdown: 0,
      bestTrade: 0,
      worstTrade: 0,
      marketDiversification: 0,
      tradeFrequencyPerDay: 0,
      avgTradeSize: 0,
      marketsTraded: 0,
      sharpeLike: 0,
      tradeAccuracy: 0,
    };
  }

  const sorted = [...trades].sort(
    (a, b) => new Date(a.tradedAt).getTime() - new Date(b.tradedAt).getTime(),
  );
  const positions = new Map<string, PositionState>();
  const realizedSeries: number[] = [];
  const realizedGrossSeries: number[] = [];
  const holdTimes: number[] = [];
  let realizedPnl = 0;
  let entryPriceSum = 0;
  let entryCount = 0;
  let exitPriceSum = 0;
  let exitCount = 0;
  let bestTrade = -Infinity;
  let worstTrade = Infinity;
  let equityPeak = 0;
  let maxDrawdown = 0;
  const marketSet = new Set<string>();
  const tradeSizes: number[] = [];

  for (const trade of sorted) {
    marketSet.add(trade.marketId);
    tradeSizes.push(trade.size * trade.price);
    const key = `${trade.marketId}`;
    const now = new Date(trade.tradedAt).getTime();
    const state = positions.get(key) ?? { size: 0, avgPrice: 0, openAt: now };

    if (trade.side === 'BUY') {
      entryPriceSum += trade.price;
      entryCount += 1;
      const newSize = state.size + trade.size;
      const newAvg =
        newSize > 0 ? (state.size * state.avgPrice + trade.size * trade.price) / newSize : 0;
      positions.set(key, {
        size: newSize,
        avgPrice: newAvg,
        openAt: state.size === 0 ? now : state.openAt,
      });
    } else {
      exitPriceSum += trade.price;
      exitCount += 1;
      const closeSize = Math.min(state.size, trade.size);
      const pnlGross = closeSize * (trade.price - state.avgPrice);
      const pnl = pnlGross - Number(trade.fee ?? 0);
      realizedPnl += pnl;
      realizedSeries.push(pnl);
      realizedGrossSeries.push(pnlGross);
      bestTrade = Math.max(bestTrade, pnl);
      worstTrade = Math.min(worstTrade, pnl);
      if (closeSize > 0) {
        holdTimes.push((now - state.openAt) / 1000);
      }
      const remaining = Math.max(0, state.size - closeSize);
      positions.set(key, { size: remaining, avgPrice: state.avgPrice, openAt: state.openAt });
      equityPeak = Math.max(equityPeak, realizedPnl);
      const drawdown = equityPeak - realizedPnl;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
  }

  const wins = realizedSeries.filter((value) => value > 0).length;
  const losses = realizedSeries.filter((value) => value < 0).length;
  const grossWins = realizedGrossSeries.filter((value) => value > 0).length;
  const grossLosses = realizedGrossSeries.filter((value) => value < 0).length;
  const grossProfit = realizedSeries
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const grossLossAbs = Math.abs(
    realizedSeries.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );

  const start = new Date(sorted[0]?.tradedAt ?? Date.now()).getTime();
  const end = new Date(sorted.at(-1)?.tradedAt ?? Date.now()).getTime();
  const days = Math.max(1 / 24, (end - start) / 86400000);
  const average = realizedSeries.length
    ? realizedSeries.reduce((sum, value) => sum + value, 0) / realizedSeries.length
    : 0;
  const variance = realizedSeries.length
    ? realizedSeries.reduce((sum, value) => sum + (value - average) ** 2, 0) / realizedSeries.length
    : 0;
  const sharpeLike = variance > 0 ? average / Math.sqrt(variance) : 0;

  return {
    totalTrades: sorted.length,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    grossWinRate: grossWins + grossLosses > 0 ? grossWins / (grossWins + grossLosses) : 0,
    winRateDefinition: WIN_RATE_DEFINITION,
    averageEntryPrice: entryCount > 0 ? entryPriceSum / entryCount : 0,
    averageExitPrice: exitCount > 0 ? exitPriceSum / exitCount : 0,
    averageHoldTimeSeconds:
      holdTimes.length > 0
        ? holdTimes.reduce((sum, value) => sum + value, 0) / holdTimes.length
        : 0,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit,
    realizedPnl,
    unrealizedPnl: 0,
    maxDrawdown,
    bestTrade: bestTrade === -Infinity ? 0 : bestTrade,
    worstTrade: worstTrade === Infinity ? 0 : worstTrade,
    marketDiversification: marketSet.size,
    tradeFrequencyPerDay: sorted.length / days,
    avgTradeSize: tradeSizes.length
      ? tradeSizes.reduce((sum, value) => sum + value, 0) / tradeSizes.length
      : 0,
    marketsTraded: marketSet.size,
    sharpeLike,
    tradeAccuracy: wins + losses > 0 ? wins / (wins + losses) : 0,
  };
}
