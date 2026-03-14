import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publishEvent } from './event-stream.js';
import { createPolymarketDataAdapter } from './polymarket.js';

const adapter = createPolymarketDataAdapter();

export async function reconcileWalletExposure(walletId: string, address: string): Promise<void> {
  try {
    const [openPositions, recentActivity] = await Promise.all([
      adapter.getWalletPositions(address, 'OPEN', 250),
      prisma.walletActivityEvent.findMany({
        where: {
          trackedWalletId: walletId,
          side: { in: ['BUY', 'SELL'] },
          shares: { not: null },
        },
        orderBy: { eventTimestamp: 'desc' },
        take: 3000,
      }),
    ]);

    const exposureByMarket = new Map<string, number>();
    for (const row of recentActivity) {
      if (!row.side || row.shares === null) {
        continue;
      }
      const direction = row.side === 'BUY' ? 1 : -1;
      const current = exposureByMarket.get(row.marketId) ?? 0;
      exposureByMarket.set(row.marketId, current + direction * Number(row.shares));
    }

    const mismatches: Array<{ marketId: string; activityShares: number; positionsShares: number }> =
      [];
    for (const position of openPositions) {
      const activityShares = exposureByMarket.get(position.conditionId) ?? 0;
      const delta = Math.abs(activityShares - position.size);
      if (delta > Math.max(5, position.size * 0.1)) {
        mismatches.push({
          marketId: position.conditionId,
          activityShares,
          positionsShares: position.size,
        });
      }
    }

    await prisma.watchedWallet.update({
      where: { id: walletId },
      data: { lastPositionsSyncedAt: new Date() },
    });

    if (mismatches.length > 0) {
      await prisma.auditLog.create({
        data: {
          category: 'RECONCILIATION',
          entityId: walletId,
          action: 'MISMATCH',
          payload: {
            walletId,
            address,
            mismatches,
            checkedAt: new Date().toISOString(),
          },
        },
      });

      await publishEvent(
        'MARKET_SENTIMENT_UPDATE',
        {
          category: 'RECONCILIATION',
          walletId,
          mismatches,
        },
        walletId,
      );

      logger.warn({ walletId, mismatches: mismatches.length }, 'wallet reconciliation mismatch');
    }
  } catch (error) {
    logger.warn({ walletId, error }, 'wallet reconciliation failed');
  }
}
