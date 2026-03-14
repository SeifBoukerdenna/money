import { prisma } from '../lib/prisma.js';
import { publishEvent } from './event-stream.js';

function computeMarketIntelligence(
  trades: Array<{
    marketId: string;
    walletId: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
  }>,
) {
  const buckets = new Map<string, { buy: number; sell: number; wallets: Set<string> }>();
  for (const trade of trades) {
    const bucket = buckets.get(trade.marketId) ?? { buy: 0, sell: 0, wallets: new Set<string>() };
    const notional = trade.size * trade.price;
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

export async function refreshMarketIntelligenceSnapshots(): Promise<void> {
  const trades = await prisma.tradeEvent.findMany({
    include: { wallet: true },
    orderBy: { tradedAt: 'desc' },
    take: 5000,
  });
  const intelligence = computeMarketIntelligence(
    trades.map((row: (typeof trades)[number]) => ({
      marketId: row.marketId,
      walletId: row.walletId,
      side: row.side,
      size: Number(row.size),
      price: Number(row.price),
    })),
  );

  for (const metric of intelligence) {
    await prisma.marketIntelligenceSnapshot.create({
      data: {
        marketId: metric.marketId,
        totalBuyVolume: metric.totalBuyVolume,
        totalSellVolume: metric.totalSellVolume,
        uniqueWallets: metric.uniqueWallets,
        netSentimentScore: metric.netSentimentScore,
        buyPressure: metric.buyPressure,
        sellPressure: metric.sellPressure,
      },
    });

    await publishEvent('MARKET_SENTIMENT_UPDATE', {
      marketId: metric.marketId,
      totalBuyVolume: metric.totalBuyVolume,
      totalSellVolume: metric.totalSellVolume,
      uniqueWallets: metric.uniqueWallets,
      netSentimentScore: metric.netSentimentScore,
      buyPressure: metric.buyPressure,
      sellPressure: metric.sellPressure,
    });
  }
}

export async function getLatestMarketIntelligence(limit = 100) {
  const rows = await prisma.marketIntelligenceSnapshot.findMany({
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });
  const latestByMarket = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByMarket.has(row.marketId) && latestByMarket.size < limit) {
      latestByMarket.set(row.marketId, row);
    }
  }
  return Array.from(latestByMarket.values()).map((row) => ({
    marketId: row.marketId,
    totalBuyVolume: Number(row.totalBuyVolume),
    totalSellVolume: Number(row.totalSellVolume),
    uniqueWallets: row.uniqueWallets,
    netSentimentScore: Number(row.netSentimentScore),
    buyPressure: Number(row.buyPressure),
    sellPressure: Number(row.sellPressure),
    createdAt: row.createdAt,
  }));
}
