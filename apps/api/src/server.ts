import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { queueBacklogGauge } from './lib/metrics.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { processDecision } from './modules/decision.js';
import { processExecution } from './modules/execution.js';
import { processWalletPoll, scheduleWalletPolls } from './modules/ingestion.js';
import { refreshMarketIntelligenceSnapshots } from './modules/market-intelligence.js';
import { tickRunningPaperSessions } from './modules/paper-copy.js';
import { createWorker, decisionQueue, executionQueue, ingestQueue } from './modules/queue.js';
import { reconcileWalletExposure } from './modules/reconciliation.js';
import {
  incrementWorkerCompleted,
  incrementWorkerFailed,
  markLoopFailure,
  markLoopStart,
  markLoopSuccess,
  markRuntimeStarted,
  markSchedulerLeadership,
  sampleMemoryUsage,
} from './modules/runtime-ops.js';
import { createPortfolioSnapshots } from './modules/snapshots.js';
import { refreshWalletAnalyticsSnapshots } from './modules/wallet-analytics.js';
import { createApp } from './app.js';
import { isTurboModeEnabled } from './modules/latency-profile.js';

// ---------------------------------------------------------------------------
// Overlap guard for paper session tick
// Prevents the setInterval from firing a second tick before the first one
// finishes when event processing is slow (was causing duplicate DB writes).
// ---------------------------------------------------------------------------
let _paperTickInFlight = false;
let _runtimeStarted = false;
const _instanceId = randomUUID();
let _holdsSchedulerLease = false;
let _lastWalletSchedulerRunAt = 0;
let _lastPaperTickRunAt = 0;

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

async function acquireOrRenewSchedulerLease(): Promise<boolean> {
  if (!config.RUNTIME_SCHEDULER_ENABLED) {
    markSchedulerLeadership(true, false);
    return true;
  }

  const ttlMs = Math.max(5_000, config.RUNTIME_SCHEDULER_LEASE_TTL_MS);
  const key = config.RUNTIME_SCHEDULER_LEASE_KEY;

  try {
    if (_holdsSchedulerLease) {
      const current = await redis.get(key);
      if (current === _instanceId) {
        await redis.pexpire(key, ttlMs);
        markSchedulerLeadership(true, true);
        return true;
      }
      _holdsSchedulerLease = false;
    }

    const acquired = await redis.set(key, _instanceId, 'PX', ttlMs, 'NX');
    _holdsSchedulerLease = acquired === 'OK';
    markSchedulerLeadership(_holdsSchedulerLease, _holdsSchedulerLease);
    return _holdsSchedulerLease;
  } catch (error) {
    logger.warn({ error }, 'scheduler lease check failed');
    markSchedulerLeadership(false, false);
    return false;
  }
}

async function runLoopWithLease(
  name:
    | 'wallet-poll-scheduler'
    | 'portfolio-snapshot'
    | 'wallet-analytics'
    | 'market-intelligence'
    | 'paper-session-tick'
    | 'reconciliation'
    | 'memory-sample',
  intervalMs: number,
  fn: () => Promise<void>,
) {
  const leader = await acquireOrRenewSchedulerLease();
  if (!leader) {
    return;
  }

  markLoopStart(name, intervalMs);
  try {
    await fn();
    markLoopSuccess(name, intervalMs);
  } catch (error) {
    markLoopFailure(name, intervalMs, error);
    logger.error({ loop: name, error }, 'runtime loop failed');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (_runtimeStarted) {
    logger.warn('runtime already started; skipping duplicate startup');
    return;
  }
  _runtimeStarted = true;

  markRuntimeStarted({
    instanceId: _instanceId,
    schedulerEnabled: config.RUNTIME_SCHEDULER_ENABLED,
    schedulerLeaseKey: config.RUNTIME_SCHEDULER_LEASE_KEY,
  });

  const app = await createApp();
  const ingestSchedulerBaseMs = 1000;
  const paperTickSchedulerBaseMs = 1000;

  const getIngestLoopIntervalMs = () => {
    if (isTurboModeEnabled()) {
      return Math.max(
        500,
        Math.min(config.INGEST_POLL_INTERVAL_MS, config.TURBO_INGEST_POLL_INTERVAL_MS),
      );
    }
    return config.INGEST_POLL_INTERVAL_MS;
  };

  const getPaperTickIntervalMs = () => {
    if (isTurboModeEnabled()) {
      return Math.max(
        750,
        Math.min(config.PAPER_TICK_INTERVAL_MS, config.TURBO_PAPER_TICK_INTERVAL_MS),
      );
    }
    return config.PAPER_TICK_INTERVAL_MS;
  };

  // BullMQ workers
  const workers = [
    createWorker(
      'ingest',
      async (job: Job) => {
        const { walletId, address } = job.data as { walletId: string; address: string };
        await processWalletPoll(walletId, address);
      },
      { concurrency: config.INGEST_WORKER_CONCURRENCY },
    ),

    createWorker(
      'decision',
      async (job: Job) => {
        const { strategyId, tradeEventId } = job.data as {
          strategyId: string;
          tradeEventId: string;
        };
        await processDecision(strategyId, tradeEventId);
      },
      { concurrency: config.DECISION_WORKER_CONCURRENCY },
    ),

    createWorker(
      'execution',
      async (job: Job) => {
        const { strategyId, decisionId } = job.data as { strategyId: string; decisionId: string };
        await processExecution(strategyId, decisionId);
      },
      { concurrency: config.EXECUTION_WORKER_CONCURRENCY },
    ),
  ];

  for (const worker of workers) {
    worker.on('completed', () => incrementWorkerCompleted());
    worker.on('failed', () => incrementWorkerFailed());
  }

  // Wallet ingestion scheduler
  const ingestTimer = setInterval(async () => {
    const loopInterval = getIngestLoopIntervalMs();
    const now = Date.now();
    if (now - _lastWalletSchedulerRunAt < loopInterval) {
      return;
    }
    _lastWalletSchedulerRunAt = now;

    await runLoopWithLease('wallet-poll-scheduler', loopInterval, async () => {
      await scheduleWalletPolls();
      const [ingestWaiting, decisionWaiting, executionWaiting] = await Promise.all([
        ingestQueue.getWaitingCount(),
        decisionQueue.getWaitingCount(),
        executionQueue.getWaitingCount(),
      ]);
      queueBacklogGauge.set({ queue: 'ingest' }, ingestWaiting);
      queueBacklogGauge.set({ queue: 'decision' }, decisionWaiting);
      queueBacklogGauge.set({ queue: 'execution' }, executionWaiting);
    });
  }, ingestSchedulerBaseMs).unref();

  // Portfolio snapshots
  const portfolioTimer = setInterval(async () => {
    await runLoopWithLease(
      'portfolio-snapshot',
      config.PORTFOLIO_SNAPSHOT_INTERVAL_MS,
      async () => {
        await createPortfolioSnapshots();
      },
    );
  }, config.PORTFOLIO_SNAPSHOT_INTERVAL_MS).unref();

  // Wallet analytics
  const analyticsTimer = setInterval(async () => {
    await runLoopWithLease('wallet-analytics', config.WALLET_ANALYTICS_INTERVAL_MS, async () => {
      await refreshWalletAnalyticsSnapshots();
    });
  }, config.WALLET_ANALYTICS_INTERVAL_MS).unref();

  // Market intelligence
  const intelligenceTimer = setInterval(async () => {
    await runLoopWithLease(
      'market-intelligence',
      config.MARKET_INTELLIGENCE_INTERVAL_MS,
      async () => {
        await refreshMarketIntelligenceSnapshots();
      },
    );
  }, config.MARKET_INTELLIGENCE_INTERVAL_MS).unref();

  // Paper session tick — uses overlap guard to prevent concurrent runs
  const paperTimer = setInterval(async () => {
    const loopInterval = getPaperTickIntervalMs();
    const now = Date.now();
    if (now - _lastPaperTickRunAt < loopInterval) {
      return;
    }
    _lastPaperTickRunAt = now;

    await runLoopWithLease('paper-session-tick', loopInterval, async () => {
      await safePaperTick();
    });
  }, paperTickSchedulerBaseMs).unref();

  // Reconciliation (infrequent)
  const reconcileTimer = setInterval(async () => {
    await runLoopWithLease('reconciliation', config.RECONCILIATION_INTERVAL_MS, async () => {
      const wallets = await prisma.watchedWallet.findMany({
        where: { enabled: true, copyEnabled: true },
        select: { id: true, address: true },
        take: 100,
      });
      for (const wallet of wallets) {
        await reconcileWalletExposure(wallet.id, wallet.address);
      }
    });
  }, config.RECONCILIATION_INTERVAL_MS).unref();

  const memoryTimer = setInterval(async () => {
    await runLoopWithLease('memory-sample', config.OPS_MEMORY_SAMPLE_INTERVAL_MS, async () => {
      sampleMemoryUsage();
    });
  }, config.OPS_MEMORY_SAMPLE_INTERVAL_MS).unref();

  // Kick off once at startup to avoid waiting for first interval boundary.
  await Promise.allSettled([
    runLoopWithLease('wallet-poll-scheduler', getIngestLoopIntervalMs(), async () => {
      await scheduleWalletPolls();
    }),
    runLoopWithLease('paper-session-tick', getPaperTickIntervalMs(), async () => {
      await safePaperTick();
    }),
  ]);

  // Graceful shutdown — clears all timers so the process exits cleanly
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down gracefully');
    clearInterval(ingestTimer);
    clearInterval(portfolioTimer);
    clearInterval(analyticsTimer);
    clearInterval(intelligenceTimer);
    clearInterval(paperTimer);
    clearInterval(reconcileTimer);
    clearInterval(memoryTimer);
    for (const worker of workers) {
      await worker.close();
    }
    if (_holdsSchedulerLease && config.RUNTIME_SCHEDULER_ENABLED) {
      const current = await redis.get(config.RUNTIME_SCHEDULER_LEASE_KEY);
      if (current === _instanceId) {
        await redis.del(config.RUNTIME_SCHEDULER_LEASE_KEY);
      }
    }
    await redis.quit();
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
