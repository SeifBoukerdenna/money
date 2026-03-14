import { prisma } from '../lib/prisma.js';

export type SmartCopyFilterResult = {
  allowed: boolean;
  reasons: Array<{ code: string; message: string }>;
};

export async function evaluateSmartCopyFilters(input: {
  strategyId: string;
  walletId: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  sourceTradeUsd: number;
}): Promise<SmartCopyFilterResult> {
  const reasons: Array<{ code: string; message: string }> = [];
  const config = await prisma.smartCopyStrategyConfig.findUnique({
    where: { strategyId: input.strategyId },
  });
  if (!config) {
    return { allowed: true, reasons };
  }

  if (config.minSourceTradeUsd && input.sourceTradeUsd < Number(config.minSourceTradeUsd)) {
    reasons.push({ code: 'MIN_SOURCE_TRADE_USD', message: 'Source trade below minimum threshold' });
  }

  if (config.ignoreExitTrades && input.side === 'SELL') {
    reasons.push({
      code: 'IGNORE_EXIT_TRADES',
      message: 'Exit trades are disabled for this strategy',
    });
  }

  if (config.firstEntryOnly && input.side === 'BUY') {
    const priorEntries = await prisma.tradeEvent.count({
      where: {
        walletId: input.walletId,
        marketId: input.marketId,
        side: 'BUY',
      },
    });
    if (priorEntries > 1) {
      reasons.push({
        code: 'FIRST_ENTRY_ONLY',
        message: 'Only first entry into market is allowed',
      });
    }
  }

  if (config.copyClustersOnly) {
    const cluster = await prisma.clusterSignal.findFirst({
      where: {
        marketId: input.marketId,
        side: input.side,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!cluster) {
      reasons.push({ code: 'CLUSTER_ONLY', message: 'Trade is not part of a cluster signal' });
    }
  }

  if (config.profitableWalletsOnly) {
    const latestSnapshot = await prisma.walletAnalyticsSnapshot.findFirst({
      where: { walletId: input.walletId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latestSnapshot || Number(latestSnapshot.realizedPnl) <= 0) {
      reasons.push({
        code: 'PROFITABLE_WALLETS_ONLY',
        message: 'Wallet is not profitable in latest snapshot',
      });
    }
  }

  if (config.topRankedWalletsOnly) {
    const latest = await prisma.walletAnalyticsSnapshot.findFirst({
      where: { walletId: input.walletId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      reasons.push({ code: 'TOP_RANK_ONLY', message: 'No leaderboard metrics for wallet' });
    } else {
      if (config.topRankMinWinRate && Number(latest.winRate) < Number(config.topRankMinWinRate)) {
        reasons.push({
          code: 'TOP_RANK_WINRATE',
          message: 'Wallet win rate below top rank minimum',
        });
      }
      if (
        config.topRankMinSharpeLike &&
        Number(latest.sharpeLike) < Number(config.topRankMinSharpeLike)
      ) {
        reasons.push({ code: 'TOP_RANK_SHARPE', message: 'Wallet sharpe-like below threshold' });
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
