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

async function main() {
  const app = await createApp();

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

  setInterval(async () => {
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

  setInterval(async () => {
    await createPortfolioSnapshots();
  }, 15_000).unref();

  setInterval(async () => {
    await refreshWalletAnalyticsSnapshots();
  }, 30_000).unref();

  setInterval(async () => {
    await refreshMarketIntelligenceSnapshots();
  }, 20_000).unref();

  setInterval(async () => {
    await tickRunningPaperSessions();
  }, 5_000).unref();

  setInterval(async () => {
    const wallets = await prisma.watchedWallet.findMany({
      where: { enabled: true, copyEnabled: true },
      select: { id: true, address: true },
      take: 100,
    });
    for (const wallet of wallets) {
      await reconcileWalletExposure(wallet.id, wallet.address);
    }
  }, 10 * 60_000).unref();

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  logger.info({ port: config.API_PORT }, 'api started');
}

main().catch(async (error) => {
  logger.error({ error }, 'fatal startup error');
  await prisma.$disconnect();
  process.exit(1);
});
