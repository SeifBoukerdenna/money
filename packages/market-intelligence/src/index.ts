export type MarketTrade = {
  marketId: string;
  walletId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
};

export type MarketIntel = {
  marketId: string;
  totalBuyVolume: number;
  totalSellVolume: number;
  uniqueWallets: number;
  netSentimentScore: number;
  buyPressure: number;
  sellPressure: number;
};

export function computeMarketIntelligence(trades: MarketTrade[]): MarketIntel[] {
  const buckets = new Map<string, { buy: number; sell: number; wallets: Set<string> }>();
  for (const trade of trades) {
    const notional = trade.size * trade.price;
    const bucket = buckets.get(trade.marketId) ?? { buy: 0, sell: 0, wallets: new Set<string>() };
    if (trade.side === 'BUY') {
      bucket.buy += notional;
    } else {
      bucket.sell += notional;
    }
    bucket.wallets.add(trade.walletId);
    buckets.set(trade.marketId, bucket);
  }

  return Array.from(buckets.entries()).map(([marketId, bucket]) => {
    const total = bucket.buy + bucket.sell;
    return {
      marketId,
      totalBuyVolume: bucket.buy,
      totalSellVolume: bucket.sell,
      uniqueWallets: bucket.wallets.size,
      netSentimentScore: total > 0 ? (bucket.buy - bucket.sell) / total : 0,
      buyPressure: total > 0 ? bucket.buy / total : 0,
      sellPressure: total > 0 ? bucket.sell / total : 0,
    };
  });
}
