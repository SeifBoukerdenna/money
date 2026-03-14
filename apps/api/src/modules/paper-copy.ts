import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createPolymarketDataAdapter } from './polymarket.js';

const adapter = createPolymarketDataAdapter();
const db = prisma as unknown as Record<string, any>;

type SessionConfig = {
  startingCash: number;
  maxAllocationPerMarket: number;
  maxTotalExposure: number;
  minNotionalThreshold: number;
  feeBps: number;
  slippageBps: number;
};

export async function createPaperCopySession(input: {
  trackedWalletId: string;
  startingCash?: number;
  maxAllocationPerMarket?: number;
  maxTotalExposure?: number;
  minNotionalThreshold?: number;
  feeBps?: number;
  slippageBps?: number;
}) {
  const wallet = await prisma.watchedWallet.findUnique({ where: { id: input.trackedWalletId } });
  if (!wallet) {
    throw new Error('Tracked wallet not found');
  }

  const config: SessionConfig = {
    startingCash: input.startingCash ?? 50000,
    maxAllocationPerMarket: input.maxAllocationPerMarket ?? 2500,
    maxTotalExposure: input.maxTotalExposure ?? 10000,
    minNotionalThreshold: input.minNotionalThreshold ?? 2,
    feeBps: input.feeBps ?? 10,
    slippageBps: input.slippageBps ?? 8,
  };

  return db.paperCopySession.create({
    data: {
      trackedWalletId: wallet.id,
      trackedWalletAddress: wallet.address,
      status: 'PAUSED',
      startingCash: config.startingCash,
      currentCash: config.startingCash,
      maxAllocationPerMarket: config.maxAllocationPerMarket,
      maxTotalExposure: config.maxTotalExposure,
      minNotionalThreshold: config.minNotionalThreshold,
      feeBps: config.feeBps,
      slippageBps: config.slippageBps,
    },
  });
}

export async function startPaperCopySession(sessionId: string) {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) {
    throw new Error('Session not found');
  }

  const startedAt = session.startedAt ?? new Date();
  const bootstrapped = await bootstrapSessionFromOpenPositions(
    sessionId,
    session.trackedWalletAddress,
  );

  await db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      status: 'RUNNING',
      startedAt,
      estimatedSourceExposure: bootstrapped.estimatedSourceExposure,
      copyRatio: bootstrapped.copyRatio,
      ...(session.startedAt
        ? {}
        : {
            currentCash: Math.max(0, Number(session.startingCash) - bootstrapped.bootstrapNotional),
          }),
    },
  });

  await processPaperSessionTick(sessionId);
}

export async function pausePaperCopySession(sessionId: string) {
  await db.paperCopySession.update({ where: { id: sessionId }, data: { status: 'PAUSED' } });
}

export async function resumePaperCopySession(sessionId: string) {
  await db.paperCopySession.update({ where: { id: sessionId }, data: { status: 'RUNNING' } });
}

export async function stopPaperCopySession(sessionId: string) {
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: { status: 'COMPLETED', endedAt: new Date() },
  });
  await createSessionSnapshot(sessionId);
}

async function bootstrapSessionFromOpenPositions(sessionId: string, walletAddress: string) {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) {
    throw new Error('Session not found');
  }

  const openPositions = await adapter.getWalletPositions(walletAddress, 'OPEN', 200);
  const estimatedSourceExposure = openPositions.reduce(
    (sum, p) => sum + Math.abs(p.totalTraded),
    0,
  );
  const baseExposure = Math.max(estimatedSourceExposure, Number(session.startingCash));
  const copyRatio = Number(session.startingCash) / baseExposure;

  const now = new Date();
  let bootstrapNotional = 0;

  for (const position of openPositions) {
    const simulatedShares = position.size * copyRatio;
    if (simulatedShares <= 0) {
      continue;
    }
    const simulatedPrice = position.currentPrice > 0 ? position.currentPrice : position.avgPrice;
    const notional = simulatedShares * simulatedPrice;

    const existing = await db.paperCopyPosition.findUnique({
      where: {
        sessionId_marketId_outcome: {
          sessionId,
          marketId: position.conditionId,
          outcome: position.outcome,
        },
      },
    });

    if (!existing) {
      bootstrapNotional += notional;

      await db.paperCopyPosition.create({
        data: {
          sessionId,
          marketId: position.conditionId,
          marketQuestion: position.title,
          outcome: position.outcome,
          netShares: simulatedShares,
          avgEntryPrice: simulatedPrice,
          currentMarkPrice: simulatedPrice,
          realizedPnl: 0,
          unrealizedPnl: 0,
          status: 'OPEN',
          openedAt: now,
        },
      });

      await db.paperCopyTrade.create({
        data: {
          sessionId,
          sourceActivityEventId: null,
          marketId: position.conditionId,
          marketQuestion: position.title,
          outcome: position.outcome,
          side: 'BUY',
          action: 'BOOTSTRAP',
          sourcePrice: simulatedPrice,
          simulatedPrice,
          sourceShares: position.size,
          simulatedShares,
          notional,
          feeApplied: 0,
          slippageApplied: 0,
          eventTimestamp: now,
          processedAt: now,
          reasoning: {
            type: 'BOOTSTRAP_OPEN_POSITION',
            sourceExposureEstimate: estimatedSourceExposure,
            copyRatio,
          },
        },
      });
    }
  }

  return { estimatedSourceExposure, copyRatio, bootstrapNotional };
}

export async function processPaperSessionTick(sessionId: string) {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== 'RUNNING') {
    return;
  }

  const startedAt = session.startedAt ?? session.createdAt;
  const newEvents = await db.walletActivityEvent.findMany({
    where: {
      trackedWalletId: session.trackedWalletId,
      eventTimestamp: {
        gt: session.lastProcessedEventAt ?? startedAt,
      },
      side: { in: ['BUY', 'SELL'] },
      shares: { not: null },
      price: { not: null },
    },
    orderBy: { eventTimestamp: 'asc' },
    take: 1000,
  });

  for (const event of newEvents) {
    try {
      await applyActivityEventToSession(sessionId, event.id);
    } catch (error) {
      logger.warn({ sessionId, eventId: event.id, error }, 'paper session event processing failed');
    }
  }

  const latest = newEvents.at(-1);
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      lastProcessedEventAt: latest?.eventTimestamp ?? session.lastProcessedEventAt,
    },
  });

  await refreshSessionMarks(sessionId);
  await createSessionSnapshot(sessionId);
}

async function applyActivityEventToSession(sessionId: string, sourceActivityEventId: string) {
  const [session, event] = await Promise.all([
    db.paperCopySession.findUnique({ where: { id: sessionId } }),
    db.walletActivityEvent.findUnique({ where: { id: sourceActivityEventId } }),
  ]);

  if (!session || !event || !event.side || event.shares === null || event.price === null) {
    return;
  }

  const copyRatio = Number(session.copyRatio ?? 1);
  const sourceShares = Number(event.shares);
  const sourcePrice = Number(event.price);
  const slippageSign = event.side === 'BUY' ? 1 : -1;
  const slippageApplied = sourcePrice * (Number(session.slippageBps) / 10000) * slippageSign;
  const simulatedPrice = Math.max(0.0001, sourcePrice + slippageApplied);
  let simulatedShares = sourceShares * copyRatio;

  const minNotionalThreshold = Number(session.minNotionalThreshold);
  let notional = simulatedShares * simulatedPrice;
  if (notional < minNotionalThreshold) {
    return;
  }

  if (event.side === 'BUY') {
    const availableCash = Number(session.currentCash);
    if (notional > availableCash) {
      simulatedShares = availableCash / simulatedPrice;
      notional = simulatedShares * simulatedPrice;
    }
  }

  const feeApplied = notional * (Number(session.feeBps) / 10000);

  const existing = await db.paperCopyPosition.findUnique({
    where: {
      sessionId_marketId_outcome: {
        sessionId,
        marketId: event.marketId,
        outcome: event.outcome ?? 'UNKNOWN',
      },
    },
  });

  if (event.side === 'BUY') {
    if (existing) {
      const currShares = Number(existing.netShares);
      const currAvg = Number(existing.avgEntryPrice);
      const newShares = currShares + simulatedShares;
      const newAvg =
        newShares > 0
          ? (currShares * currAvg + simulatedShares * simulatedPrice) / newShares
          : currAvg;
      await db.paperCopyPosition.update({
        where: { id: existing.id },
        data: {
          netShares: newShares,
          avgEntryPrice: newAvg,
          currentMarkPrice: simulatedPrice,
          status: 'OPEN',
        },
      });
    } else {
      await db.paperCopyPosition.create({
        data: {
          sessionId,
          marketId: event.marketId,
          marketQuestion: event.marketQuestion,
          outcome: event.outcome ?? 'UNKNOWN',
          netShares: simulatedShares,
          avgEntryPrice: simulatedPrice,
          currentMarkPrice: simulatedPrice,
          realizedPnl: 0,
          unrealizedPnl: 0,
          status: 'OPEN',
          openedAt: event.eventTimestamp,
        },
      });
    }
  } else {
    if (existing) {
      const currShares = Number(existing.netShares);
      const closeShares = Math.min(currShares, simulatedShares);
      const pnl = closeShares * (simulatedPrice - Number(existing.avgEntryPrice));
      const newShares = Math.max(0, currShares - closeShares);
      await db.paperCopyPosition.update({
        where: { id: existing.id },
        data: {
          netShares: newShares,
          currentMarkPrice: simulatedPrice,
          realizedPnl: Number(existing.realizedPnl) + pnl - feeApplied,
          status: newShares <= 0 ? 'CLOSED' : 'OPEN',
          closedAt: newShares <= 0 ? event.eventTimestamp : null,
        },
      });
      simulatedShares = closeShares;
      notional = simulatedShares * simulatedPrice;
    } else {
      return;
    }
  }

  await db.paperCopyTrade.create({
    data: {
      sessionId,
      sourceActivityEventId,
      marketId: event.marketId,
      marketQuestion: event.marketQuestion,
      outcome: event.outcome ?? 'UNKNOWN',
      side: event.side,
      action: event.eventType,
      sourcePrice,
      simulatedPrice,
      sourceShares,
      simulatedShares,
      notional,
      feeApplied,
      slippageApplied,
      eventTimestamp: event.eventTimestamp,
      processedAt: new Date(),
      reasoning: {
        copyRatio,
        feeBps: Number(session.feeBps),
        slippageBps: Number(session.slippageBps),
        sourceEventType: event.eventType,
      },
    },
  });

  const cashDelta = event.side === 'BUY' ? -(notional + feeApplied) : notional - feeApplied;
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      currentCash: Number(session.currentCash) + cashDelta,
    },
  });
}

async function refreshSessionMarks(sessionId: string) {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) {
    return;
  }

  const openPositions = await db.paperCopyPosition.findMany({
    where: { sessionId, status: 'OPEN' },
  });

  for (const position of openPositions) {
    const recent = await db.walletActivityEvent.findFirst({
      where: {
        trackedWalletId: session.trackedWalletId,
        marketId: position.marketId,
        outcome: position.outcome,
        price: { not: null },
      },
      orderBy: { eventTimestamp: 'desc' },
    });

    const mark = recent?.price ? Number(recent.price) : Number(position.currentMarkPrice);
    const unrealized = Number(position.netShares) * (mark - Number(position.avgEntryPrice));
    await db.paperCopyPosition.update({
      where: { id: position.id },
      data: {
        currentMarkPrice: mark,
        unrealizedPnl: unrealized,
      },
    });
  }
}

export async function createSessionSnapshot(sessionId: string) {
  const [session, positions] = await Promise.all([
    db.paperCopySession.findUnique({ where: { id: sessionId } }),
    db.paperCopyPosition.findMany({ where: { sessionId } }),
  ]);

  if (!session) {
    return;
  }

  const openMarketValue = positions
    .filter((p: any) => p.status === 'OPEN')
    .reduce(
      (sum: number, row: any) => sum + Number(row.netShares) * Number(row.currentMarkPrice),
      0,
    );
  const grossExposure = positions
    .filter((p: any) => p.status === 'OPEN')
    .reduce(
      (sum: number, row: any) =>
        sum + Math.abs(Number(row.netShares) * Number(row.currentMarkPrice)),
      0,
    );
  const realizedPnl = positions.reduce((sum: number, row: any) => sum + Number(row.realizedPnl), 0);
  const unrealizedPnl = positions
    .filter((p: any) => p.status === 'OPEN')
    .reduce((sum: number, row: any) => sum + Number(row.unrealizedPnl), 0);

  const cash = Number(session.currentCash);
  const netLiquidationValue = cash + openMarketValue;
  const totalPnl = netLiquidationValue - Number(session.startingCash);
  const returnPct =
    Number(session.startingCash) > 0 ? (totalPnl / Number(session.startingCash)) * 100 : 0;

  const timestamp = new Date();
  await db.paperPortfolioSnapshot.create({
    data: {
      sessionId,
      timestamp,
      cash,
      grossExposure,
      netLiquidationValue,
      realizedPnl,
      unrealizedPnl,
      totalPnl,
      returnPct,
    },
  });

  await db.paperSessionMetricPoint.create({
    data: {
      sessionId,
      timestamp,
      totalPnl,
      realizedPnl,
      unrealizedPnl,
      netLiquidationValue,
      openPositionsCount: positions.filter((p: any) => p.status === 'OPEN').length,
    },
  });
}

export async function tickRunningPaperSessions() {
  const sessions = await db.paperCopySession.findMany({ where: { status: 'RUNNING' } });
  for (const session of sessions) {
    await processPaperSessionTick(session.id);
  }
}
