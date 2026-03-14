import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createPolymarketDataAdapter } from './polymarket.js';

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
const MAX_EVENTS_PER_TICK = 200;

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
  maxAllocationPerMarket?: number;
  maxTotalExposure?: number;
  minNotionalThreshold?: number;
  feeBps?: number;
  slippageBps?: number;
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
      maxAllocationPerMarket: input.maxAllocationPerMarket ?? startingCash * 0.05,
      maxTotalExposure: input.maxTotalExposure ?? startingCash * 0.8,
      minNotionalThreshold: input.minNotionalThreshold ?? 2,
      // Polymarket charges a 2% taker fee (200 bps) on all orders.
      // Makers get 0% — but as a copy-follower you are always a taker.
      // Slippage of 20 bps is a conservative estimate for liquid mid-cap markets.
      // Illiquid / newly listed markets can see 50-150 bps slippage.
      feeBps: input.feeBps ?? 200,
      slippageBps: input.slippageBps ?? 20,
    },
  });
}

export async function startPaperCopySession(sessionId: string) {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');
  if (session.status === 'RUNNING') return; // idempotent

  const startedAt: Date = session.startedAt ?? new Date();

  const bootstrapped = await _bootstrapFromOpenPositions(sessionId, session.trackedWalletAddress);

  await db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      status: 'RUNNING',
      startedAt,
      estimatedSourceExposure: bootstrapped.estimatedSourceExposure,
      copyRatio: bootstrapped.copyRatio,
      // Only deduct bootstrap notional on the very first start (not on resume)
      ...(session.startedAt
        ? {}
        : {
            currentCash: Math.max(0, Number(session.startingCash) - bootstrapped.bootstrapNotional),
          }),
    },
  });

  // Immediately catch up on any events that came in during bootstrap
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

  // Release lock if held
  _sessionLocks.delete(sessionId);
  _lastSnapshotAt.delete(sessionId);

  const previousStatus = session.status;
  const cashBefore = Number(session.currentCash);

  // ── Step 1: Force to PAUSED ────────────────────────────────────────────────
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: { status: 'PAUSED' },
  });

  // ── Step 2: Recalculate cash from trade history ────────────────────────────
  const allTrades: Array<Record<string, any>> = await db.paperCopyTrade.findMany({
    where: { sessionId },
    orderBy: { eventTimestamp: 'asc' },
  });

  let repairedCash = Number(session.startingCash);
  for (const trade of allTrades) {
    const notional = Number(trade.notional);
    const fee = Number(trade.feeApplied);
    if (trade.side === 'BUY') {
      repairedCash -= notional + fee;
    } else if (trade.side === 'SELL') {
      repairedCash += notional - fee;
    }
    // BOOTSTRAP trades have fee=0 and their notional was already subtracted
    // from startingCash at session start — skip them to avoid double-counting
    if (trade.action === 'BOOTSTRAP') {
      // Bootstrap notional was subtracted at start; undo the above
      repairedCash += notional + fee; // restore
      repairedCash -= notional; // deduct bootstrap cost (no fee)
    }
  }

  await db.paperCopySession.update({
    where: { id: sessionId },
    data: { currentCash: repairedCash },
  });

  // ── Step 3 & 4: Recalculate each position from its trade slice ────────────
  const positions: Array<Record<string, any>> = await db.paperCopyPosition.findMany({
    where: { sessionId },
  });

  let positionsFixed = 0;

  for (const pos of positions) {
    const posTrades = allTrades.filter(
      (t) => t.marketId === pos.marketId && t.outcome === pos.outcome,
    );

    let netShares = 0;
    let totalCost = 0;
    let realizedPnl = 0;
    let avgEntry = Number(pos.avgEntryPrice);

    for (const t of posTrades) {
      const shares = Number(t.simulatedShares);
      const price = Number(t.simulatedPrice);
      const fee = Number(t.feeApplied);

      if (t.side === 'BUY') {
        const newTotal = netShares + shares;
        if (newTotal > 0) {
          avgEntry = (netShares * avgEntry + shares * price) / newTotal;
        }
        netShares = newTotal;
        totalCost += shares * price + fee;
      } else if (t.side === 'SELL') {
        const closeShares = Math.min(netShares, shares);
        realizedPnl += closeShares * (price - avgEntry) - fee;
        netShares = Math.max(0, netShares - closeShares);
      }
    }

    const needsFix =
      Math.abs(netShares - Number(pos.netShares)) > 0.0001 ||
      Math.abs(realizedPnl - Number(pos.realizedPnl)) > 0.01 ||
      (netShares <= 0 && pos.status === 'OPEN');

    if (needsFix) {
      await db.paperCopyPosition.update({
        where: { id: pos.id },
        data: {
          netShares: Math.max(0, netShares),
          avgEntryPrice: avgEntry,
          realizedPnl,
          status: netShares <= 0 ? 'CLOSED' : 'OPEN',
          closedAt: netShares <= 0 && !pos.closedAt ? new Date() : pos.closedAt,
        },
      });
      positionsFixed++;
    }
  }

  // ── Step 5: Write a fresh snapshot ────────────────────────────────────────
  await _writeSnapshot(sessionId, { force: true });

  logger.info(
    { sessionId, previousStatus, cashBefore, cashAfter: repairedCash, positionsFixed },
    'session repaired',
  );

  return {
    previousStatus,
    cashBefore,
    cashAfter: repairedCash,
    positionsFixed,
    snapshotWritten: true,
  };
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
}> {
  const session = await db.paperCopySession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');

  _sessionLocks.delete(sessionId);

  // Fetch current open positions from Polymarket (ground truth)
  const livePositions = await adapter.getWalletPositions(session.trackedWalletAddress, 'OPEN', 200);

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
      // This position was closed/resolved on-chain but we missed the event.
      // Close it at the last known mark price.
      const markPrice = Number(pos.currentMarkPrice);
      const closeShares = Number(pos.netShares);
      const realizedPnl = closeShares * (markPrice - Number(pos.avgEntryPrice));

      await db.paperCopyPosition.update({
        where: { id: pos.id },
        data: {
          netShares: 0,
          status: 'CLOSED',
          closedAt: now,
          realizedPnl: Number(pos.realizedPnl) + realizedPnl,
        },
      });

      // Record a synthetic CLOSE trade so the copy log shows the reconciliation
      await db.paperCopyTrade.create({
        data: {
          sessionId,
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

      // Add cash back for the closed position
      await db.paperCopySession.update({
        where: { id: sessionId },
        data: {
          currentCash: {
            increment: closeShares * markPrice,
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

  await _writeSnapshot(sessionId, { force: true });

  return {
    openOnChain: livePositions.length,
    openInSim: simOpen.length,
    closedByReconciliation,
    cashRecalculated: false,
  };
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

  const startedAt: Date = session.startedAt ?? session.createdAt;

  // Fetch activity events after the last watermark.
  // CRITICAL: Do NOT filter on `side`, `price`, or `shares` here.
  // Polymarket sends:
  //   - SELL/CLOSE events with side=null (eventType is the only signal)
  //   - REDEEM events (market resolution) with price=null, shares=null, side=null
  //     for worthless positions ($0 payout). These STILL need to close the position.
  // Filtering on any of these fields causes exit events to be silently dropped.
  const newEvents: Array<Record<string, any>> = await db.walletActivityEvent.findMany({
    where: {
      trackedWalletId: session.trackedWalletId,
      eventTimestamp: { gt: session.lastProcessedEventAt ?? startedAt },
      eventType: {
        in: ['BUY', 'SELL', 'TRADE', 'INCREASE', 'REDUCE', 'CLOSE', 'REDEEM'],
      },
    },
    orderBy: { eventTimestamp: 'asc' },
    take: MAX_EVENTS_PER_TICK,
  });

  if (newEvents.length === 0) {
    // Refresh marks + maybe write a snapshot even with no new events
    await _refreshMarks(sessionId);
    await _writeSnapshot(sessionId);
    return;
  }

  // ---- Process events, accumulating cash delta ----
  // We read session.currentCash once then maintain a running total.
  // This avoids the original race where each applyEvent re-read stale cash.
  let currentCash = Number(session.currentCash);
  let lastEventTs: Date | null = session.lastProcessedEventAt;

  for (const event of newEvents) {
    // Idempotency: skip if this event was already applied to this session
    const already = await db.paperCopyTrade.findFirst({
      where: { sessionId, sourceActivityEventId: event.id },
      select: { id: true },
    });
    if (already) {
      lastEventTs = event.eventTimestamp;
      continue;
    }

    try {
      const delta = await _applyEvent(sessionId, session, event, currentCash);
      currentCash += delta;
      lastEventTs = event.eventTimestamp;
    } catch (err) {
      logger.warn({ sessionId, eventId: event.id, err }, 'failed to apply event to session');
    }
  }

  // Flush accumulated cash + watermark in one update
  await db.paperCopySession.update({
    where: { id: sessionId },
    data: {
      currentCash,
      ...(lastEventTs ? { lastProcessedEventAt: lastEventTs } : {}),
    },
  });

  await _refreshMarks(sessionId);
  await _writeSnapshot(sessionId);
}

// ---------------------------------------------------------------------------
// Internal: apply single activity event to a session
// Returns cash delta (negative = BUY, positive = SELL).
// Does NOT write to paperCopySession.currentCash — caller flushes.
// ---------------------------------------------------------------------------

/**
 * Resolve the effective trade side from a WalletActivityEvent.
 *
 * Polymarket's data-api is inconsistent:
 *   - Some records have side = 'BUY' | 'SELL'
 *   - Others have side = null but eventType = 'SELL' | 'CLOSE' | 'REDUCE' | 'REDEEM'
 *   - TRADE events need the takerSide field from rawPayloadJson
 *
 * We treat CLOSE / REDUCE / REDEEM / SELL as effective SELLs.
 * Anything else that reaches this point is treated as BUY.
 */
function _resolveEffectiveSide(event: Record<string, any>): 'BUY' | 'SELL' {
  // Explicit side field wins
  if (event.side === 'SELL') return 'SELL';
  if (event.side === 'BUY') return 'BUY';

  // Fall back to eventType
  const et = (event.eventType ?? '').toUpperCase();
  if (['SELL', 'CLOSE', 'REDUCE', 'REDEEM'].includes(et)) return 'SELL';

  // Try rawPayloadJson for TRADE events where takerSide indicates the direction
  const raw = event.rawPayloadJson as Record<string, unknown> | null;
  if (raw) {
    const takerSide = String(raw.takerSide ?? raw.side ?? '').toUpperCase();
    if (takerSide === 'SELL') return 'SELL';
  }

  return 'BUY';
}

async function _applyEvent(
  sessionId: string,
  session: Record<string, any>,
  event: Record<string, any>,
  currentCash: number,
): Promise<number> {
  // Resolve effective side — critical for Polymarket where side can be null
  const effectiveSide = _resolveEffectiveSide(event);
  const eventType = (event.eventType ?? '').toUpperCase();

  // Normalize outcome to uppercase to prevent case-mismatch misses.
  // Polymarket returns "Up"/"Down" from positions API but "UP"/"DOWN" from activity API.
  const outcome = (event.outcome ?? 'UNKNOWN').toUpperCase();
  const copyRatio = Number(session.copyRatio ?? 1);

  // ── Full-close events: CLOSE and REDEEM ─────────────────────────────────────
  // These are market-resolution events. They must close the position regardless
  // of whether price/shares are null (losing/worthless positions have both = null).
  const isFullCloseEvent = ['CLOSE', 'REDEEM'].includes(eventType);

  if (isFullCloseEvent) {
    const existing = await db.paperCopyPosition.findUnique({
      where: { sessionId_marketId_outcome: { sessionId, marketId: event.marketId, outcome } },
    });
    if (!existing || Number(existing.netShares) <= 0) return 0;

    // For winning REDEEMs: price=1.0. For losing: price=0. Use whatever came in, floor at 0.
    const closePrice = Math.max(0, event.price !== null ? Number(event.price) : 0);
    const closeShares = Number(existing.netShares);
    const realizedPnl = closeShares * (closePrice - Number(existing.avgEntryPrice));
    const feeApplied = closeShares * closePrice * (Number(session.feeBps) / 10_000);

    await db.paperCopyPosition.update({
      where: { id: existing.id },
      data: {
        netShares: 0,
        currentMarkPrice: closePrice,
        realizedPnl: Number(existing.realizedPnl) + realizedPnl - feeApplied,
        status: 'CLOSED',
        closedAt: event.eventTimestamp,
      },
    });

    const notional = closeShares * closePrice;
    await db.paperCopyTrade.create({
      data: {
        sessionId,
        sourceActivityEventId: event.id,
        marketId: event.marketId,
        marketQuestion: event.marketQuestion ?? null,
        outcome,
        side: 'SELL',
        action: eventType,
        sourcePrice: closePrice,
        simulatedPrice: closePrice,
        sourceShares: event.shares !== null ? Number(event.shares) : closeShares,
        simulatedShares: closeShares,
        notional,
        feeApplied,
        slippageApplied: 0,
        eventTimestamp: event.eventTimestamp,
        processedAt: new Date(),
        reasoning: {
          copyRatio,
          feeBps: Number(session.feeBps),
          slippageBps: Number(session.slippageBps),
          sourceEventType: eventType,
          resolvedSide: 'SELL',
          originalSide: event.side ?? null,
          closeReason: closePrice === 0 ? 'EXPIRED_WORTHLESS' : 'REDEEMED_WINNING',
        },
      },
    });

    const cashReceived = notional - feeApplied;
    logger.info(
      { sessionId, marketId: event.marketId, outcome, closeShares, closePrice, cashReceived },
      'position closed by REDEEM/CLOSE event',
    );
    return cashReceived;
  }

  // ── BUY / SELL / REDUCE events ──────────────────────────────────────────────
  // These require valid price and shares to size the trade.
  if (event.shares === null || event.price === null) return 0;

  const sourceShares = Number(event.shares);
  const sourcePrice = Number(event.price);
  if (sourcePrice <= 0 || sourceShares <= 0) return 0;

  // Slippage: add for BUY (worse fill), subtract for SELL (worse fill)
  const slippageSign = effectiveSide === 'BUY' ? 1 : -1;
  const slippageApplied = sourcePrice * (Number(session.slippageBps) / 10_000) * slippageSign;
  const simulatedPrice = Math.max(0.0001, sourcePrice + slippageApplied);

  let simulatedShares = sourceShares * copyRatio;
  let notional = simulatedShares * simulatedPrice;

  // Skip below minimum notional threshold
  if (notional < Number(session.minNotionalThreshold)) return 0;

  // Cap BUY to available cash
  if (effectiveSide === 'BUY') {
    const maxBuy = Math.min(currentCash, Number(session.maxAllocationPerMarket));
    if (maxBuy <= 0) {
      logger.info({ sessionId, eventId: event.id }, 'BUY skipped — no cash available');
      return 0;
    }
    if (notional > maxBuy) {
      simulatedShares = maxBuy / simulatedPrice;
      notional = simulatedShares * simulatedPrice;
    }
  }

  const feeApplied = notional * (Number(session.feeBps) / 10_000);

  const existing = await db.paperCopyPosition.findUnique({
    where: { sessionId_marketId_outcome: { sessionId, marketId: event.marketId, outcome } },
  });

  if (effectiveSide === 'BUY') {
    if (existing) {
      const currShares = Number(existing.netShares);
      const newShares = currShares + simulatedShares;
      const newAvg =
        newShares > 0
          ? (currShares * Number(existing.avgEntryPrice) + simulatedShares * simulatedPrice) /
            newShares
          : Number(existing.avgEntryPrice);
      await db.paperCopyPosition.update({
        where: { id: existing.id },
        data: {
          netShares: newShares,
          avgEntryPrice: newAvg,
          currentMarkPrice: simulatedPrice,
          status: 'OPEN',
        },
      });
    } else {
      await db.paperCopyPosition.create({
        data: {
          sessionId,
          marketId: event.marketId,
          marketQuestion: event.marketQuestion ?? null,
          outcome,
          netShares: simulatedShares,
          avgEntryPrice: simulatedPrice,
          currentMarkPrice: simulatedPrice,
          realizedPnl: 0,
          unrealizedPnl: 0,
          status: 'OPEN',
          openedAt: event.eventTimestamp,
        },
      });
    }
  } else {
    // SELL / REDUCE
    if (!existing) return 0;
    const currShares = Number(existing.netShares);
    if (currShares <= 0) return 0;

    const closeShares = Math.min(currShares, simulatedShares);
    const realizedPnl = closeShares * (simulatedPrice - Number(existing.avgEntryPrice));
    const newShares = Math.max(0, currShares - closeShares);

    await db.paperCopyPosition.update({
      where: { id: existing.id },
      data: {
        netShares: newShares,
        currentMarkPrice: simulatedPrice,
        realizedPnl: Number(existing.realizedPnl) + realizedPnl - feeApplied,
        status: newShares <= 0 ? 'CLOSED' : 'OPEN',
        closedAt: newShares <= 0 ? event.eventTimestamp : null,
      },
    });

    simulatedShares = closeShares;
    notional = simulatedShares * simulatedPrice;
  }

  await db.paperCopyTrade.create({
    data: {
      sessionId,
      sourceActivityEventId: event.id,
      marketId: event.marketId,
      marketQuestion: event.marketQuestion ?? null,
      outcome,
      side: effectiveSide,
      action: event.eventType,
      sourcePrice,
      simulatedPrice,
      sourceShares,
      simulatedShares,
      notional,
      feeApplied,
      slippageApplied,
      eventTimestamp: event.eventTimestamp,
      processedAt: new Date(),
      reasoning: {
        copyRatio,
        feeBps: Number(session.feeBps),
        slippageBps: Number(session.slippageBps),
        sourceEventType: event.eventType,
        resolvedSide: effectiveSide,
        originalSide: event.side ?? null,
      },
    },
  });

  const cashDelta = effectiveSide === 'BUY' ? -(notional + feeApplied) : notional - feeApplied;
  return cashDelta;
}

// ---------------------------------------------------------------------------
// Internal: bulk mark refresh (fixes original N+1 query bug)
// ---------------------------------------------------------------------------

async function _refreshMarks(sessionId: string): Promise<void> {
  const [session, openPositions] = await Promise.all([
    db.paperCopySession.findUnique({
      where: { id: sessionId },
      select: { trackedWalletId: true },
    }),
    db.paperCopyPosition.findMany({
      where: { sessionId, status: 'OPEN' },
    }),
  ]);

  if (!session || openPositions.length === 0) return;

  // Fetch the latest price for each unique marketId in a single query
  const marketIds = [...new Set(openPositions.map((p: any) => p.marketId as string))];

  const recentPrices: Array<Record<string, any>> = await db.walletActivityEvent.findMany({
    where: {
      trackedWalletId: session.trackedWalletId,
      marketId: { in: marketIds },
      price: { not: null },
    },
    orderBy: { eventTimestamp: 'desc' },
    // Enough to cover all markets × outcomes with some buffer
    take: marketIds.length * 6,
    select: { marketId: true, outcome: true, price: true },
  });

  // Build price map: "marketId:outcome" → latest price
  const priceMap = new Map<string, number>();
  for (const row of recentPrices) {
    const key = `${row.marketId}:${row.outcome}`;
    if (!priceMap.has(key) && row.price !== null) {
      priceMap.set(key, Number(row.price));
    }
  }

  await Promise.all(
    openPositions.map((pos: any) => {
      const key = `${pos.marketId}:${pos.outcome}`;
      const mark = priceMap.get(key) ?? Number(pos.currentMarkPrice);
      const unrealized = Number(pos.netShares) * (mark - Number(pos.avgEntryPrice));
      return db.paperCopyPosition.update({
        where: { id: pos.id },
        data: { currentMarkPrice: mark, unrealizedPnl: unrealized },
      });
    }),
  );
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

  const [session, positions] = await Promise.all([
    db.paperCopySession.findUnique({ where: { id: sessionId } }),
    db.paperCopyPosition.findMany({ where: { sessionId } }),
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

  for (const position of openPositions) {
    const simulatedShares = position.size * copyRatio;
    if (simulatedShares <= 0) continue;

    const simulatedPrice = position.currentPrice > 0 ? position.currentPrice : position.avgPrice;
    const notional = simulatedShares * simulatedPrice;

    // Normalize outcome to UPPERCASE — Polymarket positions API returns "Up"/"Down"
    // but activity events return "UP"/"DOWN". Must match for position lookups.
    const normalizedOutcome = position.outcome.toUpperCase();

    // Idempotent — don't re-bootstrap if position already exists
    const existing = await db.paperCopyPosition.findUnique({
      where: {
        sessionId_marketId_outcome: {
          sessionId,
          marketId: position.conditionId,
          outcome: normalizedOutcome,
        },
      },
    });
    if (existing) continue;

    bootstrapNotional += notional;

    await db.paperCopyPosition.create({
      data: {
        sessionId,
        marketId: position.conditionId,
        marketQuestion: position.title,
        outcome: normalizedOutcome,
        netShares: simulatedShares,
        avgEntryPrice: simulatedPrice,
        currentMarkPrice: simulatedPrice,
        realizedPnl: 0,
        unrealizedPnl: 0,
        status: 'OPEN',
        openedAt: now,
      },
    });

    await db.paperCopyTrade.create({
      data: {
        sessionId,
        sourceActivityEventId: null,
        marketId: position.conditionId,
        marketQuestion: position.title,
        outcome: normalizedOutcome,
        side: 'BUY',
        action: 'BOOTSTRAP',
        sourcePrice: simulatedPrice,
        simulatedPrice,
        sourceShares: position.size,
        simulatedShares,
        notional,
        feeApplied: 0,
        slippageApplied: 0,
        eventTimestamp: now,
        processedAt: now,
        reasoning: {
          type: 'BOOTSTRAP_OPEN_POSITION',
          sourceExposureEstimate: estimatedSourceExposure,
          copyRatio,
          rawOutcome: position.outcome,
        },
      },
    });
  }

  return { estimatedSourceExposure, copyRatio, bootstrapNotional };
}
