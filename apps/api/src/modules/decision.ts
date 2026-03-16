import { decideCopyOrder } from '@copytrader/risk-engine';

import { decisionsCounter, skippedReasonCounter } from '../lib/metrics.js';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createPolymarketDataAdapter } from './polymarket.js';
import { executionQueue } from './queue.js';
import { evaluateSmartCopyFilters } from './smart-copy.js';
import { isTurboModeEnabled } from './latency-profile.js';

const dataAdapter = createPolymarketDataAdapter();

export async function processDecision(strategyId: string, tradeEventId: string): Promise<void> {
  const strategy = await prisma.strategy.findUnique({
    where: { id: strategyId },
    include: { riskConfig: true, wallet: true },
  });
  if (!strategy?.riskConfig) {
    return;
  }
  const event = await prisma.tradeEvent.findUnique({ where: { id: tradeEventId } });
  if (!event) {
    return;
  }

  const market = await dataAdapter.getMarket(event.marketId);
  if (!market) {
    return;
  }

  const exposureRows = await prisma.position.findMany({ where: { strategyId } });
  const currentExposure = exposureRows.reduce(
    (sum: number, row: (typeof exposureRows)[number]) =>
      sum + Number(row.size) * Number(row.avgPrice),
    0,
  );
  const perMarketExposure = exposureRows
    .filter((row: (typeof exposureRows)[number]) => row.marketId === event.marketId)
    .reduce(
      (sum: number, row: (typeof exposureRows)[number]) =>
        sum + Number(row.size) * Number(row.avgPrice),
      0,
    );

  const decision = decideCopyOrder({
    strategyId,
    riskConfig: {
      id: strategy.riskConfig.id,
      strategyId,
      fixedDollar: strategy.riskConfig.fixedDollar ? Number(strategy.riskConfig.fixedDollar) : null,
      pctSourceSize: strategy.riskConfig.pctSourceSize
        ? Number(strategy.riskConfig.pctSourceSize)
        : null,
      pctBankroll: strategy.riskConfig.pctBankroll ? Number(strategy.riskConfig.pctBankroll) : null,
      maxExposure: Number(strategy.riskConfig.maxExposure),
      perMarketMaxAllocation: Number(strategy.riskConfig.perMarketMaxAllocation),
      dailyLossCap: Number(strategy.riskConfig.dailyLossCap),
      maxSlippageBps: strategy.riskConfig.maxSlippageBps,
      minLiquidity: Number(strategy.riskConfig.minLiquidity),
      maxSpreadBps: strategy.riskConfig.maxSpreadBps,
      inverseMode: strategy.riskConfig.inverseMode,
      copyBuys: strategy.riskConfig.copyBuys,
      copySells: strategy.riskConfig.copySells,
      cooldownSeconds: strategy.riskConfig.cooldownSeconds,
      fillStrategy: strategy.riskConfig.fillStrategy as
        | 'AGGRESSIVE_LIMIT'
        | 'PASSIVE_LIMIT'
        | 'MIDPOINT_FALLBACK',
    },
    event: {
      id: event.id,
      sourceEventId: event.sourceEventId,
      sourceWalletAddress: event.sourceWalletAddress,
      marketId: event.marketId,
      outcome: event.outcome,
      side: event.side,
      size: Number(event.size),
      price: Number(event.price),
      tradedAt: event.tradedAt.toISOString(),
      observedAt: event.observedAt.toISOString(),
    },
    market,
    bankroll: Number(strategy.bankroll),
    currentExposure,
    perMarketExposure,
    dailyPnl: Number(strategy.dailyPnl),
    ...(strategy.lastCopiedTradeAt
      ? { lastTradeAtIso: strategy.lastCopiedTradeAt.toISOString() }
      : {}),
  });

  const smartCopyCheck = await evaluateSmartCopyFilters({
    strategyId,
    walletId: strategy.walletId,
    marketId: event.marketId,
    side: event.side,
    sourceTradeUsd: Number(event.size) * Number(event.price),
  });

  if (!smartCopyCheck.allowed) {
    decision.action = 'SKIP';
    decision.reasons.push(...smartCopyCheck.reasons);
  }

  const created = await prisma.copyDecision.upsert({
    where: { idempotencyKey: decision.idempotencyKey },
    update: {},
    create: {
      strategyId,
      tradeEventId,
      action: decision.action,
      side: decision.side,
      orderSize: decision.orderSize,
      limitPrice: decision.limitPrice,
      reasonsJson: decision.reasons,
      idempotencyKey: decision.idempotencyKey,
    },
  });

  await prisma.auditLog.create({
    data: {
      category: 'COPY_DECISION',
      entityId: created.id,
      action: created.action,
      payload: {
        reasons: decision.reasons,
        strategyId,
        tradeEventId,
      },
    },
  });

  decisionsCounter.inc({ action: created.action });
  if (created.action === 'SKIP') {
    const reasons = Array.isArray(created.reasonsJson) ? created.reasonsJson : [];
    for (const reason of reasons as Array<{ code?: string }>) {
      skippedReasonCounter.inc({ reason: reason.code ?? 'UNKNOWN' });
    }
  }

  const strategyUpdateData: Record<string, unknown> = {};
  if (created.action === 'EXECUTE') {
    strategyUpdateData.copiedTradesToday = { increment: 1 };
  }
  if (created.action === 'SKIP') {
    strategyUpdateData.skippedTradesToday = { increment: 1 };
  }

  if (Object.keys(strategyUpdateData).length > 0) {
    await prisma.strategy.update({
      where: { id: strategyId },
      data: strategyUpdateData,
    });
  }

  if (created.action === 'EXECUTE') {
    await executionQueue.add(
      'execute',
      { strategyId, decisionId: created.id },
      {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: isTurboModeEnabled() ? config.TURBO_EXECUTION_BACKOFF_MS : 1000,
        },
      },
    );
  }

  logger.info({ strategyId, tradeEventId, action: created.action }, 'decision completed');
}
