/**
 * force-close.ts — Force-close positions that our poller/reconcile missed.
 *
 * The existing reconcile only closes positions that disappeared from Polymarket's
 * open positions API. But Polymarket can be slow to reflect market resolution.
 *
 * This module adds:
 *   1. closeResolvedPositions — closes positions where mark price ≈ 0 or ≈ 1
 *      (indicating the market has resolved, win or lose)
 *   2. forceClosePosition — force-close a single position at its current mark price
 *
 * These functions are safe to call at any time. They create proper CLOSE trade
 * records, update cash, and write a snapshot.
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const db = prisma as any;

// A mark price within this tolerance of 0 or 1 is considered "resolved"
const RESOLVED_TOLERANCE = 0.02;

function isLikelyResolved(markPrice: number): boolean {
  return markPrice <= RESOLVED_TOLERANCE || markPrice >= 1 - RESOLVED_TOLERANCE;
}

function resolvedClosePrice(markPrice: number): number {
  if (markPrice >= 1 - RESOLVED_TOLERANCE) return 1.0; // winning outcome
  if (markPrice <= RESOLVED_TOLERANCE) return 0.0; // losing outcome
  return markPrice;
}

/**
 * Close a single position by ID. Uses the current mark price (or resolved price
 * if mark is near 0/1). Records a FORCE_CLOSE trade and updates cash.
 */
export async function forceClosePosition(
  sessionId: string,
  positionId: string,
): Promise<{ closed: boolean; realizedPnl: number; cashReturned: number }> {
  const pos = await db.paperCopyPosition.findUnique({ where: { id: positionId } });
  if (!pos || pos.sessionId !== sessionId || pos.status !== 'OPEN') {
    return { closed: false, realizedPnl: 0, cashReturned: 0 };
  }

  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');

  const closeShares = Number(pos.netShares);
  if (closeShares <= 0) return { closed: false, realizedPnl: 0, cashReturned: 0 };

  const rawMark = Number(pos.currentMarkPrice);
  const closePrice = isLikelyResolved(rawMark) ? resolvedClosePrice(rawMark) : rawMark;
  const avgEntry = Number(pos.avgEntryPrice);
  const realizedPnl = closeShares * (closePrice - avgEntry);
  const notional = closeShares * closePrice;
  const feeApplied = notional * (Number(session.feeBps) / 10_000);
  const cashReturned = notional - feeApplied;
  const now = new Date();

  // Update position
  await db.paperCopyPosition.update({
    where: { id: pos.id },
    data: {
      netShares: 0,
      currentMarkPrice: closePrice,
      realizedPnl: Number(pos.realizedPnl) + realizedPnl - feeApplied,
      status: 'CLOSED',
      closedAt: now,
    },
  });

  // Record a FORCE_CLOSE trade
  await db.paperCopyTrade.create({
    data: {
      sessionId,
      sourceActivityEventId: null,
      marketId: pos.marketId,
      marketQuestion: pos.marketQuestion ?? null,
      outcome: pos.outcome,
      side: 'SELL',
      action: 'FORCE_CLOSE',
      sourcePrice: closePrice,
      simulatedPrice: closePrice,
      sourceShares: closeShares,
      simulatedShares: closeShares,
      notional,
      feeApplied,
      slippageApplied: 0,
      eventTimestamp: now,
      processedAt: now,
      reasoning: {
        type: 'FORCE_CLOSE',
        reason: 'Manually force-closed by user',
        markPrice: rawMark,
        closePrice,
        isResolvedMark: isLikelyResolved(rawMark),
      },
    },
  });

  // Update cash
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: { currentCash: { increment: cashReturned } },
  });

  logger.info(
    {
      sessionId,
      positionId,
      marketId: pos.marketId,
      outcome: pos.outcome,
      closeShares,
      closePrice,
      realizedPnl,
      cashReturned,
    },
    'position force-closed',
  );

  return { closed: true, realizedPnl, cashReturned };
}

/**
 * Close all open positions whose mark price indicates the market has resolved
 * (mark ≈ 0 or mark ≈ 1). This catches markets that our poller/reconcile missed.
 *
 * Winning positions (mark ≈ 1) close at $1.00.
 * Losing positions (mark ≈ 0) close at $0.00.
 */
export async function closeResolvedPositions(sessionId: string): Promise<{
  checked: number;
  closed: number;
  totalRealizedPnl: number;
  totalCashReturned: number;
  closedMarkets: string[];
}> {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');

  const openPositions: Array<Record<string, any>> = await db.paperCopyPosition.findMany({
    where: { sessionId, status: 'OPEN' },
  });

  let closed = 0;
  let totalRealizedPnl = 0;
  let totalCashReturned = 0;
  const closedMarkets: string[] = [];
  const now = new Date();

  for (const pos of openPositions) {
    const markPrice = Number(pos.currentMarkPrice);

    if (!isLikelyResolved(markPrice)) continue;

    const closeShares = Number(pos.netShares);
    if (closeShares <= 0) continue;

    const closePrice = resolvedClosePrice(markPrice);
    const avgEntry = Number(pos.avgEntryPrice);
    const realizedPnl = closeShares * (closePrice - avgEntry);
    const notional = closeShares * closePrice;
    const feeApplied = notional * (Number(session.feeBps) / 10_000);
    const cashReturned = notional - feeApplied;

    await db.paperCopyPosition.update({
      where: { id: pos.id },
      data: {
        netShares: 0,
        currentMarkPrice: closePrice,
        realizedPnl: Number(pos.realizedPnl) + realizedPnl - feeApplied,
        status: 'CLOSED',
        closedAt: now,
      },
    });

    await db.paperCopyTrade.create({
      data: {
        sessionId,
        sourceActivityEventId: null,
        marketId: pos.marketId,
        marketQuestion: pos.marketQuestion ?? null,
        outcome: pos.outcome,
        side: 'SELL',
        action: 'AUTO_CLOSE_RESOLVED',
        sourcePrice: closePrice,
        simulatedPrice: closePrice,
        sourceShares: closeShares,
        simulatedShares: closeShares,
        notional,
        feeApplied,
        slippageApplied: 0,
        eventTimestamp: now,
        processedAt: now,
        reasoning: {
          type: 'AUTO_CLOSE_RESOLVED',
          reason: `Market resolved — mark price ${markPrice.toFixed(4)} ≈ ${closePrice === 1 ? 'WON' : 'LOST'}`,
          markPrice,
          closePrice,
        },
      },
    });

    await db.paperCopySession.update({
      where: { id: sessionId },
      data: { currentCash: { increment: cashReturned } },
    });

    totalRealizedPnl += realizedPnl;
    totalCashReturned += cashReturned;
    closed++;
    closedMarkets.push(`${pos.marketQuestion ?? pos.marketId} (${pos.outcome})`);

    logger.info(
      {
        sessionId,
        marketId: pos.marketId,
        outcome: pos.outcome,
        closePrice,
        closeShares,
        realizedPnl,
      },
      'position auto-closed — market resolved (mark ≈ 0 or 1)',
    );
  }

  return {
    checked: openPositions.length,
    closed,
    totalRealizedPnl,
    totalCashReturned,
    closedMarkets,
  };
}
