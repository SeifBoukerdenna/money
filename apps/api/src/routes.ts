import { runBacktest } from '@copytrader/backtest-engine';
import { decideCopyOrder } from '@copytrader/risk-engine';
import { z } from 'zod';

import { config } from './config.js';
import { metricsRegistry } from './lib/metrics.js';
import { prisma } from './lib/prisma.js';
import { eventBus, loadRecentEvents } from './modules/event-stream.js';
import { getRuntimeOpsSnapshot } from './modules/runtime-ops.js';
import { getLatencyProfileState, setLatencyProfile } from './modules/latency-profile.js';
import { scheduleWalletPolls } from './modules/ingestion.js';
import { getLatestMarketIntelligence } from './modules/market-intelligence.js';
import { processWalletPoll } from './modules/ingestion.js';
import { createPolymarketDataAdapter } from './modules/polymarket.js';
import { decisionQueue, executionQueue, ingestQueue } from './modules/queue.js';
import {
  createPaperCopySession,
  deletePaperCopySession,
  getPaperCopySessionAnalytics,
  getSessionHealth,
  killAllPaperSessions,
  pausePaperCopySession,
  reconcilePaperSessionPositions,
  repairPaperCopySession,
  resumePaperCopySession,
  startPaperCopySession,
  stopPaperCopySession,
  updatePaperCopySessionGuardrails,
} from './modules/paper-copy.js';
import { resolvePaperExecutor } from './modules/paper-executor.js';
import { materializePaperSessionState } from './modules/paper-accounting.js';
import { reconcileWalletExposure } from './modules/reconciliation.js';
import { resolveWalletAddress, shortenAddress } from './modules/wallet-input.js';
import { getWalletLeaderboard } from './modules/wallet-analytics.js';
import { registerForceCloseRoutes } from './modules/force-close-routes.js';
import { listSystemAlerts, raiseSystemAlert } from './modules/system-alerts.js';
import {
  calculateWalletPnlSummary,
  deriveClosedPositionsFromDb,
  registerProfileParityRoutes,
} from './modules/profile-parity-routes.js';
import { buildProfileSummary } from './modules/profile-parity.js';
import { registerPaperSessionMarketRoutes } from './paper-session-market-routes.js';
import {
  buildTradeAttribution,
  resolveAttributionPositionKey,
  toNullableNumber,
} from './modules/paper-api-mappers.js';
import {
  bucketTrackedWalletTimeline,
  compareSourceVsSession,
  reduceTrackedWalletEvents,
  type TimelineBucket,
  type TrackedWalletTimelinePoint,
} from './modules/tracked-wallet-performance.js';
import { buildSessionSourceComparison } from './modules/session-analytics-contract.js';

const TRACKED_WALLET_CACHE_TTL_MS = 20_000;
const TRACKED_WALLET_MAX_EVENTS = 25_000;

type TrackedWalletEventRow = {
  id: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  side: 'BUY' | 'SELL' | null;
  effectiveSide: 'BUY' | 'SELL' | null;
  eventType: string;
  price: unknown;
  shares: unknown;
  notional: unknown;
  fee: unknown;
  eventTimestamp: Date;
  createdAt: Date;
};

type CachedTrackedWalletEvent = {
  id: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  side: 'BUY' | 'SELL' | null;
  effectiveSide: 'BUY' | 'SELL' | null;
  eventType: string;
  price: number | null;
  shares: number | null;
  notional: number | null;
  fee: number | null;
  eventTimestamp: Date;
  createdAt: Date;
};

type TrackedWalletCacheCursor = {
  eventTimestamp: Date;
  createdAt: Date;
  id: string;
};

function normalizeTrackedEventRow(row: TrackedWalletEventRow): CachedTrackedWalletEvent {
  return {
    id: row.id,
    marketId: row.marketId,
    conditionId: row.conditionId,
    marketQuestion: row.marketQuestion,
    outcome: row.outcome,
    side: row.side,
    effectiveSide: row.effectiveSide,
    eventType: row.eventType,
    price: row.price !== null ? Number(row.price) : null,
    shares: row.shares !== null ? Number(row.shares) : null,
    notional: row.notional !== null ? Number(row.notional) : null,
    fee: row.fee !== null ? Number(row.fee) : null,
    eventTimestamp: row.eventTimestamp,
    createdAt: row.createdAt,
  };
}

function toTrackedWalletCursor(
  event: CachedTrackedWalletEvent | undefined,
): TrackedWalletCacheCursor | null {
  if (!event) return null;
  return {
    eventTimestamp: event.eventTimestamp,
    createdAt: event.createdAt,
    id: event.id,
  };
}

function isEventAfterCursor(
  event: CachedTrackedWalletEvent,
  cursor: TrackedWalletCacheCursor,
): boolean {
  const eventTs = event.eventTimestamp.getTime();
  const cursorTs = cursor.eventTimestamp.getTime();
  if (eventTs !== cursorTs) return eventTs > cursorTs;

  const eventCreated = event.createdAt.getTime();
  const cursorCreated = cursor.createdAt.getTime();
  if (eventCreated !== cursorCreated) return eventCreated > cursorCreated;

  return event.id > cursor.id;
}

const trackedWalletReductionCache = new Map<
  string,
  {
    computedAt: number;
    wallet: { id: string; address: string; label: string };
    events: CachedTrackedWalletEvent[];
    lastCursor: TrackedWalletCacheCursor | null;
    hasTruncatedHistory: boolean;
    reduced: ReturnType<typeof reduceTrackedWalletEvents>;
  }
>();

const walletCreateSchema = z.object({
  input: z.string().min(3),
  label: z.string().optional(),
});

const modeUpdateSchema = z.object({
  strategyId: z.string().uuid(),
  mode: z.enum(['PAPER', 'LIVE']),
  confirmationToken: z.string().optional(),
});

const previewSchema = z.object({
  strategyId: z.string().uuid(),
  event: z.object({
    sourceEventId: z.string(),
    marketId: z.string(),
    outcome: z.string(),
    side: z.enum(['BUY', 'SELL']),
    size: z.number().positive(),
    price: z.number().positive(),
  }),
});

const smartConfigSchema = z.object({
  strategyId: z.string().uuid(),
  profitableWalletsOnly: z.boolean().optional(),
  minSourceTradeUsd: z.number().nullable().optional(),
  firstEntryOnly: z.boolean().optional(),
  ignoreExitTrades: z.boolean().optional(),
  copyClustersOnly: z.boolean().optional(),
  topRankedWalletsOnly: z.boolean().optional(),
  topRankMinWinRate: z.number().nullable().optional(),
  topRankMinSharpeLike: z.number().nullable().optional(),
});

const latencyProfileUpdateSchema = z.object({
  profile: z.enum(['NORMAL', 'TURBO']),
});

const dataAdapter = createPolymarketDataAdapter();

type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function computeSimulationRiskTier(input: {
  winRatePct: number;
  netPnl: number;
  tradeCount: number;
}): RiskTier {
  if (input.winRatePct > 60 && input.netPnl > 0 && input.tradeCount > 50) return 'LOW';
  if (input.winRatePct > 45 && input.netPnl > 0) return 'MEDIUM';
  if (input.winRatePct < 40 || input.netPnl < 0) return 'HIGH';
  return 'UNKNOWN';
}

function formatRelativeTime(input: Date): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - input.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function sampleTimelineValueAtOrBefore(
  points: Array<{ timestamp: string; value: number }>,
  timestamp: string,
): number {
  if (points.length === 0) return 0;
  const targetMs = new Date(timestamp).getTime();
  if (!Number.isFinite(targetMs)) return points.at(-1)?.value ?? 0;

  let lo = 0;
  let hi = points.length - 1;
  let best = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const pointMs = new Date(points[mid]?.timestamp ?? '').getTime();
    if (pointMs <= targetMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best < 0) return 0;
  return points[best]?.value ?? 0;
}

function reduceTimelineWindowDelta(
  timeline: TrackedWalletTimelinePoint[],
  windowStart: string,
  windowEnd: string,
) {
  const startMs = new Date(windowStart).getTime();
  const baselineTimestamp = Number.isFinite(startMs)
    ? new Date(startMs - 1).toISOString()
    : windowStart;

  const realizedSeries = timeline.map((row) => ({
    timestamp: row.eventTimestamp,
    value: row.realizedPnlGross,
  }));
  const feeSeries = timeline.map((row) => ({ timestamp: row.eventTimestamp, value: row.fees }));
  const unrealizedSeries = timeline.map((row) => ({
    timestamp: row.eventTimestamp,
    value: row.unrealizedPnl,
  }));
  const netSeries = timeline.map((row) => ({ timestamp: row.eventTimestamp, value: row.netPnl }));

  const startRealized = sampleTimelineValueAtOrBefore(realizedSeries, baselineTimestamp);
  const endRealized = sampleTimelineValueAtOrBefore(realizedSeries, windowEnd);
  const startFees = sampleTimelineValueAtOrBefore(feeSeries, baselineTimestamp);
  const endFees = sampleTimelineValueAtOrBefore(feeSeries, windowEnd);
  const startUnrealized = sampleTimelineValueAtOrBefore(unrealizedSeries, baselineTimestamp);
  const endUnrealized = sampleTimelineValueAtOrBefore(unrealizedSeries, windowEnd);
  const startNet = sampleTimelineValueAtOrBefore(netSeries, baselineTimestamp);
  const endNet = sampleTimelineValueAtOrBefore(netSeries, windowEnd);

  return {
    realizedPnlGross: endRealized - startRealized,
    fees: endFees - startFees,
    unrealizedPnl: endUnrealized - startUnrealized,
    netPnl: endNet - startNet,
  };
}

function bucketCurvePoints(
  points: Array<{ timestamp: string; value: number }>,
  bucket: TimelineBucket,
): Array<{ timestamp: string; value: number }> {
  if (bucket === 'RAW' || points.length === 0) return points;

  const sizeMs = bucket === '5M' ? 5 * 60_000 : bucket === '15M' ? 15 * 60_000 : 60 * 60_000;
  const byBucket = new Map<number, { timestamp: string; value: number }>();
  for (const point of points) {
    const ts = new Date(point.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const b = Math.floor(ts / sizeMs) * sizeMs;
    const existing = byBucket.get(b);
    if (
      !existing ||
      new Date(point.timestamp).getTime() >= new Date(existing.timestamp).getTime()
    ) {
      byBucket.set(b, point);
    }
  }
  return Array.from(byBucket.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, point]) => point);
}

async function buildTrackedWalletMarkMap(input: {
  trackedWalletId: string;
  walletAddress: string;
}) {
  const markMap = new Map<string, number>();
  const markMetaByKey = new Map<string, { source: 'LIVE' | 'FALLBACK'; stale: boolean }>();
  let liveMarkCount = 0;
  let fallbackMarkCount = 0;

  try {
    const livePositions = await dataAdapter.getWalletPositions(input.walletAddress, 'OPEN', 500);
    for (const row of livePositions as Array<Record<string, unknown>>) {
      const marketKey = String(row.conditionId ?? row.marketId ?? '').trim();
      const outcome = String(row.outcome ?? '')
        .trim()
        .toUpperCase();
      const price = Number(row.currentPrice ?? row.curPrice ?? row.price ?? row.avgPrice ?? 0);
      if (!marketKey || !outcome || !Number.isFinite(price)) continue;
      const clamped = Math.max(0, Math.min(1, price));
      const key = `${marketKey}:${outcome}`;
      markMap.set(key, clamped);
      markMetaByKey.set(key, { source: 'LIVE', stale: false });
      liveMarkCount += 1;
    }
  } catch {
    // Non-fatal. We still build marks from recent event prices below.
  }

  const fallbackPrices = await prisma.walletActivityEvent.findMany({
    where: {
      trackedWalletId: input.trackedWalletId,
      price: { not: null },
      outcome: { not: null },
    },
    orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }],
    take: 4000,
    select: {
      marketId: true,
      conditionId: true,
      outcome: true,
      price: true,
    },
  });

  for (const row of fallbackPrices) {
    const marketKey = String(row.conditionId ?? row.marketId ?? '').trim();
    const outcome = String(row.outcome ?? '')
      .trim()
      .toUpperCase();
    const price = row.price !== null ? Number(row.price) : NaN;
    if (!marketKey || !outcome || !Number.isFinite(price)) continue;
    const key = `${marketKey}:${outcome}`;
    if (!markMap.has(key)) {
      markMap.set(key, Math.max(0, Math.min(1, price)));
      markMetaByKey.set(key, { source: 'FALLBACK', stale: true });
      fallbackMarkCount += 1;
    }
  }

  return {
    markPriceByKey: markMap,
    markMetaByKey,
    diagnostics: {
      liveMarkCount,
      fallbackMarkCount,
    },
  };
}

async function getLatestIngestionDiagnostic(walletId: string) {
  const row = await prisma.auditLog.findFirst({
    where: { category: 'INGESTION', entityId: walletId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  const payload = row.payload as Record<string, unknown>;
  const summary =
    payload && typeof payload.summary === 'object'
      ? (payload.summary as Record<string, unknown>)
      : null;

  return {
    outcome: row.action,
    createdAt: row.createdAt,
    errorClass: typeof payload?.errorClass === 'string' ? payload.errorClass : null,
    message: typeof payload?.message === 'string' ? payload.message : null,
    summary: summary
      ? {
          fetchedEvents: Number(summary.fetchedEvents ?? 0),
          insertedActivityEvents: Number(summary.insertedActivityEvents ?? 0),
          insertedTradeEvents: Number(summary.insertedTradeEvents ?? 0),
          duplicateEvents: Number(summary.duplicateEvents ?? 0),
          parseErrors: Number(summary.parseErrors ?? 0),
          dbInsertErrors: Number(summary.dbInsertErrors ?? 0),
          decisionEnqueueErrors: Number(summary.decisionEnqueueErrors ?? 0),
        }
      : null,
  };
}

async function computeTrackedWalletPerformance(input: {
  walletId: string;
  strictKnownOnly?: boolean;
}) {
  const strictKnownOnly = input.strictKnownOnly ?? false;
  const cacheKey = `${input.walletId}:${strictKnownOnly ? 'STRICT' : 'INFER'}`;
  const now = Date.now();
  const cached = trackedWalletReductionCache.get(cacheKey);
  if (cached && now - cached.computedAt <= TRACKED_WALLET_CACHE_TTL_MS) {
    return {
      wallet: cached.wallet,
      reduced: cached.reduced,
      markDiagnostics: {
        liveMarkCount: 0,
        fallbackMarkCount: 0,
      },
      fromCache: true,
      incrementalRefresh: false,
      hasTruncatedHistory: cached.hasTruncatedHistory,
      scannedEventCount: cached.events.length,
      maxEventCap: TRACKED_WALLET_MAX_EVENTS,
    };
  }

  const wallet = await prisma.watchedWallet.findUnique({
    where: { id: input.walletId },
    select: { id: true, address: true, label: true },
  });
  if (!wallet) {
    throw new Error('Wallet not found');
  }

  const eventSelect = {
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
    eventTimestamp: true,
    createdAt: true,
  } as const;

  let eventsForReduction: CachedTrackedWalletEvent[] = [];
  let incrementalRefresh = false;
  let hasTruncatedHistory = false;

  if (cached) {
    const cursor = cached.lastCursor;
    const incrementalRowsRawDesc = await prisma.walletActivityEvent.findMany({
      where: {
        trackedWalletId: input.walletId,
        ...(cursor
          ? {
              OR: [
                { eventTimestamp: { gt: cursor.eventTimestamp } },
                {
                  eventTimestamp: cursor.eventTimestamp,
                  createdAt: { gt: cursor.createdAt },
                },
                {
                  eventTimestamp: cursor.eventTimestamp,
                  createdAt: cursor.createdAt,
                  id: { gt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: TRACKED_WALLET_MAX_EVENTS + 1,
      select: eventSelect,
    });

    if (incrementalRowsRawDesc.length > 0) {
      const incrementalOverflow = incrementalRowsRawDesc.length > TRACKED_WALLET_MAX_EVENTS;
      const incrementalRows = incrementalRowsRawDesc
        .slice(0, TRACKED_WALLET_MAX_EVENTS)
        .reverse()
        .map((row) => normalizeTrackedEventRow(row as unknown as TrackedWalletEventRow));
      eventsForReduction = [...cached.events, ...incrementalRows];
      if (eventsForReduction.length > TRACKED_WALLET_MAX_EVENTS) {
        eventsForReduction = eventsForReduction.slice(-TRACKED_WALLET_MAX_EVENTS);
        hasTruncatedHistory = true;
      } else {
        hasTruncatedHistory = cached.hasTruncatedHistory || incrementalOverflow;
      }
      incrementalRefresh = true;
    } else {
      eventsForReduction = cached.events;
      hasTruncatedHistory = cached.hasTruncatedHistory;
    }
  } else {
    const latestRowsRaw = await prisma.walletActivityEvent.findMany({
      where: { trackedWalletId: input.walletId },
      orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: TRACKED_WALLET_MAX_EVENTS + 1,
      select: eventSelect,
    });

    hasTruncatedHistory = latestRowsRaw.length > TRACKED_WALLET_MAX_EVENTS;
    eventsForReduction = latestRowsRaw
      .slice(0, TRACKED_WALLET_MAX_EVENTS)
      .reverse()
      .map((row) => normalizeTrackedEventRow(row as unknown as TrackedWalletEventRow));
  }

  const marks = await buildTrackedWalletMarkMap({
    trackedWalletId: wallet.id,
    walletAddress: wallet.address,
  });

  const reduced = reduceTrackedWalletEvents({
    events: eventsForReduction.map((row) => ({
      id: row.id,
      marketId: row.marketId,
      conditionId: row.conditionId,
      marketQuestion: row.marketQuestion,
      outcome: row.outcome,
      side: row.side,
      effectiveSide: row.effectiveSide,
      eventType: row.eventType,
      price: row.price !== null ? Number(row.price) : null,
      shares: row.shares !== null ? Number(row.shares) : null,
      notional: row.notional !== null ? Number(row.notional) : null,
      fee: row.fee !== null ? Number(row.fee) : null,
      eventTimestamp: row.eventTimestamp,
      createdAt: row.createdAt,
    })),
    markPriceByKey: marks.markPriceByKey,
    markMetaByKey: marks.markMetaByKey,
    inferMissingFields: !strictKnownOnly,
    hasTruncatedHistory,
  });

  trackedWalletReductionCache.set(cacheKey, {
    computedAt: now,
    wallet,
    events: eventsForReduction,
    lastCursor: toTrackedWalletCursor(eventsForReduction.at(-1)),
    hasTruncatedHistory,
    reduced,
  });

  return {
    wallet,
    reduced,
    markDiagnostics: marks.diagnostics,
    fromCache: false,
    incrementalRefresh,
    hasTruncatedHistory,
    scannedEventCount: eventsForReduction.length,
    maxEventCap: TRACKED_WALLET_MAX_EVENTS,
  };
}

async function getWalletSyncVisibility(walletId: string, lastActivitySyncedAt: Date | null) {
  const [latestDiagnostic, mismatchCount, unresolvedGapCount, cursor] = await Promise.all([
    getLatestIngestionDiagnostic(walletId),
    prisma.auditLog.count({
      where: {
        category: 'RECONCILIATION',
        entityId: walletId,
        action: 'MISMATCH',
      },
    }),
    prisma.walletReconciliationIssue.count({
      where: {
        trackedWalletId: walletId,
        resolvedAt: null,
      },
    }),
    prisma.walletSyncCursor.findUnique({
      where: {
        trackedWalletId_sourceName: {
          trackedWalletId: walletId,
          sourceName: 'POLYMARKET_DATA_API',
        },
      },
      select: {
        sourceName: true,
        sourceType: true,
        highWatermarkTimestamp: true,
        highWatermarkCursor: true,
        overlapWindowSec: true,
        lastSuccessAt: true,
        lastFailureAt: true,
        lastErrorClass: true,
        lagSec: true,
        status: true,
        lastFetchedCount: true,
        lastInsertedCount: true,
        lastDuplicateCount: true,
        lastParseErrorCount: true,
        lastInsertErrorCount: true,
      },
    }),
  ]);

  const now = Date.now();
  const basisTs =
    cursor?.highWatermarkTimestamp ?? lastActivitySyncedAt ?? latestDiagnostic?.createdAt ?? null;
  const staleSeconds = basisTs ? Math.floor((now - basisTs.getTime()) / 1000) : null;

  return {
    latestIngestion: latestDiagnostic,
    mismatchCount,
    unresolvedGapCount,
    staleSeconds,
    isStale: staleSeconds !== null ? staleSeconds > 120 : false,
    cursor,
  };
}

export async function registerRoutes(app: any): Promise<void> {
  const db = prisma as unknown as Record<string, any>;

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ready' };
  });

  app.get('/health/ops', async () => {
    const now = Date.now();
    const staleCutoff = new Date(now - 5 * 60_000);
    const [
      ingestWaiting,
      decisionWaiting,
      executionWaiting,
      staleWalletSyncCount,
      staleSessionCount,
    ] = await Promise.all([
      ingestQueue.getWaitingCount(),
      decisionQueue.getWaitingCount(),
      executionQueue.getWaitingCount(),
      prisma.watchedWallet.count({
        where: {
          enabled: true,
          copyEnabled: true,
          OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: staleCutoff } }, { syncStatus: 'ERROR' }],
        },
      }),
      prisma.paperCopySession.count({
        where: {
          status: 'RUNNING',
          OR: [{ lastProcessedEventAt: null }, { lastProcessedEventAt: { lt: staleCutoff } }],
        },
      }),
    ]);

    if (staleWalletSyncCount > 0) {
      await raiseSystemAlert({
        dedupeKey: 'OPS:STALE_WALLETS',
        alertType: 'STALE_WALLET_SYNC',
        severity: 'WARN',
        title: 'Stale wallet polling detected',
        message: `${staleWalletSyncCount} tracked wallet(s) are stale or in sync error state.`,
        payloadJson: {
          staleWalletSyncCount,
          staleCutoffIso: staleCutoff.toISOString(),
        },
      }).catch(() => undefined);
    }

    if (staleSessionCount > 0) {
      await raiseSystemAlert({
        dedupeKey: 'OPS:STALE_SESSIONS',
        alertType: 'STALE_PAPER_SESSION',
        severity: 'WARN',
        title: 'Stale paper sessions detected',
        message: `${staleSessionCount} running paper session(s) have not processed recent source events.`,
        payloadJson: {
          staleSessionCount,
          staleCutoffIso: staleCutoff.toISOString(),
        },
      }).catch(() => undefined);
    }

    const mem = process.memoryUsage();
    return {
      runtime: getRuntimeOpsSnapshot(),
      queue: {
        ingestWaiting,
        decisionWaiting,
        executionWaiting,
      },
      stale: {
        staleWalletSyncCount,
        staleSessionCount,
      },
      process: {
        pid: process.pid,
        uptimeSec: Math.floor(process.uptime()),
        memoryMb: {
          rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
          heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
          heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
          external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
        },
      },
      eventBus: {
        listenerCount: eventBus.listenerCount(),
      },
    };
  });

  app.get('/metrics', async (_: any, reply: any) => {
    reply.header('content-type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  app.get('/admin/latency-profile', async () => {
    return getLatencyProfileState();
  });

  app.post('/admin/latency-profile', async (req: any) => {
    const body = latencyProfileUpdateSchema.parse(req.body ?? {});
    return setLatencyProfile(body.profile);
  });

  app.get('/alerts/system', async (req: any) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
        sessionId: z.string().uuid().optional(),
        walletId: z.string().uuid().optional(),
      })
      .parse(req.query ?? {});

    return listSystemAlerts({
      limit: query.limit,
      status: query.status,
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.walletId ? { walletId: query.walletId } : {}),
    });
  });

  app.get('/admin/ops/advanced', async () => {
    const staleCutoff = new Date(Date.now() - 5 * 60_000);

    const [staleWallets, atRiskSessions, latestAlerts] = await Promise.all([
      prisma.watchedWallet.findMany({
        where: {
          enabled: true,
          copyEnabled: true,
          OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: staleCutoff } }, { syncStatus: 'ERROR' }],
        },
        orderBy: { lastSyncAt: 'asc' },
        take: 50,
        select: {
          id: true,
          label: true,
          address: true,
          syncStatus: true,
          lastSyncAt: true,
          lastSyncError: true,
        },
      }),
      prisma.paperCopySession.findMany({
        where: {
          status: { in: ['RUNNING', 'PAUSED'] },
          OR: [
            { consecutiveDecisionFailures: { gte: 3 } },
            { lastProcessedEventAt: { lt: staleCutoff } },
          ],
        },
        orderBy: [{ consecutiveDecisionFailures: 'desc' }, { updatedAt: 'desc' }],
        take: 50,
        select: {
          id: true,
          status: true,
          trackedWalletId: true,
          trackedWalletAddress: true,
          consecutiveDecisionFailures: true,
          lastProcessedEventAt: true,
          lastAutoPausedAt: true,
          minWalletTrades: true,
          minWalletWinRate: true,
          minWalletSharpeLike: true,
          dailyDrawdownLimitPct: true,
        },
      }),
      listSystemAlerts({ limit: 30, status: 'OPEN' }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      staleWallets,
      atRiskSessions: atRiskSessions.map((row: any) => ({
        ...row,
        minWalletWinRate: row.minWalletWinRate !== null ? Number(row.minWalletWinRate) : null,
        minWalletSharpeLike:
          row.minWalletSharpeLike !== null ? Number(row.minWalletSharpeLike) : null,
        dailyDrawdownLimitPct:
          row.dailyDrawdownLimitPct !== null ? Number(row.dailyDrawdownLimitPct) : null,
      })),
      alerts: latestAlerts,
    };
  });

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  app.get('/dashboard/overview', async () => {
    const [walletCount, activeWallets, totalTrades, tradesToday, latestTrades] = await Promise.all([
      prisma.watchedWallet.count(),
      prisma.watchedWallet.count({
        where: { enabled: true, copyEnabled: true, syncStatus: 'ACTIVE' },
      }),
      prisma.tradeEvent.count(),
      prisma.tradeEvent.count({
        where: { tradedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
      prisma.tradeEvent.findMany({
        orderBy: { tradedAt: 'desc' },
        take: 20,
        include: { wallet: true },
      }),
    ]);

    return {
      trackedWallets: walletCount,
      activeWallets,
      totalTrades,
      tradesToday,
      recentWalletActivity: latestTrades.map((row: any) => ({
        walletId: row.walletId,
        label: row.wallet.label,
        address: row.wallet.address,
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        side: row.side,
        price: Number(row.price),
        size: Number(row.size),
        tradedAt: row.tradedAt,
      })),
    };
  });

  app.get('/dashboard/intelligence', async () => {
    const [leaderboard, whaleTrades, clusterSignals, sentiment, activeMarkets] = await Promise.all([
      getWalletLeaderboard('pnl').then((rows: any[]) => rows.slice(0, 10)),
      prisma.whaleAlert.findMany({
        include: { wallet: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.clusterSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      getLatestMarketIntelligence(20),
      prisma.tradeEvent.groupBy({
        by: ['marketId'],
        _count: { marketId: true },
        where: { tradedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        orderBy: { _count: { marketId: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      leaderboard,
      whaleAlerts: whaleTrades,
      clusterSignals,
      sentiment,
      activeMarkets,
    };
  });

  app.get('/intelligence/scorecards', async (req: any) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
      .parse(req.query ?? {});

    const snapshots = await prisma.walletAnalyticsSnapshot.findMany({
      orderBy: { createdAt: 'desc' },
      include: { wallet: true },
      take: 5000,
    });

    const latestByWallet = new Map<string, (typeof snapshots)[number]>();
    for (const row of snapshots) {
      if (!latestByWallet.has(row.walletId)) {
        latestByWallet.set(row.walletId, row);
      }
    }

    const nowMs = Date.now();
    const rows = Array.from(latestByWallet.values())
      .map((row) => {
        const trades = Number(row.totalTrades ?? 0);
        const winRate = Number(row.winRate ?? 0);
        const sharpeLike = Number(row.sharpeLike ?? 0);
        const pnl = Number(row.realizedPnl ?? 0);
        const maxDrawdown = Number(row.maxDrawdown ?? 0);
        const recencyHours = Math.max(0, (nowMs - row.createdAt.getTime()) / 3_600_000);
        const sampleConfidence = Math.min(1, trades / 120);
        const recencyConfidence = Math.max(0, 1 - recencyHours / 24);
        const confidence = Number((sampleConfidence * 0.7 + recencyConfidence * 0.3).toFixed(3));
        const normalizedPnl = Math.tanh(pnl / 4_000);
        const normalizedSharpe = Math.tanh(sharpeLike / 2.2);
        const normalizedWinRate = Math.max(-1, Math.min(1, (winRate - 0.5) * 2));
        const normalizedDrawdown = Math.tanh(maxDrawdown / 2_000);
        const compositeScore = Number(
          (
            (normalizedPnl * 0.45 +
              normalizedSharpe * 0.25 +
              normalizedWinRate * 0.2 -
              normalizedDrawdown * 0.1) *
            confidence
          ).toFixed(4),
        );
        return {
          walletId: row.walletId,
          label: row.wallet.label,
          wallet: row.wallet.address,
          totalTrades: trades,
          winRate,
          sharpeLike,
          realizedPnl: pnl,
          maxDrawdown,
          confidence,
          recencyHours: Number(recencyHours.toFixed(2)),
          compositeScore,
          snapshotAt: row.createdAt,
        };
      })
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, query.limit);

    return {
      methodology: {
        version: 'phase6-v1',
        confidence: '70% sample size + 30% recency',
        score:
          '45% pnl + 25% sharpe-like + 20% win rate - 10% drawdown, then multiplied by confidence',
      },
      rows,
    };
  });

  // ---------------------------------------------------------------------------
  // Wallets
  // ---------------------------------------------------------------------------

  app.get('/wallets', async () => {
    const wallets = await prisma.watchedWallet.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tradeEvents: true } } },
    });
    const enriched = await Promise.all(
      wallets.map(async (w: any) => {
        const visibility = await getWalletSyncVisibility(w.id, w.lastActivitySyncedAt ?? null);
        return {
          id: w.id,
          address: w.address,
          shortAddress: w.address.slice(0, 6) + '…' + w.address.slice(-4),
          label: w.label,
          enabled: w.enabled,
          copyEnabled: w.copyEnabled,
          syncStatus: w.syncStatus,
          lastSyncAt: w.lastSyncAt,
          lastSyncError: w.lastSyncError,
          lastActivitySyncAt: w.lastActivitySyncedAt,
          lastPositionsSyncAt: w.lastPositionsSyncedAt,
          totalTrades: w._count.tradeEvents,
          lastPolledAt: w.lastPolledAt,
          nextPollAt: w.nextPollAt,
          staleSeconds: visibility.staleSeconds,
          isStale: visibility.isStale,
          mismatchCount: visibility.mismatchCount,
          unresolvedGapCount: visibility.unresolvedGapCount,
          latestIngestion: visibility.latestIngestion,
          syncCursor: visibility.cursor,
        };
      }),
    );
    return enriched;
  });

  app.post('/wallets', async (req: any) => {
    const body = walletCreateSchema.parse(req.body ?? {});
    const address = await resolveWalletAddress(body.input);

    const existing = await prisma.watchedWallet.findUnique({ where: { address } });
    if (existing) {
      if (!existing.enabled) {
        await prisma.watchedWallet.update({
          where: { id: existing.id },
          data: { enabled: true, copyEnabled: true, syncStatus: 'SYNCING', lastSyncError: null },
        });
        await processWalletPoll(existing.id, existing.address);
        return {
          walletId: existing.id,
          created: false,
          address: existing.address,
          message: 'Wallet re-enabled and sync restarted.',
        };
      }
      return {
        walletId: existing.id,
        created: false,
        address: existing.address,
        message: 'Wallet already tracked',
      };
    }

    const label = body.label?.trim() || shortenAddress(address);
    const wallet = await prisma.watchedWallet.create({
      data: {
        address,
        label,
        enabled: true,
        copyEnabled: true,
        syncStatus: 'SYNCING',
        strategies: {
          create: {
            name: `${label} Strategy`,
            enabled: true,
            mode: 'PAPER',
            riskConfig: {
              create: {
                fixedDollar: 100,
                pctSourceSize: null,
                pctBankroll: null,
                maxExposure: 5000,
                perMarketMaxAllocation: 1000,
                dailyLossCap: 500,
                maxSlippageBps: 150,
                minLiquidity: 1000,
                maxSpreadBps: 1500,
                inverseMode: false,
                copyBuys: true,
                copySells: true,
                cooldownSeconds: 5,
                fillStrategy: 'MIDPOINT_FALLBACK',
              },
            },
            smartConfig: {
              create: {
                profitableWalletsOnly: false,
                minSourceTradeUsd: null,
                firstEntryOnly: false,
                ignoreExitTrades: false,
                copyClustersOnly: false,
                topRankedWalletsOnly: false,
                topRankMinWinRate: null,
                topRankMinSharpeLike: null,
              },
            },
          },
        },
      },
    });

    await processWalletPoll(wallet.id, wallet.address);
    return { walletId: wallet.id, created: true, address: wallet.address, label: wallet.label };
  });

  app.get('/wallets/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({
      where: { id: params.id },
      include: { _count: { select: { tradeEvents: true } } },
    });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    const recentMarkets = await prisma.tradeEvent.groupBy({
      by: ['marketId', 'marketQuestion'],
      where: { walletId: wallet.id },
      _count: { marketId: true },
      orderBy: { _count: { marketId: 'desc' } },
      take: 10,
    });

    const visibility = await getWalletSyncVisibility(
      wallet.id,
      wallet.lastActivitySyncedAt ?? null,
    );

    return {
      id: wallet.id,
      address: wallet.address,
      label: wallet.label,
      syncStatus: wallet.syncStatus,
      lastSyncAt: wallet.lastSyncAt,
      lastSyncError: wallet.lastSyncError,
      lastActivitySyncAt: wallet.lastActivitySyncedAt,
      lastPositionsSyncAt: wallet.lastPositionsSyncedAt,
      lastPolledAt: wallet.lastPolledAt,
      nextPollAt: wallet.nextPollAt,
      staleSeconds: visibility.staleSeconds,
      isStale: visibility.isStale,
      mismatchCount: visibility.mismatchCount,
      unresolvedGapCount: visibility.unresolvedGapCount,
      latestIngestion: visibility.latestIngestion,
      syncCursor: visibility.cursor,
      totalTrades: wallet._count.tradeEvents,
      recentMarkets: recentMarkets.map((row: any) => ({
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        trades: row._count.marketId,
      })),
    };
  });

  app.get('/wallets/:id/activity', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        eventType: z.string().optional(),
        side: z.enum(['BUY', 'SELL']).optional(),
        market: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(req.query ?? {});

    const where: Record<string, unknown> = { trackedWalletId: params.id };
    if (query.side) where.side = query.side;
    if (query.eventType) where.eventType = query.eventType;
    if (query.market) where.marketId = { contains: query.market, mode: 'insensitive' };
    if (query.from || query.to) {
      const ts: Record<string, Date> = {};
      if (query.from) ts.gte = new Date(query.from);
      if (query.to) ts.lte = new Date(query.to);
      where.eventTimestamp = ts;
    }

    const [total, rows] = await Promise.all([
      prisma.walletActivityEvent.count({ where }),
      prisma.walletActivityEvent.findMany({
        where,
        orderBy: [{ eventTimestamp: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map((row: any) => ({
        id: row.id,
        sourceName: row.sourceName,
        sourceType: row.sourceType,
        sourceEventId: row.sourceEventId,
        sourceCursor: row.sourceCursor,
        sourceTxHash: row.sourceTxHash,
        blockNumber: row.blockNumber,
        logIndex: row.logIndex,
        eventType: row.eventType,
        marketId: row.marketId,
        conditionId: row.conditionId,
        marketQuestion: row.marketQuestion,
        outcome: row.outcome,
        side: row.side,
        effectiveSide: row.effectiveSide,
        price: row.price ? Number(row.price) : null,
        shares: row.shares ? Number(row.shares) : null,
        notional: row.notional ? Number(row.notional) : null,
        txHash: row.txHash,
        orderId: row.orderId,
        eventTimestamp: row.eventTimestamp,
        observedAt: row.observedAt,
        detectedAt: row.detectedAt,
        provenanceNote: row.provenanceNote,
      })),
    };
  });

  app.get('/wallets/:id/positions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        status: z.enum(['OPEN', 'CLOSED']).default('OPEN'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});

    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    try {
      const items = await dataAdapter.getWalletPositions(wallet.address, query.status, query.limit);
      return { walletId: wallet.id, status: query.status, total: items.length, items };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load wallet positions';
      throw app.httpErrors.badRequest(message);
    }
  });

  app.post('/wallets/:id/sync', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');
    await processWalletPoll(wallet.id, wallet.address);
    return { synced: true };
  });

  app.post('/wallets/:id/reconcile', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');
    await reconcileWalletExposure(wallet.id, wallet.address);
    return { reconciled: true };
  });

  app.get('/wallets/:id/reconciliation-issues', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        unresolvedOnly: z.coerce.boolean().default(true),
        limit: z.coerce.number().int().min(1).max(2500).default(100),
      })
      .parse(req.query ?? {});

    const where: Record<string, unknown> = {
      trackedWalletId: params.id,
    };
    if (query.unresolvedOnly) {
      where.resolvedAt = null;
    }

    const rows = await prisma.walletReconciliationIssue.findMany({
      where,
      orderBy: [{ detectedAt: 'desc' }, { createdAt: 'desc' }],
      take: query.limit,
    });

    return {
      walletId: params.id,
      total: rows.length,
      items: rows,
    };
  });

  app.delete('/wallets/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await prisma.watchedWallet.delete({ where: { id: params.id } });
    return { deleted: true };
  });

  app.post('/wallets/:id/toggle', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    return prisma.watchedWallet.update({
      where: { id: params.id },
      data: {
        enabled: body.enabled,
        copyEnabled: body.enabled,
        syncStatus: body.enabled ? 'ACTIVE' : 'PAUSED',
      },
    });
  });

  app.get('/wallets/:id/analytics', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const snapshot = await prisma.walletAnalyticsSnapshot.findFirst({
      where: { walletId: params.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!snapshot) throw app.httpErrors.notFound('No analytics snapshot yet');
    return snapshot;
  });

  app.get('/wallets/:id/tracked-performance', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(10000).default(1500),
        bucket: z.enum(['RAW', '5M', '15M', '1H']).default('RAW'),
        strictKnownOnly: z.coerce.boolean().default(true),
      })
      .parse(req.query ?? {});

    const {
      wallet,
      reduced,
      markDiagnostics,
      fromCache,
      incrementalRefresh,
      hasTruncatedHistory,
      scannedEventCount,
      maxEventCap,
    } = await computeTrackedWalletPerformance({
      walletId: params.id,
      strictKnownOnly: query.strictKnownOnly,
    });
    const startWindow = query.from ?? reduced.timeline[0]?.eventTimestamp ?? null;
    const endWindow = query.to ?? reduced.timeline.at(-1)?.eventTimestamp ?? null;

    const bucketedTimeline = bucketTrackedWalletTimeline(
      reduced.timeline,
      query.bucket as TimelineBucket,
    );

    const filteredTimeline = bucketedTimeline
      .filter((point) => {
        if (query.from) {
          const fromMs = new Date(query.from).getTime();
          if (new Date(point.eventTimestamp).getTime() < fromMs) return false;
        }
        if (query.to) {
          const toMs = new Date(query.to).getTime();
          if (new Date(point.eventTimestamp).getTime() > toMs) return false;
        }
        return true;
      })
      .slice(-query.limit);

    const windowSummary =
      startWindow && endWindow
        ? reduceTimelineWindowDelta(reduced.timeline, startWindow, endWindow)
        : {
            realizedPnlGross: reduced.realizedPnlGross,
            unrealizedPnl: reduced.unrealizedPnl,
            fees: reduced.fees,
            netPnl: reduced.netPnl,
          };

    return {
      walletId: wallet.id,
      walletAddress: wallet.address,
      walletLabel: wallet.label,
      canonical: {
        canonicalKnownNetPnl: reduced.canonical.canonicalKnownNetPnl,
        canonicalRealizedPnl: reduced.canonical.canonicalRealizedPnl,
        canonicalUnrealizedPnl: reduced.canonical.canonicalUnrealizedPnl,
        canonicalFees: reduced.canonical.canonicalFees,
        estimatedNetPnl: reduced.canonical.estimatedNetPnl,
      },
      confidence: reduced.confidenceModel.confidence,
      confidenceModel: reduced.confidenceModel,
      knowability: {
        startingCashKnown: false,
        accountValueMode: 'RECONSTRUCTED_RELATIVE',
        accountValueDescription:
          'Reconstructed account value is relative to baseline because true wallet cash is not directly observable from activity events alone.',
        feeCoveragePct: reduced.summary.feeCoveragePct,
        inferredShareEvents: reduced.summary.inferredShareEvents,
        inferredPriceEvents: reduced.summary.inferredPriceEvents,
        strictKnownOnly: query.strictKnownOnly,
        historyTruncatedByCap: hasTruncatedHistory,
        scannedEventCount,
        maxEventCap,
        liveMarkCount: markDiagnostics.liveMarkCount,
        fallbackMarkCount: markDiagnostics.fallbackMarkCount,
      },
      totals: {
        // Deprecated compatibility fields. Prefer `canonical` metrics above.
        canonicalKnownNetPnl: reduced.canonical.canonicalKnownNetPnl,
        canonicalRealizedPnl: reduced.canonical.canonicalRealizedPnl,
        canonicalUnrealizedPnl: reduced.canonical.canonicalUnrealizedPnl,
        canonicalFees: reduced.canonical.canonicalFees,
        estimatedNetPnl: reduced.canonical.estimatedNetPnl,
        realizedPnlGross: reduced.realizedPnlGross,
        unrealizedPnl: reduced.unrealizedPnl,
        fees: reduced.fees,
        netPnl: reduced.netPnl,
        cashDelta: reduced.cashDelta,
        openMarketValue: reduced.openMarketValue,
        reconstructedAccountValue: reduced.reconstructedAccountValue,
      },
      window: {
        from: startWindow,
        to: endWindow,
        ...windowSummary,
      },
      invariants: {
        netDecompositionDrift:
          reduced.netPnl - (reduced.realizedPnlGross + reduced.unrealizedPnl - reduced.fees),
      },
      summary: reduced.summary,
      debugReport: reduced.debugReport,
      validationReport: {
        eventCountsByType: reduced.debugReport.eventCountsByType,
        firstEventTimestamp: reduced.debugReport.firstEventTimestamp,
        lastEventTimestamp: reduced.debugReport.lastEventTimestamp,
        duplicates: reduced.debugReport.duplicateCount,
        unsupportedCount: reduced.debugReport.unsupportedIgnoredEvents,
        confidenceFlags: reduced.confidenceModel,
        realized: reduced.realizedPnlGross,
        unrealized: reduced.unrealizedPnl,
        fees: reduced.fees,
        openPositions: reduced.positions.filter((p) => p.status === 'OPEN').length,
        unknownCostBasisPositions: reduced.debugReport.unknownCostBasisPositions,
        reconciliationWarnings: reduced.warnings.map((w) => w.message),
        notes: [
          'Source vs session can differ from execution latency, slippage, fees, and unsupported source events.',
          'Canonical known metrics exclude unknown or estimated components to remain conservative.',
        ],
      },
      compute: {
        cacheHit: fromCache,
        incrementalRefresh,
        scannedEventCount,
        maxEventCap,
        historyTruncatedByCap: hasTruncatedHistory,
        bucket: query.bucket,
      },
      warnings: [
        ...reduced.warnings,
        ...(hasTruncatedHistory
          ? [
              {
                code: 'SOURCE_HISTORY_TRUNCATED',
                eventId: 'SYSTEM',
                message: `Source history capped at ${maxEventCap} events; only ${scannedEventCount} most recent events were used for reduction.`,
              },
            ]
          : []),
      ],
      timeline: filteredTimeline,
      positions: reduced.positions,
    };
  });

  app.get('/wallets/:id/source-vs-sessions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        sessionIds: z.string().optional(),
        alignment: z.enum(['SESSION_WINDOW', 'SHARED_WINDOW']).default('SESSION_WINDOW'),
        strictKnownOnly: z.coerce.boolean().default(true),
        curveBucket: z.enum(['RAW', '5M', '15M', '1H']).default('RAW'),
      })
      .parse(req.query ?? {});

    const {
      wallet,
      reduced,
      markDiagnostics,
      fromCache,
      incrementalRefresh,
      hasTruncatedHistory,
      scannedEventCount,
      maxEventCap,
    } = await computeTrackedWalletPerformance({
      walletId: params.id,
      strictKnownOnly: query.strictKnownOnly,
    });

    const requestedSessionIds = query.sessionIds
      ? query.sessionIds
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
      : null;

    const sessions = await prisma.paperCopySession.findMany({
      where: {
        trackedWalletId: params.id,
        ...(requestedSessionIds ? { id: { in: requestedSessionIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
      },
    });

    if (sessions.length === 0) {
      return {
        walletId: wallet.id,
        walletAddress: wallet.address,
        alignment: query.alignment,
        sessions: [],
      };
    }

    const windows = sessions.map((session) => {
      const start = (session.startedAt ?? session.createdAt).toISOString();
      const end = (session.endedAt ?? new Date()).toISOString();
      return { sessionId: session.id, start, end };
    });

    let sharedWindow: { start: string; end: string } | null = null;
    if (query.alignment === 'SHARED_WINDOW') {
      const sharedStartMs = Math.max(...windows.map((w) => new Date(w.start).getTime()));
      const sharedEndMs = Math.min(...windows.map((w) => new Date(w.end).getTime()));
      if (
        Number.isFinite(sharedStartMs) &&
        Number.isFinite(sharedEndMs) &&
        sharedStartMs <= sharedEndMs
      ) {
        sharedWindow = {
          start: new Date(sharedStartMs).toISOString(),
          end: new Date(sharedEndMs).toISOString(),
        };
      }
    }

    const comparisons = await Promise.all(
      sessions.map(async (session) => {
        const ownWindow = windows.find((w) => w.sessionId === session.id)!;
        const windowStart = sharedWindow?.start ?? ownWindow.start;
        const windowEnd = sharedWindow?.end ?? ownWindow.end;

        const sessionTimelineRows = await prisma.paperSessionMetricPoint.findMany({
          where: {
            sessionId: session.id,
            timestamp: {
              gte: new Date(windowStart),
              lte: new Date(windowEnd),
            },
          },
          orderBy: { timestamp: 'asc' },
          select: {
            timestamp: true,
            totalPnl: true,
            realizedPnl: true,
            unrealizedPnl: true,
            fees: true,
          },
        });

        let sessionTimeline = sessionTimelineRows.map((row) => ({
          timestamp: row.timestamp.toISOString(),
          totalPnl: Number(row.totalPnl),
          realizedPnl: Number(row.realizedPnl),
          unrealizedPnl: Number(row.unrealizedPnl),
          fees: Number(row.fees ?? 0),
        }));

        if (sessionTimeline.length === 0) {
          const fallback = await prisma.paperPortfolioSnapshot.findFirst({
            where: {
              sessionId: session.id,
              timestamp: {
                lte: new Date(windowEnd),
              },
            },
            orderBy: { timestamp: 'desc' },
            select: {
              timestamp: true,
              totalPnl: true,
              realizedPnl: true,
              unrealizedPnl: true,
              fees: true,
            },
          });

          sessionTimeline = [
            {
              timestamp: windowStart,
              totalPnl: 0,
              realizedPnl: 0,
              unrealizedPnl: 0,
              fees: 0,
            },
            {
              timestamp: windowEnd,
              totalPnl: fallback ? Number(fallback.totalPnl) : 0,
              realizedPnl: fallback ? Number(fallback.realizedPnl) : 0,
              unrealizedPnl: fallback ? Number(fallback.unrealizedPnl) : 0,
              fees: fallback ? Number(fallback.fees) : 0,
            },
          ];
        }

        const comparison = compareSourceVsSession({
          sourceTimeline: reduced.timeline,
          sessionTimeline,
          windowStart,
          windowEnd,
        });

        const conservativeSourceNet = reduced.canonical.canonicalKnownNetPnl;
        const sourceNetForComparison = conservativeSourceNet ?? comparison.source.netPnl;
        const conservativeGap = sourceNetForComparison - comparison.session.netPnl;

        const sourceCurve = bucketCurvePoints(
          comparison.curves.sourceNetPnl,
          query.curveBucket as TimelineBucket,
        );
        const sessionCurve = bucketCurvePoints(
          comparison.curves.sessionNetPnl,
          query.curveBucket as TimelineBucket,
        );
        const gapCurve = bucketCurvePoints(
          comparison.curves.gap,
          query.curveBucket as TimelineBucket,
        );

        return {
          sessionId: session.id,
          sessionStatus: session.status,
          window: {
            start: windowStart,
            end: windowEnd,
            mode: sharedWindow ? 'SHARED_WINDOW' : 'SESSION_WINDOW',
          },
          ...comparison,
          source: {
            ...comparison.source,
            canonicalKnownNetPnl: conservativeSourceNet,
            canonicalRealizedPnl: reduced.canonical.canonicalRealizedPnl,
            canonicalUnrealizedPnl: reduced.canonical.canonicalUnrealizedPnl,
            canonicalFees: reduced.canonical.canonicalFees,
            estimatedNetPnl: reduced.canonical.estimatedNetPnl,
            netPnl: sourceNetForComparison,
          },
          gaps: {
            ...comparison.gaps,
            netPnlGap: conservativeGap,
          },
          curves: {
            sourceNetPnl: sourceCurve,
            sessionNetPnl: sessionCurve,
            gap: gapCurve,
          },
        };
      }),
    );

    return {
      walletId: wallet.id,
      walletAddress: wallet.address,
      walletLabel: wallet.label,
      alignment: query.alignment,
      sourceKnowability: {
        startingCashKnown: false,
        accountValueMode: 'RECONSTRUCTED_RELATIVE',
        feeCoveragePct: reduced.summary.feeCoveragePct,
        inferredShareEvents: reduced.summary.inferredShareEvents,
        inferredPriceEvents: reduced.summary.inferredPriceEvents,
        strictKnownOnly: query.strictKnownOnly,
        scannedEventCount,
        maxEventCap,
        historyTruncatedByCap: hasTruncatedHistory,
      },
      confidence: reduced.confidenceModel.confidence,
      confidenceModel: reduced.confidenceModel,
      canonical: reduced.canonical,
      debugReport: reduced.debugReport,
      compute: {
        cacheHit: fromCache,
        incrementalRefresh,
        scannedEventCount,
        maxEventCap,
        historyTruncatedByCap: hasTruncatedHistory,
        curveBucket: query.curveBucket,
        liveMarkCount: markDiagnostics.liveMarkCount,
        fallbackMarkCount: markDiagnostics.fallbackMarkCount,
      },
      warnings: hasTruncatedHistory
        ? [
            {
              code: 'SOURCE_HISTORY_TRUNCATED',
              message: `Source history capped at ${maxEventCap} events; comparisons are computed on the most recent ${scannedEventCount} events.`,
              severity: 'warn',
            },
          ]
        : [],
      sessions: comparisons,
    };
  });

  app.get('/wallets/:id/simulation-intelligence', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({
      where: { id: params.id },
      select: { id: true, address: true },
    });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    let livePositionsValueUsd = 0;
    try {
      const livePositions: Array<Record<string, unknown>> = await dataAdapter.getWalletPositions(
        wallet.address,
        'OPEN',
        500,
      );
      for (const p of livePositions) {
        livePositionsValueUsd +=
          Number(p.size ?? 0) * Number(p.currentPrice ?? p.curPrice ?? p.price ?? 0);
      }
    } catch {
      livePositionsValueUsd = 0;
    }

    const [summary, pnlAll, pnl30d] = await Promise.all([
      buildProfileSummary(wallet.id, livePositionsValueUsd),
      calculateWalletPnlSummary(prisma, wallet.id, { range: 'ALL' }),
      calculateWalletPnlSummary(prisma, wallet.id, { range: '30D' }),
    ]);

    const riskTier = computeSimulationRiskTier({
      winRatePct: Number(pnlAll.winRatePct ?? pnlAll.winRate * 100),
      netPnl: pnlAll.netPnl,
      tradeCount: pnlAll.tradeCount,
    });

    const suggestedCopyRatio =
      riskTier === 'LOW' ? 1 : riskTier === 'MEDIUM' ? 0.5 : riskTier === 'HIGH' ? 0.25 : 0.5;
    const suggestedStartingCash = clamp(summary.positionsValueUsd * suggestedCopyRatio, 500, 50000);

    const suggestionReason =
      riskTier === 'LOW'
        ? 'Strong historical edge and sample size support full 1.0x copy sizing.'
        : riskTier === 'MEDIUM'
          ? 'Positive performance with moderate confidence; sizing reduced to 0.5x.'
          : riskTier === 'HIGH'
            ? 'Weak/negative performance risk detected; sizing reduced to 0.25x.'
            : 'Uncertain profile; using neutral 0.5x sizing.';

    return {
      summary,
      pnlAll,
      pnl30d,
      suggestedCopyRatio,
      suggestedStartingCash: Math.round(suggestedStartingCash * 100) / 100,
      suggestionReason,
      riskTier,
    };
  });

  // ---------------------------------------------------------------------------
  // Trades
  // ---------------------------------------------------------------------------

  app.get('/trades', async (req: any) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        side: z.enum(['BUY', 'SELL']).optional(),
        market: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(req.query ?? {});

    const where: Record<string, unknown> = {};
    if (query.side) where.side = query.side;
    if (query.market) where.marketId = { contains: query.market, mode: 'insensitive' };
    if (query.from || query.to) {
      const tradedAt: Record<string, Date> = {};
      if (query.from) tradedAt.gte = new Date(query.from);
      if (query.to) tradedAt.lte = new Date(query.to);
      where.tradedAt = tradedAt;
    }

    const [total, rows] = await Promise.all([
      prisma.tradeEvent.count({ where }),
      prisma.tradeEvent.findMany({
        where,
        orderBy: { tradedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map((row: any) => ({
        id: row.id,
        timestamp: row.tradedAt,
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        outcome: row.outcome,
        side: row.side,
        price: Number(row.price),
        size: Number(row.size),
        notional: Number(row.price) * Number(row.size),
        txHash: row.txHash,
        orderId: row.orderId,
      })),
    };
  });

  // ---------------------------------------------------------------------------
  // Markets
  // ---------------------------------------------------------------------------

  app.get('/markets', async (req: any) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    const markets = await prisma.tradeEvent.groupBy({
      by: ['marketId', 'marketQuestion'],
      _count: { marketId: true },
      _max: { tradedAt: true },
      orderBy: { _count: { marketId: 'desc' } },
      take: query.limit,
    });
    return markets.map((row: any) => ({
      marketId: row.marketId,
      marketQuestion: row.marketQuestion,
      tradeCount: row._count.marketId,
      lastTradeAt: row._max.tradedAt,
    }));
  });

  app.get('/markets/:id', async (req: any) => {
    const params = z.object({ id: z.string().min(1) }).parse(req.params);

    const [agg, recentTrades] = await Promise.all([
      prisma.tradeEvent.aggregate({
        where: { marketId: params.id },
        _count: { _all: true },
        _sum: { size: true },
        _max: { tradedAt: true },
      }),
      prisma.tradeEvent.findMany({
        where: { marketId: params.id },
        orderBy: { tradedAt: 'desc' },
        take: 50,
      }),
    ]);

    if ((agg._count._all ?? 0) === 0) {
      throw app.httpErrors.notFound('Market not found');
    }

    const sourceNotional = recentTrades.reduce(
      (sum: number, row: any) => sum + Number(row.size) * Number(row.price),
      0,
    );

    return {
      marketId: params.id,
      marketQuestion: recentTrades[0]?.marketQuestion ?? null,
      eventCount: agg._count._all ?? 0,
      tradeCount: agg._count._all ?? 0,
      latestTradeAt: agg._max.tradedAt ?? null,
      sourceNotional,
      decisionsAvailable: false,
      decisionsAvailabilityMessage:
        'Copy-decision and execution records are not exposed on this endpoint in Phase 0.',
      recentTrades: recentTrades.map((row: any) => ({
        id: row.id,
        side: row.side,
        outcome: row.outcome,
        price: Number(row.price),
        size: Number(row.size),
        notional: Number(row.price) * Number(row.size),
        tradedAt: row.tradedAt,
        sourceWalletAddress: row.sourceWalletAddress,
        txHash: row.txHash,
      })),
    };
  });

  // ---------------------------------------------------------------------------
  // Intelligence
  // ---------------------------------------------------------------------------

  app.get('/market-intelligence', async (req: any) => {
    const query = z
      .object({ limit: z.coerce.number().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    return getLatestMarketIntelligence(query.limit);
  });

  app.get('/leaderboard', async (req: any) => {
    const query = z
      .object({
        sortBy: z.enum(['pnl', 'winRate', 'sharpe', 'accuracy']).default('pnl'),
        minTrades: z.coerce.number().optional(),
      })
      .parse(req.query ?? {});
    const rows = await getWalletLeaderboard(query.sortBy);
    return query.minTrades === undefined
      ? rows
      : rows.filter((r: any) => r.totalTrades >= query.minTrades!);
  });

  app.get('/heatmap', async () => {
    const intel = await getLatestMarketIntelligence(100);
    return intel
      .map((row: any) => ({
        marketId: row.marketId,
        buyPressure: row.buyPressure,
        sellPressure: row.sellPressure,
        activeWallets: row.uniqueWallets,
        sentiment: row.netSentimentScore,
      }))
      .sort((a: any, b: any) => Math.abs(b.sentiment) - Math.abs(a.sentiment));
  });

  app.get('/whale-alerts', async () => {
    return prisma.whaleAlert.findMany({
      include: { wallet: true, tradeEvent: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.get('/alerts/whales', async () => {
    return prisma.whaleAlert.findMany({
      include: { wallet: true, tradeEvent: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.get('/cluster-signals', async () => {
    return prisma.clusterSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  });

  app.get('/signals/clusters', async () => {
    return prisma.clusterSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  });

  // ---------------------------------------------------------------------------
  // Events / websocket
  // ---------------------------------------------------------------------------

  app.get('/events', async (req: any) => {
    const query = z
      .object({ limit: z.coerce.number().min(1).max(500).default(200) })
      .parse(req.query ?? {});
    return loadRecentEvents(query.limit);
  });

  app.get('/events/ws', { websocket: true }, (connection: any) => {
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = eventBus.subscribe((event) => {
        connection.socket.send(JSON.stringify(event));
      });
    } catch (error) {
      connection.socket.send(
        JSON.stringify({
          type: 'ERROR',
          message: error instanceof Error ? error.message : 'Event stream unavailable',
        }),
      );
      connection.socket.close();
      return;
    }

    connection.socket.on('close', () => {
      if (unsubscribe) {
        unsubscribe();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Strategies
  // ---------------------------------------------------------------------------

  app.post('/mode', async (req: any) => {
    const body = modeUpdateSchema.parse(req.body);
    if (body.mode === 'LIVE') {
      if (!config.LIVE_TRADING_ENABLED) {
        await prisma.strategy.update({ where: { id: body.strategyId }, data: { mode: 'PAPER' } });
        return { strategyId: body.strategyId, mode: 'PAPER', fallback: 'LIVE_TRADING_DISABLED' };
      }
      if (body.confirmationToken !== config.LIVE_TRADING_CONFIRMATION_TOKEN) {
        await prisma.strategy.update({ where: { id: body.strategyId }, data: { mode: 'PAPER' } });
        return { strategyId: body.strategyId, mode: 'PAPER', fallback: 'INVALID_CONFIRMATION' };
      }
    }
    return prisma.strategy.update({ where: { id: body.strategyId }, data: { mode: body.mode } });
  });

  app.post('/execution/preview', async (req: any) => {
    const body = previewSchema.parse(req.body);
    const strategy = await prisma.strategy.findUnique({
      where: { id: body.strategyId },
      include: { riskConfig: true, wallet: { select: { address: true } } },
    });
    if (!strategy?.riskConfig) throw app.httpErrors.notFound('Strategy or risk config not found');

    const marketEvents = await prisma.tradeEvent.findMany({
      where: { marketId: body.event.marketId },
      orderBy: { tradedAt: 'desc' },
      take: 1,
    });
    const marketPrice = marketEvents[0] ? Number(marketEvents[0].price) : body.event.price;
    const decision = decideCopyOrder({
      strategyId: strategy.id,
      riskConfig: {
        id: strategy.riskConfig.id,
        strategyId: strategy.id,
        fixedDollar: strategy.riskConfig.fixedDollar
          ? Number(strategy.riskConfig.fixedDollar)
          : null,
        pctSourceSize: strategy.riskConfig.pctSourceSize
          ? Number(strategy.riskConfig.pctSourceSize)
          : null,
        pctBankroll: strategy.riskConfig.pctBankroll
          ? Number(strategy.riskConfig.pctBankroll)
          : null,
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
          | 'MIDPOINT_FALLBACK'
          | 'AGGRESSIVE_LIMIT'
          | 'PASSIVE_LIMIT',
      },
      market: {
        id: body.event.marketId,
        slug: body.event.marketId,
        question: body.event.marketId,
        active: true,
        bestBid: marketPrice * 0.99,
        bestAsk: marketPrice * 1.01,
        midpoint: marketPrice,
        liquidity: 100_000,
        spreadBps: 200,
      },
      event: {
        id: body.event.sourceEventId,
        sourceEventId: body.event.sourceEventId,
        sourceWalletAddress: strategy.wallet?.address ?? '',
        marketId: body.event.marketId,
        outcome: body.event.outcome,
        side: body.event.side,
        size: body.event.size,
        price: body.event.price,
        tradedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
      },
      bankroll: Number(strategy.bankroll),
      currentExposure: 0,
      perMarketExposure: 0,
      dailyPnl: Number(strategy.dailyPnl ?? 0),
    });
    return decision;
  });

  app.get('/strategies/:id/smart-config', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const config = await prisma.smartCopyStrategyConfig.findUnique({
      where: { strategyId: params.id },
    });
    if (!config) throw app.httpErrors.notFound('Smart config not found');
    return config;
  });

  app.post('/strategies/smart-config', async (req: any) => {
    const body = smartConfigSchema.parse(req.body ?? {});
    return prisma.smartCopyStrategyConfig.upsert({
      where: { strategyId: body.strategyId },
      create: {
        strategyId: body.strategyId,
        profitableWalletsOnly: body.profitableWalletsOnly ?? false,
        minSourceTradeUsd: body.minSourceTradeUsd ?? null,
        firstEntryOnly: body.firstEntryOnly ?? false,
        ignoreExitTrades: body.ignoreExitTrades ?? false,
        copyClustersOnly: body.copyClustersOnly ?? false,
        topRankedWalletsOnly: body.topRankedWalletsOnly ?? false,
        topRankMinWinRate: body.topRankMinWinRate ?? null,
        topRankMinSharpeLike: body.topRankMinSharpeLike ?? null,
      },
      update: {
        profitableWalletsOnly: body.profitableWalletsOnly ?? false,
        minSourceTradeUsd: body.minSourceTradeUsd ?? null,
        firstEntryOnly: body.firstEntryOnly ?? false,
        ignoreExitTrades: body.ignoreExitTrades ?? false,
        copyClustersOnly: body.copyClustersOnly ?? false,
        topRankedWalletsOnly: body.topRankedWalletsOnly ?? false,
        topRankMinWinRate: body.topRankMinWinRate ?? null,
        topRankMinSharpeLike: body.topRankMinSharpeLike ?? null,
      },
    });
  });

  app.post('/backtest', async (req: any) => {
    const body = z
      .object({
        strategyId: z.string().uuid(),
        name: z.string().min(1),
        startDate: z.string().datetime(),
        endDate: z.string().datetime(),
      })
      .parse(req.body);

    const strategy = await prisma.strategy.findUnique({
      where: { id: body.strategyId },
      include: { riskConfig: true },
    });
    if (!strategy?.riskConfig) throw app.httpErrors.notFound('Strategy or risk config not found');

    const events = await prisma.tradeEvent.findMany({
      where: {
        walletId: strategy.walletId,
        tradedAt: { gte: new Date(body.startDate), lte: new Date(body.endDate) },
      },
      orderBy: { tradedAt: 'asc' },
    });

    const result = runBacktest({
      strategyId: strategy.id,
      bankrollStart: Number(strategy.bankroll),
      riskConfig: {
        id: strategy.riskConfig.id,
        strategyId: strategy.id,
        fixedDollar: strategy.riskConfig.fixedDollar
          ? Number(strategy.riskConfig.fixedDollar)
          : null,
        pctSourceSize: strategy.riskConfig.pctSourceSize
          ? Number(strategy.riskConfig.pctSourceSize)
          : null,
        pctBankroll: strategy.riskConfig.pctBankroll
          ? Number(strategy.riskConfig.pctBankroll)
          : null,
        maxExposure: Number(strategy.riskConfig.maxExposure),
        perMarketMaxAllocation: Number(strategy.riskConfig.perMarketMaxAllocation),
        dailyLossCap: Number(strategy.riskConfig.dailyLossCap),
        maxSlippageBps: strategy.riskConfig.maxSlippageBps,
        minLiquidity: Number(strategy.riskConfig.minLiquidity ?? 0),
        maxSpreadBps: strategy.riskConfig.maxSpreadBps,
        inverseMode: strategy.riskConfig.inverseMode,
        copyBuys: strategy.riskConfig.copyBuys,
        copySells: strategy.riskConfig.copySells,
        cooldownSeconds: strategy.riskConfig.cooldownSeconds,
        fillStrategy: strategy.riskConfig.fillStrategy as
          | 'MIDPOINT_FALLBACK'
          | 'AGGRESSIVE_LIMIT'
          | 'PASSIVE_LIMIT',
      },
      // Build a marketById map from the events so the backtest engine can look up market data.
      // We use the event price as a proxy for midpoint since we don't have live CLOB data.
      marketById: Object.fromEntries(
        events.map((e: any) => [
          e.marketId,
          {
            bestBid: Number(e.price) * 0.99,
            bestAsk: Number(e.price) * 1.01,
            midpoint: Number(e.price),
            spreadBps: 200,
            liquidity: 100_000,
            active: true,
            question: e.marketQuestion ?? e.marketId,
            slug: e.marketId,
          },
        ]),
      ),
      events: events.map((e: any) => ({
        id: e.id,
        sourceEventId: e.sourceEventId ?? e.id,
        sourceWalletAddress: e.sourceWalletAddress ?? '',
        marketId: e.marketId,
        outcome: e.outcome,
        side: e.side,
        size: Number(e.size),
        price: Number(e.price),
        tradedAt: e.tradedAt instanceof Date ? e.tradedAt.toISOString() : String(e.tradedAt),
        observedAt:
          e.observedAt instanceof Date ? e.observedAt.toISOString() : new Date().toISOString(),
      })),
    });

    await prisma.backtestRun.create({
      data: {
        strategyId: strategy.id,
        name: body.name,
        configJson: { start: body.startDate, end: body.endDate },
        resultJson: result as any,
      },
    });

    return result;
  });

  // ---------------------------------------------------------------------------
  // Paper copy sessions
  // ---------------------------------------------------------------------------

  app.post('/paper-copy-sessions', async (req: any) => {
    const body = z
      .object({
        trackedWalletId: z.string().uuid(),
        startingCash: z.number().positive().optional(),
        copyRatio: z.number().positive().max(2).optional(),
        maxAllocationPerMarket: z.number().positive().optional(),
        maxTotalExposure: z.number().positive().optional(),
        minNotionalThreshold: z.number().nonnegative().optional(),
        minWalletTrades: z.number().int().min(0).max(100000).optional(),
        minWalletWinRate: z.number().min(0).max(1).optional(),
        minWalletSharpeLike: z.number().min(-5).max(10).optional(),
        dailyDrawdownLimitPct: z.number().positive().max(100).optional(),
        autoPauseOnHealthDegradation: z.boolean().optional(),
        feeBps: z.number().nonnegative().max(500).optional(),
        slippageBps: z.number().nonnegative().max(500).optional(),
        slippageConfig: z.any().nullable().optional(),
      })
      .parse(req.body ?? {});

    return createPaperCopySession({
      trackedWalletId: body.trackedWalletId,
      ...(body.startingCash !== undefined ? { startingCash: body.startingCash } : {}),
      ...(body.copyRatio !== undefined ? { copyRatio: body.copyRatio } : {}),
      ...(body.maxAllocationPerMarket !== undefined
        ? { maxAllocationPerMarket: body.maxAllocationPerMarket }
        : {}),
      ...(body.maxTotalExposure !== undefined ? { maxTotalExposure: body.maxTotalExposure } : {}),
      ...(body.minNotionalThreshold !== undefined
        ? { minNotionalThreshold: body.minNotionalThreshold }
        : {}),
      ...(body.minWalletTrades !== undefined ? { minWalletTrades: body.minWalletTrades } : {}),
      ...(body.minWalletWinRate !== undefined ? { minWalletWinRate: body.minWalletWinRate } : {}),
      ...(body.minWalletSharpeLike !== undefined
        ? { minWalletSharpeLike: body.minWalletSharpeLike }
        : {}),
      ...(body.dailyDrawdownLimitPct !== undefined
        ? { dailyDrawdownLimitPct: body.dailyDrawdownLimitPct }
        : {}),
      ...(body.autoPauseOnHealthDegradation !== undefined
        ? { autoPauseOnHealthDegradation: body.autoPauseOnHealthDegradation }
        : {}),
      ...(body.feeBps !== undefined ? { feeBps: body.feeBps } : {}),
      ...(body.slippageBps !== undefined ? { slippageBps: body.slippageBps } : {}),
      ...(body.slippageConfig !== undefined ? { slippageConfig: body.slippageConfig } : {}),
    });
  });

  app.post('/paper-copy-sessions/:id/start', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        forceStart: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    await startPaperCopySession(params.id, {
      forceStart: body.forceStart ?? false,
    });
    return { started: true };
  });

  app.post('/paper-copy-sessions/:id/pause', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await pausePaperCopySession(params.id);
    return { paused: true };
  });

  app.post('/paper-copy-sessions/:id/resume', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await resumePaperCopySession(params.id);
    return { resumed: true };
  });

  app.patch('/paper-copy-sessions/:id/guardrails', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        minWalletTrades: z.number().int().min(0).max(100000).nullable().optional(),
        minWalletWinRate: z.number().min(0).max(1).nullable().optional(),
        minWalletSharpeLike: z.number().min(-5).max(10).nullable().optional(),
        dailyDrawdownLimitPct: z.number().positive().max(100).nullable().optional(),
        autoPauseOnHealthDegradation: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    const updated = await updatePaperCopySessionGuardrails(params.id, {
      ...(body.minWalletTrades !== undefined ? { minWalletTrades: body.minWalletTrades } : {}),
      ...(body.minWalletWinRate !== undefined ? { minWalletWinRate: body.minWalletWinRate } : {}),
      ...(body.minWalletSharpeLike !== undefined
        ? { minWalletSharpeLike: body.minWalletSharpeLike }
        : {}),
      ...(body.dailyDrawdownLimitPct !== undefined
        ? { dailyDrawdownLimitPct: body.dailyDrawdownLimitPct }
        : {}),
      ...(body.autoPauseOnHealthDegradation !== undefined
        ? { autoPauseOnHealthDegradation: body.autoPauseOnHealthDegradation }
        : {}),
    });
    return {
      id: updated.id,
      minWalletTrades: updated.minWalletTrades,
      minWalletWinRate: updated.minWalletWinRate !== null ? Number(updated.minWalletWinRate) : null,
      minWalletSharpeLike:
        updated.minWalletSharpeLike !== null ? Number(updated.minWalletSharpeLike) : null,
      dailyDrawdownLimitPct:
        updated.dailyDrawdownLimitPct !== null ? Number(updated.dailyDrawdownLimitPct) : null,
      autoPauseOnHealthDegradation: updated.autoPauseOnHealthDegradation,
      updatedAt: updated.updatedAt,
    };
  });

  app.post('/paper-copy-sessions/:id/stop', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await stopPaperCopySession(params.id);
    return { stopped: true };
  });

  // Kill all RUNNING sessions at once (marks them COMPLETED, keeps data)
  app.post('/paper-copy-sessions/kill-all', async () => {
    const result = await killAllPaperSessions();
    return result;
  });

  // Permanently delete a session and all its data (trades, positions, snapshots)
  app.delete('/paper-copy-sessions/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await deletePaperCopySession(params.id);
    return { deleted: true };
  });

  // Repair a corrupted session: recalculates cash + positions from trade history,
  // forces status → PAUSED, writes fresh snapshot
  app.post('/paper-copy-sessions/:id/repair', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await repairPaperCopySession(params.id);
    return result;
  });

  // NEW — health/freshness endpoint for the session dashboard
  app.get('/paper-copy-sessions/:id/health', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const health = await getSessionHealth(params.id);
    if (!health) throw app.httpErrors.notFound('Session not found');
    return health;
  });

  // DEBUG — shows raw WalletActivityEvent records for the session's wallet.
  // Use this to diagnose why SELL/CLOSE events are or aren't being processed.
  app.get('/paper-copy-sessions/:id/debug', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(req.query ?? {});

    const session = await db.paperCopySession.findUnique({ where: { id: params.id } });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const events = await db.walletActivityEvent.findMany({
      where: {
        trackedWalletId: session.trackedWalletId,
        eventTimestamp: { gte: session.startedAt ?? session.createdAt },
      },
      orderBy: { eventTimestamp: 'desc' },
      take: query.limit,
      select: {
        id: true,
        eventType: true,
        side: true,
        marketId: true,
        marketQuestion: true,
        outcome: true,
        price: true,
        shares: true,
        eventTimestamp: true,
      },
    });

    // Group by side/eventType so you can see immediately what's in the DB
    const summary = events.reduce((acc: Record<string, number>, e: any) => {
      const key = `${e.eventType ?? 'NULL'}|side=${e.side ?? 'NULL'}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    const processedIds = new Set(
      (
        await db.paperCopyTrade.findMany({
          where: { sessionId: params.id, sourceActivityEventId: { not: null } },
          select: { sourceActivityEventId: true },
        })
      ).map((t: any) => t.sourceActivityEventId),
    );

    return {
      sessionId: params.id,
      walletId: session.trackedWalletId,
      totalEvents: events.length,
      processedCount: events.filter((e: any) => processedIds.has(e.id)).length,
      skippedCount: events.filter((e: any) => !processedIds.has(e.id)).length,
      byTypeAndSide: summary,
      recentEvents: events.slice(0, 30).map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        side: e.side,
        outcome: e.outcome,
        price: e.price != null ? Number(e.price) : null,
        shares: e.shares != null ? Number(e.shares) : null,
        market: e.marketQuestion ?? e.marketId,
        ts: e.eventTimestamp,
        processed: processedIds.has(e.id),
      })),
    };
  });

  // RECONCILE POSITIONS — closes any simulated position whose market no longer
  // exists in the source wallet's current open positions on Polymarket.
  // This handles market resolution (REDEEM) events that the polling may have missed.
  app.post('/paper-copy-sessions/:id/reconcile-positions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await reconcilePaperSessionPositions(params.id);
    return result;
  });

  app.post('/paper-copy-sessions/:id/replicate-missed-trades', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        decisionIds: z.array(z.string().uuid()).optional(),
      })
      .parse(req.body ?? {});

    const session = await db.paperCopySession.findUnique({ where: { id: params.id } });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const skipWhere: Record<string, unknown> = {
      sessionId: params.id,
      status: 'SKIPPED',
      decisionType: 'SKIP',
    };
    if (body.decisionIds && body.decisionIds.length > 0) {
      skipWhere.id = { in: body.decisionIds };
    }

    const skipped = await db.paperCopyDecision.findMany({
      where: skipWhere,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const executor = resolvePaperExecutor('PAPER');
    const ratio = session.copyRatio !== null ? Number(session.copyRatio) : 1;

    let attempted = 0;
    let executed = 0;
    let failed = 0;
    let skippedInvalid = 0;

    for (const src of skipped) {
      const sourceShares = src.sourceShares !== null ? Number(src.sourceShares) : 0;
      const sourcePrice = src.sourcePrice !== null ? Number(src.sourcePrice) : 0;
      const marketId = src.marketId;
      const outcome = src.outcome;
      const side = src.side;

      if (!marketId || !outcome || !side || sourceShares <= 0 || sourcePrice <= 0) {
        skippedInvalid += 1;
        continue;
      }

      const simulatedShares = sourceShares * ratio;
      if (simulatedShares <= 0) {
        skippedInvalid += 1;
        continue;
      }

      attempted += 1;

      const decision = await db.paperCopyDecision.create({
        data: {
          sessionId: session.id,
          trackedWalletId: session.trackedWalletId,
          walletAddress: session.trackedWalletAddress,
          sourceActivityEventId: null,
          sourceEventTimestamp: src.sourceEventTimestamp ?? src.createdAt,
          sourceTxHash: src.sourceTxHash,
          decisionType: 'COPY',
          status: 'PENDING',
          executorType: 'PAPER',
          marketId,
          marketQuestion: src.marketQuestion,
          outcome,
          side,
          sourceShares,
          simulatedShares,
          sourcePrice,
          intendedFillPrice: sourcePrice,
          copyRatio: ratio,
          sizingInputsJson: {
            replicatedFromDecisionId: src.id,
            sourceDecisionType: src.decisionType,
          },
          reasonCode: 'MANUAL_REPLICATE_MISSED',
          humanReason: 'User requested replication of a previously skipped source trade.',
          riskChecksJson: {},
          notes: `REPLICATE_MISSED:${src.id}`,
        },
      });

      const result = await executor.execute({
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
          status: result.status,
          reasonCode: result.reasonCode,
          humanReason: result.humanReason,
          executionError: result.errorMessage,
        },
      });

      if (result.status === 'EXECUTED') {
        executed += 1;
      } else {
        failed += 1;
      }
    }

    if (executed > 0) {
      await materializePaperSessionState(session.id);
    }

    return {
      attempted,
      executed,
      failed,
      skippedInvalid,
      totalCandidates: skipped.length,
    };
  });

  app.post('/paper-copy-sessions/:id/bootstrap-missing', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        positions: z
          .array(
            z.object({
              marketId: z.string().min(1),
              outcome: z.string().min(1),
              marketQuestion: z.string().optional(),
              sourceShares: z.number().positive(),
              sourceCurrent: z.number().nonnegative(),
            }),
          )
          .max(500)
          .default([]),
      })
      .parse(req.body ?? {});

    const session = await db.paperCopySession.findUnique({ where: { id: params.id } });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const executor = resolvePaperExecutor('PAPER');
    const ratio = session.copyRatio !== null ? Number(session.copyRatio) : 1;
    const now = new Date();

    let attempted = 0;
    let executed = 0;

    for (const pos of body.positions) {
      const existing = await db.paperCopyPosition.findFirst({
        where: {
          sessionId: params.id,
          status: 'OPEN',
          marketId: pos.marketId,
          outcome: pos.outcome.toUpperCase(),
        },
        select: { id: true },
      });
      if (existing) continue;

      const shares = pos.sourceShares * ratio;
      const price = pos.sourceCurrent;
      if (shares <= 0 || price <= 0) continue;

      attempted += 1;
      const decision = await db.paperCopyDecision.create({
        data: {
          sessionId: session.id,
          trackedWalletId: session.trackedWalletId,
          walletAddress: session.trackedWalletAddress,
          sourceActivityEventId: null,
          sourceEventTimestamp: now,
          sourceTxHash: null,
          decisionType: 'BOOTSTRAP',
          status: 'PENDING',
          executorType: 'PAPER',
          marketId: pos.marketId,
          marketQuestion: pos.marketQuestion ?? null,
          outcome: pos.outcome.toUpperCase(),
          side: 'BUY',
          sourceShares: pos.sourceShares,
          simulatedShares: shares,
          sourcePrice: price,
          intendedFillPrice: price,
          copyRatio: ratio,
          sizingInputsJson: { source: 'bootstrap_missing' },
          reasonCode: 'BOOTSTRAP_EXISTING_POSITION',
          humanReason: 'Bootstrapping missing source position into paper session.',
          riskChecksJson: {},
          notes: 'BOOTSTRAP_MISSING_POSITION',
        },
      });

      const result = await executor.execute({
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
          status: result.status,
          reasonCode: result.reasonCode,
          humanReason: result.humanReason,
          executionError: result.errorMessage,
        },
      });

      if (result.status === 'EXECUTED') executed += 1;
    }

    if (executed > 0) {
      await materializePaperSessionState(session.id);
    }

    return { attempted, executed };
  });

  app.get('/paper-copy-sessions/comparison', async () => {
    const sessions = await db.paperCopySession.findMany({
      include: {
        trackedWallet: { select: { id: true, label: true, address: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = await Promise.all(
      sessions.map(async (s: Record<string, unknown>) => {
        const sessionId = String(s.id);
        const walletId = String(s.trackedWalletId);
        const startedAt = s.startedAt instanceof Date ? s.startedAt : null;

        const [latestSnapshot, openCount, sourcePnlAll, sourcePnlWindow, latestWalletSnap] =
          await Promise.all([
            db.paperPortfolioSnapshot.findFirst({
              where: { sessionId },
              orderBy: { timestamp: 'desc' },
              select: {
                netLiquidationValue: true,
                totalPnl: true,
                returnPct: true,
                realizedPnl: true,
                fees: true,
              },
            }),
            db.paperCopyPosition.count({ where: { sessionId, status: 'OPEN' } }),
            calculateWalletPnlSummary(prisma, walletId, { range: 'ALL' }),
            startedAt
              ? calculateWalletPnlSummary(prisma, walletId, {
                  range: 'ALL',
                  from: startedAt.toISOString(),
                  to: new Date().toISOString(),
                })
              : null,
            prisma.walletAnalyticsSnapshot.findFirst({
              where: { walletId },
              orderBy: { createdAt: 'desc' },
              select: { winRate: true, realizedPnl: true },
            }),
          ]);

        const sourceNetPnl = sourcePnlWindow?.netPnl ?? sourcePnlAll.netPnl;
        const totalPnl = latestSnapshot ? Number(latestSnapshot.totalPnl) : 0;
        const trackingEfficiencyPct = sourceNetPnl !== 0 ? (totalPnl / sourceNetPnl) * 100 : null;

        const trackedWallet = s.trackedWallet as { id: string; label: string; address: string };
        return {
          id: sessionId,
          walletId,
          walletLabel: trackedWallet.label,
          walletAddress: trackedWallet.address,
          status: String(s.status),
          startingCash: Number(s.startingCash),
          copyRatio: s.copyRatio !== null ? Number(s.copyRatio) : 0,
          currentNlv: latestSnapshot
            ? Number(latestSnapshot.netLiquidationValue)
            : Number(s.currentCash),
          totalPnl,
          fees: latestSnapshot ? Number(latestSnapshot.fees) : 0,
          returnPct: latestSnapshot ? Number(latestSnapshot.returnPct) : 0,
          realizedPnl: latestSnapshot ? Number(latestSnapshot.realizedPnl) : 0,
          openPositionsCount: openCount,
          lastActivity: s.lastProcessedEventAt
            ? (s.lastProcessedEventAt as Date).toISOString()
            : null,
          sourceWinRate:
            latestWalletSnap?.winRate != null ? Number(latestWalletSnap.winRate) : null,
          sourceNetPnl:
            latestWalletSnap?.realizedPnl != null ? Number(latestWalletSnap.realizedPnl) : null,
          trackingEfficiencyPct,
        };
      }),
    );

    rows.sort((a, b) => b.returnPct - a.returnPct);
    return { sessions: rows };
  });

  app.get('/paper-copy-sessions/:id/live-feed', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query ?? {});

    const session = await db.paperCopySession.findUnique({ where: { id: params.id } });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const sessionStart = (session.startedAt as Date | null) ?? (session.createdAt as Date);

    const sourceEvents: Array<Record<string, unknown>> = await db.walletActivityEvent.findMany({
      where: {
        trackedWalletId: session.trackedWalletId,
        eventTimestamp: { gte: sessionStart },
      },
      orderBy: { eventTimestamp: 'desc' },
      take: 100,
      select: {
        id: true,
        externalEventId: true,
        eventType: true,
        marketId: true,
        marketQuestion: true,
        outcome: true,
        shares: true,
        price: true,
        notional: true,
        txHash: true,
        eventTimestamp: true,
      },
    });

    const sourceEventIds = sourceEvents.map((e) => String(e.id));

    const [decisions, openPositions, allSessionTrades] = await Promise.all([
      sourceEventIds.length > 0
        ? db.paperCopyDecision.findMany({
            where: {
              sessionId: params.id,
              sourceActivityEventId: { in: sourceEventIds },
            },
            include: {
              trades: {
                orderBy: { eventTimestamp: 'desc' },
                take: 5,
              },
            },
          })
        : Promise.resolve([]),
      db.paperCopyPosition.findMany({
        where: { sessionId: params.id, status: 'OPEN' },
        select: { marketId: true, outcome: true, netShares: true },
      }),
      db.paperCopyTrade.findMany({
        where: { sessionId: params.id },
        orderBy: [{ eventTimestamp: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          marketId: true,
          outcome: true,
          side: true,
          simulatedPrice: true,
          simulatedShares: true,
          feeApplied: true,
        },
      }),
    ]);

    const decisionBySourceId = new Map<string, Record<string, unknown>>();
    for (const d of decisions as Array<Record<string, unknown>>) {
      const sourceId = d.sourceActivityEventId ? String(d.sourceActivityEventId) : null;
      if (!sourceId) continue;
      decisionBySourceId.set(sourceId, d);
    }

    const openByKey = new Map<string, { netShares: number }>();
    for (const p of openPositions as Array<Record<string, unknown>>) {
      openByKey.set(`${String(p.marketId)}:${String(p.outcome).toUpperCase()}`, {
        netShares: Number(p.netShares ?? 0),
      });
    }

    const attribution = buildTradeAttribution(
      (allSessionTrades as Array<Record<string, unknown>>).map((trade) => ({
        id: String(trade.id),
        marketId: String(trade.marketId ?? ''),
        outcome: String(trade.outcome ?? ''),
        side: String(trade.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        simulatedPrice: Number(trade.simulatedPrice ?? 0),
        simulatedShares: Number(trade.simulatedShares ?? 0),
        feeApplied: Number(trade.feeApplied ?? 0),
      })),
    );

    const items = sourceEvents
      .map((event) => {
        const eventTs = event.eventTimestamp as Date;
        const marketId = String(event.marketId ?? '');
        const outcome = event.outcome ? String(event.outcome).toUpperCase() : null;
        const decision = decisionBySourceId.get(String(event.id));
        const sizingInputs =
          decision?.sizingInputsJson && typeof decision.sizingInputsJson === 'object'
            ? (decision.sizingInputsJson as Record<string, unknown>)
            : null;
        const slippageResult =
          sizingInputs?.slippageResult && typeof sizingInputs.slippageResult === 'object'
            ? (sizingInputs.slippageResult as Record<string, unknown>)
            : null;
        const decisionStatus = decision?.status ? String(decision.status) : null;
        const decisionType = decision?.decisionType ? String(decision.decisionType) : null;
        const decisionTrades =
          (decision?.trades as Array<Record<string, unknown>> | undefined) ?? [];
        const latestTrade = decisionTrades[0];
        const tradeAction = latestTrade?.action ? String(latestTrade.action) : '';
        const key = resolveAttributionPositionKey({
          marketId,
          sourceOutcome: outcome,
          decisionOutcome: decision?.outcome,
          tradeOutcome: latestTrade?.outcome,
        });

        let ourAction: 'COPIED' | 'SKIPPED' | 'AUTO_CLOSED' | 'OPEN' | null = null;
        if (decisionStatus === 'SKIPPED') {
          ourAction = 'SKIPPED';
        } else if (decisionStatus === 'EXECUTED') {
          if (
            decisionType === 'CLOSE' ||
            decisionType === 'REDUCE' ||
            tradeAction.includes('CLOSE') ||
            tradeAction.includes('REDEEM')
          ) {
            ourAction = 'AUTO_CLOSED';
          } else {
            ourAction = 'COPIED';
          }
        } else if (key && openByKey.has(key)) {
          ourAction = 'OPEN';
        }

        const fallbackAmount =
          Number(event.notional ?? 0) > 0
            ? Number(event.notional)
            : Number(event.shares ?? 0) * Number(event.price ?? 0);

        return {
          id: String(event.id),
          sourceEventId: event.externalEventId ? String(event.externalEventId) : null,
          eventType: String(event.eventType ?? 'UNKNOWN').toUpperCase(),
          market: String(event.marketQuestion ?? event.marketId ?? 'Unknown market'),
          outcome,
          shares: event.shares !== null ? Number(event.shares ?? 0) : null,
          price: event.price !== null ? Number(event.price ?? 0) : null,
          amountUsd: Number.isFinite(fallbackAmount) ? fallbackAmount : null,
          relativeTime: formatRelativeTime(eventTs),
          eventTimestamp: eventTs.toISOString(),
          ourAction,
          ourPnl:
            ourAction === 'AUTO_CLOSED' && latestTrade?.id != null
              ? (attribution.eventRealizedPnlGrossByTradeId.get(String(latestTrade.id)) ?? 0)
              : null,
          ourPnlCumulative:
            ourAction === 'AUTO_CLOSED' && key
              ? (attribution.cumulativeRealizedPnlGrossByPositionKey.get(key) ?? null)
              : null,
          ourFeeUsd:
            latestTrade?.id != null
              ? (attribution.feeByTradeId.get(String(latestTrade.id)) ?? null)
              : null,
          ourAmountUsd:
            latestTrade?.notional != null && Number.isFinite(Number(latestTrade.notional))
              ? Number(latestTrade.notional)
              : null,
          ourShares:
            decision?.simulatedShares != null
              ? Number(decision.simulatedShares)
              : latestTrade?.simulatedShares != null
                ? Number(latestTrade.simulatedShares)
                : null,
          ourLatencyMs:
            slippageResult?.latencyApplied != null ? Number(slippageResult.latencyApplied) : null,
          ourSlippageBps:
            slippageResult?.slippageBps != null ? Number(slippageResult.slippageBps) : null,
          ourDriftBps: slippageResult?.driftBps != null ? Number(slippageResult.driftBps) : null,
          ourTotalAdverseBps:
            slippageResult?.totalAdverseBps != null ? Number(slippageResult.totalAdverseBps) : null,
          skipReason:
            ourAction === 'SKIPPED'
              ? decision?.humanReason
                ? String(decision.humanReason)
                : String(decision?.reasonCode ?? 'SKIPPED')
              : null,
          txHash: event.txHash ? String(event.txHash) : null,
        };
      })
      .sort((a, b) => new Date(b.eventTimestamp).getTime() - new Date(a.eventTimestamp).getTime())
      .slice(0, query.limit);

    return { items };
  });

  app.get('/paper-copy-sessions/:id/position-coverage', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const session = await db.paperCopySession.findUnique({ where: { id: params.id } });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const [sourceRaw, paperOpen] = await Promise.all([
      dataAdapter.getWalletPositions(session.trackedWalletAddress, 'OPEN', 500),
      db.paperCopyPosition.findMany({ where: { sessionId: params.id, status: 'OPEN' } }),
    ]);

    const paperByKey = new Map<
      string,
      { netShares: number; avgEntryPrice: number; currentMarkPrice: number }
    >();
    for (const p of paperOpen as Array<Record<string, unknown>>) {
      const key = `${String(p.marketId)}:${String(p.outcome).toUpperCase()}`;
      paperByKey.set(key, {
        netShares: Number(p.netShares),
        avgEntryPrice: Number(p.avgEntryPrice),
        currentMarkPrice: Number(p.currentMarkPrice),
      });
    }

    const positions = (sourceRaw as Array<Record<string, unknown>>).map((s) => {
      const marketId = String(s.conditionId ?? s.marketId ?? '');
      const outcome = String(s.outcome ?? 'UNKNOWN').toUpperCase();
      const sourceShares = Number(s.size ?? 0);
      const sourceCurrent = Number(s.currentPrice ?? s.curPrice ?? s.price ?? 0);
      const sourceAvg = Number(s.avgPrice ?? s.price ?? 0);
      const sourceValue = sourceShares * sourceCurrent;
      const sourcePnlPct = sourceAvg > 0 ? ((sourceCurrent - sourceAvg) / sourceAvg) * 100 : 0;
      const paper = paperByKey.get(`${marketId}:${outcome}`) ?? null;
      const coverageRatio = paper && sourceShares > 0 ? paper.netShares / sourceShares : null;
      const status =
        coverageRatio == null
          ? 'MISSING'
          : coverageRatio >= 0.8
            ? 'MATCHED'
            : coverageRatio > 0
              ? 'PARTIAL'
              : 'MISSING';
      return {
        marketId,
        marketQuestion: String(s.title ?? s.marketQuestion ?? marketId),
        outcome,
        sourceShares,
        sourceCurrent,
        sourceValue,
        sourcePnlPct,
        paperShares: paper ? paper.netShares : null,
        paperAvgPrice: paper ? paper.avgEntryPrice : null,
        paperValue: paper ? paper.netShares * paper.currentMarkPrice : 0,
        coverageRatio,
        status,
      };
    });

    const totalSourceValueUsd = positions.reduce((sum, p) => sum + p.sourceValue, 0);
    const coveredValueUsd = positions.reduce((sum, p) => {
      if (p.status === 'MISSING') return sum;
      return sum + Math.min(p.sourceValue, p.paperValue);
    }, 0);
    const coveragePct = totalSourceValueUsd > 0 ? (coveredValueUsd / totalSourceValueUsd) * 100 : 0;

    return {
      coveragePct,
      totalSourceValueUsd,
      coveredValueUsd,
      positions,
    };
  });

  app.get('/paper-copy-sessions/:id/enriched-timeline', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const session = await db.paperCopySession.findUnique({ where: { id: params.id } });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const [decisions, closedSource, openSource, paperPositions] = await Promise.all([
      db.paperCopyDecision.findMany({
        where: { sessionId: params.id },
        include: {
          sourceActivityEvent: true,
          trades: {
            orderBy: { eventTimestamp: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      deriveClosedPositionsFromDb(prisma, session.trackedWalletId),
      dataAdapter.getWalletPositions(session.trackedWalletAddress, 'OPEN', 500),
      db.paperCopyPosition.findMany({ where: { sessionId: params.id } }),
    ]);

    const closedByKey = new Map<
      string,
      { resolution: string | null; valueUsd: number; totalTraded: number; pnlUsd: number }
    >();
    for (const c of closedSource) {
      closedByKey.set(`${c.conditionId}:${c.outcome.toUpperCase()}`, {
        resolution: c.resolution,
        valueUsd: c.valueUsd,
        totalTraded: c.totalTraded,
        pnlUsd: c.pnlUsd,
      });
    }
    const openByKey = new Map<string, number>();
    for (const o of openSource as Array<Record<string, unknown>>) {
      openByKey.set(
        `${String(o.conditionId ?? o.marketId ?? '')}:${String(o.outcome ?? '').toUpperCase()}`,
        Number(o.currentPrice ?? o.curPrice ?? o.price ?? 0),
      );
    }
    const paperByKey = new Map<string, { realizedPnl: number; unrealizedPnl: number }>();
    for (const p of paperPositions as Array<Record<string, unknown>>) {
      paperByKey.set(`${String(p.marketId)}:${String(p.outcome).toUpperCase()}`, {
        realizedPnl: Number(p.realizedPnl ?? 0),
        unrealizedPnl: Number(p.unrealizedPnl ?? 0),
      });
    }

    const rows = decisions.map((d: Record<string, unknown>) => {
      const marketId = d.marketId ? String(d.marketId) : null;
      const outcome = d.outcome ? String(d.outcome).toUpperCase() : null;
      const key = marketId && outcome ? `${marketId}:${outcome}` : null;
      const closed = key ? (closedByKey.get(key) ?? null) : null;
      const openPrice = key ? (openByKey.get(key) ?? null) : null;
      const sourcePrice = d.sourcePrice != null ? Number(d.sourcePrice) : null;
      const shares = d.sourceShares != null ? Number(d.sourceShares) : null;
      const side = d.side ? String(d.side) : null;

      const currentPrice = closed
        ? closed.resolution === 'WON'
          ? 1
          : closed.resolution === 'LOST'
            ? 0
            : null
        : openPrice;

      let sourcePnl: number | null = null;
      if (closed) {
        sourcePnl = closed.pnlUsd;
      } else if (currentPrice != null && sourcePrice != null && shares != null && side) {
        const dir = side === 'SELL' ? -1 : 1;
        sourcePnl = dir * shares * (currentPrice - sourcePrice);
      }

      const paper = key ? (paperByKey.get(key) ?? null) : null;
      const status = String(d.status) as 'EXECUTED' | 'SKIPPED' | 'FAILED';
      return {
        id: String(d.id),
        decisionType: String(d.decisionType),
        status,
        marketId,
        marketQuestion: d.marketQuestion ? String(d.marketQuestion) : null,
        outcome,
        sourceOutcome: {
          status: closed
            ? closed.resolution === 'WON'
              ? 'WON'
              : closed.resolution === 'LOST'
                ? 'LOST'
                : 'UNKNOWN'
            : currentPrice != null
              ? 'OPEN'
              : 'UNKNOWN',
          currentPrice,
          pnlUsd: sourcePnl,
          totalTraded: closed ? closed.totalTraded : null,
          amountWon: closed ? closed.valueUsd : null,
        },
        paperOutcome: {
          realizedPnl: paper ? paper.realizedPnl : null,
          unrealizedPnl: paper ? paper.unrealizedPnl : null,
          status,
        },
        counterfactualPnl: String(d.decisionType) === 'SKIP' ? sourcePnl : null,
        createdAt: d.createdAt,
      };
    });

    rows.sort(
      (
        a: { sourceOutcome: { pnlUsd: number | null } },
        b: { sourceOutcome: { pnlUsd: number | null } },
      ) => Math.abs(b.sourceOutcome.pnlUsd ?? 0) - Math.abs(a.sourceOutcome.pnlUsd ?? 0),
    );
    return { items: rows };
  });

  app.get('/paper-copy-sessions', async () => {
    const rows = await db.paperCopySession.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        trackedWallet: true,
        _count: { select: { trades: true, positions: true } },
      },
    });

    // Attach latest PnL from snapshot to the list view
    return Promise.all(
      rows.map(async (row: any) => {
        const [latestSnapshot, closedRows] = await Promise.all([
          db.paperPortfolioSnapshot.findFirst({
            where: { sessionId: row.id },
            orderBy: { timestamp: 'desc' },
            select: { totalPnl: true, returnPct: true, netLiquidationValue: true, fees: true },
          }),
          db.paperCopyPosition.findMany({
            where: { sessionId: row.id, status: 'CLOSED' },
            select: { realizedPnl: true },
          }),
        ]);

        const winCount = (closedRows as Array<Record<string, unknown>>).filter(
          (p) => Number(p.realizedPnl ?? 0) > 0,
        ).length;
        const lossCount = closedRows.length - winCount;
        const winRate = winCount + lossCount > 0 ? winCount / (winCount + lossCount) : 0;
        const winRatePct = winRate * 100;

        return {
          id: row.id,
          trackedWalletId: row.trackedWalletId,
          trackedWalletAddress: row.trackedWalletAddress,
          trackedWalletLabel: row.trackedWallet.label,
          status: row.status,
          startingCash: Number(row.startingCash),
          currentCash: Number(row.currentCash),
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          createdAt: row.createdAt,
          lastProcessedEventAt: row.lastProcessedEventAt,
          estimatedSourceExposure:
            row.estimatedSourceExposure !== null ? Number(row.estimatedSourceExposure) : null,
          copyRatio: row.copyRatio !== null ? Number(row.copyRatio) : null,
          minWalletTrades: row.minWalletTrades,
          minWalletWinRate: row.minWalletWinRate !== null ? Number(row.minWalletWinRate) : null,
          minWalletSharpeLike:
            row.minWalletSharpeLike !== null ? Number(row.minWalletSharpeLike) : null,
          dailyDrawdownLimitPct:
            row.dailyDrawdownLimitPct !== null ? Number(row.dailyDrawdownLimitPct) : null,
          autoPauseOnHealthDegradation: Boolean(row.autoPauseOnHealthDegradation),
          consecutiveDecisionFailures: Number(row.consecutiveDecisionFailures ?? 0),
          lastAutoPausedAt: row.lastAutoPausedAt,
          totalPnl: latestSnapshot ? Number(latestSnapshot.totalPnl) : 0,
          returnPct: latestSnapshot ? Number(latestSnapshot.returnPct) : 0,
          fees: latestSnapshot ? Number(latestSnapshot.fees) : 0,
          netLiquidationValue: latestSnapshot
            ? Number(latestSnapshot.netLiquidationValue)
            : Number(row.currentCash),
          winRate,
          winRatePct,
          tradesCount: row._count.trades,
          positionsCount: row._count.positions,
        };
      }),
    );
  });

  app.get('/paper-copy-sessions/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db.paperCopySession.findUnique({
      where: { id: params.id },
      include: { trackedWallet: true },
    });
    if (!row) throw app.httpErrors.notFound('Session not found');

    const [latestSnapshot, openCount, closedRows, positionPnlRows] = await Promise.all([
      db.paperPortfolioSnapshot.findFirst({
        where: { sessionId: row.id },
        orderBy: { timestamp: 'desc' },
      }),
      db.paperCopyPosition.count({ where: { sessionId: row.id, status: 'OPEN' } }),
      db.paperCopyPosition.findMany({
        where: { sessionId: row.id, status: 'CLOSED' },
        select: { realizedPnl: true },
      }),
      db.paperCopyPosition.findMany({
        where: { sessionId: row.id },
        select: { realizedPnl: true, unrealizedPnl: true },
      }),
    ]);

    const nlv = latestSnapshot
      ? Number(latestSnapshot.netLiquidationValue)
      : Number(row.currentCash);
    const totalPnl = latestSnapshot ? Number(latestSnapshot.totalPnl) : 0;
    const returnPct = latestSnapshot ? Number(latestSnapshot.returnPct) : 0;
    const fees = latestSnapshot ? Number(latestSnapshot.fees) : 0;
    const realizedPnl = latestSnapshot
      ? Number(latestSnapshot.realizedPnl)
      : (positionPnlRows as Array<Record<string, unknown>>).reduce(
          (sum, p) => sum + Number(p.realizedPnl ?? 0),
          0,
        );
    const unrealizedPnl = latestSnapshot
      ? Number(latestSnapshot.unrealizedPnl)
      : (positionPnlRows as Array<Record<string, unknown>>).reduce(
          (sum, p) => sum + Number(p.unrealizedPnl ?? 0),
          0,
        );
    const winCount = (closedRows as Array<Record<string, unknown>>).filter(
      (p) => Number(p.realizedPnl ?? 0) > 0,
    ).length;
    const lossCount = closedRows.length - winCount;
    const winRate = winCount + lossCount > 0 ? winCount / (winCount + lossCount) : 0;
    const winRatePct = winRate * 100;

    return {
      id: row.id,
      trackedWalletId: row.trackedWalletId,
      trackedWalletAddress: row.trackedWalletAddress,
      trackedWalletLabel: row.trackedWallet.label,
      status: row.status,
      startingCash: Number(row.startingCash),
      currentCash: Number(row.currentCash),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      lastProcessedEventAt: row.lastProcessedEventAt,
      minWalletTrades: row.minWalletTrades,
      minWalletWinRate: row.minWalletWinRate !== null ? Number(row.minWalletWinRate) : null,
      minWalletSharpeLike:
        row.minWalletSharpeLike !== null ? Number(row.minWalletSharpeLike) : null,
      dailyDrawdownLimitPct:
        row.dailyDrawdownLimitPct !== null ? Number(row.dailyDrawdownLimitPct) : null,
      autoPauseOnHealthDegradation: Boolean(row.autoPauseOnHealthDegradation),
      consecutiveDecisionFailures: Number(row.consecutiveDecisionFailures ?? 0),
      lastAutoPausedAt: row.lastAutoPausedAt,
      estimatedSourceExposure:
        row.estimatedSourceExposure != null ? Number(row.estimatedSourceExposure) : null,
      copyRatio: row.copyRatio != null ? Number(row.copyRatio) : null,
      slippageBps: Number(row.slippageBps ?? 0),
      slippageConfig: row.slippageConfig ?? null,
      netLiquidationValue: nlv,
      totalPnl,
      realizedPnl,
      unrealizedPnl,
      fees,
      returnPct,
      winCount,
      lossCount,
      winRate,
      winRatePct,
      summarySentence:
        totalPnl >= 0
          ? `Hypothetically, copying this wallet since session start would have made $${totalPnl.toFixed(2)} (+${returnPct.toFixed(2)}%).`
          : `Hypothetically, copying this wallet since session start would have lost $${Math.abs(totalPnl).toFixed(2)} (${returnPct.toFixed(2)}%).`,
      stats: { openPositionsCount: openCount },
    };
  });

  app.get('/paper-copy-sessions/:id/metrics', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(2000).default(200) })
      .parse(req.query ?? {});
    const rows = await db.paperSessionMetricPoint.findMany({
      where: { sessionId: params.id },
      orderBy: { timestamp: 'asc' },
      take: query.limit,
    });
    return rows.map((row: any) => ({
      timestamp: row.timestamp,
      totalPnl: Number(row.totalPnl),
      realizedPnl: Number(row.realizedPnl),
      unrealizedPnl: Number(row.unrealizedPnl),
      netLiquidationValue: Number(row.netLiquidationValue),
      openPositionsCount: row.openPositionsCount,
      fees: Number(row.fees ?? 0),
    }));
  });

  app.get('/paper-copy-sessions/:id/analytics', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [result, session, closedPositions] = await Promise.all([
      getPaperCopySessionAnalytics(params.id),
      db.paperCopySession.findUnique({ where: { id: params.id } }),
      db.paperCopyPosition.findMany({ where: { sessionId: params.id, status: 'CLOSED' } }),
    ]);
    if (!result || !session) throw app.httpErrors.notFound('Session not found');

    const startedAt = session.startedAt ? (session.startedAt as Date).toISOString() : null;
    const sourceWindow = startedAt
      ? await calculateWalletPnlSummary(prisma, session.trackedWalletId, {
          range: 'ALL',
          from: startedAt,
          to: new Date().toISOString(),
        })
      : await calculateWalletPnlSummary(prisma, session.trackedWalletId, { range: 'ALL' });

    const sourceComparison = buildSessionSourceComparison({
      sourceWinRate: Number(sourceWindow.winRate),
      sourceNetPnl: sourceWindow.netPnl,
      closedPositions: closedPositions as Array<{ realizedPnl: unknown }>,
      startedAt,
      createdAtIso: new Date(session.createdAt as Date).toISOString(),
    });

    return {
      ...result,
      sourceComparison,
    };
  });

  app.get('/paper-copy-sessions/:id/positions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        status: z.enum(['OPEN', 'CLOSED', 'ALL']).default('ALL'),
        limit: z.coerce.number().int().min(1).max(2500).default(100),
      })
      .parse(req.query ?? {});
    const rows = await db.paperCopyPosition.findMany({
      where: { sessionId: params.id, ...(query.status === 'ALL' ? {} : { status: query.status }) },
      orderBy: { openedAt: 'desc' },
      take: query.limit,
    });
    return rows.map((row: any) => ({
      id: row.id,
      marketId: row.marketId,
      marketQuestion: row.marketQuestion,
      outcome: row.outcome,
      netShares: Number(row.netShares),
      avgEntryPrice: Number(row.avgEntryPrice),
      currentMarkPrice: Number(row.currentMarkPrice),
      realizedPnl: Number(row.realizedPnl),
      unrealizedPnl: Number(row.unrealizedPnl),
      status: row.status,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      updatedAt: row.updatedAt,
    }));
  });

  app.get('/paper-copy-sessions/:id/trades', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(50) })
      .parse(req.query ?? {});

    const rows = await db.paperCopyTrade.findMany({
      where: { sessionId: params.id },
      orderBy: { eventTimestamp: 'desc' },
      take: query.limit,
      include: {
        sourceActivityEvent: {
          select: {
            id: true,
            eventType: true,
            walletAddress: true,
            eventTimestamp: true,
            txHash: true,
            orderId: true,
            externalEventId: true,
            rawPayloadJson: true,
          },
        },
      },
    });

    const marketUrlFor = (marketId: string, rawPayloadJson?: unknown): string => {
      const raw =
        rawPayloadJson && typeof rawPayloadJson === 'object'
          ? (rawPayloadJson as Record<string, unknown>)
          : null;
      const slug =
        raw && typeof raw.eventSlug === 'string'
          ? raw.eventSlug
          : raw && typeof raw.slug === 'string'
            ? raw.slug
            : raw && typeof raw.marketSlug === 'string'
              ? raw.marketSlug
              : null;
      return slug
        ? `https://polymarket.com/event/${encodeURIComponent(slug)}`
        : `https://polymarket.com/market/${encodeURIComponent(marketId)}`;
    };

    return rows.map((row: any) => ({
      id: row.id,
      trackedWalletId: row.trackedWalletId,
      walletAddress: row.walletAddress,
      sourceType: row.sourceType,
      decisionId: row.decisionId ?? null,
      sourceEventTimestamp:
        row.sourceEventTimestamp ?? row.sourceActivityEvent?.eventTimestamp ?? null,
      sourceTxHash: row.sourceTxHash ?? row.sourceActivityEvent?.txHash ?? null,
      sourceEventType: row.sourceActivityEvent?.eventType ?? null,
      executorType: row.executorType,
      isBootstrap: row.isBootstrap,
      marketId: row.marketId,
      marketUrl: marketUrlFor(row.marketId, row.sourceActivityEvent?.rawPayloadJson),
      marketQuestion: row.marketQuestion,
      outcome: row.outcome,
      side: row.side,
      action: row.action,
      sourceActivityEventId: row.sourceActivityEventId,
      sourcePrice: toNullableNumber(row.sourcePrice),
      simulatedPrice: Number(row.simulatedPrice),
      sourceShares: toNullableNumber(row.sourceShares),
      simulatedShares: Number(row.simulatedShares),
      notional: Number(row.notional),
      feeApplied: Number(row.feeApplied),
      slippageApplied: Number(row.slippageApplied),
      sourceWalletAddress: row.sourceActivityEvent?.walletAddress ?? null,
      sourceTxUrl: row.sourceActivityEvent?.txHash
        ? `https://polygonscan.com/tx/${row.sourceActivityEvent.txHash}`
        : null,
      sourceOrderId: row.sourceActivityEvent?.orderId ?? null,
      sourceExternalEventId: row.sourceActivityEvent?.externalEventId ?? null,
      eventTimestamp: row.eventTimestamp,
      processedAt: row.processedAt,
      reasoning: row.reasoning,
    }));
  });

  app.get('/paper-copy-sessions/:id/decisions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(2500).default(100),
        status: z.enum(['PENDING', 'EXECUTED', 'SKIPPED', 'FAILED', 'ALL']).default('ALL'),
        decisionType: z
          .enum(['COPY', 'SKIP', 'REDUCE', 'CLOSE', 'BOOTSTRAP', 'NOOP', 'ALL'])
          .default('ALL'),
      })
      .parse(req.query ?? {});

    const where: Record<string, unknown> = { sessionId: params.id };
    if (query.status !== 'ALL') {
      where.status = query.status;
    }
    if (query.decisionType !== 'ALL') {
      where.decisionType = query.decisionType;
    }

    const rows = await db.paperCopyDecision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: {
        sourceActivityEvent: {
          select: {
            eventType: true,
            sourceName: true,
            sourceType: true,
          },
        },
        trades: {
          select: {
            id: true,
            eventTimestamp: true,
            simulatedPrice: true,
            simulatedShares: true,
            notional: true,
            feeApplied: true,
          },
          take: 1,
        },
      },
    });

    return rows.map((row: any) => {
      const trade = row.trades[0] ?? null;
      return {
        id: row.id,
        sessionId: row.sessionId,
        trackedWalletId: row.trackedWalletId,
        walletAddress: row.walletAddress,
        sourceActivityEventId: row.sourceActivityEventId,
        sourceEventType: row.sourceActivityEvent?.eventType ?? null,
        sourceEventName: row.sourceActivityEvent?.sourceName ?? null,
        sourceEventSourceType: row.sourceActivityEvent?.sourceType ?? null,
        sourceEventTimestamp: row.sourceEventTimestamp,
        sourceTxHash: row.sourceTxHash,
        decisionType: row.decisionType,
        status: row.status,
        executorType: row.executorType,
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        outcome: row.outcome,
        side: row.side,
        sourceShares: toNullableNumber(row.sourceShares),
        simulatedShares: toNullableNumber(row.simulatedShares),
        sourcePrice: toNullableNumber(row.sourcePrice),
        intendedFillPrice: toNullableNumber(row.intendedFillPrice),
        copyRatio: toNullableNumber(row.copyRatio),
        reasonCode: row.reasonCode,
        humanReason: row.humanReason,
        sizingInputs: row.sizingInputsJson,
        riskChecks: row.riskChecksJson,
        notes: row.notes,
        executionError: row.executionError,
        executedTrade:
          trade === null
            ? null
            : {
                id: trade.id,
                ledgerEntryId: trade.id,
                eventTimestamp: trade.eventTimestamp,
                simulatedPrice: Number(trade.simulatedPrice),
                simulatedShares: Number(trade.simulatedShares),
                notional: Number(trade.notional),
                feeApplied: Number(trade.feeApplied),
              },
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  });

  app.get('/paper-copy-sessions/:id/snapshots', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(1000).default(500) })
      .parse(req.query ?? {});
    const rows = await db.paperPortfolioSnapshot.findMany({
      where: { sessionId: params.id },
      orderBy: { timestamp: 'asc' },
      take: query.limit,
    });
    return rows.map((row: any) => ({
      timestamp: row.timestamp,
      cash: Number(row.cash),
      grossExposure: Number(row.grossExposure),
      netLiquidationValue: Number(row.netLiquidationValue),
      realizedPnl: Number(row.realizedPnl),
      unrealizedPnl: Number(row.unrealizedPnl),
      totalPnl: Number(row.totalPnl),
      returnPct: Number(row.returnPct),
    }));
  });
  registerForceCloseRoutes(app);
  registerProfileParityRoutes(app, { prisma, dataAdapter });
  registerPaperSessionMarketRoutes(app);
}
