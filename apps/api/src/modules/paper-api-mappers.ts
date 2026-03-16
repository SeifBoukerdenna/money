export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export type TradeAttributionInput = {
  id: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  simulatedPrice: number;
  simulatedShares: number;
  feeApplied: number;
};

export type TradeAttribution = {
  eventRealizedPnlGrossByTradeId: Map<string, number>;
  cumulativeRealizedPnlGrossByPositionKey: Map<string, number>;
  feeByTradeId: Map<string, number>;
};

export function buildTradeAttribution(trades: TradeAttributionInput[]): TradeAttribution {
  const eventRealizedPnlGrossByTradeId = new Map<string, number>();
  const cumulativeRealizedPnlGrossByPositionKey = new Map<string, number>();
  const feeByTradeId = new Map<string, number>();
  const runningNetSharesByKey = new Map<string, number>();
  const runningAvgEntryByKey = new Map<string, number>();

  for (const trade of trades) {
    const key = `${trade.marketId}:${trade.outcome.toUpperCase()}`;
    const held = runningNetSharesByKey.get(key) ?? 0;
    const avgEntry = runningAvgEntryByKey.get(key) ?? 0;
    const shares = Math.max(0, Number(trade.simulatedShares));
    const price = Number(trade.simulatedPrice);
    const fee = Number(trade.feeApplied);

    if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0) {
      continue;
    }

    if (trade.side === 'BUY') {
      const nextShares = held + shares;
      const nextAvg = nextShares > 0 ? (held * avgEntry + shares * price) / nextShares : avgEntry;
      runningNetSharesByKey.set(key, nextShares);
      runningAvgEntryByKey.set(key, nextAvg);
      eventRealizedPnlGrossByTradeId.set(trade.id, 0);
      feeByTradeId.set(trade.id, fee);
      continue;
    }

    const closeShares = Math.min(held, shares);
    const eventRealized = closeShares > 0 ? closeShares * (price - avgEntry) : 0;
    const nextShares = Math.max(0, held - closeShares);

    runningNetSharesByKey.set(key, nextShares);
    if (nextShares === 0) {
      runningAvgEntryByKey.set(key, 0);
    }

    const cumulative = (cumulativeRealizedPnlGrossByPositionKey.get(key) ?? 0) + eventRealized;
    cumulativeRealizedPnlGrossByPositionKey.set(key, cumulative);
    eventRealizedPnlGrossByTradeId.set(trade.id, eventRealized);
    feeByTradeId.set(trade.id, fee);
  }

  return {
    eventRealizedPnlGrossByTradeId,
    cumulativeRealizedPnlGrossByPositionKey,
    feeByTradeId,
  };
}
