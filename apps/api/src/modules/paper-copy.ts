import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { config } from '../config.js';
import { randomUUID } from 'node:crypto';
import { createPolymarketDataAdapter } from './polymarket.js';
import { materializePaperSessionState } from './paper-accounting.js';
import {
  applyProjectedExecution,
  evaluatePaperEventDecision,
  PAPER_REASON_CODES,
} from './paper-decisioning.js';
import { resolvePaperExecutor } from './paper-executor.js';
import { calculateSlippage, type SlippageConfig } from './slippage.js';
import { raiseSystemAlert } from './system-alerts.js';
import { closeResolvedPositions } from './force-close.js';
import { processWalletPoll } from './ingestion.js';
import { paperEndToEndLatency, paperPipelineLatency } from '../lib/metrics.js';
import { reduceTrackedWalletEvents } from './tracked-wallet-performance.js';

const adapter = createPolymarketDataAdapter();
const db = prisma as unknown as Record<string, any>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum metric / snapshot rows kept per session. Older rows are pruned. */
const MAX_METRIC_ROWS = 2000;

/**
 * Minimum milliseconds between successive snapshot writes while a session is
 * running. Prevents the original bug of writing 2 DB rows every 5 s (= 5 760
 * rows per session per overnight run).
 */
const MIN_SNAPSHOT_INTERVAL_MS = 60_000;

/** Maximum activity events processed per tick. Prevents runaway DB load. */
const MAX_EVENTS_PER_TICK = 1500;
const IDLE_MAINTENANCE_INTERVAL_MS = 30_000;
const SOURCE_START_READINESS_MAX_EVENTS = 25_000;
const RELEASE_LOCK_IF_OWNER_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;
const RENEW_LOCK_IF_OWNER_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Per-session in-process lock. Prevents concurrent ticks on the same session
 * from the setInterval in server.ts overlapping when processing is slow.
 * For multi-process deployments replace with a Redis SET NX EX lock.
 */
const _sessionLocks = new Set<string>();

/**
 * Last snapshot timestamp per session (module-level cache).
 * Used to throttle snapshot writes without an extra DB query.
 */
const _lastSnapshotAt = new Map<string, number>();
const _lastIdleMaintenanceAt = new Map<string, number>();

async function evaluateSourceStartReadiness(trackedWalletId: string): Promise<{
  blocked: boolean;
  reasons: string[];
}> {
  const rows = await db.walletActivityEvent.findMany({
    where: { trackedWalletId },
    orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: SOURCE_START_READINESS_MAX_EVENTS + 1,
    select: {
      id: true,
      marketId: true,
      conditionId: true,
      marketQuestion: true,
      outcome: true,
      side: true,
      effectiveSide: true,
      eventType: true,
      price: true,
      shares: true,
      notional: true,
      fee: true,
      rawPayloadJson: true,
      eventTimestamp: true,
      createdAt: true,
    },
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      blocked: false,
      reasons: [],
    };
  }

  const hasTruncatedHistory = rows.length > SOURCE_START_READINESS_MAX_EVENTS;
  const eventsForReduction = rows.slice(-SOURCE_START_READINESS_MAX_EVENTS).map((row: any) => ({
    id: String(row.id),
    marketId: String(row.marketId),
    conditionId: row.conditionId ? String(row.conditionId) : null,
    marketQuestion: row.marketQuestion ? String(row.marketQuestion) : null,
    outcome: row.outcome ? String(row.outcome) : null,
    side: row.side ?? null,
    effectiveSide: row.effectiveSide ?? null,
    eventType: String(row.eventType),
    price: row.price !== null ? Number(row.price) : null,
    shares: row.shares !== null ? Number(row.shares) : null,
    notional: row.notional !== null ? Number(row.notional) : null,
    fee: row.fee !== null ? Number(row.fee) : null,
    feeIsInferred:
      row.rawPayloadJson &&
      typeof row.rawPayloadJson === 'object' &&
      (row.rawPayloadJson as Record<string, unknown>).feeIsInferred === true,
    eventTimestamp: new Date(row.eventTimestamp),
    createdAt: new Date(row.createdAt ?? row.eventTimestamp),
  }));

  const reduced = reduceTrackedWalletEvents({
    events: eventsForReduction,
    inferMissingFields: false,
    hasTruncatedHistory,
  });

  const blocked = reduced.confidenceModel.confidence === 'LOW';
  const reasons: string[] = [];
  if (blocked) {
    reasons.push('low-confidence');
    if (reduced.canonical.canonicalKnownNetPnl === null) {
      reasons.push('canonical-net-unavailable');
    }
  }

  return {
    blocked,
    reasons,
  };
}

function paperTickLockKey(sessionId: string): string {
  return `${config.PAPER_TICK_DISTRIBUTED_LOCK_PREFIX}:${sessionId}`;
}

async function acquireDistributedSessionTickLock(sessionId: string): Promise<string | null> {
  if (!config.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED) {
    return null;
  }

  const token = randomUUID();
  const ttlMs = Math.max(5_000, config.PAPER_TICK_DISTRIBUTED_LOCK_TTL_MS);
  const key = paperTickLockKey(sessionId);
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return acquired === 'OK' ? token : null;
}

async function releaseDistributedSessionTickLock(sessionId: string, token: string): Promise<void> {
  if (!config.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED) {
    return;
  }

  const key = paperTickLockKey(sessionId);
  await redis.eval(RELEASE_LOCK_IF_OWNER_LUA, 1, key, token);
}

function startDistributedSessionTickLockHeartbeat(sessionId: string, token: string): () => void {
  if (!config.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED) {
    return () => undefined;
  }

  const ttlMs = Math.max(5_000, config.PAPER_TICK_DISTRIBUTED_LOCK_TTL_MS);
  const key = paperTickLockKey(sessionId);
  const intervalMs = Math.max(1_000, Math.floor(ttlMs / 3));
  let renewing = false;

  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void redis
      .eval(RENEW_LOCK_IF_OWNER_LUA, 1, key, token, String(ttlMs))
      .then((result) => {
        if (Number(result) !== 1) {
          logger.warn(
            { sessionId },
            'distributed paper tick lock heartbeat could not renew ownership',
          );
        }
      })
      .catch((error) => {
        logger.warn({ sessionId, error }, 'distributed paper tick lock heartbeat failed');
      })
      .finally(() => {
        renewing = false;
      });
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createPaperCopySession(input: {
  trackedWalletId: string;
  startingCash?: number;
  copyRatio?: number;
  maxAllocationPerMarket?: number;
  maxTotalExposure?: number;
  minNotionalThreshold?: number;
  minWalletTrades?: number;
  minWalletWinRate?: number;
  minWalletSharpeLike?: number;
  dailyDrawdownLimitPct?: number;
  autoPauseOnHealthDegradation?: boolean;
  feeBps?: number;
  slippageBps?: number;
  slippageConfig?: any;
}) {
  const wallet = await prisma.watchedWallet.findUnique({
    where: { id: input.trackedWalletId },
    select: { address: true, label: true },
  });
  if (!wallet) throw new Error('Tracked wallet not found');

  const startingCash = input.startingCash ?? 50_000;

  return db.paperCopySession.create({
    data: {
      trackedWalletId: input.trackedWalletId,
      trackedWalletAddress: wallet.address,
      status: 'PAUSED',
      startingCash,
      currentCash: startingCash,
      copyRatio: input.copyRatio ?? 1,
      // Mirror-first defaults: use full cash unless user explicitly tightens limits.
      maxAllocationPerMarket: input.maxAllocationPerMarket ?? startingCash,
      maxTotalExposure: input.maxTotalExposure ?? startingCash,
      minNotionalThreshold: input.minNotionalThreshold ?? 2,
      minWalletTrades: input.minWalletTrades ?? null,
      minWalletWinRate: input.minWalletWinRate ?? null,
      minWalletSharpeLike: input.minWalletSharpeLike ?? null,
      dailyDrawdownLimitPct: input.dailyDrawdownLimitPct ?? null,
      autoPauseOnHealthDegradation: input.autoPauseOnHealthDegradation ?? false,
      // Polymarket charges a 2% taker fee (200 bps) on all orders.
      // Makers get 0% — but as a copy-follower you are always a taker.
      // Slippage of 20 bps is a conservative estimate for liquid mid-cap markets.
      // Illiquid / newly listed markets can see 50-150 bps slippage.
      feeBps: input.feeBps ?? 200,
      slippageBps: input.slippageBps ?? 20,
      slippageConfig: input.slippageConfig ?? null,
    },
  });
}

export async function startPaperCopySession(sessionId: string, options?: { forceStart?: boolean }) {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');
  if (session.status === 'RUNNING') return;

  const forceStart = options?.forceStart ?? false;
  if (!forceStart) {
    const readiness = await evaluateSourceStartReadiness(String(session.trackedWalletId));
    if (readiness.blocked) {
      throw new Error(
        `Session start blocked by source confidence gate: ${readiness.reasons.join(', ')}`,
      );
    }
  }

  const startedAt = new Date();

  await db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      status: 'RUNNING',
      startedAt,
      copyRatio: session.copyRatio ?? 1,
      estimatedSourceExposure: null,
    },
  });

  await materializePaperSessionState(sessionId);

  // Immediately run a tick to catch events that arrived during startup.
  await _runTick(sessionId);
}

export async function pausePaperCopySession(sessionId: string) {
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: { status: 'PAUSED' },
  });
}

export async function resumePaperCopySession(sessionId: string) {
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: { status: 'RUNNING' },
  });
}

export async function updatePaperCopySessionGuardrails(
  sessionId: string,
  input: {
    minWalletTrades?: number | null | undefined;
    minWalletWinRate?: number | null | undefined;
    minWalletSharpeLike?: number | null | undefined;
    dailyDrawdownLimitPct?: number | null | undefined;
    autoPauseOnHealthDegradation?: boolean | undefined;
  },
) {
  return db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      ...(input.minWalletTrades !== undefined ? { minWalletTrades: input.minWalletTrades } : {}),
      ...(input.minWalletWinRate !== undefined ? { minWalletWinRate: input.minWalletWinRate } : {}),
      ...(input.minWalletSharpeLike !== undefined
        ? { minWalletSharpeLike: input.minWalletSharpeLike }
        : {}),
      ...(input.dailyDrawdownLimitPct !== undefined
        ? { dailyDrawdownLimitPct: input.dailyDrawdownLimitPct }
        : {}),
      ...(input.autoPauseOnHealthDegradation !== undefined
        ? { autoPauseOnHealthDegradation: input.autoPauseOnHealthDegradation }
        : {}),
    },
  });
}

export async function getPaperCopySessionAnalytics(sessionId: string) {
  const [
    session,
    decisions,
    trades,
    positions,
    latestSnapshot,
    totalTradeCount,
    totalDecisionCount,
    buyTradeCount,
    sellTradeCount,
    redeemDecisionCount,
  ] = await Promise.all([
    db.paperCopySession.findUnique({ where: { id: sessionId } }),
    db.paperCopyDecision.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    }),
    db.paperCopyTrade.findMany({
      where: { sessionId },
      orderBy: { eventTimestamp: 'desc' },
      take: 5000,
    }),
    db.paperCopyPosition.findMany({ where: { sessionId } }),
    db.paperPortfolioSnapshot.findFirst({
      where: { sessionId },
      orderBy: { timestamp: 'desc' },
      select: { netLiquidationValue: true },
    }),
    db.paperCopyTrade.count({ where: { sessionId } }),
    db.paperCopyDecision.count({ where: { sessionId } }),
    db.paperCopyTrade.count({ where: { sessionId, side: 'BUY' } }),
    db.paperCopyTrade.count({ where: { sessionId, side: 'SELL' } }),
    db.paperCopyDecision.count({
      where: {
        sessionId,
        status: 'EXECUTED',
        notes: 'REDEEM',
      },
    }),
  ]);

  if (!session) {
    return null;
  }

  const decisionBreakdown = decisions.reduce((acc: Record<string, number>, row: any) => {
    const key = row.reasonCode ?? 'UNKNOWN';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const statusBreakdown = decisions.reduce((acc: Record<string, number>, row: any) => {
    const key = row.status ?? 'UNKNOWN';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const marketPnl = positions.reduce((acc: Record<string, number>, row: any) => {
    const key = row.marketQuestion ?? row.marketId;
    const pnl = Number(row.realizedPnl) + Number(row.unrealizedPnl);
    acc[key] = (acc[key] ?? 0) + pnl;
    return acc;
  }, {});

  const largestTrade = trades.reduce((best: any, row: any) => {
    const notional = Math.abs(Number(row.notional));
    if (!best || notional > best.notional) {
      return {
        id: row.id,
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        side: row.side,
        notional,
        eventTimestamp: row.eventTimestamp,
      };
    }
    return best;
  }, null);

  const skippedWithNotional = decisions
    .filter((row: any) => row.status === 'SKIPPED')
    .map((row: any) => ({
      id: row.id,
      marketId: row.marketId,
      marketQuestion: row.marketQuestion,
      side: row.side,
      reasonCode: row.reasonCode,
      notional:
        Number(row.sourceShares ?? 0) *
        Number(row.sourcePrice ?? row.intendedFillPrice ?? 0) *
        Number(row.copyRatio ?? 1),
      createdAt: row.createdAt,
    }))
    .sort((a: any, b: any) => b.notional - a.notional);

  const nlv = latestSnapshot
    ? Number(latestSnapshot.netLiquidationValue)
    : Number(session.currentCash);
  const realizedPnl = positions.reduce((sum: number, row: any) => sum + Number(row.realizedPnl), 0);
  const unrealizedPnl = positions
    .filter((row: any) => row.status === 'OPEN')
    .reduce((sum: number, row: any) => sum + Number(row.unrealizedPnl), 0);
  const totalFees = trades.reduce((sum: number, row: any) => sum + Number(row.feeApplied ?? 0), 0);
  const netPnl = realizedPnl + unrealizedPnl - totalFees;
  const openPositionCount = positions.filter((row: any) => row.status === 'OPEN').length;
  const openPositionGrossExposure = positions
    .filter((row: any) => row.status === 'OPEN')
    .reduce(
      (sum: number, row: any) =>
        sum + Math.abs(Number(row.netShares) * Number(row.currentMarkPrice)),
      0,
    );
  const realizedFraction = Math.abs(netPnl) > 1e-9 ? realizedPnl / netPnl : null;
  const unrealizedFraction = Math.abs(netPnl) > 1e-9 ? unrealizedPnl / Math.abs(netPnl) : 0;
  const dataQualityWarnings: string[] = [];
  if (Math.abs(netPnl) > 1e-9 && unrealizedPnl / Math.abs(netPnl) > 0.25) {
    dataQualityWarnings.push(
      'More than 25% of net PnL is unrealized. Result is sensitive to current mark prices and may change on resolution.',
    );
  }
  const startedAtMs = session.startedAt ? new Date(session.startedAt).getTime() : null;
  const endedAtMs = session.endedAt ? new Date(session.endedAt).getTime() : null;
  const runtimeSeconds =
    startedAtMs === null
      ? 0
      : Math.max(0, Math.floor(((endedAtMs ?? Date.now()) - startedAtMs) / 1000));

  const executedWithSlippage = decisions.filter((d: any) => {
    if (String(d.status) !== 'EXECUTED') return false;
    const sr = (d?.sizingInputsJson as Record<string, any> | null)?.slippageResult;
    return sr && typeof sr === 'object';
  });

  const frictionTotals = executedWithSlippage.reduce(
    (
      acc: {
        count: number;
        latencyMs: number;
        totalLatencyMs: number;
        slippageBps: number;
        driftBps: number;
        totalAdverseBps: number;
      },
      d: any,
    ) => {
      const sr = (d?.sizingInputsJson as Record<string, any>).slippageResult as Record<string, any>;
      acc.count += 1;
      acc.latencyMs += Number(sr.latencyApplied ?? 0);
      acc.totalLatencyMs += Number(
        (d?.sizingInputsJson as Record<string, any>)?.totalObservedLatencyMs ?? 0,
      );
      acc.slippageBps += Number(sr.slippageBps ?? 0);
      acc.driftBps += Number(sr.driftBps ?? 0);
      acc.totalAdverseBps += Number(sr.totalAdverseBps ?? sr.slippageBps ?? 0);
      return acc;
    },
    { count: 0, latencyMs: 0, totalLatencyMs: 0, slippageBps: 0, driftBps: 0, totalAdverseBps: 0 },
  );

  const frictionAverages =
    frictionTotals.count > 0
      ? {
          avgLatencyMs: frictionTotals.latencyMs / frictionTotals.count,
          avgTotalLatencyMs: frictionTotals.totalLatencyMs / frictionTotals.count,
          avgSlippageBps: frictionTotals.slippageBps / frictionTotals.count,
          avgDriftBps: frictionTotals.driftBps / frictionTotals.count,
          avgTotalAdverseBps: frictionTotals.totalAdverseBps / frictionTotals.count,
        }
      : {
          avgLatencyMs: 0,
          avgTotalLatencyMs: 0,
          avgSlippageBps: 0,
          avgDriftBps: 0,
          avgTotalAdverseBps: 0,
        };

  const skippedDueToMaxAdverseMoveRows = decisions.filter(
    (row: any) =>
      String(row.status) === 'SKIPPED' &&
      String(row.reasonCode) === PAPER_REASON_CODES.SKIP_MAX_ADVERSE_MOVE,
  );
  const skippedDueToMaxAdverseMove = skippedDueToMaxAdverseMoveRows.length;
  const skippedNotionalForegoone = skippedDueToMaxAdverseMoveRows.reduce(
    (sum: number, row: any) => {
      const sourceNotional = Number(
        (row?.sizingInputsJson as Record<string, any> | null)?.sourceNotional ??
          Number(row.sourceShares ?? 0) * Number(row.sourcePrice ?? 0),
      );
      return sum + Math.abs(Number.isFinite(sourceNotional) ? sourceNotional : 0);
    },
    0,
  );
  const maxAdverseMovePercent = Number(
    (session.slippageConfig as Record<string, any> | null)?.maxAdverseMovePercent ?? 0,
  );
  const conservativeSkipLoss = skippedNotionalForegoone * Math.max(0, maxAdverseMovePercent);
  const grossIncludingSkips = {
    netPnlIfAllSkipsExecutedAtMaxAdverse: nlv - Number(session.startingCash) - conservativeSkipLoss,
    skippedTradeCount: skippedDueToMaxAdverseMove,
    skippedNotional: skippedNotionalForegoone,
  };
  const summaryWarnings: string[] = [];
  if (skippedDueToMaxAdverseMove > 0) {
    summaryWarnings.push(
      `Reported net PnL excludes ${skippedDueToMaxAdverseMove} trades skipped for adverse move. Conservative lower bound including skips: $${grossIncludingSkips.netPnlIfAllSkipsExecutedAtMaxAdverse.toFixed(2)}`,
    );
  }

  return {
    sessionId,
    summary: {
      startingCash: Number(session.startingCash),
      currentNlv: nlv,
      totalPnl: nlv - Number(session.startingCash),
      realizedPnl,
      unrealizedPnl,
      totalFees,
      netPnl,
      realizedFraction,
      openPositionCount,
      openPositionGrossExposure,
      unrealizedFraction,
      dataQualityWarnings,
      trades: totalTradeCount,
      decisions: totalDecisionCount,
      openPositions: openPositionCount,
      closedPositions: positions.filter((row: any) => row.status === 'CLOSED').length,
      runtimeSeconds,
      tradeHistory: {
        buys: buyTradeCount,
        sells: sellTradeCount,
        redeems: redeemDecisionCount,
        totalTrades: totalTradeCount,
      },
      executionFriction: {
        samples: frictionTotals.count,
        ...frictionAverages,
      },
      skippedDueToMaxAdverseMove,
      skippedNotionalForegoone,
      grossIncludingSkips,
      warnings: summaryWarnings,
    },
    decisionBreakdown,
    executionStatusBreakdown: statusBreakdown,
    topMarketPnl: Object.entries(marketPnl)
      .map(([market, pnl]) => ({ market, pnl: Number(pnl) }))
      .sort((a, b) => Math.abs(Number(b.pnl)) - Math.abs(Number(a.pnl)))
      .slice(0, 8),
    largestExecutedTrade: largestTrade,
    largestSkippedOpportunity: skippedWithNotional[0] ?? null,
    recentSkippedOpportunities: skippedWithNotional.slice(0, 10),
  };
}

export async function stopPaperCopySession(sessionId: string) {
  _sessionLocks.delete(sessionId);
  _lastSnapshotAt.delete(sessionId);
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: { status: 'COMPLETED', endedAt: new Date() },
  });
  await _writeSnapshot(sessionId, { force: true });
}

/**
 * Stop all RUNNING sessions and mark them COMPLETED.
 * Does NOT delete data — use deletePaperCopySession for that.
 * Returns how many sessions were stopped.
 */
export async function killAllPaperSessions(): Promise<{ stopped: number }> {
  const running = await db.paperCopySession.findMany({
    where: { status: 'RUNNING' },
    select: { id: true },
  });

  // Release any in-process locks first
  for (const s of running) {
    _sessionLocks.delete(s.id);
    _lastSnapshotAt.delete(s.id);
  }

  if (running.length === 0) return { stopped: 0 };

  await db.paperCopySession.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'COMPLETED', endedAt: new Date() },
  });

  // Write final snapshots for each (fire-and-forget, don't block the response)
  Promise.allSettled(
    running.map((s: { id: string }) => _writeSnapshot(s.id, { force: true })),
  ).catch((err) => logger.warn({ err }, 'killAll: some final snapshots failed'));

  logger.info({ stopped: running.length }, 'kill-all paper sessions');
  return { stopped: running.length };
}

/**
 * Permanently delete a single session and all its associated data
 * (trades, positions, snapshots, metric points).
 * Safe to call on any status including RUNNING — releases lock first.
 */
export async function deletePaperCopySession(sessionId: string): Promise<void> {
  _sessionLocks.delete(sessionId);
  _lastSnapshotAt.delete(sessionId);
  // Cascade deletes handle trades/positions/snapshots/metricPoints
  await db.paperCopySession.delete({ where: { id: sessionId } });
  logger.info({ sessionId }, 'paper session deleted');
}

/**
 * Repair a corrupted session.
 *
 * What "corrupted" means in practice:
 *   - Status stuck as RUNNING after a crash with no recent events processed
 *   - currentCash drifted from reality (race condition bug, now fixed)
 *   - Position netShares out of sync with trade history
 *   - Negative cash balance that shouldn't exist
 *
 * Repair strategy:
 *   1. Force status → PAUSED (safe state, user can restart from here)
 *   2. Recalculate currentCash by replaying all trades from startingCash
 *   3. Recalculate each position's netShares and avgEntryPrice from its trades
 *   4. Fix any OPEN positions with netShares ≤ 0 → mark CLOSED
 *   5. Write a fresh snapshot so the chart reflects repaired state
 *   6. Return a summary of what was corrected
 */
export async function repairPaperCopySession(sessionId: string): Promise<{
  previousStatus: string;
  cashBefore: number;
  cashAfter: number;
  positionsFixed: number;
  snapshotWritten: boolean;
}> {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');

  // FIX-8: Acquire the session lock instead of blindly deleting it.
  // If a tick is in progress, refuse to repair — user should pause first.
  if (_sessionLocks.has(sessionId)) {
    throw new Error(
      'Session tick is currently in progress — pause the session first, then repair.',
    );
  }

  _sessionLocks.add(sessionId);
  _lastSnapshotAt.delete(sessionId);

  try {
    const previousStatus = session.status;
    const cashBefore = Number(session.currentCash);

    await db.paperCopySession.update({
      where: { id: sessionId },
      data: { status: 'PAUSED' },
    });

    const before = await db.paperCopyPosition.findMany({ where: { sessionId } });
    const after = await materializePaperSessionState(sessionId);
    const afterRows = await db.paperCopyPosition.findMany({ where: { sessionId } });
    const positionsFixed = Math.abs(before.length - afterRows.length);

    await _writeSnapshot(sessionId, { force: true });

    logger.info(
      { sessionId, previousStatus, cashBefore, cashAfter: after.cash, positionsFixed },
      'session repaired',
    );

    return {
      previousStatus,
      cashBefore,
      cashAfter: after.cash,
      positionsFixed,
      snapshotWritten: true,
    };
  } finally {
    _sessionLocks.delete(sessionId);
  }
}

/**
 * Reconcile simulated positions against the source wallet's CURRENT Polymarket positions.
 *
 * This is the nuclear option when polling missed SELL/CLOSE/REDEEM events.
 * It calls the Polymarket positions API directly, compares against our open positions,
 * and closes any simulated position that no longer exists on-chain.
 *
 * Also runs the standard repair (cash recalculation) after closing.
 */
export async function reconcilePaperSessionPositions(sessionId: string): Promise<{
  openOnChain: number;
  openInSim: number;
  closedByReconciliation: number;
  cashRecalculated: boolean;
  skipped?: boolean;
  reason?: string;
}> {
  // FIX-8: Acquire the session lock instead of blindly deleting it.
  // If a tick is currently in progress, skip reconciliation — the caller can retry.
  // The old code called `_sessionLocks.delete(sessionId)` here, which cleared
  // any existing lock and allowed a concurrent tick + reconciliation to run
  // simultaneously, creating duplicate trade records.
  if (_sessionLocks.has(sessionId)) {
    logger.warn({ sessionId }, 'reconciliation skipped — session tick in progress');
    return {
      openOnChain: 0,
      openInSim: 0,
      closedByReconciliation: 0,
      cashRecalculated: false,
      skipped: true,
      reason: 'Session tick in progress — retry after current tick completes',
    };
  }

  _sessionLocks.add(sessionId);

  try {
    const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error('Session not found');

    // Fetch current open positions from Polymarket (ground truth)
    const livePositions = await adapter.getWalletPositions(
      session.trackedWalletAddress,
      'OPEN',
      200,
    );

    // Build a set of market+outcome combos that are still open on-chain
    const liveOpenKeys = new Set(
      livePositions.map((p) => `${p.conditionId}:${p.outcome.toUpperCase()}`),
    );

    // Get all simulated open positions
    const simOpen: Array<Record<string, any>> = await db.paperCopyPosition.findMany({
      where: { sessionId, status: 'OPEN' },
    });

    let closedByReconciliation = 0;
    const now = new Date();

    for (const pos of simOpen) {
      const key = `${pos.marketId}:${(pos.outcome ?? '').toUpperCase()}`;
      if (!liveOpenKeys.has(key)) {
        const markPrice = Number(pos.currentMarkPrice);
        const closeShares = Number(pos.netShares);

        await db.paperCopyTrade.create({
          data: {
            sessionId,
            trackedWalletId: session.trackedWalletId,
            walletAddress: session.trackedWalletAddress,
            sourceType: 'RECONCILIATION',
            sourceEventTimestamp: null,
            sourceTxHash: null,
            executorType: 'PAPER_SESSION_ENGINE',
            isBootstrap: false,
            sourceActivityEventId: null,
            marketId: pos.marketId,
            marketQuestion: pos.marketQuestion ?? null,
            outcome: pos.outcome,
            side: 'SELL',
            action: 'RECONCILE_CLOSE',
            sourcePrice: markPrice,
            simulatedPrice: markPrice,
            sourceShares: closeShares,
            simulatedShares: closeShares,
            notional: closeShares * markPrice,
            feeApplied: 0,
            slippageApplied: 0,
            eventTimestamp: now,
            processedAt: now,
            reasoning: {
              type: 'RECONCILE_CLOSE',
              reason: 'Position no longer open on Polymarket — closed by reconciliation',
            },
          },
        });

        closedByReconciliation++;
        logger.info(
          { sessionId, marketId: pos.marketId, outcome: pos.outcome, closeShares, markPrice },
          'position closed by reconciliation',
        );
      }
    }

    await materializePaperSessionState(sessionId);
    await _writeSnapshot(sessionId, { force: true });

    return {
      openOnChain: livePositions.length,
      openInSim: simOpen.length,
      closedByReconciliation,
      cashRecalculated: false,
    };
  } finally {
    // Always release the lock, even if an error occurred
    _sessionLocks.delete(sessionId);
  }
}

/**
 * Called by the scheduler in server.ts every 5 s.
 * Processes new activity events for all RUNNING sessions sequentially.
 */
export async function tickRunningPaperSessions() {
  const sessions = await db.paperCopySession.findMany({
    where: { status: 'RUNNING' },
    select: { id: true },
  });
  // Run in parallel but each session is internally locked
  await Promise.allSettled(sessions.map((s: { id: string }) => processPaperSessionTick(s.id)));
}

/** Public single-session tick (also used in routes for on-demand ticks). */
export async function processPaperSessionTick(sessionId: string) {
  return _runTick(sessionId);
}

/**
 * Returns health/freshness data for the session dashboard.
 * Powers GET /paper-copy-sessions/:id/health
 */
export async function getSessionHealth(sessionId: string) {
  const session = await db.paperCopySession.findUnique({
    where: { id: sessionId },
    include: {
      trackedWallet: {
        select: {
          syncStatus: true,
          lastSyncAt: true,
          lastSyncError: true,
          nextPollAt: true,
        },
      },
    },
  });
  if (!session) return null;

  const [latestEvent, invariantAlert] = await Promise.all([
    db.walletActivityEvent.findFirst({
      where: { trackedWalletId: session.trackedWalletId },
      orderBy: { eventTimestamp: 'desc' },
      select: { eventTimestamp: true },
    }),
    db.systemAlert.findFirst({
      where: {
        sessionId,
        alertType: 'PAPER_ACCOUNTING_INVARIANT_MISMATCH',
      },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        severity: true,
        status: true,
        title: true,
        message: true,
        payloadJson: true,
        lastSeenAt: true,
      },
    }),
  ]);

  const nowMs = Date.now();
  const lastProcessedMs =
    session.lastProcessedEventAt?.getTime() ?? session.startedAt?.getTime() ?? nowMs;
  const lagSeconds = Math.floor((nowMs - lastProcessedMs) / 1000);

  return {
    status: session.status,
    lastProcessedEventAt: session.lastProcessedEventAt ?? null,
    lagSeconds,
    isStale: lagSeconds > 120 && session.status === 'RUNNING',
    consecutiveDecisionFailures: Number(session.consecutiveDecisionFailures ?? 0),
    lastAutoPausedAt: session.lastAutoPausedAt ?? null,
    walletSyncStatus: session.trackedWallet?.syncStatus ?? 'UNKNOWN',
    walletLastSyncAt: session.trackedWallet?.lastSyncAt ?? null,
    walletLastSyncError: session.trackedWallet?.lastSyncError ?? null,
    walletNextPollAt: session.trackedWallet?.nextPollAt ?? null,
    latestSourceEventAt: latestEvent?.eventTimestamp ?? null,
    accountingInvariant:
      invariantAlert == null
        ? null
        : {
            severity: invariantAlert.severity,
            status: invariantAlert.status,
            title: invariantAlert.title,
            message: invariantAlert.message,
            payload: invariantAlert.payloadJson,
            lastSeenAt: invariantAlert.lastSeenAt,
          },
  };
}

// ---------------------------------------------------------------------------
// Internal: tick with per-session lock
// ---------------------------------------------------------------------------

async function _runTick(sessionId: string): Promise<void> {
  if (_sessionLocks.has(sessionId)) {
    logger.debug({ sessionId }, 'paper tick skipped — previous tick still running');
    return;
  }

  _sessionLocks.add(sessionId);

  let distributedLockToken: string | null = null;
  let stopDistributedHeartbeat: (() => void) | null = null;
  try {
    if (config.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED) {
      distributedLockToken = await acquireDistributedSessionTickLock(sessionId);
      if (!distributedLockToken) {
        logger.debug({ sessionId }, 'paper tick skipped — distributed session lock not acquired');
        return;
      }
      stopDistributedHeartbeat = startDistributedSessionTickLockHeartbeat(
        sessionId,
        distributedLockToken,
      );
    }

    await _runTickUnsafe(sessionId);
  } catch (err) {
    logger.error({ sessionId, err }, 'paper session tick threw unexpectedly');
  } finally {
    if (stopDistributedHeartbeat) {
      stopDistributedHeartbeat();
    }
    if (distributedLockToken) {
      await releaseDistributedSessionTickLock(sessionId, distributedLockToken).catch((error) => {
        logger.warn({ sessionId, error }, 'failed to release distributed paper tick lock');
      });
    }
    _sessionLocks.delete(sessionId);
  }
}

async function _runTickUnsafe(sessionId: string): Promise<void> {
  const tickStartedMs = Date.now();
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== 'RUNNING') return;

  // Pull fresh source activity through the same ingestion pipeline used by Wallet Tracker
  // so paper sessions always consume the latest normalized activity feed.
  const pollStartedMs = Date.now();
  await processWalletPoll(session.trackedWalletId, session.trackedWalletAddress).catch((err) =>
    logger.warn({ sessionId, err }, 'wallet poll from paper tick failed (non-fatal)'),
  );
  paperPipelineLatency.observe({ stage: 'wallet_poll' }, Date.now() - pollStartedMs);

  const wallet = await db.watchedWallet.findUnique({
    where: { id: session.trackedWalletId },
    select: { id: true, syncStatus: true, lastSyncAt: true },
  });

  if (session.autoPauseOnHealthDegradation && wallet) {
    const staleMs = wallet.lastSyncAt
      ? Date.now() - wallet.lastSyncAt.getTime()
      : Number.POSITIVE_INFINITY;
    const walletHealthy = wallet.syncStatus === 'ACTIVE' && staleMs <= 5 * 60_000;
    if (!walletHealthy) {
      await db.paperCopySession.update({
        where: { id: sessionId },
        data: {
          status: 'PAUSED',
          lastAutoPausedAt: new Date(),
        },
      });
      await raiseSystemAlert({
        dedupeKey: `SESSION_HEALTH:${sessionId}`,
        alertType: 'SESSION_HEALTH_DEGRADED',
        severity: 'WARN',
        title: 'Session auto-paused due to source wallet health',
        message: `Session ${sessionId} paused because wallet sync is degraded (${wallet.syncStatus}).`,
        walletId: session.trackedWalletId,
        sessionId,
        payloadJson: {
          syncStatus: wallet.syncStatus,
          lastSyncAt: wallet.lastSyncAt?.toISOString() ?? null,
          staleSeconds: Number.isFinite(staleMs) ? Math.floor(staleMs / 1000) : null,
        },
      });
      return;
    }
  }

  const startedAt: Date = session.startedAt ?? session.createdAt;
  const lastWatermark = session.lastProcessedEventAt ?? startedAt;
  const overlapStart = new Date(lastWatermark.getTime() - 2 * 15_000);

  // Fetch activity events after the last watermark.
  // CRITICAL: Do NOT filter on `side`, `price`, or `shares` here.
  // Polymarket sends:
  //   - SELL/CLOSE events with side=null (eventType is the only signal)
  //   - REDEEM events (market resolution) with price=null, shares=null, side=null
  //     for worthless positions ($0 payout). These STILL need to close the position.
  // Phase 3: fetch all event types and record explicit SKIP decisions for
  // unsupported/non-copy events rather than silently dropping them.
  const eventFetchStartedMs = Date.now();
  const newEvents: Array<Record<string, any>> = await db.walletActivityEvent.findMany({
    where: {
      trackedWalletId: session.trackedWalletId,
      // Small overlap window allows retrying recently skipped events after guardrail/config changes.
      // Dedupe safety is guaranteed by per-event decision upsert keyed by sourceActivityEventId.
      eventTimestamp: { gte: overlapStart },
    },
    orderBy: [{ eventTimestamp: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_EVENTS_PER_TICK,
  });
  paperPipelineLatency.observe({ stage: 'event_fetch' }, Date.now() - eventFetchStartedMs);

  if (newEvents.length === 0) {
    const lastMaintenance = _lastIdleMaintenanceAt.get(sessionId) ?? 0;
    const nowMs = Date.now();
    if (nowMs - lastMaintenance < IDLE_MAINTENANCE_INTERVAL_MS) {
      const autoCloseResult = await closeResolvedPositions(sessionId).catch((err) => {
        logger.warn({ sessionId, err }, 'auto-close-resolved failed (non-fatal)');
        return null;
      });
      if (autoCloseResult && Number(autoCloseResult.closed) > 0) {
        await _writeSnapshot(sessionId, { force: true });
      }
      paperPipelineLatency.observe({ stage: 'tick_total' }, nowMs - tickStartedMs);
      return;
    }

    _lastIdleMaintenanceAt.set(sessionId, nowMs);
    const maintenanceStartedMs = Date.now();
    await materializePaperSessionState(sessionId);
    await _writeSnapshot(sessionId);
    const autoCloseResult = await closeResolvedPositions(sessionId).catch((err) => {
      logger.warn({ sessionId, err }, 'auto-close-resolved failed (non-fatal)');
      return null;
    });
    if (autoCloseResult && Number(autoCloseResult.closed) > 0) {
      await _writeSnapshot(sessionId, { force: true });
    }
    paperPipelineLatency.observe({ stage: 'idle_maintenance' }, Date.now() - maintenanceStartedMs);
    paperPipelineLatency.observe({ stage: 'tick_total' }, Date.now() - tickStartedMs);
    return;
  }

  _lastIdleMaintenanceAt.set(sessionId, Date.now());

  const reducedBefore = await materializePaperSessionState(sessionId);

  if (session.dailyDrawdownLimitPct !== null && session.dailyDrawdownLimitPct !== undefined) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayAnchorSnapshot = await db.paperPortfolioSnapshot.findFirst({
      where: {
        sessionId,
        timestamp: { gte: dayStart },
      },
      orderBy: { timestamp: 'asc' },
      select: { netLiquidationValue: true },
    });

    const anchorNlv = dayAnchorSnapshot
      ? Number(dayAnchorSnapshot.netLiquidationValue)
      : Number(session.startingCash);
    const dailyPct =
      anchorNlv > 0 ? ((reducedBefore.netLiquidationValue - anchorNlv) / anchorNlv) * 100 : 0;
    const limitPct = Number(session.dailyDrawdownLimitPct);

    if (dailyPct <= -Math.abs(limitPct)) {
      await db.paperCopySession.update({
        where: { id: sessionId },
        data: {
          status: 'PAUSED',
          lastAutoPausedAt: new Date(),
        },
      });
      await raiseSystemAlert({
        dedupeKey: `SESSION_DRAWDOWN:${sessionId}`,
        alertType: 'SESSION_DRAWDOWN_BREACH',
        severity: 'CRITICAL',
        title: 'Session auto-paused due to drawdown limit',
        message: `Session ${sessionId} hit drawdown ${dailyPct.toFixed(2)}% (limit -${Math.abs(limitPct).toFixed(2)}%).`,
        walletId: session.trackedWalletId,
        sessionId,
        payloadJson: {
          dailyReturnPct: dailyPct,
          drawdownLimitPct: -Math.abs(limitPct),
          anchorNlv,
          currentNlv: reducedBefore.netLiquidationValue,
        },
      });
      return;
    }
  }

  const latestWalletAnalytics = await db.walletAnalyticsSnapshot.findFirst({
    where: { walletId: session.trackedWalletId },
    orderBy: { createdAt: 'desc' },
  });

  const walletQualityBlockReason = (() => {
    if (!latestWalletAnalytics) return null;
    const tradeCount = Number(latestWalletAnalytics.totalTrades ?? 0);
    const winRate = Number(latestWalletAnalytics.winRate ?? 0);
    const sharpeLike = Number(latestWalletAnalytics.sharpeLike ?? 0);

    if (
      session.minWalletTrades !== null &&
      session.minWalletTrades !== undefined &&
      tradeCount < Number(session.minWalletTrades)
    ) {
      return `Trade count ${tradeCount} below minimum ${Number(session.minWalletTrades)}.`;
    }
    if (
      session.minWalletWinRate !== null &&
      session.minWalletWinRate !== undefined &&
      winRate < Number(session.minWalletWinRate)
    ) {
      return `Win rate ${(winRate * 100).toFixed(1)}% below minimum ${(Number(session.minWalletWinRate) * 100).toFixed(1)}%.`;
    }
    if (
      session.minWalletSharpeLike !== null &&
      session.minWalletSharpeLike !== undefined &&
      sharpeLike < Number(session.minWalletSharpeLike)
    ) {
      return `Sharpe-like ${sharpeLike.toFixed(3)} below minimum ${Number(session.minWalletSharpeLike).toFixed(3)}.`;
    }
    return null;
  })();

  const executor = resolvePaperExecutor('PAPER');
  const positionStateByKey = new Map(
    reducedBefore.positions.map((position) => [
      `${position.marketId}:${position.outcome.toUpperCase()}`,
      {
        marketId: position.marketId,
        outcome: position.outcome.toUpperCase(),
        avgEntryPrice: position.avgEntryPrice,
        netShares: position.netShares,
        marketQuestion: position.marketQuestion,
      },
    ]),
  );
  let projectedCash = reducedBefore.cash;
  let projectedGrossExposure = reducedBefore.grossExposure;

  const eventIds = newEvents.map((event) => String(event.id));
  const [existingDecisions, existingExecutions] = await Promise.all([
    db.paperCopyDecision.findMany({
      where: {
        sessionId,
        sourceActivityEventId: { in: eventIds },
      },
      select: {
        id: true,
        sourceActivityEventId: true,
        status: true,
        reasonCode: true,
      },
    }),
    db.paperCopyTrade.findMany({
      where: {
        sessionId,
        sourceActivityEventId: { in: eventIds },
      },
      select: {
        id: true,
        sourceActivityEventId: true,
      },
    }),
  ]);

  const decisionByEventId = new Map<string, any>(
    existingDecisions.map((decision: any) => [String(decision.sourceActivityEventId), decision]),
  );
  const executionByEventId = new Map(
    existingExecutions.map((trade: any) => [String(trade.sourceActivityEventId), trade.id]),
  );

  let lastEventTs: Date | null = session.lastProcessedEventAt;
  const advanceWatermark = (candidate: Date | null | undefined) => {
    if (!candidate) return;
    if (!lastEventTs || candidate.getTime() > lastEventTs.getTime()) {
      lastEventTs = candidate;
    }
  };
  let consecutiveFailures = Number(session.consecutiveDecisionFailures ?? 0);
  let autoPausedByFailure = false;

  const decisionLoopStartedMs = Date.now();
  for (const event of newEvents) {
    const eventId = String(event.id);
    const alreadyProcessedDecision = decisionByEventId.get(eventId) ?? null;

    const retriableReasonCodes = new Set<string>([
      PAPER_REASON_CODES.SKIP_INVALID_SOURCE_SIZE,
      PAPER_REASON_CODES.SKIP_BELOW_MIN_NOTIONAL,
      PAPER_REASON_CODES.SKIP_NO_AVAILABLE_CASH,
      PAPER_REASON_CODES.SKIP_OVER_MARKET_CAP,
    ]);

    const canRetrySkippedDecision =
      alreadyProcessedDecision?.status === 'SKIPPED' &&
      retriableReasonCodes.has(String(alreadyProcessedDecision.reasonCode ?? ''));

    if (alreadyProcessedDecision?.status === 'EXECUTED') {
      advanceWatermark(event.eventTimestamp);
      continue;
    }

    if (alreadyProcessedDecision?.status === 'SKIPPED' && !canRetrySkippedDecision) {
      advanceWatermark(event.eventTimestamp);
      continue;
    }

    try {
      if (walletQualityBlockReason) {
        await db.paperCopyDecision.upsert({
          where: {
            sessionId_sourceActivityEventId: {
              sessionId,
              sourceActivityEventId: event.id,
            },
          },
          update: {
            status: 'SKIPPED',
            decisionType: 'SKIP',
            executorType: 'PAPER',
            marketId: event.marketId ?? null,
            marketQuestion: event.marketQuestion ?? null,
            outcome: event.outcome ? String(event.outcome).toUpperCase() : null,
            side: null,
            sourceShares: event.shares ?? null,
            sourcePrice: event.price ?? null,
            copyRatio: session.copyRatio ?? 1,
            reasonCode: PAPER_REASON_CODES.SKIP_GUARDRAIL_WALLET_QUALITY,
            humanReason: walletQualityBlockReason,
            riskChecksJson: {
              totalTrades: latestWalletAnalytics?.totalTrades ?? null,
              winRate: latestWalletAnalytics?.winRate ?? null,
              sharpeLike: latestWalletAnalytics?.sharpeLike ?? null,
              minWalletTrades: session.minWalletTrades ?? null,
              minWalletWinRate: session.minWalletWinRate ?? null,
              minWalletSharpeLike: session.minWalletSharpeLike ?? null,
            },
            executionError: null,
          },
          create: {
            sessionId,
            trackedWalletId: session.trackedWalletId,
            walletAddress: session.trackedWalletAddress,
            sourceActivityEventId: event.id,
            sourceEventTimestamp: event.eventTimestamp,
            sourceTxHash: event.txHash ?? null,
            decisionType: 'SKIP',
            status: 'SKIPPED',
            executorType: 'PAPER',
            marketId: event.marketId ?? null,
            marketQuestion: event.marketQuestion ?? null,
            outcome: event.outcome ? String(event.outcome).toUpperCase() : null,
            side: null,
            sourceShares: event.shares ?? null,
            simulatedShares: null,
            sourcePrice: event.price ?? null,
            intendedFillPrice: null,
            copyRatio: session.copyRatio ?? 1,
            sizingInputsJson: { eventType: event.eventType ?? null },
            reasonCode: PAPER_REASON_CODES.SKIP_GUARDRAIL_WALLET_QUALITY,
            humanReason: walletQualityBlockReason,
            riskChecksJson: {
              totalTrades: latestWalletAnalytics?.totalTrades ?? null,
              winRate: latestWalletAnalytics?.winRate ?? null,
              sharpeLike: latestWalletAnalytics?.sharpeLike ?? null,
              minWalletTrades: session.minWalletTrades ?? null,
              minWalletWinRate: session.minWalletWinRate ?? null,
              minWalletSharpeLike: session.minWalletSharpeLike ?? null,
            },
            notes: null,
            executionError: null,
          },
        });

        advanceWatermark(event.eventTimestamp);
        consecutiveFailures = 0;
        continue;
      }

      const sourceAtMs =
        event.eventTimestamp instanceof Date ? event.eventTimestamp.getTime() : NaN;
      const detectedAtMs = event.detectedAt instanceof Date ? event.detectedAt.getTime() : NaN;
      const persistedAtMs = Date.now();
      const pollingLatencyMs =
        Number.isFinite(sourceAtMs) && Number.isFinite(detectedAtMs)
          ? Math.max(0, detectedAtMs - sourceAtMs)
          : 0;
      const totalObservedLatencyMs = Number.isFinite(sourceAtMs)
        ? Math.max(0, persistedAtMs - sourceAtMs)
        : 0;
      const queueAndProcessingLatencyMs = Math.max(0, totalObservedLatencyMs - pollingLatencyMs);

      let liveMarketPrice: { bestAsk: number; bestBid: number; spreadBps?: number } | undefined;
      if (typeof event.marketId === 'string' && event.marketId.trim().length > 0) {
        try {
          const liveMarket = await adapter.getMarket(event.marketId);
          if (
            liveMarket &&
            Number.isFinite(liveMarket.bestAsk) &&
            Number.isFinite(liveMarket.bestBid)
          ) {
            liveMarketPrice = {
              bestAsk: Number(liveMarket.bestAsk),
              bestBid: Number(liveMarket.bestBid),
              spreadBps: Number.isFinite(liveMarket.spreadBps)
                ? Number(liveMarket.spreadBps)
                : undefined,
            };
          }
        } catch (error) {
          logger.warn(
            { sessionId, eventId: event.id, marketId: event.marketId, error },
            'failed to fetch live market book for paper decision; falling back to source-price mode',
          );
        }
      }

      const draft = evaluatePaperEventDecision({
        session,
        event,
        projectedCash,
        projectedGrossExposure,
        positionStateByKey,
        latencyMs: totalObservedLatencyMs,
        liveMarketPrice,
      });

      const draftSlippage =
        draft?.sizingInputsJson && typeof draft.sizingInputsJson === 'object'
          ? (draft.sizingInputsJson as Record<string, any>).slippageResult
          : null;
      if (
        draftSlippage &&
        typeof draftSlippage === 'object' &&
        String(draftSlippage.priceSource ?? '') === 'SOURCE_PRICE'
      ) {
        logger.warn(
          { sessionId, eventId: event.id, marketId: event.marketId },
          'paper decision slippage used SOURCE_PRICE because live market book was unavailable',
        );
      }

      const decision = await db.paperCopyDecision.upsert({
        where: {
          sessionId_sourceActivityEventId: {
            sessionId,
            sourceActivityEventId: event.id,
          },
        },
        update: {
          trackedWalletId: session.trackedWalletId,
          walletAddress: session.trackedWalletAddress,
          sourceEventTimestamp: event.eventTimestamp,
          sourceTxHash: event.txHash ?? null,
          decisionType: draft.decisionType,
          status: draft.status,
          executorType: draft.executorType,
          marketId: draft.marketId,
          marketQuestion: draft.marketQuestion,
          outcome: draft.outcome,
          side: draft.side,
          sourceShares: draft.sourceShares,
          simulatedShares: draft.simulatedShares,
          sourcePrice: draft.sourcePrice,
          intendedFillPrice: draft.intendedFillPrice,
          copyRatio: draft.copyRatio,
          sizingInputsJson: draft.sizingInputsJson,
          reasonCode: draft.reasonCode,
          humanReason: draft.humanReason,
          riskChecksJson: draft.riskChecksJson,
          notes: draft.notes,
          executionError: null,
        },
        create: {
          sessionId,
          trackedWalletId: session.trackedWalletId,
          walletAddress: session.trackedWalletAddress,
          sourceActivityEventId: event.id,
          sourceEventTimestamp: event.eventTimestamp,
          sourceTxHash: event.txHash ?? null,
          decisionType: draft.decisionType,
          status: draft.status,
          executorType: draft.executorType,
          marketId: draft.marketId,
          marketQuestion: draft.marketQuestion,
          outcome: draft.outcome,
          side: draft.side,
          sourceShares: draft.sourceShares,
          simulatedShares: draft.simulatedShares,
          sourcePrice: draft.sourcePrice,
          intendedFillPrice: draft.intendedFillPrice,
          copyRatio: draft.copyRatio,
          sizingInputsJson: draft.sizingInputsJson,
          reasonCode: draft.reasonCode,
          humanReason: draft.humanReason,
          riskChecksJson: draft.riskChecksJson,
          notes: draft.notes,
        },
      });

      if (decision.status === 'SKIPPED') {
        advanceWatermark(event.eventTimestamp);
        consecutiveFailures = 0;
        continue;
      }

      const existingExecutionId = executionByEventId.get(eventId) ?? null;

      if (existingExecutionId) {
        await db.paperCopyDecision.update({
          where: { id: decision.id },
          data: {
            status: 'EXECUTED',
            executionError: null,
          },
        });
        decisionByEventId.set(eventId, {
          ...decision,
          status: 'EXECUTED',
          reasonCode: decision.reasonCode,
        });
        advanceWatermark(event.eventTimestamp);
        consecutiveFailures = 0;
        continue;
      }

      const execution = await executor.execute({
        session: {
          id: session.id,
          trackedWalletId: session.trackedWalletId,
          trackedWalletAddress: session.trackedWalletAddress,
          feeBps: session.feeBps,
          slippageBps: session.slippageBps,
        },
        decision,
      });

      await db.paperCopyDecision.update({
        where: { id: decision.id },
        data: {
          status: execution.status,
          reasonCode: execution.reasonCode,
          humanReason: execution.humanReason,
          executionError: execution.errorMessage,
        },
      });

      const existingSizingInputs =
        draft.sizingInputsJson && typeof draft.sizingInputsJson === 'object'
          ? (draft.sizingInputsJson as Record<string, unknown>)
          : {};
      await db.paperCopyDecision.update({
        where: { id: decision.id },
        data: {
          sizingInputsJson: {
            ...existingSizingInputs,
            pollingLatencyMs,
            queueAndProcessingLatencyMs,
            totalObservedLatencyMs,
          },
        },
      });

      if (execution.status === 'FAILED') {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }

      if (execution.status === 'EXECUTED') {
        executionByEventId.set(eventId, execution.tradeId ?? `executed:${eventId}`);
        decisionByEventId.set(eventId, {
          ...decision,
          status: 'EXECUTED',
          reasonCode: execution.reasonCode,
        });

        const executedAtMs = persistedAtMs;

        if (Number.isFinite(sourceAtMs)) {
          paperEndToEndLatency.observe(
            { segment: 'source_to_execution' },
            Math.max(0, executedAtMs - sourceAtMs),
          );
        }
        if (Number.isFinite(detectedAtMs)) {
          paperEndToEndLatency.observe(
            { segment: 'detection_to_execution' },
            Math.max(0, executedAtMs - detectedAtMs),
          );
        }
      }

      if (consecutiveFailures >= 5) {
        autoPausedByFailure = true;
        await db.paperCopySession.update({
          where: { id: sessionId },
          data: {
            status: 'PAUSED',
            lastAutoPausedAt: new Date(),
            consecutiveDecisionFailures: consecutiveFailures,
          },
        });
        await raiseSystemAlert({
          dedupeKey: `SESSION_FAILURE_BURST:${sessionId}`,
          alertType: 'SESSION_FAILURE_BURST',
          severity: 'CRITICAL',
          title: 'Session auto-paused after repeated decision failures',
          message: `Session ${sessionId} has ${consecutiveFailures} consecutive decision/execution failures.`,
          walletId: session.trackedWalletId,
          sessionId,
          payloadJson: {
            eventId: event.id,
            lastReason: execution.reasonCode,
            threshold: 5,
          },
        });
        advanceWatermark(event.eventTimestamp);
        break;
      }

      if (
        execution.status === 'EXECUTED' &&
        decision.side &&
        decision.marketId &&
        decision.outcome
      ) {
        applyProjectedExecution({
          positionStateByKey,
          marketId: decision.marketId,
          marketQuestion: decision.marketQuestion,
          outcome: decision.outcome,
          side: decision.side,
          fillPrice: execution.fillPrice,
          fillShares: execution.fillShares,
        });
        projectedCash += execution.cashDelta;
        const exposureDelta = execution.fillPrice * execution.fillShares;
        projectedGrossExposure += decision.side === 'BUY' ? exposureDelta : -exposureDelta;
        projectedGrossExposure = Math.max(0, projectedGrossExposure);
      }

      advanceWatermark(event.eventTimestamp);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown decision/execution error';
      await db.paperCopyDecision
        .upsert({
          where: {
            sessionId_sourceActivityEventId: {
              sessionId,
              sourceActivityEventId: event.id,
            },
          },
          update: {
            status: 'FAILED',
            reasonCode: PAPER_REASON_CODES.EXECUTION_FAILED_RUNTIME,
            humanReason: 'Unexpected runtime error while processing paper decision pipeline.',
            executionError: message,
          },
          create: {
            sessionId,
            trackedWalletId: session.trackedWalletId,
            walletAddress: session.trackedWalletAddress,
            sourceActivityEventId: event.id,
            sourceEventTimestamp: event.eventTimestamp,
            sourceTxHash: event.txHash ?? null,
            decisionType: 'NOOP',
            status: 'FAILED',
            executorType: 'PAPER',
            marketId: event.marketId ?? null,
            marketQuestion: event.marketQuestion ?? null,
            outcome: event.outcome ? String(event.outcome).toUpperCase() : null,
            side: null,
            sourceShares: event.shares ?? null,
            simulatedShares: null,
            sourcePrice: event.price ?? null,
            intendedFillPrice: null,
            copyRatio: session.copyRatio ?? 1,
            sizingInputsJson: { eventType: event.eventType ?? null },
            reasonCode: PAPER_REASON_CODES.EXECUTION_FAILED_RUNTIME,
            humanReason: 'Unexpected runtime error while processing paper decision pipeline.',
            riskChecksJson: {},
            notes: null,
            executionError: message,
          },
        })
        .catch(() => undefined);
      logger.warn({ sessionId, eventId: event.id, err }, 'failed to process decision/execution');
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) {
        autoPausedByFailure = true;
        await db.paperCopySession.update({
          where: { id: sessionId },
          data: {
            status: 'PAUSED',
            lastAutoPausedAt: new Date(),
            consecutiveDecisionFailures: consecutiveFailures,
          },
        });
        await raiseSystemAlert({
          dedupeKey: `SESSION_FAILURE_BURST:${sessionId}`,
          alertType: 'SESSION_FAILURE_BURST',
          severity: 'CRITICAL',
          title: 'Session auto-paused after repeated decision failures',
          message: `Session ${sessionId} has ${consecutiveFailures} consecutive decision/execution failures.`,
          walletId: session.trackedWalletId,
          sessionId,
          payloadJson: {
            eventId: event.id,
            lastReason: 'EXECUTION_FAILED_RUNTIME',
            threshold: 5,
          },
        });
        break;
      }
    }
  }
  paperPipelineLatency.observe({ stage: 'decision_loop' }, Date.now() - decisionLoopStartedMs);

  // Flush accumulated cash + watermark in one update
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      ...(lastEventTs ? { lastProcessedEventAt: lastEventTs } : {}),
      consecutiveDecisionFailures: consecutiveFailures,
    },
  });

  if (autoPausedByFailure) {
    return;
  }

  await materializePaperSessionState(sessionId);
  await _writeSnapshot(sessionId);
  const autoCloseResult = await closeResolvedPositions(sessionId).catch((err) => {
    logger.warn({ sessionId, err }, 'auto-close-resolved failed (non-fatal)');
    return null;
  });
  if (autoCloseResult && Number(autoCloseResult.closed) > 0) {
    await _writeSnapshot(sessionId, { force: true });
  }
  paperPipelineLatency.observe({ stage: 'tick_total' }, Date.now() - tickStartedMs);
}

// ---------------------------------------------------------------------------
// Internal: mark refresh
// ---------------------------------------------------------------------------

async function _refreshMarks(sessionId: string): Promise<void> {
  await materializePaperSessionState(sessionId);
}

// ---------------------------------------------------------------------------
// Internal: snapshot write with throttle + pruning
// ---------------------------------------------------------------------------

export async function createSessionSnapshot(
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  return _writeSnapshot(sessionId, opts);
}

async function _writeSnapshot(sessionId: string, opts: { force?: boolean } = {}): Promise<void> {
  const nowMs = Date.now();
  const lastAt = _lastSnapshotAt.get(sessionId) ?? 0;
  if (!opts.force && nowMs - lastAt < MIN_SNAPSHOT_INTERVAL_MS) return;
  _lastSnapshotAt.set(sessionId, nowMs);

  const [session, positions, trades] = await Promise.all([
    db.paperCopySession.findUnique({ where: { id: sessionId } }),
    db.paperCopyPosition.findMany({ where: { sessionId } }),
    db.paperCopyTrade.findMany({ where: { sessionId }, select: { feeApplied: true } }),
  ]);
  if (!session) return;

  const openPos = positions.filter((p: any) => p.status === 'OPEN');

  const openMarketValue = openPos.reduce(
    (s: number, p: any) => s + Number(p.netShares) * Number(p.currentMarkPrice),
    0,
  );
  const grossExposure = openPos.reduce(
    (s: number, p: any) => s + Math.abs(Number(p.netShares) * Number(p.currentMarkPrice)),
    0,
  );
  const realizedPnl = positions.reduce((s: number, p: any) => s + Number(p.realizedPnl), 0);
  const unrealizedPnl = openPos.reduce((s: number, p: any) => s + Number(p.unrealizedPnl), 0);
  const fees = trades.reduce((s: number, t: any) => s + Number(t.feeApplied), 0);

  const cash = Number(session.currentCash);
  const netLiquidationValue = cash + openMarketValue;
  const totalPnl = netLiquidationValue - Number(session.startingCash);
  const returnPct =
    Number(session.startingCash) > 0 ? (totalPnl / Number(session.startingCash)) * 100 : 0;
  const timestamp = new Date();

  const accountingIdentityDrift =
    Number(session.startingCash) + realizedPnl + unrealizedPnl - fees - netLiquidationValue;
  const accountValueCompositionDrift = netLiquidationValue - (cash + openMarketValue);
  const netPnlSinceStartDrift = totalPnl - (netLiquidationValue - Number(session.startingCash));
  const maxAbsDrift = Math.max(
    Math.abs(accountingIdentityDrift),
    Math.abs(accountValueCompositionDrift),
    Math.abs(netPnlSinceStartDrift),
  );
  const invariantTolerance = Math.max(0.01, Number(session.startingCash) * 0.0001);

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
      fees,
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
      fees,
      netLiquidationValue,
      openPositionsCount: openPos.length,
    },
  });

  if (maxAbsDrift > invariantTolerance) {
    logger.error(
      {
        sessionId,
        accountingIdentityDrift,
        accountValueCompositionDrift,
        netPnlSinceStartDrift,
        maxAbsDrift,
        startingCash: Number(session.startingCash),
        cash,
        openMarketValue,
        netLiquidationValue,
        realizedPnl,
        unrealizedPnl,
        fees,
        tolerance: invariantTolerance,
      },
      'paper accounting invariant drift detected during snapshot write',
    );

    await raiseSystemAlert({
      dedupeKey: `PAPER_ACCOUNTING_INVARIANT:${sessionId}`,
      alertType: 'PAPER_ACCOUNTING_INVARIANT_MISMATCH',
      severity: 'CRITICAL',
      title: 'Paper accounting invariant mismatch',
      message:
        'Session accounting identities are out of tolerance; review reconciliation drift details.',
      sessionId,
      walletId: session.trackedWalletId,
      payloadJson: {
        sessionId,
        accountingIdentityDrift,
        accountValueCompositionDrift,
        netPnlSinceStartDrift,
        maxAbsDrift,
        at: timestamp.toISOString(),
      },
    });
  }

  // ---- Prune old rows to keep table size bounded ----
  // Both tables are pruned to MAX_METRIC_ROWS. We do this asynchronously after
  // the snapshot write so it never blocks the tick path.
  _pruneOldRows(sessionId).catch((err) =>
    logger.warn({ sessionId, err }, 'metric pruning failed (non-fatal)'),
  );
}

async function _pruneOldRows(sessionId: string): Promise<void> {
  const [metricCount, snapshotCount] = await Promise.all([
    db.paperSessionMetricPoint.count({ where: { sessionId } }),
    db.paperPortfolioSnapshot.count({ where: { sessionId } }),
  ]);

  const pruneThreshold = MAX_METRIC_ROWS + 200; // prune in batches, not every write

  if (metricCount > pruneThreshold) {
    const oldest: Array<{ id: string }> = await db.paperSessionMetricPoint.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' },
      take: metricCount - MAX_METRIC_ROWS,
      select: { id: true },
    });
    if (oldest.length > 0) {
      await db.paperSessionMetricPoint.deleteMany({
        where: { id: { in: oldest.map((r) => r.id) } },
      });
      logger.debug({ sessionId, pruned: oldest.length }, 'pruned old metric points');
    }
  }

  if (snapshotCount > pruneThreshold) {
    const oldest: Array<{ id: string }> = await db.paperPortfolioSnapshot.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' },
      take: snapshotCount - MAX_METRIC_ROWS,
      select: { id: true },
    });
    if (oldest.length > 0) {
      await db.paperPortfolioSnapshot.deleteMany({
        where: { id: { in: oldest.map((r) => r.id) } },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: bootstrap from source wallet's open positions
// ---------------------------------------------------------------------------

async function _bootstrapFromOpenPositions(
  sessionId: string,
  walletAddress: string,
): Promise<{ estimatedSourceExposure: number; copyRatio: number; bootstrapNotional: number }> {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');

  const openPositions = await adapter.getWalletPositions(walletAddress, 'OPEN', 200);

  const estimatedSourceExposure = openPositions.reduce(
    (sum: number, p: any) => sum + Math.abs(p.totalTraded),
    0,
  );
  const baseExposure = Math.max(estimatedSourceExposure, Number(session.startingCash));
  const copyRatio = Number(session.startingCash) / baseExposure;

  const now = new Date();
  let bootstrapNotional = 0;
  const executor = resolvePaperExecutor('PAPER');

  for (const position of openPositions) {
    const simulatedShares = position.size * copyRatio;
    if (simulatedShares <= 0) continue;

    const simulatedPrice = position.currentPrice > 0 ? position.currentPrice : position.avgPrice;
    const notional = simulatedShares * simulatedPrice;

    // Normalize outcome to UPPERCASE — Polymarket positions API returns "Up"/"Down"
    // but activity events return "UP"/"DOWN". Must match for position lookups.
    const normalizedOutcome = position.outcome.toUpperCase();

    const existingBootstrapEntry = await db.paperCopyTrade.findFirst({
      where: {
        sessionId,
        marketId: position.conditionId,
        outcome: normalizedOutcome,
        action: 'BOOTSTRAP',
      },
    });
    if (existingBootstrapEntry) continue;

    bootstrapNotional += notional;

    const decision = await db.paperCopyDecision.create({
      data: {
        sessionId,
        trackedWalletId: session.trackedWalletId,
        walletAddress,
        sourceActivityEventId: null,
        sourceEventTimestamp: now,
        sourceTxHash: null,
        decisionType: 'BOOTSTRAP',
        status: 'PENDING',
        executorType: 'PAPER',
        marketId: position.conditionId,
        marketQuestion: position.title,
        outcome: normalizedOutcome,
        side: 'BUY',
        sourceShares: position.size,
        simulatedShares,
        sourcePrice: simulatedPrice,
        intendedFillPrice: simulatedPrice,
        copyRatio,
        sizingInputsJson: {
          sourceExposureEstimate: estimatedSourceExposure,
        },
        reasonCode: PAPER_REASON_CODES.BOOTSTRAP_EXISTING_POSITION,
        humanReason: 'Bootstrapping existing source exposure into canonical copy ledger.',
        riskChecksJson: {},
        notes: 'BOOTSTRAP_OPEN_POSITION',
      },
    });

    const execution = await executor.execute({
      session: {
        id: session.id,
        trackedWalletId: session.trackedWalletId,
        trackedWalletAddress: session.trackedWalletAddress,
        feeBps: session.feeBps,
        slippageBps: session.slippageBps,
      },
      decision,
    });

    await db.paperCopyDecision.update({
      where: { id: decision.id },
      data: {
        status: execution.status,
        reasonCode: execution.reasonCode,
        humanReason: execution.humanReason,
        executionError: execution.errorMessage,
      },
    });
  }

  return { estimatedSourceExposure, copyRatio, bootstrapNotional };
}
