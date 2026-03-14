import { Job } from 'bullmq';

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { queueBacklogGauge } from './lib/metrics.js';
import { prisma } from './lib/prisma.js';
import { processDecision } from './modules/decision.js';
import { processExecution } from './modules/execution.js';
import { processWalletPoll, scheduleWalletPolls } from './modules/ingestion.js';
import { refreshMarketIntelligenceSnapshots } from './modules/market-intelligence.js';
import { tickRunningPaperSessions } from './modules/paper-copy.js';
import { createWorker, decisionQueue, executionQueue, ingestQueue } from './modules/queue.js';
import { reconcileWalletExposure } from './modules/reconciliation.js';
import { createPortfolioSnapshots } from './modules/snapshots.js';
import { refreshWalletAnalyticsSnapshots } from './modules/wallet-analytics.js';
import { createApp } from './app.js';

// ---------------------------------------------------------------------------
// Overlap guard for paper session tick
// Prevents the setInterval from firing a second tick before the first one
// finishes when event processing is slow (was causing duplicate DB writes).
// ---------------------------------------------------------------------------
let _paperTickInFlight = false;

async function safePaperTick() {
  if (_paperTickInFlight) {
    logger.debug('paper tick skipped — previous tick still running');
    return;
  }
  _paperTickInFlight = true;
  try {
    await tickRunningPaperSessions();
  } catch (err) {
    logger.error({ err }, 'paper session tick error');
  } finally {
    _paperTickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const app = await createApp();

  // BullMQ workers
  createWorker('ingest', async (job: Job) => {
    const { walletId, address } = job.data as { walletId: string; address: string };
    await processWalletPoll(walletId, address);
  });

  createWorker('decision', async (job: Job) => {
    const { strategyId, tradeEventId } = job.data as { strategyId: string; tradeEventId: string };
    await processDecision(strategyId, tradeEventId);
  });

  createWorker('execution', async (job: Job) => {
    const { strategyId, decisionId } = job.data as { strategyId: string; decisionId: string };
    await processExecution(strategyId, decisionId);
  });

  // Wallet ingestion scheduler
  const ingestTimer = setInterval(async () => {
    await scheduleWalletPolls();
    const [ingestWaiting, decisionWaiting, executionWaiting] = await Promise.all([
      ingestQueue.getWaitingCount(),
      decisionQueue.getWaitingCount(),
      executionQueue.getWaitingCount(),
    ]);
    queueBacklogGauge.set({ queue: 'ingest' }, ingestWaiting);
    queueBacklogGauge.set({ queue: 'decision' }, decisionWaiting);
    queueBacklogGauge.set({ queue: 'execution' }, executionWaiting);
  }, config.INGEST_POLL_INTERVAL_MS).unref();

  // Portfolio snapshots
  const portfolioTimer = setInterval(async () => {
    await createPortfolioSnapshots();
  }, 15_000).unref();

  // Wallet analytics
  const analyticsTimer = setInterval(async () => {
    await refreshWalletAnalyticsSnapshots();
  }, 30_000).unref();

  // Market intelligence
  const intelligenceTimer = setInterval(async () => {
    await refreshMarketIntelligenceSnapshots();
  }, 20_000).unref();

  // Paper session tick — uses overlap guard to prevent concurrent runs
  const paperTimer = setInterval(safePaperTick, 5_000).unref();

  // Reconciliation (infrequent)
  const reconcileTimer = setInterval(async () => {
    const wallets = await prisma.watchedWallet.findMany({
      where: { enabled: true, copyEnabled: true },
      select: { id: true, address: true },
      take: 100,
    });
    for (const wallet of wallets) {
      await reconcileWalletExposure(wallet.id, wallet.address);
    }
  }, 10 * 60_000).unref();

  // Graceful shutdown — clears all timers so the process exits cleanly
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down gracefully');
    clearInterval(ingestTimer);
    clearInterval(portfolioTimer);
    clearInterval(analyticsTimer);
    clearInterval(intelligenceTimer);
    clearInterval(paperTimer);
    clearInterval(reconcileTimer);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  logger.info({ port: config.API_PORT }, 'api started');
}

main().catch(async (error) => {
  logger.error({ error }, 'fatal startup error');
  await prisma.$disconnect();
  process.exit(1);
});
