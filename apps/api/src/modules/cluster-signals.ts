import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { publishEvent } from './event-stream.js';

function detectTradeCluster(
  trades: Array<{ walletId: string; marketId: string; side: 'BUY' | 'SELL'; tradedAt: string }>,
  thresholdWallets: number,
  windowSeconds: number,
) {
  if (trades.length === 0) {
    return null;
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.tradedAt).getTime() - new Date(b.tradedAt).getTime(),
  );
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) {
    return null;
  }
  const delta = (new Date(last.tradedAt).getTime() - new Date(first.tradedAt).getTime()) / 1000;
  const walletIds = Array.from(new Set(sorted.map((row) => row.walletId)));
  if (delta > windowSeconds || walletIds.length < thresholdWallets) {
    return null;
  }
  return {
    marketId: first.marketId,
    side: first.side,
    walletIds,
    firstTradeAt: first.tradedAt,
    lastTradeAt: last.tradedAt,
    windowSeconds,
  };
}

export async function detectAndPersistClusterSignal(triggerTradeEventId: string): Promise<void> {
  const trigger = await prisma.tradeEvent.findUnique({ where: { id: triggerTradeEventId } });
  if (!trigger) {
    return;
  }

  const windowStart = new Date(trigger.tradedAt.getTime() - config.CLUSTER_WINDOW_SECONDS * 1000);
  const candidates = await prisma.tradeEvent.findMany({
    where: {
      marketId: trigger.marketId,
      side: trigger.side,
      tradedAt: { gte: windowStart, lte: trigger.tradedAt },
    },
    include: {
      wallet: true,
    },
  });

  const cluster = detectTradeCluster(
    candidates.map((row: (typeof candidates)[number]) => ({
      walletId: row.walletId,
      marketId: row.marketId,
      side: row.side,
      tradedAt: row.tradedAt.toISOString(),
    })),
    config.CLUSTER_THRESHOLD_WALLETS,
    config.CLUSTER_WINDOW_SECONDS,
  );

  if (!cluster) {
    return;
  }

  const eventKey = `${cluster.marketId}:${cluster.side}:${cluster.firstTradeAt}:${cluster.lastTradeAt}:${cluster.walletIds.sort().join('-')}`;

  await prisma.clusterSignal.upsert({
    where: { eventKey },
    update: {},
    create: {
      marketId: cluster.marketId,
      side: cluster.side,
      walletIdsJson: cluster.walletIds,
      thresholdWallets: cluster.walletIds.length,
      windowSeconds: cluster.windowSeconds,
      firstTradeAt: new Date(cluster.firstTradeAt),
      lastTradeAt: new Date(cluster.lastTradeAt),
      eventKey,
      triggerTradeEventId,
    },
  });

  await publishEvent('CLUSTER_SIGNAL', {
    marketId: cluster.marketId,
    side: cluster.side,
    walletIds: cluster.walletIds,
    firstTradeAt: cluster.firstTradeAt,
    lastTradeAt: cluster.lastTradeAt,
    windowSeconds: cluster.windowSeconds,
  });
}
