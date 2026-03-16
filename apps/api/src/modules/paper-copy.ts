import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
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

export async function startPaperCopySession(sessionId: string) {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');
  if (session.status === 'RUNNING') return;

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
        slippageBps: number;
        driftBps: number;
        totalAdverseBps: number;
      },
      d: any,
    ) => {
      const sr = (d?.sizingInputsJson as Record<string, any>).slippageResult as Record<string, any>;
      acc.count += 1;
      acc.latencyMs += Number(sr.latencyApplied ?? 0);
      acc.slippageBps += Number(sr.slippageBps ?? 0);
      acc.driftBps += Number(sr.driftBps ?? 0);
      acc.totalAdverseBps += Number(sr.totalAdverseBps ?? sr.slippageBps ?? 0);
      return acc;
    },
    { count: 0, latencyMs: 0, slippageBps: 0, driftBps: 0, totalAdverseBps: 0 },
  );

  const frictionAverages =
    frictionTotals.count > 0
      ? {
          avgLatencyMs: frictionTotals.latencyMs / frictionTotals.count,
          avgSlippageBps: frictionTotals.slippageBps / frictionTotals.count,
          avgDriftBps: frictionTotals.driftBps / frictionTotals.count,
          avgTotalAdverseBps: frictionTotals.totalAdverseBps / frictionTotals.count,
        }
      : {
          avgLatencyMs: 0,
          avgSlippageBps: 0,
          avgDriftBps: 0,
          avgTotalAdverseBps: 0,
        };

  return {
    sessionId,
    summary: {
      startingCash: Number(session.startingCash),
      currentNlv: nlv,
      totalPnl: nlv - Number(session.startingCash),
      trades: totalTradeCount,
      decisions: totalDecisionCount,
      openPositions: positions.filter((row: any) => row.status === 'OPEN').length,
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

  const latestEvent = await db.walletActivityEvent.findFirst({
    where: { trackedWalletId: session.trackedWalletId },
    orderBy: { eventTimestamp: 'desc' },
    select: { eventTimestamp: true },
  });

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
  try {
    await _runTickUnsafe(sessionId);
  } catch (err) {
    logger.error({ sessionId, err }, 'paper session tick threw unexpectedly');
  } finally {
    _sessionLocks.delete(sessionId);
  }
}

async function _runTickUnsafe(sessionId: string): Promise<void> {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== 'RUNNING') return;

  // Pull fresh source activity through the same ingestion pipeline used by Wallet Tracker
  // so paper sessions always consume the latest normalized activity feed.
  await processWalletPoll(session.trackedWalletId, session.trackedWalletAddress).catch((err) =>
    logger.warn({ sessionId, err }, 'wallet poll from paper tick failed (non-fatal)'),
  );

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
  const newEvents: Array<Record<string, any>> = await db.walletActivityEvent.findMany({
    where: {
      trackedWalletId: session.trackedWalletId,
      // Small overlap window allows retrying recently skipped events after guardrail/config changes.
      // Dedupe safety is guaranteed by per-event decision upsert keyed by sourceActivityEventId.
      eventTimestamp: { gte: overlapStart },
    },
    orderBy: { eventTimestamp: 'asc' },
    take: MAX_EVENTS_PER_TICK,
  });

  if (newEvents.length === 0) {
    await materializePaperSessionState(sessionId);
    await _writeSnapshot(sessionId);
    await closeResolvedPositions(sessionId).catch((err) =>
      logger.warn({ sessionId, err }, 'auto-close-resolved failed (non-fatal)'),
    );
    return;
  }

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

  let lastEventTs: Date | null = session.lastProcessedEventAt;
  let consecutiveFailures = Number(session.consecutiveDecisionFailures ?? 0);
  let autoPausedByFailure = false;

  for (const event of newEvents) {
    const alreadyProcessedDecision = await db.paperCopyDecision.findUnique({
      where: {
        sessionId_sourceActivityEventId: {
          sessionId,
          sourceActivityEventId: event.id,
        },
      },
      select: { id: true, status: true, reasonCode: true },
    });

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
      lastEventTs = event.eventTimestamp;
      continue;
    }

    if (alreadyProcessedDecision?.status === 'SKIPPED' && !canRetrySkippedDecision) {
      lastEventTs = event.eventTimestamp;
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

        lastEventTs = event.eventTimestamp;
        consecutiveFailures = 0;
        continue;
      }

      const draft = evaluatePaperEventDecision({
        session,
        event,
        projectedCash,
        projectedGrossExposure,
        positionStateByKey,
      });

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
        lastEventTs = event.eventTimestamp;
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

      if (execution.status === 'FAILED') {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
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
        lastEventTs = event.eventTimestamp;
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

      lastEventTs = event.eventTimestamp;
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
  await closeResolvedPositions(sessionId).catch((err) =>
    logger.warn({ sessionId, err }, 'auto-close-resolved failed (non-fatal)'),
  );
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
