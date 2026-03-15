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
      const key = row.conditionId ?? row.marketId;
      const current = exposureByMarket.get(key) ?? 0;
      exposureByMarket.set(key, current + direction * Number(row.shares));
    }

    const openPositionsByCondition = new Map<string, number>();
    for (const position of openPositions) {
      openPositionsByCondition.set(position.conditionId, position.size);
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

    const missingPositionCoverage: Array<{
      marketId: string;
      activityShares: number;
      positionsShares: number;
    }> = [];
    for (const [conditionId, activityShares] of exposureByMarket.entries()) {
      const absoluteShares = Math.abs(activityShares);
      if (absoluteShares < 1) {
        continue;
      }
      if (!openPositionsByCondition.has(conditionId)) {
        missingPositionCoverage.push({
          marketId: conditionId,
          activityShares,
          positionsShares: 0,
        });
      }
    }

    const issuesPayload = [
      ...mismatches.map((mismatch) => ({
        trackedWalletId: walletId,
        sourceName: 'POLYMARKET_DATA_API',
        issueType: 'POSITION_ACTIVITY_MISMATCH',
        severity: 'WARN',
        marketId: mismatch.marketId,
        conditionId: mismatch.marketId,
        expectedValue: {
          activityShares: mismatch.activityShares,
        },
        actualValue: {
          positionShares: mismatch.positionsShares,
        },
        notes: 'Open position size does not reconcile with canonical wallet activity events.',
        detectedAt: new Date(),
      })),
      ...missingPositionCoverage.map((issue) => ({
        trackedWalletId: walletId,
        sourceName: 'POLYMARKET_DATA_API',
        issueType: 'MISSING_POSITION_FROM_ACTIVITY',
        severity: 'WARN',
        marketId: issue.marketId,
        conditionId: issue.marketId,
        expectedValue: {
          activityShares: issue.activityShares,
        },
        actualValue: {
          positionShares: issue.positionsShares,
        },
        notes:
          'Canonical activity implies open exposure but source open-positions endpoint does not report it.',
        detectedAt: new Date(),
      })),
    ];

    if (issuesPayload.length > 0) {
      await prisma.walletReconciliationIssue.createMany({
        data: issuesPayload,
      });
    }

    await prisma.watchedWallet.update({
      where: { id: walletId },
      data: { lastPositionsSyncedAt: new Date() },
    });

    if (mismatches.length > 0 || missingPositionCoverage.length > 0) {
      await prisma.auditLog.create({
        data: {
          category: 'RECONCILIATION',
          entityId: walletId,
          action: 'MISMATCH',
          payload: {
            walletId,
            address,
            mismatches,
            missingPositionCoverage,
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
          missingPositionCoverage,
        },
        walletId,
      );

      logger.warn(
        {
          walletId,
          mismatches: mismatches.length,
          missingPositionCoverage: missingPositionCoverage.length,
        },
        'wallet reconciliation mismatch',
      );
    }
  } catch (error) {
    logger.warn({ walletId, error }, 'wallet reconciliation failed');
  }
}
