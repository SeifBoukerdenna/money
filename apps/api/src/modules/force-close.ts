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
import { materializePaperSessionState } from './paper-accounting.js';
import { createPolymarketDataAdapter } from './polymarket.js';
import { deriveClosedPositionsFromDb } from './profile-parity-routes.js';

const db = prisma as any;
const dataAdapter = createPolymarketDataAdapter();

// Per-session in-process lock to prevent concurrent manual/auto close races.
const _forceCloseLocks = new Set<string>();

function _acquireForceCloseLock(sessionId: string): boolean {
  if (_forceCloseLocks.has(sessionId)) return false;
  _forceCloseLocks.add(sessionId);
  return true;
}

function _releaseForceCloseLock(sessionId: string): void {
  _forceCloseLocks.delete(sessionId);
}

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
  if (!_acquireForceCloseLock(sessionId)) {
    logger.warn({ sessionId, positionId }, 'force close skipped — close lock already held');
    return { closed: false, realizedPnl: 0, cashReturned: 0 };
  }

  try {
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

    await db.paperCopyTrade.create({
      data: {
        sessionId,
        trackedWalletId: session.trackedWalletId,
        walletAddress: session.trackedWalletAddress,
        sourceType: 'MANUAL_FORCE_CLOSE',
        sourceEventTimestamp: now,
        sourceTxHash: null,
        executorType: 'FORCE_CLOSE_TOOLING',
        isBootstrap: false,
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

    await materializePaperSessionState(sessionId);

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
  } finally {
    _releaseForceCloseLock(sessionId);
  }
}

function isSellLikeTrade(t: { side: string; action: string }): boolean {
  const action = String(t.action ?? '').toUpperCase();
  return (
    String(t.side ?? '').toUpperCase() === 'SELL' ||
    action.includes('SELL') ||
    action.includes('CLOSE') ||
    action.includes('REDUCE') ||
    action.includes('REDEEM')
  );
}

/**
 * Force-close a single open lot identified by its BUY trade id.
 * Uses FIFO replay to compute remaining shares for that exact lot.
 */
export async function forceCloseLot(
  sessionId: string,
  lotTradeId: string,
): Promise<{ closed: boolean; realizedPnl: number; cashReturned: number; closedShares: number }> {
  if (!_acquireForceCloseLock(sessionId)) {
    logger.warn({ sessionId, lotTradeId }, 'force-close-lot skipped — close lock already held');
    return { closed: false, realizedPnl: 0, cashReturned: 0, closedShares: 0 };
  }

  try {
    const lotTrade = await db.paperCopyTrade.findUnique({ where: { id: lotTradeId } });
    if (!lotTrade || lotTrade.sessionId !== sessionId) {
      return { closed: false, realizedPnl: 0, cashReturned: 0, closedShares: 0 };
    }

    if (String(lotTrade.side).toUpperCase() !== 'BUY') {
      return { closed: false, realizedPnl: 0, cashReturned: 0, closedShares: 0 };
    }

    const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error('Session not found');

    const allTrades: Array<Record<string, any>> = await db.paperCopyTrade.findMany({
      where: {
        sessionId,
        marketId: lotTrade.marketId,
        outcome: lotTrade.outcome,
      },
      orderBy: [{ eventTimestamp: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        side: true,
        action: true,
        simulatedShares: true,
      },
    });

    const lotQueue: Array<{ id: string; remainingShares: number }> = [];
    for (const t of allTrades) {
      const shares = Number(t.simulatedShares ?? 0);
      if (shares <= 0) continue;
      if (!isSellLikeTrade({ side: String(t.side), action: String(t.action) })) {
        lotQueue.push({ id: String(t.id), remainingShares: shares });
        continue;
      }

      let remainingToClose = shares;
      for (const lot of lotQueue) {
        if (remainingToClose <= 0) break;
        if (lot.remainingShares <= 0) continue;
        const consume = Math.min(lot.remainingShares, remainingToClose);
        lot.remainingShares -= consume;
        remainingToClose -= consume;
      }
    }

    const targetLot = lotQueue.find((l) => l.id === lotTradeId);
    const closeShares = targetLot ? Number(targetLot.remainingShares) : 0;
    if (closeShares <= 1e-8) {
      return { closed: false, realizedPnl: 0, cashReturned: 0, closedShares: 0 };
    }

    const openPosition = await db.paperCopyPosition.findFirst({
      where: {
        sessionId,
        status: 'OPEN',
        marketId: lotTrade.marketId,
        outcome: lotTrade.outcome,
      },
      select: {
        id: true,
        currentMarkPrice: true,
        netShares: true,
        avgEntryPrice: true,
        marketQuestion: true,
        marketId: true,
        outcome: true,
      },
    });

    if (!openPosition || Number(openPosition.netShares) <= 0) {
      return { closed: false, realizedPnl: 0, cashReturned: 0, closedShares: 0 };
    }

    const sharesToClose = Math.min(closeShares, Number(openPosition.netShares));
    if (sharesToClose <= 1e-8) {
      return { closed: false, realizedPnl: 0, cashReturned: 0, closedShares: 0 };
    }

    const rawMark = Number(openPosition.currentMarkPrice);
    const closePrice = isLikelyResolved(rawMark) ? resolvedClosePrice(rawMark) : rawMark;
    const entryPrice = Number(lotTrade.simulatedPrice ?? openPosition.avgEntryPrice ?? 0);
    const realizedPnl = sharesToClose * (closePrice - entryPrice);
    const notional = sharesToClose * closePrice;
    const feeApplied = notional * (Number(session.feeBps) / 10_000);
    const cashReturned = notional - feeApplied;
    const now = new Date();

    await db.paperCopyTrade.create({
      data: {
        sessionId,
        trackedWalletId: session.trackedWalletId,
        walletAddress: session.trackedWalletAddress,
        sourceType: 'MANUAL_FORCE_CLOSE',
        sourceEventTimestamp: now,
        sourceTxHash: null,
        executorType: 'FORCE_CLOSE_TOOLING',
        isBootstrap: false,
        sourceActivityEventId: null,
        marketId: String(openPosition.marketId),
        marketQuestion: openPosition.marketQuestion ?? null,
        outcome: String(openPosition.outcome),
        side: 'SELL',
        action: 'FORCE_CLOSE_LOT',
        sourcePrice: closePrice,
        simulatedPrice: closePrice,
        sourceShares: sharesToClose,
        simulatedShares: sharesToClose,
        notional,
        feeApplied,
        slippageApplied: 0,
        eventTimestamp: now,
        processedAt: now,
        reasoning: {
          type: 'FORCE_CLOSE_LOT',
          reason: 'Manually force-closed a specific open lot',
          lotTradeId,
          entryPrice,
          markPrice: rawMark,
          closePrice,
        },
      },
    });

    await materializePaperSessionState(sessionId);

    logger.info(
      {
        sessionId,
        lotTradeId,
        marketId: openPosition.marketId,
        outcome: openPosition.outcome,
        sharesToClose,
        closePrice,
        realizedPnl,
        cashReturned,
      },
      'lot force-closed',
    );

    return { closed: true, realizedPnl, cashReturned, closedShares: sharesToClose };
  } finally {
    _releaseForceCloseLock(sessionId);
  }
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
  skipped?: boolean;
  reason?: string;
}> {
  if (!_acquireForceCloseLock(sessionId)) {
    logger.warn({ sessionId }, 'auto-close-resolved skipped — close lock already held');
    return {
      checked: 0,
      closed: 0,
      totalRealizedPnl: 0,
      totalCashReturned: 0,
      closedMarkets: [],
      skipped: true,
      reason: 'Session close lock already held',
    };
  }

  try {
    const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error('Session not found');

    const openPositions: Array<Record<string, any>> = await db.paperCopyPosition.findMany({
      where: { sessionId, status: 'OPEN' },
    });

    const sourceResolutionByKey = new Map<string, number>();

    // 1) Source closed positions from REDEEM/CLOSE history are primary ground truth.
    try {
      const sourceClosed = await deriveClosedPositionsFromDb(db, session.trackedWalletId);
      for (const pos of sourceClosed) {
        const marketId = String(pos.conditionId ?? '').trim();
        const outcome = String(pos.outcome ?? '')
          .trim()
          .toUpperCase();
        if (!marketId || !outcome) continue;

        const amountWon = Number(pos.valueUsd ?? 0);
        const totalTraded = Number(pos.totalTraded ?? 0);
        const currentPrice = Number(pos.currentPrice ?? 0);

        let closePrice = currentPrice;
        if (amountWon > 0 && totalTraded > 0) {
          closePrice = 1;
        } else if (totalTraded > 0 && amountWon <= 0) {
          closePrice = 0;
        }
        if (closePrice >= 0.95) closePrice = 1;
        if (closePrice <= 0.05) closePrice = 0;

        sourceResolutionByKey.set(`${marketId}:${outcome}`, closePrice);
      }
    } catch {
      // Non-fatal: adapter and DB event fallbacks below provide additional signals.
    }

    // 2) DB REDEEM/CLOSE wallet events provide additional authoritative resolution.
    const redeemRows: Array<Record<string, unknown>> = await db.walletActivityEvent.findMany({
      where: {
        trackedWalletId: session.trackedWalletId,
        eventType: { in: ['REDEEM', 'CLOSE'] },
        ...(session.startedAt ? { eventTimestamp: { gte: session.startedAt } } : {}),
      },
      orderBy: { eventTimestamp: 'desc' },
      select: {
        marketId: true,
        conditionId: true,
        outcome: true,
        shares: true,
        notional: true,
        price: true,
      },
    });

    for (const row of redeemRows) {
      const marketId = String(row.conditionId ?? row.marketId ?? '').trim();
      const outcome = String(row.outcome ?? '')
        .trim()
        .toUpperCase();
      if (!marketId || !outcome) continue;

      const shares = Math.abs(Number(row.shares ?? 0));
      const notional = Number(row.notional ?? 0);
      const rawPrice = Number(row.price ?? 0);

      let closePrice = shares > 0 ? notional / shares : rawPrice;
      if (!Number.isFinite(closePrice) || closePrice < 0) closePrice = 0;
      if (closePrice >= 0.95) closePrice = 1;
      if (closePrice <= 0.05) closePrice = 0;

      sourceResolutionByKey.set(`${marketId}:${outcome}`, closePrice);
    }

    let closed = 0;
    let totalRealizedPnl = 0;
    let totalCashReturned = 0;
    const closedMarkets: string[] = [];
    const now = new Date();

    for (const pos of openPositions) {
      const key = `${String(pos.marketId)}:${String(pos.outcome).toUpperCase()}`;
      const resolvedFromSource = sourceResolutionByKey.get(key);
      const isThresholdResolved = isLikelyResolved(Number(pos.currentMarkPrice));
      if (resolvedFromSource === undefined && !isThresholdResolved) continue;

      const closeShares = Number(pos.netShares);
      if (closeShares <= 0) continue;

      const closePrice =
        resolvedFromSource !== undefined
          ? resolvedFromSource
          : resolvedClosePrice(Number(pos.currentMarkPrice));
      const avgEntry = Number(pos.avgEntryPrice);
      const realizedPnl = closeShares * (closePrice - avgEntry);
      const notional = closeShares * closePrice;
      const feeApplied = notional * (Number(session.feeBps) / 10_000);
      const cashReturned = notional - feeApplied;

      await db.paperCopyTrade.create({
        data: {
          sessionId,
          trackedWalletId: session.trackedWalletId,
          walletAddress: session.trackedWalletAddress,
          sourceType: 'AUTO_RESOLUTION_CLOSE',
          sourceEventTimestamp: now,
          sourceTxHash: null,
          executorType: 'FORCE_CLOSE_TOOLING',
          isBootstrap: false,
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
            reason:
              resolvedFromSource !== undefined
                ? `Market resolved using source wallet redemption ground truth (${closePrice === 1 ? 'WON' : 'LOST'})`
                : `Fallback threshold resolution used (mark≈${Number(pos.currentMarkPrice).toFixed(3)})`,
            markPrice: Number(pos.currentMarkPrice),
            closePrice,
            sourceGroundTruth:
              resolvedFromSource !== undefined ? 'wallet_redemption' : 'mark_threshold_fallback',
          },
        },
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
        'position auto-closed from source redemption ground truth',
      );
    }

    if (closed > 0) {
      await materializePaperSessionState(sessionId);
    }

    return {
      checked: openPositions.length,
      closed,
      totalRealizedPnl,
      totalCashReturned,
      closedMarkets,
    };
  } finally {
    _releaseForceCloseLock(sessionId);
  }
}
