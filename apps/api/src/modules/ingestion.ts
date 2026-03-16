import {
  apiLatency,
  detectionLatency,
  ingestionRate,
  pollLatency,
  tradeDetectionLatency,
} from '../lib/metrics.js';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { createPolymarketDataAdapter } from './polymarket.js';
import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type {
  WalletActivityFeedEvent,
  WalletActivityFeedQuery,
} from '@copytrader/polymarket-adapter';
import { handleWhaleAlert } from './alerts.js';
import { detectAndPersistClusterSignal } from './cluster-signals.js';
import { publishEvent } from './event-stream.js';
import { decisionQueue, ingestQueue } from './queue.js';
import { buildActivityDedupeKey, isTradeLikeActivity } from './activity.js';
import { incrementDuplicatePollSkip } from './runtime-ops.js';
import { isTurboModeEnabled } from './latency-profile.js';

const dataAdapter = createPolymarketDataAdapter();
const SOURCE_NAME = 'POLYMARKET_DATA_API';
const SOURCE_TYPE = 'HTTP_API';
const NON_MARKET_TYPES = new Set(['MERGE', 'SPLIT', 'DEPOSIT', 'WITHDRAW', 'CONVERT', 'TRANSFER']);

const MAX_MONITOR_CONCURRENCY = 30;
const hexWalletRegex = /^0x[a-fA-F0-9]{40}$/;
const profileHandleRegex = /^[a-zA-Z0-9._-]{2,64}$/;

type IngestionErrorClass =
  | 'DUPLICATE_EVENT'
  | 'TRANSIENT_FETCH_ERROR'
  | 'PARSE_NORMALIZATION_ERROR'
  | 'DB_INSERT_ERROR'
  | 'CURSOR_STATE_UPDATE_ERROR'
  | 'RECONCILIATION_WARNING';

type IngestionRunSummary = {
  mode: 'BACKFILL' | 'INCREMENTAL';
  overlapWindowSec: number;
  previousHighWatermark: string | null;
  nextHighWatermark: string | null;
  fetchedEvents: number;
  insertedActivityEvents: number;
  insertedTradeEvents: number;
  duplicateEvents: number;
  parseErrors: number;
  dbInsertErrors: number;
  decisionEnqueueErrors: number;
  gapIssuesDetected: number;
  warnings: number;
};

type CursorState = {
  id: string;
  highWatermarkTimestamp: Date | null;
  highWatermarkCursor: string | null;
  overlapWindowSec: number;
};

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as any).code === 'P2002'
  );
}

function classifyFetchError(error: unknown): IngestionErrorClass {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes('429') ||
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('temporar')
  ) {
    return 'TRANSIENT_FETCH_ERROR';
  }
  if (
    message.includes('400') ||
    message.includes('404') ||
    message.includes('invalid') ||
    message.includes('malformed')
  ) {
    return 'PARSE_NORMALIZATION_ERROR';
  }
  return 'TRANSIENT_FETCH_ERROR';
}

async function acquireWalletPollLock(walletId: string): Promise<string | null> {
  const lockToken = crypto.randomUUID();
  const key = `wallet:poll:lock:${walletId}`;
  const acquired = await redis.set(key, lockToken, 'EX', 90, 'NX');
  if (acquired !== 'OK') {
    return null;
  }
  return lockToken;
}

async function releaseWalletPollLock(walletId: string, lockToken: string) {
  const key = `wallet:poll:lock:${walletId}`;
  const current = await redis.get(key);
  if (current === lockToken) {
    await redis.del(key);
  }
}

function asIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function safeObservedAtIso(value: string | null | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function computeRawPayloadHash(payload: Prisma.InputJsonValue): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function sanitizeForPg(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/\u0000/g, '');
  if (Array.isArray(v)) return v.map(sanitizeForPg);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, sanitizeForPg(val)]),
    );
  }
  return v;
}

async function getOrCreateCursor(walletId: string): Promise<CursorState> {
  const row = await prisma.walletSyncCursor.upsert({
    where: {
      trackedWalletId_sourceName: {
        trackedWalletId: walletId,
        sourceName: SOURCE_NAME,
      },
    },
    create: {
      trackedWalletId: walletId,
      sourceName: SOURCE_NAME,
      sourceType: SOURCE_TYPE,
      overlapWindowSec: config.INGEST_OVERLAP_WINDOW_SEC,
      status: 'ACTIVE',
    },
    update: {
      overlapWindowSec: config.INGEST_OVERLAP_WINDOW_SEC,
      sourceType: SOURCE_TYPE,
    },
    select: {
      id: true,
      highWatermarkTimestamp: true,
      highWatermarkCursor: true,
      overlapWindowSec: true,
    },
  });

  return {
    id: row.id,
    highWatermarkTimestamp: row.highWatermarkTimestamp,
    highWatermarkCursor: row.highWatermarkCursor,
    overlapWindowSec: row.overlapWindowSec,
  };
}

async function fetchWalletActivityPages(
  address: string,
  baseQuery: Omit<WalletActivityFeedQuery, 'offset' | 'limit'>,
): Promise<WalletActivityFeedEvent[]> {
  const pageLimit = config.INGEST_BACKFILL_PAGE_LIMIT;
  const pageSize = config.INGEST_ACTIVITY_PAGE_SIZE;
  const results: WalletActivityFeedEvent[] = [];

  for (let page = 0; page < pageLimit; page += 1) {
    const offset = page * pageSize;
    const batch = await dataAdapter.getWalletActivityFeed(address, {
      ...baseQuery,
      offset,
      limit: pageSize,
    });
    if (batch.length === 0) {
      break;
    }
    results.push(...batch);
    if (batch.length < pageSize) {
      break;
    }
  }

  return results;
}

function sourceEventIdForTradeEvent(event: WalletActivityFeedEvent, dedupeKey: string): string {
  if (event.externalEventId) return event.externalEventId;
  if (event.txHash && Number.isInteger(event.logIndex)) {
    return `${event.txHash}:${event.logIndex}`;
  }
  if (event.txHash && event.orderId) {
    return `${event.txHash}:${event.orderId}`;
  }
  return dedupeKey;
}

function activityCursorForEvent(event: WalletActivityFeedEvent): string | null {
  return event.sourceCursor ?? event.externalEventId ?? null;
}

function shouldAdvanceWatermark(input: {
  currentTimestamp: Date | null;
  currentCursor: string | null;
  candidateTimestamp: Date;
  candidateCursor: string | null;
}): boolean {
  if (!input.currentTimestamp) return true;

  const currentTs = input.currentTimestamp.getTime();
  const candidateTs = input.candidateTimestamp.getTime();
  if (candidateTs > currentTs) return true;
  if (candidateTs < currentTs) return false;

  const currentCursor = input.currentCursor ?? '';
  const candidateCursor = input.candidateCursor ?? '';
  return candidateCursor > currentCursor;
}

function orderEventsForSafeIngestion(events: WalletActivityFeedEvent[]): WalletActivityFeedEvent[] {
  return [...events].sort((a, b) => {
    const aTs = new Date(a.eventTimestamp).getTime();
    const bTs = new Date(b.eventTimestamp).getTime();

    const aSafeTs = Number.isFinite(aTs) ? aTs : Number.MAX_SAFE_INTEGER;
    const bSafeTs = Number.isFinite(bTs) ? bTs : Number.MAX_SAFE_INTEGER;
    if (aSafeTs !== bSafeTs) return aSafeTs - bSafeTs;

    const aCursor = activityCursorForEvent(a) ?? '';
    const bCursor = activityCursorForEvent(b) ?? '';
    if (aCursor !== bCursor) return aCursor.localeCompare(bCursor);

    const aTx = String(a.txHash ?? '');
    const bTx = String(b.txHash ?? '');
    if (aTx !== bTx) return aTx.localeCompare(bTx);

    const aLog = Number.isInteger(a.logIndex) ? Number(a.logIndex) : Number.MAX_SAFE_INTEGER;
    const bLog = Number.isInteger(b.logIndex) ? Number(b.logIndex) : Number.MAX_SAFE_INTEGER;
    if (aLog !== bLog) return aLog - bLog;

    return String(a.orderId ?? '').localeCompare(String(b.orderId ?? ''));
  });
}

async function recordIngestionDiagnostic(input: {
  walletId: string;
  address: string;
  outcome: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  errorClass?: IngestionErrorClass;
  message?: string;
  summary: IngestionRunSummary;
  startedAt: Date;
  durationMs: number;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        category: 'INGESTION',
        entityId: input.walletId,
        action: input.outcome,
        payload: {
          walletId: input.walletId,
          address: input.address,
          startedAt: input.startedAt.toISOString(),
          durationMs: input.durationMs,
          errorClass: input.errorClass ?? null,
          message: input.message ?? null,
          summary: input.summary,
        },
      },
    });
  } catch (error) {
    logger.warn({ walletId: input.walletId, error }, 'failed to persist ingestion diagnostic');
  }
}

function isPollIdentifierValid(addressOrHandle: string): boolean {
  if (hexWalletRegex.test(addressOrHandle)) {
    return true;
  }
  if (addressOrHandle.startsWith('0x')) {
    if (addressOrHandle.length === 42) {
      return false;
    }
    return profileHandleRegex.test(addressOrHandle);
  }
  return profileHandleRegex.test(addressOrHandle);
}

function isRecentlyActive(lastTradeAt: Date | null): boolean {
  if (!lastTradeAt) {
    return false;
  }
  const cutoff = Date.now() - config.ACTIVE_WALLET_WINDOW_MINUTES * 60_000;
  return lastTradeAt.getTime() >= cutoff;
}

function computeNextPollIntervalMs(active: boolean): number {
  if (isTurboModeEnabled()) {
    if (active) {
      return Math.max(300, config.TURBO_ACTIVE_WALLET_POLL_MS);
    }
    const min = Math.max(1000, config.TURBO_INACTIVE_WALLET_POLL_MIN_MS);
    const max = Math.max(min, config.TURBO_INACTIVE_WALLET_POLL_MAX_MS);
    return min + Math.floor(Math.random() * Math.max(1, max - min));
  }

  if (active) {
    return config.ACTIVE_WALLET_POLL_MS;
  }
  const min = config.INACTIVE_WALLET_POLL_MIN_MS;
  const max = config.INACTIVE_WALLET_POLL_MAX_MS;
  return min + Math.floor(Math.random() * Math.max(1, max - min));
}

async function shouldPollWalletNow(walletId: string): Promise<boolean> {
  const key = `wallet:last-poll:${walletId}`;
  const value = await redis.get(key);
  if (!value) {
    return true;
  }
  const lastMs = Number(value);
  if (!Number.isFinite(lastMs)) {
    return true;
  }
  const latestTrade = await prisma.tradeEvent.findFirst({
    where: { walletId },
    orderBy: { tradedAt: 'desc' },
    select: { tradedAt: true },
  });
  const active = isRecentlyActive(latestTrade?.tradedAt ?? null);
  const waitMs = computeNextPollIntervalMs(active);
  return Date.now() - lastMs >= waitMs;
}

export async function scheduleWalletPolls(): Promise<void> {
  const wallets = await prisma.watchedWallet.findMany({
    where: {
      enabled: true,
      copyEnabled: true,
      syncStatus: { not: 'ERROR' },
    },
  });

  const turboMode = isTurboModeEnabled();
  const batchConcurrency = turboMode
    ? Math.max(MAX_MONITOR_CONCURRENCY, config.TURBO_SCHEDULE_BATCH_CONCURRENCY)
    : MAX_MONITOR_CONCURRENCY;

  for (let index = 0; index < wallets.length; index += batchConcurrency) {
    const batch = wallets.slice(index, index + batchConcurrency);
    await Promise.all(
      batch.map(async (wallet) => {
        if (!(await shouldPollWalletNow(wallet.id))) {
          return;
        }
        const latestTrade = await prisma.tradeEvent.findFirst({
          where: { walletId: wallet.id },
          orderBy: { tradedAt: 'desc' },
          select: { tradedAt: true },
        });
        const active = isRecentlyActive(latestTrade?.tradedAt ?? null);
        await ingestQueue.add(
          'poll-wallet',
          { walletId: wallet.id, address: wallet.address, tier: active ? 'ACTIVE' : 'INACTIVE' },
          {
            jobId: `poll-wallet:${wallet.id}`,
            priority: active ? 1 : 10,
            removeOnComplete: 1000,
            removeOnFail: 5000,
            attempts: 5,
            backoff: {
              type: 'exponential',
              delay: turboMode ? config.TURBO_INGEST_BACKOFF_MS : 500,
            },
          },
        );
      }),
    );
  }
}

export async function processWalletPoll(walletId: string, address: string): Promise<void> {
  const lockToken = await acquireWalletPollLock(walletId);
  if (!lockToken) {
    incrementDuplicatePollSkip();
    logger.debug({ walletId }, 'wallet poll skipped due to active lock owner');
    return;
  }

  const runStartedAt = new Date();
  let cursorState: CursorState | null = null;
  const summary: IngestionRunSummary = {
    mode: 'INCREMENTAL',
    overlapWindowSec: config.INGEST_OVERLAP_WINDOW_SEC,
    previousHighWatermark: null,
    nextHighWatermark: null,
    fetchedEvents: 0,
    insertedActivityEvents: 0,
    insertedTradeEvents: 0,
    duplicateEvents: 0,
    parseErrors: 0,
    dbInsertErrors: 0,
    decisionEnqueueErrors: 0,
    gapIssuesDetected: 0,
    warnings: 0,
  };

  try {
    if (!isPollIdentifierValid(address)) {
      await prisma.watchedWallet.update({
        where: { id: walletId },
        data: {
          enabled: false,
          copyEnabled: false,
          syncStatus: 'ERROR',
          lastSyncError:
            '[PARSE_NORMALIZATION_ERROR] Invalid wallet identifier. Use a Polymarket profile handle or full 0x address.',
          lastPolledAt: new Date(),
        },
      });
      await recordIngestionDiagnostic({
        walletId,
        address,
        outcome: 'FAILED',
        errorClass: 'PARSE_NORMALIZATION_ERROR',
        message: 'Invalid wallet identifier. Use a Polymarket profile handle or full 0x address.',
        summary,
        startedAt: runStartedAt,
        durationMs: 0,
      });
      logger.warn({ walletId, address }, 'wallet disabled due to invalid identifier');
      return;
    }

    const start = Date.now();
    await redis.set(`wallet:last-poll:${walletId}`, String(start));

    try {
      cursorState = await getOrCreateCursor(walletId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load wallet sync cursor';
      await prisma.watchedWallet.update({
        where: { id: walletId },
        data: {
          syncStatus: 'ERROR',
          lastSyncError: `[CURSOR_STATE_UPDATE_ERROR] ${message}`,
          lastPolledAt: new Date(),
        },
      });
      await recordIngestionDiagnostic({
        walletId,
        address,
        outcome: 'FAILED',
        errorClass: 'CURSOR_STATE_UPDATE_ERROR',
        message,
        summary,
        startedAt: runStartedAt,
        durationMs: Date.now() - start,
      });
      return;
    }

    summary.overlapWindowSec = cursorState.overlapWindowSec;
    summary.previousHighWatermark = asIsoString(cursorState.highWatermarkTimestamp);
    const cursor = cursorState;

    await prisma.watchedWallet.update({
      where: { id: walletId },
      data: {
        syncStatus: 'SYNCING',
        lastSyncError: null,
      },
    });

    const apiStart = Date.now();
    let events: WalletActivityFeedEvent[] = [];
    const now = Date.now();
    const overlapStartMs = cursorState.highWatermarkTimestamp
      ? Math.max(
          0,
          cursorState.highWatermarkTimestamp.getTime() - cursorState.overlapWindowSec * 1000,
        )
      : null;

    summary.mode = cursorState.highWatermarkTimestamp ? 'INCREMENTAL' : 'BACKFILL';

    // Overlap window is intentional: strict event_ts > high_watermark can miss
    // same-timestamp or delayed-index events at poll boundaries.
    const incrementalQuery: Omit<WalletActivityFeedQuery, 'offset' | 'limit'> =
      overlapStartMs !== null ? { sinceIso: new Date(overlapStartMs).toISOString() } : {};

    const lookbackStartMs = now - config.INGEST_BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    try {
      if (summary.mode === 'BACKFILL') {
        const fetched = await fetchWalletActivityPages(address, {});
        events = fetched.filter((event) => {
          const ts = new Date(event.eventTimestamp).getTime();
          return Number.isFinite(ts) && ts >= lookbackStartMs;
        });
      } else {
        events = await fetchWalletActivityPages(address, incrementalQuery);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown ingestion fetch error';
      const errorClass = classifyFetchError(error);

      // TRANSIENT errors (rate limits, network blips) should NOT mark the wallet as ERROR —
      // that would permanently stop scheduleWalletPolls from retrying it.
      // Only PARSE_NORMALIZATION_ERROR (bad address, 400/404) is a permanent failure.
      const isPermanentError = errorClass === 'PARSE_NORMALIZATION_ERROR';

      await prisma.watchedWallet.update({
        where: { id: walletId },
        data: {
          syncStatus: isPermanentError ? 'ERROR' : 'SYNCING',
          lastSyncError: `[${errorClass}] ${message}`,
          lastPolledAt: new Date(),
          nextPollAt: new Date(Date.now() + config.INGEST_POLL_MAX_INTERVAL_MS),
        },
      });
      await prisma.walletSyncCursor.update({
        where: { id: cursor.id },
        data: {
          lastFailureAt: new Date(),
          lastErrorClass: errorClass,
          status: isPermanentError ? 'ERROR' : 'ACTIVE',
        },
      });
      await recordIngestionDiagnostic({
        walletId,
        address,
        outcome: 'FAILED',
        errorClass,
        message,
        summary,
        startedAt: runStartedAt,
        durationMs: Date.now() - start,
      });
      logger.warn({ walletId, address, message, errorClass }, 'wallet poll failed');
      apiLatency.observe({ adapter: 'polymarket' }, Date.now() - apiStart);
      return;
    }
    apiLatency.observe({ adapter: 'polymarket' }, Date.now() - apiStart);
    summary.fetchedEvents = events.length;

    const activeTier = isRecentlyActive(cursor.highWatermarkTimestamp) ? 'ACTIVE' : 'INACTIVE';

    let latestSafeActivityAt: Date | null = cursorState.highWatermarkTimestamp;
    let latestSafeCursor: string | null = cursorState.highWatermarkCursor;
    let firstNonDuplicateInsertFailure: {
      dedupeKey: string;
      externalEventId: string | null;
      eventTimestamp: string;
      message: string;
    } | null = null;

    for (const event of orderEventsForSafeIngestion(events)) {
      const eventTs = new Date(event.eventTimestamp);
      if (!Number.isFinite(eventTs.getTime())) {
        summary.parseErrors += 1;
        logger.warn(
          {
            walletId,
            externalEventId: event.externalEventId ?? null,
            eventTimestamp: event.eventTimestamp,
          },
          'skipping event with invalid timestamp',
        );
        continue;
      }
      if (!event.marketId || event.marketId.trim().length === 0) {
        if (!NON_MARKET_TYPES.has(event.eventType.toUpperCase())) {
          summary.parseErrors += 1;
          logger.warn({ walletId, eventType: event.eventType }, 'trade event missing marketId');
        }
        continue;
      }
      const dedupeKey = buildActivityDedupeKey(event);
      const detectedMs = Math.max(0, Date.now() - eventTs.getTime());
      detectionLatency.observe(detectedMs);
      tradeDetectionLatency.observe(detectedMs);

      let activityRow: { id: string } | null = null;
      try {
        const rawPayloadJson = sanitizeForPg(event.rawPayload) as Prisma.InputJsonValue;
        const rawPayloadHash = computeRawPayloadHash(rawPayloadJson);

        activityRow = await prisma.walletActivityEvent.create({
          data: {
            trackedWalletId: walletId,
            walletAddress: event.walletAddress,
            sourceName: SOURCE_NAME,
            sourceType: SOURCE_TYPE,
            externalEventId: event.externalEventId ?? null,
            sourceEventId: event.externalEventId ?? null,
            sourceCursor: event.sourceCursor ?? event.externalEventId ?? null,
            dedupeKey,
            eventType: event.eventType,
            marketId: event.marketId,
            conditionId: event.conditionId,
            marketQuestion: event.marketQuestion ?? null,
            outcome: event.outcome ?? null,
            side: event.side,
            effectiveSide: event.effectiveSide,
            price: event.price,
            shares: event.shares,
            notional: event.notional,
            fee: event.fee,
            blockNumber: event.blockNumber,
            logIndex: event.logIndex,
            sourceTxHash: event.txHash,
            txHash: event.txHash,
            orderId: event.orderId,
            eventTimestamp: eventTs,
            observedAt: new Date(safeObservedAtIso(event.detectedAt)),
            detectedAt: new Date(safeObservedAtIso(event.detectedAt)),
            rawPayloadHash,
            rawPayloadJson,
            provenanceNote:
              summary.mode === 'BACKFILL'
                ? 'Historical backfill event'
                : 'Incremental overlap poll event',
          },
        });
        summary.insertedActivityEvents += 1;

        const candidateCursor = activityCursorForEvent(event);
        if (
          shouldAdvanceWatermark({
            currentTimestamp: latestSafeActivityAt,
            currentCursor: latestSafeCursor,
            candidateTimestamp: eventTs,
            candidateCursor,
          })
        ) {
          latestSafeActivityAt = eventTs;
          latestSafeCursor = candidateCursor;
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          summary.duplicateEvents += 1;

          const candidateCursor = activityCursorForEvent(event);
          if (
            shouldAdvanceWatermark({
              currentTimestamp: latestSafeActivityAt,
              currentCursor: latestSafeCursor,
              candidateTimestamp: eventTs,
              candidateCursor,
            })
          ) {
            latestSafeActivityAt = eventTs;
            latestSafeCursor = candidateCursor;
          }

          logger.debug(
            { walletId, dedupeKey, externalEventId: event.externalEventId ?? null },
            'skipping duplicate wallet activity event',
          );
          continue;
        }
        summary.dbInsertErrors += 1;
        firstNonDuplicateInsertFailure = {
          dedupeKey,
          externalEventId: event.externalEventId ?? null,
          eventTimestamp: event.eventTimestamp,
          message: error instanceof Error ? error.message : String(error),
        };
        logger.warn(
          {
            walletId,
            dedupeKey,
            externalEventId: event.externalEventId ?? null,
            eventTimestamp: event.eventTimestamp,
            error,
          },
          'failed to insert wallet activity event; halting batch to preserve cursor retryability',
        );
        break;
      }

      if (!isTradeLikeActivity(event)) {
        continue;
      }

      try {
        const row = await prisma.tradeEvent.create({
          data: {
            walletId,
            sourceEventId: sourceEventIdForTradeEvent(event, dedupeKey),
            sourceWalletAddress: event.walletAddress,
            marketId: event.marketId,
            marketQuestion: event.marketQuestion
              ? (sanitizeForPg(event.marketQuestion) as string)
              : null,
            outcome: event.outcome ?? 'UNKNOWN',
            side: event.side!,
            size: event.shares!,
            price: event.price!,
            txHash: event.txHash,
            orderId: event.orderId,
            tradedAt: eventTs,
            observedAt: new Date(safeObservedAtIso(event.detectedAt)),
          },
        });
        summary.insertedTradeEvents += 1;

        ingestionRate.inc({ wallet_tier: activeTier.toLowerCase() });

        await publishEvent(
          'WALLET_TRADE_DETECTED',
          {
            walletId,
            walletAddress: event.walletAddress,
            activityEventId: activityRow.id,
            eventType: event.eventType,
            marketId: event.marketId,
            side: event.side,
            size: event.shares,
            price: event.price,
            tradedAt: event.eventTimestamp,
            detectionLatencyMs: detectedMs,
          },
          row.id,
        );

        const recentEntriesInWindow = await prisma.tradeEvent.count({
          where: {
            walletId,
            marketId: row.marketId,
            side: row.side,
            tradedAt: {
              gte: new Date(row.tradedAt.getTime() - config.CLUSTER_WINDOW_SECONDS * 1000),
              lte: row.tradedAt,
            },
          },
        });

        const marketLiquidityApprox = Number(row.size) * Number(row.price) * 20;
        await handleWhaleAlert({
          walletId,
          tradeEventId: row.id,
          walletAddress: row.sourceWalletAddress,
          marketId: row.marketId,
          side: row.side,
          price: Number(row.price),
          size: Number(row.size),
          liquidity: marketLiquidityApprox,
          tradedAt: row.tradedAt,
          recentEntriesInWindow,
        });

        await detectAndPersistClusterSignal(row.id);

        const strategies = await prisma.strategy.findMany({
          where: { walletId, enabled: true },
          select: { id: true },
        });
        for (const strategy of strategies) {
          try {
            await decisionQueue.add(
              'decision',
              { strategyId: strategy.id, tradeEventId: row.id, activityEventId: activityRow.id },
              {
                jobId: `decision:${strategy.id}:${row.id}`,
                removeOnComplete: 1000,
                removeOnFail: 5000,
                attempts: 5,
                backoff: {
                  type: 'exponential',
                  delay: isTurboModeEnabled() ? config.TURBO_DECISION_BACKOFF_MS : 500,
                },
              },
            );
          } catch (error) {
            summary.decisionEnqueueErrors += 1;
            logger.warn(
              { walletId, strategyId: strategy.id, tradeEventId: row.id, error },
              'failed to enqueue decision job',
            );
          }
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          summary.duplicateEvents += 1;
          logger.debug(
            { walletId, dedupeKey, externalEventId: event.externalEventId ?? null },
            'skipping duplicate trade event',
          );
          continue;
        }
        summary.dbInsertErrors += 1;
        logger.warn(
          { walletId, dedupeKey, externalEventId: event.externalEventId ?? null, error },
          'failed to process trade-like activity event',
        );
      }
    }

    const nextInterval = computeNextPollIntervalMs(activeTier === 'ACTIVE');
    const hasHardFailures = summary.dbInsertErrors > 0;
    const hasWarnings = summary.decisionEnqueueErrors > 0;
    summary.warnings = hasWarnings ? 1 : 0;
    const outcome: 'SUCCESS' | 'PARTIAL' = hasHardFailures || hasWarnings ? 'PARTIAL' : 'SUCCESS';

    if (latestSafeActivityAt) {
      summary.nextHighWatermark = latestSafeActivityAt.toISOString();
    }

    const walletUpdateData: Record<string, unknown> = {
      syncStatus: outcome === 'SUCCESS' ? 'ACTIVE' : 'DEGRADED',
      lastSyncAt: new Date(),
      lastPolledAt: new Date(),
      nextPollAt: new Date(Date.now() + nextInterval),
      priorityTier: activeTier,
      lastSyncError:
        outcome === 'SUCCESS'
          ? null
          : hasHardFailures
            ? `[DB_INSERT_ERROR] ${summary.dbInsertErrors} insert failure(s). Cursor held at last safe event.${
                firstNonDuplicateInsertFailure
                  ? ` First failure at ${firstNonDuplicateInsertFailure.eventTimestamp} (${firstNonDuplicateInsertFailure.dedupeKey}).`
                  : ''
              } Check ingestion diagnostics.`
            : '[QUEUE_WARNING] Decision queue warnings during poll.',
    };
    if (latestSafeActivityAt) {
      walletUpdateData.lastActivitySyncedAt = latestSafeActivityAt;
    }

    try {
      const lagSec = latestSafeActivityAt
        ? Math.max(0, Math.floor((Date.now() - latestSafeActivityAt.getTime()) / 1000))
        : null;

      await prisma.$transaction([
        prisma.watchedWallet.update({
          where: { id: walletId },
          data: walletUpdateData,
        }),
        prisma.walletSyncCursor.update({
          where: { id: cursor.id },
          data: {
            highWatermarkTimestamp: latestSafeActivityAt ?? cursor.highWatermarkTimestamp,
            highWatermarkCursor: latestSafeCursor,
            overlapWindowSec: cursor.overlapWindowSec,
            lastSuccessAt: new Date(),
            lastErrorClass: null,
            lagSec,
            status: outcome === 'SUCCESS' ? 'ACTIVE' : 'DEGRADED',
            lastFetchedCount: summary.fetchedEvents,
            lastInsertedCount: summary.insertedActivityEvents,
            lastDuplicateCount: summary.duplicateEvents,
            lastParseErrorCount: summary.parseErrors,
            lastInsertErrorCount: summary.dbInsertErrors,
          },
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update wallet sync state';
      await prisma.walletSyncCursor
        .update({
          where: { id: cursor.id },
          data: {
            lastFailureAt: new Date(),
            lastErrorClass: 'CURSOR_STATE_UPDATE_ERROR',
            status: 'ERROR',
          },
        })
        .catch(() => undefined);

      await recordIngestionDiagnostic({
        walletId,
        address,
        outcome: 'FAILED',
        errorClass: 'CURSOR_STATE_UPDATE_ERROR',
        message,
        summary,
        startedAt: runStartedAt,
        durationMs: Date.now() - start,
      });
      logger.error({ walletId, error }, 'failed to update wallet sync state');
      return;
    }

    await recordIngestionDiagnostic({
      walletId,
      address,
      outcome,
      message:
        outcome === 'SUCCESS'
          ? 'Wallet poll completed successfully'
          : firstNonDuplicateInsertFailure
            ? `Wallet poll completed with partial failures/warnings. Cursor held at last safe event after insert failure at ${firstNonDuplicateInsertFailure.eventTimestamp} (${firstNonDuplicateInsertFailure.dedupeKey}).`
            : 'Wallet poll completed with partial failures/warnings',
      summary,
      startedAt: runStartedAt,
      durationMs: Date.now() - start,
    });

    pollLatency.observe(Date.now() - start);
  } finally {
    await releaseWalletPollLock(walletId, lockToken).catch(() => undefined);
  }
}
