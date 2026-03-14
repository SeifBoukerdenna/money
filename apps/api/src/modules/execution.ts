import { orderErrorCounter, copyLatency } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { applyPaperFill } from './paper-ledger.js';
import { publishEvent } from './event-stream.js';
import { createPolymarketTradingAdapter } from './polymarket.js';

function resolvePaperFillPrice(
  limitPrice: number,
  model: 'BOOK' | 'MID' | 'WORSE' = 'MID',
): number {
  if (model === 'BOOK') {
    return limitPrice;
  }
  if (model === 'WORSE') {
    return Math.min(1, limitPrice * 1.002);
  }
  return limitPrice;
}

async function ensureLiveAllowed(token?: string) {
  if (!config.LIVE_TRADING_ENABLED) {
    throw new Error('LIVE_TRADING_ENABLED=false; live trading blocked');
  }
  if (token !== config.LIVE_TRADING_CONFIRMATION_TOKEN) {
    throw new Error('Live confirmation token mismatch');
  }
}

export async function processExecution(strategyId: string, decisionId: string): Promise<void> {
  const start = Date.now();
  const strategy = await prisma.strategy.findUnique({ where: { id: strategyId } });
  const decision = await prisma.copyDecision.findUnique({
    where: { id: decisionId },
    include: { tradeEvent: true },
  });

  if (!strategy || !decision) {
    return;
  }

  if (decision.action === 'SKIP') {
    await prisma.execution.upsert({
      where: { decisionId: decision.id },
      update: {},
      create: {
        strategyId,
        decisionId: decision.id,
        mode: strategy.mode,
        status: 'SKIPPED',
        externalOrderId: null,
        filledSize: 0,
        avgFillPrice: 0,
        feePaid: 0,
        errorMessage: null,
      },
    });
    return;
  }

  if (strategy.mode === 'PAPER') {
    const fillPrice = resolvePaperFillPrice(Number(decision.limitPrice));
    const fillSize = Number(decision.orderSize);
    const { feePaid, realizedDelta } = await applyPaperFill({
      strategyId,
      marketId: decision.tradeEvent.marketId,
      outcome: decision.tradeEvent.outcome,
      side: decision.side,
      size: fillSize,
      fillPrice,
      feeBps: 20,
    });

    await prisma.execution.upsert({
      where: { decisionId: decision.id },
      update: {},
      create: {
        strategyId,
        decisionId: decision.id,
        mode: 'PAPER',
        status: 'FILLED',
        externalOrderId: `paper-${decision.id}`,
        filledSize: fillSize,
        avgFillPrice: fillPrice,
        feePaid,
        errorMessage: null,
      },
    });

    await prisma.strategy.update({
      where: { id: strategyId },
      data: {
        bankroll: { decrement: feePaid },
        dailyPnl: { increment: realizedDelta },
        lastCopiedTradeAt: new Date(),
      },
    });

    await publishEvent(
      'COPY_TRADE_EXECUTED',
      {
        strategyId,
        decisionId: decision.id,
        mode: 'PAPER',
        status: 'FILLED',
        marketId: decision.tradeEvent.marketId,
        side: decision.side,
        filledSize: fillSize,
        avgFillPrice: fillPrice,
        feePaid,
      },
      decision.id,
    );
  } else {
    try {
      await ensureLiveAllowed(process.env.LIVE_CONFIRMATION_TOKEN);
      const tradingAdapter = createPolymarketTradingAdapter('LIVE');
      const submitted = await tradingAdapter.submitOrder({
        marketId: decision.tradeEvent.marketId,
        outcome: decision.tradeEvent.outcome,
        side: decision.side,
        size: Number(decision.orderSize),
        limitPrice: Number(decision.limitPrice),
        fillStrategy: 'AGGRESSIVE_LIMIT',
        idempotencyKey: decision.idempotencyKey,
      });

      await prisma.execution.upsert({
        where: { decisionId: decision.id },
        update: {},
        create: {
          strategyId,
          decisionId: decision.id,
          mode: 'LIVE',
          status: submitted.status,
          externalOrderId: submitted.orderId,
          filledSize: submitted.filledSize,
          avgFillPrice: submitted.avgFillPrice,
          feePaid: submitted.feePaid,
          errorMessage: null,
        },
      });
      await prisma.strategy.update({
        where: { id: strategyId },
        data: { lastCopiedTradeAt: new Date() },
      });

      await publishEvent(
        'COPY_TRADE_EXECUTED',
        {
          strategyId,
          decisionId: decision.id,
          mode: 'LIVE',
          status: submitted.status,
          marketId: decision.tradeEvent.marketId,
          side: decision.side,
          filledSize: submitted.filledSize,
          avgFillPrice: submitted.avgFillPrice,
          feePaid: submitted.feePaid,
          externalOrderId: submitted.orderId,
        },
        decision.id,
      );
    } catch (error) {
      orderErrorCounter.inc();
      const message = error instanceof Error ? error.message : 'Unknown live execution error';
      await prisma.execution.upsert({
        where: { decisionId: decision.id },
        update: {},
        create: {
          strategyId,
          decisionId: decision.id,
          mode: 'LIVE',
          status: 'FAILED',
          externalOrderId: null,
          filledSize: 0,
          avgFillPrice: 0,
          feePaid: 0,
          errorMessage: message,
        },
      });
      logger.error({ strategyId, decisionId, message }, 'live execution failed');
    }
  }

  await prisma.auditLog.create({
    data: {
      category: 'EXECUTION',
      entityId: decision.id,
      action: strategy.mode,
      payload: {
        strategyId,
      },
    },
  });

  copyLatency.observe(Date.now() - start);
}
