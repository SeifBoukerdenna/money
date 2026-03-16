import { describe, expect, it, vi } from 'vitest';

type FeedEvent = {
  walletAddress: string;
  externalEventId: string;
  sourceCursor: string;
  eventTimestamp: string;
  eventType: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  side: 'BUY' | 'SELL' | null;
  effectiveSide: 'BUY' | 'SELL' | null;
  price: number | null;
  shares: number | null;
  notional: number | null;
  fee: number | null;
  blockNumber: number | null;
  logIndex: number | null;
  txHash: string | null;
  orderId: string | null;
  detectedAt: string;
  rawPayload: Record<string, unknown>;
};

function makeEvent(input: { id: string; cursor: string; ts: string }): FeedEvent {
  return {
    walletAddress: '0x0000000000000000000000000000000000000001',
    externalEventId: input.id,
    sourceCursor: input.cursor,
    eventTimestamp: input.ts,
    eventType: 'TRANSFER',
    marketId: 'm1',
    conditionId: 'm1',
    marketQuestion: 'Test market',
    outcome: 'YES',
    side: null,
    effectiveSide: null,
    price: null,
    shares: null,
    notional: null,
    fee: null,
    blockNumber: null,
    logIndex: null,
    txHash: null,
    orderId: null,
    detectedAt: input.ts,
    rawPayload: { id: input.id },
  };
}

async function setup(input: {
  events: FeedEvent[];
  createBehavior: (eventId: string) => 'ok' | 'dup' | 'fail';
}) {
  vi.resetModules();

  const redisKv = new Map<string, string>();
  const redisMock = {
    set: vi.fn(async (key: string, value: string, ...args: string[]) => {
      if (args.includes('NX')) {
        if (redisKv.has(key)) return null;
        redisKv.set(key, value);
        return 'OK';
      }
      redisKv.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => redisKv.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const existed = redisKv.delete(key);
      return existed ? 1 : 0;
    }),
  };

  const cursorUpdates: Array<Record<string, unknown>> = [];
  const walletSyncCursor = {
    upsert: vi.fn(async () => ({
      id: 'cursor-1',
      highWatermarkTimestamp: null,
      highWatermarkCursor: null,
      overlapWindowSec: 180,
    })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      cursorUpdates.push(data);
      return { id: 'cursor-1', ...data };
    }),
  };

  const walletActivityEventCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const eventId = String(data.externalEventId ?? '');
    const behavior = input.createBehavior(eventId);
    if (behavior === 'dup') {
      const err = Object.assign(new Error('duplicate'), { code: 'P2002' });
      throw err;
    }
    if (behavior === 'fail') {
      throw new Error('insert failed');
    }
    return { id: `wae:${eventId}` };
  });

  vi.doMock('../src/config.js', () => ({
    config: {
      INGEST_OVERLAP_WINDOW_SEC: 180,
      ACTIVE_WALLET_WINDOW_MINUTES: 30,
      ACTIVE_WALLET_POLL_MS: 5000,
      INACTIVE_WALLET_POLL_MIN_MS: 30000,
      INACTIVE_WALLET_POLL_MAX_MS: 60000,
      TURBO_ACTIVE_WALLET_POLL_MS: 1500,
      TURBO_INACTIVE_WALLET_POLL_MIN_MS: 10000,
      TURBO_INACTIVE_WALLET_POLL_MAX_MS: 20000,
      INGEST_BACKFILL_LOOKBACK_DAYS: 30,
      INGEST_BACKFILL_PAGE_LIMIT: 5,
      INGEST_ACTIVITY_PAGE_SIZE: 500,
      CLUSTER_WINDOW_SECONDS: 120,
      TURBO_DECISION_BACKOFF_MS: 200,
      INGEST_POLL_MAX_INTERVAL_MS: 30000,
    },
  }));

  vi.doMock('../src/lib/redis.js', () => ({ redis: redisMock }));
  vi.doMock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
  }));
  vi.doMock('../src/lib/metrics.js', () => ({
    apiLatency: { observe: vi.fn() },
    detectionLatency: { observe: vi.fn() },
    ingestionRate: { inc: vi.fn() },
    pollLatency: { observe: vi.fn() },
    tradeDetectionLatency: { observe: vi.fn() },
  }));

  vi.doMock('../src/modules/polymarket.js', () => ({
    createPolymarketDataAdapter: () => ({
      getWalletActivityFeed: vi.fn(async () => input.events),
    }),
  }));

  vi.doMock('../src/modules/activity.js', () => ({
    buildActivityDedupeKey: (event: FeedEvent) => event.externalEventId,
    isTradeLikeActivity: () => false,
  }));

  vi.doMock('../src/modules/queue.js', () => ({
    decisionQueue: { add: vi.fn() },
    ingestQueue: { add: vi.fn() },
  }));

  vi.doMock('../src/modules/alerts.js', () => ({ handleWhaleAlert: vi.fn() }));
  vi.doMock('../src/modules/cluster-signals.js', () => ({
    detectAndPersistClusterSignal: vi.fn(),
  }));
  vi.doMock('../src/modules/event-stream.js', () => ({ publishEvent: vi.fn() }));
  vi.doMock('../src/modules/runtime-ops.js', () => ({ incrementDuplicatePollSkip: vi.fn() }));
  vi.doMock('../src/modules/latency-profile.js', () => ({ isTurboModeEnabled: () => false }));

  vi.doMock('../src/lib/prisma.js', () => ({
    prisma: {
      walletSyncCursor,
      watchedWallet: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })),
        findMany: vi.fn(async () => []),
      },
      walletActivityEvent: {
        create: walletActivityEventCreate,
      },
      tradeEvent: {
        findFirst: vi.fn(async () => null),
      },
      auditLog: {
        create: vi.fn(async () => ({ id: 'audit-1' })),
      },
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    },
  }));

  const ingestion = await import('../src/modules/ingestion.js');

  return {
    processWalletPoll: ingestion.processWalletPoll,
    walletActivityEventCreate,
    cursorUpdates,
  };
}

describe('ingestion watermark safety', () => {
  it('advances watermark through duplicate events (idempotent-safe)', async () => {
    const events = [
      makeEvent({ id: 'e1', cursor: 'c1', ts: '2026-03-16T00:00:01.000Z' }),
      makeEvent({ id: 'e2', cursor: 'c2', ts: '2026-03-16T00:00:02.000Z' }),
    ];

    const { processWalletPoll, cursorUpdates } = await setup({
      events,
      createBehavior: () => 'dup',
    });

    await processWalletPoll('wallet-1', '0x0000000000000000000000000000000000000001');

    const cursorUpdate = cursorUpdates.at(-1);
    expect(cursorUpdate).toBeDefined();
    expect((cursorUpdate?.highWatermarkTimestamp as Date).toISOString()).toBe(
      events[1]!.eventTimestamp,
    );
    expect(cursorUpdate?.highWatermarkCursor).toBe('c2');
  });

  it('does not advance watermark past first non-duplicate insert failure', async () => {
    const events = [
      makeEvent({ id: 'e1', cursor: 'c1', ts: '2026-03-16T00:00:01.000Z' }),
      makeEvent({ id: 'e2', cursor: 'c2', ts: '2026-03-16T00:00:02.000Z' }),
      makeEvent({ id: 'e3', cursor: 'c3', ts: '2026-03-16T00:00:03.000Z' }),
    ];

    const { processWalletPoll, walletActivityEventCreate, cursorUpdates } = await setup({
      events,
      createBehavior: (eventId) => {
        if (eventId === 'e1') return 'dup';
        if (eventId === 'e2') return 'fail';
        return 'dup';
      },
    });

    await processWalletPoll('wallet-1', '0x0000000000000000000000000000000000000001');

    // Processing halts on first hard insert error to preserve retryability.
    expect(walletActivityEventCreate).toHaveBeenCalledTimes(2);

    const cursorUpdate = cursorUpdates.at(-1);
    expect(cursorUpdate).toBeDefined();
    expect((cursorUpdate?.highWatermarkTimestamp as Date).toISOString()).toBe(
      events[0]!.eventTimestamp,
    );
    expect(cursorUpdate?.highWatermarkCursor).toBe('c1');
    expect(cursorUpdate?.lastInsertErrorCount).toBe(1);
  });
});
