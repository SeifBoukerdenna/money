import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { Prisma } from '@prisma/client';
import { createPolymarketDataAdapter } from './polymarket.js';
import { normalizeMoney } from '../lib/money-utils.js';

const dataAdapter = createPolymarketDataAdapter();

type LedgerRow = {
  id: string;
  sessionId: string;
  marketId: string;
  marketQuestion: string | null;
  outcome: string;
  side: 'BUY' | 'SELL';
  action: string;
  simulatedPrice: number;
  simulatedShares: number;
  feeApplied: number;
  eventTimestamp: Date;
};

type PositionState = {
  marketId: string;
  marketQuestion: string | null;
  outcome: string;
  netShares: number;
  avgEntryPrice: number;
  currentMarkPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  status: 'OPEN' | 'CLOSED';
  openedAt: Date;
  closedAt: Date | null;
  lastEventAt: Date;
};

type LedgerWarning = {
  code:
    | 'SELL_EXCEEDS_HELD_SHARES'
    | 'OPEN_POSITION_ZERO_SHARES'
    | 'CLOSED_POSITION_POSITIVE_SHARES'
    | 'NON_FINITE_CASH'
    | 'NON_FINITE_POSITION_VALUE';
  message: string;
  context?: Record<string, unknown>;
};

export type ReducedSessionState = {
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  fees: number;
  netLiquidationValue: number;
  grossExposure: number;
  openPositionsCount: number;
  warnings: LedgerWarning[];
  positions: PositionState[];
};

const EPSILON = 1e-9;

function keyFor(marketId: string, outcome: string): string {
  return `${marketId}:${outcome.toUpperCase()}`;
}

function applyLedgerRow(
  positionsByKey: Map<string, PositionState>,
  warnings: LedgerWarning[],
  row: LedgerRow,
): number {
  const outcome = row.outcome.toUpperCase();
  const key = keyFor(row.marketId, outcome);

  const price = row.simulatedPrice;
  const rawShares = row.simulatedShares;
  const fee = row.feeApplied;

  if (!Number.isFinite(price) || !Number.isFinite(rawShares) || !Number.isFinite(fee)) {
    return 0;
  }

  const shares = Math.max(0, rawShares);
  if (shares <= EPSILON) {
    return 0;
  }

  let position = positionsByKey.get(key);
  if (!position) {
    position = {
      marketId: row.marketId,
      marketQuestion: row.marketQuestion,
      outcome,
      netShares: 0,
      avgEntryPrice: 0,
      currentMarkPrice: price,
      realizedPnl: 0,
      unrealizedPnl: 0,
      status: 'CLOSED',
      openedAt: row.eventTimestamp,
      closedAt: row.eventTimestamp,
      lastEventAt: row.eventTimestamp,
    };
    positionsByKey.set(key, position);
  }

  position.marketQuestion = row.marketQuestion ?? position.marketQuestion;
  if (price > EPSILON || row.side === 'BUY') {
    position.currentMarkPrice = price;
  }
  position.lastEventAt = row.eventTimestamp;

  if (row.side === 'BUY') {
    const prevShares = position.netShares;
    const newShares = prevShares + shares;
    const prevCost = prevShares * position.avgEntryPrice;
    const newCost = prevCost + shares * price;

    position.netShares = newShares;
    position.avgEntryPrice = newShares > EPSILON ? newCost / newShares : position.avgEntryPrice;
    position.status = 'OPEN';
    if (prevShares <= EPSILON) {
      position.openedAt = row.eventTimestamp;
      position.closedAt = null;
    }

    return -(shares * price + fee);
  }

  const held = position.netShares;
  const closeShares = Math.min(held, shares);
  if (shares > held + EPSILON) {
    warnings.push({
      code: 'SELL_EXCEEDS_HELD_SHARES',
      message: 'Sell amount exceeded held shares and was clamped to held shares.',
      context: {
        ledgerEntryId: row.id,
        marketId: row.marketId,
        outcome,
        requestedShares: shares,
        heldShares: held,
      },
    });
  }

  if (closeShares <= EPSILON) {
    return 0;
  }

  const realized = normalizeMoney(closeShares * (price - position.avgEntryPrice));
  position.realizedPnl += realized;
  position.netShares = Math.max(0, held - closeShares);

  if (position.netShares <= EPSILON) {
    position.netShares = 0;
    position.status = 'CLOSED';
    position.closedAt = row.eventTimestamp;
  } else {
    position.status = 'OPEN';
    position.closedAt = null;
  }

  return closeShares * price - fee;
}

async function buildMarkMap(
  trackedWalletId: string,
  trackedWalletAddress: string,
): Promise<Map<string, number>> {
  const markMap = new Map<string, number>();

  try {
    const openPositions = await dataAdapter.getWalletPositions(trackedWalletAddress, 'OPEN', 500);
    for (const p of openPositions as Array<Record<string, unknown>>) {
      const marketId = String(p.conditionId ?? p.marketId ?? '').trim();
      const outcome = String(p.outcome ?? '')
        .trim()
        .toUpperCase();
      const currentPrice = Number(p.currentPrice ?? p.price ?? p.avgPrice ?? 0);
      if (!marketId || !outcome || !Number.isFinite(currentPrice) || currentPrice <= 0) continue;
      markMap.set(keyFor(marketId, outcome), currentPrice);
    }
  } catch (err) {
    logger.warn({ trackedWalletId, err }, 'failed to fetch live wallet marks, using DB fallback');
  }

  const rows = await prisma.walletActivityEvent.findMany({
    where: { trackedWalletId, price: { not: null } },
    orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }],
    take: 3000,
    select: { marketId: true, outcome: true, price: true },
  });

  for (const row of rows) {
    const price = row.price !== null ? Number(row.price) : NaN;
    if (!Number.isFinite(price)) continue;
    const key = keyFor(row.marketId, (row.outcome ?? 'UNKNOWN').toUpperCase());
    if (!markMap.has(key)) {
      markMap.set(key, price);
    }
  }
  return markMap;
}

export async function reducePaperSessionLedger(sessionId: string): Promise<ReducedSessionState> {
  const session = await prisma.paperCopySession.findUnique({
    where: { id: sessionId },
    select: { id: true, trackedWalletId: true, trackedWalletAddress: true, startingCash: true },
  });
  if (!session) throw new Error('Session not found');

  const rows = await prisma.paperCopyTrade.findMany({
    where: { sessionId },
    orderBy: [{ eventTimestamp: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      sessionId: true,
      marketId: true,
      marketQuestion: true,
      outcome: true,
      side: true,
      action: true,
      simulatedPrice: true,
      simulatedShares: true,
      feeApplied: true,
      eventTimestamp: true,
    },
  });

  const warnings: LedgerWarning[] = [];
  const positionsByKey = new Map<string, PositionState>();
  let cash = Number(session.startingCash);
  let fees = 0;

  for (const row of rows) {
    fees += Number(row.feeApplied);
    const cashDelta = applyLedgerRow(positionsByKey, warnings, {
      ...row,
      simulatedPrice: Number(row.simulatedPrice),
      simulatedShares: Number(row.simulatedShares),
      feeApplied: Number(row.feeApplied),
    });
    cash += cashDelta;
  }

  const markMap = await buildMarkMap(session.trackedWalletId, session.trackedWalletAddress);

  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let grossExposure = 0;
  let openPositionsCount = 0;

  const positions = Array.from(positionsByKey.values()).map((position) => {
    const key = keyFor(position.marketId, position.outcome);
    const mark = markMap.get(key) ?? position.currentMarkPrice ?? position.avgEntryPrice;
    const normalizedMark = Number.isFinite(mark) ? Math.max(0, Math.min(1, mark)) : 0;
    position.currentMarkPrice = normalizedMark;

    position.realizedPnl = normalizeMoney(position.realizedPnl);
    realizedPnl += position.realizedPnl;

    if (position.status === 'OPEN' && position.netShares > EPSILON) {
      position.unrealizedPnl = position.netShares * (normalizedMark - position.avgEntryPrice);
    } else {
      position.unrealizedPnl = 0;
    }
    unrealizedPnl += position.status === 'OPEN' ? position.unrealizedPnl : 0;
    if (position.status === 'OPEN') {
      openPositionsCount += 1;
      grossExposure += Math.abs(position.netShares * position.currentMarkPrice);
    }
    return position;
  });

  if (!Number.isFinite(cash)) {
    warnings.push({
      code: 'NON_FINITE_CASH',
      message: 'Cash became non-finite during ledger reduction.',
    });
    cash = 0;
  }

  const openMarketValue = positions
    .filter((p) => p.status === 'OPEN')
    .reduce((sum, p) => sum + p.netShares * p.currentMarkPrice, 0);

  const netLiquidationValue = cash + openMarketValue;
  const startingCapital = Number(session.startingCash);
  const totalPnl = netLiquidationValue - startingCapital;

  if (Math.abs(startingCapital + realizedPnl + unrealizedPnl - fees - netLiquidationValue) > 0.05) {
    logger.warn(
      { sessionId, startingCapital, realizedPnl, unrealizedPnl, fees, netLiquidationValue },
      'Ledger reconciliation mismatch: startingCapital + realizedPnL + unrealizedPnL - fees != accountValue',
    );
  }

  logger.info(
    { startingCapital, cash, positionValue: openMarketValue, accountValue: netLiquidationValue, realizedPnl, unrealizedPnl, fees, netPnl: totalPnl },
    'Ledger reconciliation output explicit mathematical breakdown',
  );

  return {
    cash,
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    fees,
    netLiquidationValue,
    grossExposure,
    openPositionsCount,
    warnings,
    positions,
  };
}

export async function materializePaperSessionState(
  sessionId: string,
): Promise<ReducedSessionState> {
  const reduced = await reducePaperSessionLedger(sessionId);

  const existing = await prisma.paperCopyPosition.findMany({
    where: { sessionId },
    select: { id: true, marketId: true, outcome: true },
  });
  const existingByKey = new Map(existing.map((row) => [keyFor(row.marketId, row.outcome), row]));
  const touchedKeys = new Set<string>();

  for (const position of reduced.positions) {
    const key = keyFor(position.marketId, position.outcome);
    touchedKeys.add(key);
    const row = existingByKey.get(key);
    const data = {
      marketQuestion: position.marketQuestion,
      netShares: position.netShares,
      avgEntryPrice: position.avgEntryPrice,
      currentMarkPrice: position.currentMarkPrice,
      realizedPnl: position.realizedPnl,
      unrealizedPnl: position.unrealizedPnl,
      status: position.status,
      openedAt: position.openedAt,
      closedAt: position.closedAt,
    };

    if (row) {
      await prisma.paperCopyPosition.update({ where: { id: row.id }, data });
    } else {
      await prisma.paperCopyPosition.create({
        data: { sessionId, marketId: position.marketId, outcome: position.outcome, ...data },
      });
    }
  }

  const staleIds = existing
    .filter((row) => !touchedKeys.has(keyFor(row.marketId, row.outcome)))
    .map((row) => row.id);
  if (staleIds.length > 0) {
    await prisma.paperCopyPosition.deleteMany({ where: { id: { in: staleIds } } });
  }

  await prisma.paperCopySession.update({
    where: { id: sessionId },
    data: { currentCash: reduced.cash },
  });

  if (reduced.warnings.length > 0) {
    logger.warn(
      { sessionId, warnings: reduced.warnings.length },
      'paper ledger invariants warning',
    );
    await prisma.auditLog.create({
      data: {
        category: 'PAPER_ACCOUNTING',
        entityId: sessionId,
        action: 'INVARIANT_WARNING',
        payload: {
          sessionId,
          warnings: reduced.warnings,
          checkedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
  }

  return reduced;
}
