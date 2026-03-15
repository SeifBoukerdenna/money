import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';

const ANALYTICS_RETENTION_ROWS = Math.max(48, config.WALLET_ANALYTICS_RETENTION_ROWS);

async function pruneWalletAnalyticsSnapshots(walletId: string): Promise<void> {
  const count = await prisma.walletAnalyticsSnapshot.count({ where: { walletId } });
  if (count <= ANALYTICS_RETENTION_ROWS + 24) {
    return;
  }
  const staleRows = await prisma.walletAnalyticsSnapshot.findMany({
    where: { walletId },
    orderBy: { createdAt: 'asc' },
    take: count - ANALYTICS_RETENTION_ROWS,
    select: { id: true },
  });
  if (staleRows.length === 0) {
    return;
  }
  await prisma.walletAnalyticsSnapshot.deleteMany({
    where: { id: { in: staleRows.map((row) => row.id) } },
  });
}

function computeWalletAnalytics(
  trades: Array<{
    walletId: string;
    marketId: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    tradedAt: string;
  }>,
) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
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
      sharpeLike: 0,
      tradeAccuracy: 0,
      avgTradeSize: 0,
      marketsTraded: 0,
    };
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.tradedAt).getTime() - new Date(b.tradedAt).getTime(),
  );
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  let bestTrade = -Infinity;
  let worstTrade = Infinity;
  let entries = 0;
  let exits = 0;
  let entrySum = 0;
  let exitSum = 0;
  let holdSum = 0;
  let holdCount = 0;
  const pnlSeries: number[] = [];
  const marketSet = new Set<string>();
  const sizes: number[] = [];
  const positions = new Map<string, { size: number; avgPrice: number; openAt: number }>();
  let equityPeak = 0;
  let maxDrawdown = 0;

  for (const trade of sorted) {
    marketSet.add(trade.marketId);
    sizes.push(trade.size * trade.price);
    const key = trade.marketId;
    const state = positions.get(key) ?? {
      size: 0,
      avgPrice: 0,
      openAt: new Date(trade.tradedAt).getTime(),
    };

    if (trade.side === 'BUY') {
      entries += 1;
      entrySum += trade.price;
      const newSize = state.size + trade.size;
      const avg =
        newSize > 0 ? (state.size * state.avgPrice + trade.size * trade.price) / newSize : 0;
      positions.set(key, {
        size: newSize,
        avgPrice: avg,
        openAt: state.size === 0 ? new Date(trade.tradedAt).getTime() : state.openAt,
      });
    } else {
      exits += 1;
      exitSum += trade.price;
      const closeSize = Math.min(state.size, trade.size);
      const pnl = closeSize * (trade.price - state.avgPrice);
      realizedPnl += pnl;
      pnlSeries.push(pnl);
      if (pnl > 0) wins += 1;
      if (pnl < 0) losses += 1;
      bestTrade = Math.max(bestTrade, pnl);
      worstTrade = Math.min(worstTrade, pnl);
      if (closeSize > 0) {
        holdSum += (new Date(trade.tradedAt).getTime() - state.openAt) / 1000;
        holdCount += 1;
      }
      positions.set(key, {
        size: Math.max(0, state.size - closeSize),
        avgPrice: state.avgPrice,
        openAt: state.openAt,
      });
      equityPeak = Math.max(equityPeak, realizedPnl);
      maxDrawdown = Math.max(maxDrawdown, equityPeak - realizedPnl);
    }
  }

  const avgPnl = pnlSeries.length ? pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length : 0;
  const variance = pnlSeries.length
    ? pnlSeries.reduce((a, b) => a + (b - avgPnl) ** 2, 0) / pnlSeries.length
    : 0;
  const grossProfit = pnlSeries.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const grossLossAbs = Math.abs(pnlSeries.filter((v) => v < 0).reduce((a, b) => a + b, 0));
  const start = new Date(sorted[0]?.tradedAt ?? Date.now()).getTime();
  const end = new Date(sorted.at(-1)?.tradedAt ?? Date.now()).getTime();
  const days = Math.max(1 / 24, (end - start) / 86400000);

  return {
    totalTrades: sorted.length,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    averageEntryPrice: entries > 0 ? entrySum / entries : 0,
    averageExitPrice: exits > 0 ? exitSum / exits : 0,
    averageHoldTimeSeconds: holdCount > 0 ? holdSum / holdCount : 0,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit,
    realizedPnl,
    unrealizedPnl: 0,
    maxDrawdown,
    bestTrade: bestTrade === -Infinity ? 0 : bestTrade,
    worstTrade: worstTrade === Infinity ? 0 : worstTrade,
    marketDiversification: marketSet.size,
    tradeFrequencyPerDay: sorted.length / days,
    sharpeLike: variance > 0 ? avgPnl / Math.sqrt(variance) : 0,
    tradeAccuracy: wins + losses > 0 ? wins / (wins + losses) : 0,
    avgTradeSize: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0,
    marketsTraded: marketSet.size,
  };
}

export async function refreshWalletAnalyticsSnapshots(): Promise<void> {
  const wallets = await prisma.watchedWallet.findMany({ where: { enabled: true } });

  for (const wallet of wallets) {
    const latestSnapshot = await prisma.walletAnalyticsSnapshot.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (
      latestSnapshot &&
      Date.now() - latestSnapshot.createdAt.getTime() < config.WALLET_ANALYTICS_INTERVAL_MS
    ) {
      continue;
    }

    const trades = await prisma.tradeEvent.findMany({
      where: { walletId: wallet.id },
      orderBy: { tradedAt: 'asc' },
      take: 3000,
    });

    const metrics = computeWalletAnalytics(
      trades.map((row: (typeof trades)[number]) => ({
        walletId: row.walletId,
        marketId: row.marketId,
        side: row.side,
        size: Number(row.size),
        price: Number(row.price),
        tradedAt: row.tradedAt.toISOString(),
      })),
    );

    await prisma.walletAnalyticsSnapshot.create({
      data: {
        walletId: wallet.id,
        totalTrades: metrics.totalTrades,
        wins: metrics.wins,
        losses: metrics.losses,
        winRate: metrics.winRate,
        averageEntryPrice: metrics.averageEntryPrice,
        averageExitPrice: metrics.averageExitPrice,
        averageHoldTime: metrics.averageHoldTimeSeconds,
        profitFactor: metrics.profitFactor,
        realizedPnl: metrics.realizedPnl,
        unrealizedPnl: metrics.unrealizedPnl,
        maxDrawdown: metrics.maxDrawdown,
        bestTrade: metrics.bestTrade,
        worstTrade: metrics.worstTrade,
        marketDiversification: metrics.marketDiversification,
        tradeFrequency: metrics.tradeFrequencyPerDay,
        sharpeLike: metrics.sharpeLike,
        tradeAccuracy: metrics.tradeAccuracy,
        avgTradeSize: metrics.avgTradeSize,
        marketsTraded: metrics.marketsTraded,
      },
    });

    await pruneWalletAnalyticsSnapshots(wallet.id);
  }
}

export async function getWalletLeaderboard(
  sortBy: 'pnl' | 'winRate' | 'sharpe' | 'accuracy' = 'pnl',
) {
  const snapshots = await prisma.walletAnalyticsSnapshot.findMany({
    orderBy: { createdAt: 'desc' },
    include: { wallet: true },
    take: 5000,
  });

  const latestByWallet = new Map<string, (typeof snapshots)[number]>();
  for (const row of snapshots) {
    if (!latestByWallet.has(row.walletId)) {
      latestByWallet.set(row.walletId, row);
    }
  }

  const rows = Array.from(latestByWallet.values()).map((row) => ({
    walletId: row.walletId,
    wallet: row.wallet.address,
    label: row.wallet.label,
    trades: row.totalTrades,
    winRate: Number(row.winRate),
    profit: Number(row.realizedPnl),
    avgTradeSize: Number(row.avgTradeSize),
    marketsTraded: row.marketsTraded,
    sharpeLike: Number(row.sharpeLike),
    tradeAccuracy: Number(row.tradeAccuracy),
  }));

  const scoreOf = (item: (typeof rows)[number]) => {
    if (sortBy === 'winRate') return item.winRate;
    if (sortBy === 'sharpe') return item.sharpeLike;
    if (sortBy === 'accuracy') return item.tradeAccuracy;
    return item.profit;
  };

  return rows.sort((a, b) => scoreOf(b) - scoreOf(a));
}
