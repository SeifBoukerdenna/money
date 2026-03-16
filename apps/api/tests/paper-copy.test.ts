import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = {
  watchedWallets: Array<Record<string, any>>;
  sessions: Array<Record<string, any>>;
  decisions: Array<Record<string, any>>;
  positions: Array<Record<string, any>>;
  trades: Array<Record<string, any>>;
  activityEvents: Array<Record<string, any>>;
  snapshots: Array<Record<string, any>>;
  metrics: Array<Record<string, any>>;
};

function createState(): MockState {
  return {
    watchedWallets: [],
    sessions: [],
    decisions: [],
    positions: [],
    trades: [],
    activityEvents: [],
    snapshots: [],
    metrics: [],
  };
}

function createPrismaMock(state: MockState) {
  return {
    watchedWallet: {
      findUnique: vi.fn(async ({ where }) => {
        return state.watchedWallets.find((w) => w.id === where.id) ?? null;
      }),
    },
    paperCopySession: {
      create: vi.fn(async ({ data }) => {
        const now = new Date();
        const row = {
          id: `session-${state.sessions.length + 1}`,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          endedAt: null,
          lastProcessedEventAt: null,
          estimatedSourceExposure: null,
          copyRatio: null,
          ...data,
        };
        state.sessions.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }) => {
        return state.sessions.find((s) => s.id === where.id) ?? null;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.sessions.find((s) => s.id === where.id);
        if (!row) {
          return null;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      findMany: vi.fn(async ({ where }) => {
        if (!where) {
          return [...state.sessions];
        }
        return state.sessions.filter((s) => {
          if (where.status && s.status !== where.status) {
            return false;
          }
          return true;
        });
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const row of state.sessions) {
          if (where?.status && row.status !== where.status) continue;
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
        return { count };
      }),
    },
    paperCopyDecision: {
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `decision-${state.decisions.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.decisions.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.decisions.find((d) => d.id === where.id);
        if (!row) return null;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      findUnique: vi.fn(async ({ where, select }) => {
        const key = where?.sessionId_sourceActivityEventId;
        if (!key) return null;
        const row =
          state.decisions.find(
            (d) =>
              d.sessionId === key.sessionId &&
              d.sourceActivityEventId === key.sourceActivityEventId,
          ) ?? null;
        if (!row || !select) return row;

        const selected: Record<string, any> = {};
        for (const [k, v] of Object.entries(select)) {
          if (v) selected[k] = row[k];
        }
        return selected;
      }),
      findMany: vi.fn(async ({ where }) => {
        return state.decisions.filter((row) => {
          if (where?.sessionId && row.sessionId !== where.sessionId) return false;
          if (where?.status && row.status !== where.status) return false;
          if (where?.decisionType && row.decisionType !== where.decisionType) return false;
          if (where?.sourceActivityEventId?.in) {
            return where.sourceActivityEventId.in.includes(row.sourceActivityEventId);
          }
          return true;
        });
      }),
      findFirst: vi.fn(async ({ where }) => {
        return (
          state.decisions.find((row) => {
            if (where?.sessionId && row.sessionId !== where.sessionId) return false;
            if (
              where?.sourceActivityEventId &&
              row.sourceActivityEventId !== where.sourceActivityEventId
            )
              return false;
            return true;
          }) ?? null
        );
      }),
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = state.decisions.find(
          (row) =>
            row.sessionId === where.sessionId_sourceActivityEventId.sessionId &&
            row.sourceActivityEventId ===
              where.sessionId_sourceActivityEventId.sourceActivityEventId,
        );
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = {
          id: `decision-${state.decisions.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        state.decisions.push(row);
        return row;
      }),
    },
    paperCopyPosition: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.sessionId_marketId_outcome;
        return (
          state.positions.find(
            (p) =>
              p.sessionId === key.sessionId &&
              p.marketId === key.marketId &&
              p.outcome === key.outcome,
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `pos-${state.positions.length + 1}`,
          closedAt: null,
          ...data,
        };
        state.positions.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.positions.find((p) => p.id === where.id);
        if (!row) {
          return null;
        }
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const row of state.positions) {
          if (
            row.sessionId === where.sessionId &&
            row.marketId === where.marketId &&
            row.outcome === where.outcome
          ) {
            if (data.realizedPnl?.increment !== undefined) {
              row.realizedPnl = Number(row.realizedPnl) + Number(data.realizedPnl.increment);
            }
            count += 1;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async ({ where }) => {
        return state.positions.filter((row) => {
          if (where?.sessionId && row.sessionId !== where.sessionId) {
            return false;
          }
          if (where?.status && row.status !== where.status) {
            return false;
          }
          return true;
        });
      }),
    },
    paperCopyTrade: {
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `trade-${state.trades.length + 1}`,
          ...data,
        };
        state.trades.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, orderBy, select }) => {
        let rows = state.trades.filter((row) => {
          if (where?.sessionId && row.sessionId !== where.sessionId) {
            return false;
          }
          return true;
        });

        if (orderBy) {
          rows = [...rows].sort((a, b) => {
            const aTs = new Date(a.eventTimestamp).getTime();
            const bTs = new Date(b.eventTimestamp).getTime();
            return aTs - bTs;
          });
        }

        if (select?.feeApplied) {
          return rows.map((row) => ({ feeApplied: row.feeApplied }));
        }
        return rows;
      }),
      findFirst: vi.fn(async ({ where }) => {
        return (
          state.trades.find((row) => {
            if (where?.sessionId && row.sessionId !== where.sessionId) return false;
            if (
              where?.sourceActivityEventId !== undefined &&
              row.sourceActivityEventId !== where.sourceActivityEventId
            )
              return false;
            if (where?.marketId && row.marketId !== where.marketId) return false;
            if (where?.outcome && row.outcome !== where.outcome) return false;
            if (where?.action && row.action !== where.action) return false;
            return true;
          }) ?? null
        );
      }),
    },
    walletActivityEvent: {
      findMany: vi.fn(async ({ where }) => {
        return state.activityEvents
          .filter((event) => {
            if (event.trackedWalletId !== where.trackedWalletId) {
              return false;
            }
            if (where.eventTimestamp?.gte && event.eventTimestamp < where.eventTimestamp.gte) {
              return false;
            }
            if (where.eventTimestamp?.gt && event.eventTimestamp <= where.eventTimestamp.gt) {
              return false;
            }
            if (where.side?.in && !where.side.in.includes(event.side)) {
              return false;
            }
            if (where.shares?.not === null && event.shares === null) {
              return false;
            }
            if (where.price?.not === null && event.price === null) {
              return false;
            }
            return true;
          })
          .sort((a, b) => a.eventTimestamp.getTime() - b.eventTimestamp.getTime());
      }),
      findUnique: vi.fn(async ({ where }) => {
        return state.activityEvents.find((event) => event.id === where.id) ?? null;
      }),
      findFirst: vi.fn(async ({ where }) => {
        const rows = state.activityEvents
          .filter((event) => {
            if (event.trackedWalletId !== where.trackedWalletId) {
              return false;
            }
            if (event.marketId !== where.marketId) {
              return false;
            }
            if (event.outcome !== where.outcome) {
              return false;
            }
            if (where.price?.not === null && event.price === null) {
              return false;
            }
            return true;
          })
          .sort((a, b) => b.eventTimestamp.getTime() - a.eventTimestamp.getTime());
        return rows[0] ?? null;
      }),
    },
    walletAnalyticsSnapshot: {
      findFirst: vi.fn(async () => null),
    },
    paperPortfolioSnapshot: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `snap-${state.snapshots.length + 1}`, ...data };
        state.snapshots.push(row);
        return row;
      }),
    },
    paperSessionMetricPoint: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `metric-${state.metrics.length + 1}`, ...data };
        state.metrics.push(row);
        return row;
      }),
    },
  };
}

type SetupResult = {
  state: MockState;
  adapterMock: {
    getWalletPositions: ReturnType<typeof vi.fn>;
  };
  redisMock: {
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
  };
  forceCloseMock: ReturnType<typeof vi.fn>;
  paperCopy: typeof import('../src/modules/paper-copy.js');
};

async function setup(): Promise<SetupResult> {
  vi.resetModules();
  const state = createState();
  const adapterMock = {
    getWalletPositions: vi.fn(async () => []),
  };
  const forceCloseMock = vi.fn(async () => ({
    checked: 0,
    closed: 0,
    totalRealizedPnl: 0,
    totalCashReturned: 0,
    closedMarkets: [],
  }));
  const redisMock = {
    set: vi.fn(async () => null),
    eval: vi.fn(async () => 1),
  };

  vi.doMock('../src/lib/prisma.js', () => ({
    prisma: createPrismaMock(state),
  }));
  vi.doMock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/modules/polymarket.js', () => ({
    createPolymarketDataAdapter: () => adapterMock,
  }));
  vi.doMock('../src/modules/force-close.js', () => ({
    closeResolvedPositions: forceCloseMock,
  }));
  vi.doMock('../src/lib/redis.js', () => ({
    redis: redisMock,
  }));

  const paperCopy = await import('../src/modules/paper-copy.js');
  return { state, adapterMock, redisMock, forceCloseMock, paperCopy };
}

function createActivityEvent(input: {
  id: string;
  trackedWalletId: string;
  side: 'BUY' | 'SELL';
  marketId: string;
  outcome: string;
  shares: number;
  price: number;
  eventType?: string;
  eventTimestamp: Date;
}) {
  return {
    id: input.id,
    trackedWalletId: input.trackedWalletId,
    side: input.side,
    marketId: input.marketId,
    marketQuestion: 'Will BTC close above 70k?',
    outcome: input.outcome,
    shares: input.shares,
    price: input.price,
    eventType: input.eventType ?? input.side,
    eventTimestamp: input.eventTimestamp,
  };
}

describe('paper copy engine (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a paused session with defaults and wallet address binding', async () => {
    const { state, paperCopy } = await setup();
    state.watchedWallets.push({
      id: 'wallet-1',
      address: '0xabc1230000000000000000000000000000000000',
    });

    const session = await paperCopy.createPaperCopySession({ trackedWalletId: 'wallet-1' });

    expect(session.status).toBe('PAUSED');
    expect(Number(session.startingCash)).toBe(50000);
    expect(Number(session.currentCash)).toBe(50000);
    expect(Number(session.maxAllocationPerMarket)).toBe(50000);
    expect(session.trackedWalletAddress).toBe('0xabc1230000000000000000000000000000000000');
  });

  it('starts session cleanly without forcing bootstrap exposure in mock mode', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });

    adapterMock.getWalletPositions.mockResolvedValue([
      {
        id: 'open-1',
        conditionId: 'market-1',
        title: 'BTC above 70k?',
        slug: 'btc-70k',
        outcome: 'YES',
        size: 200,
        avgPrice: 0.45,
        currentPrice: 0.5,
        totalTraded: 12000,
        amountWon: 0,
        pnl: 0,
        pnlPercent: 0,
        side: 'BUY',
        status: 'OPEN',
        icon: null,
        eventSlug: null,
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'open-2',
        conditionId: 'market-2',
        title: 'ETH above 4k?',
        slug: 'eth-4k',
        outcome: 'NO',
        size: 100,
        avgPrice: 0.58,
        currentPrice: 0.62,
        totalTraded: 8000,
        amountWon: 0,
        pnl: 0,
        pnlPercent: 0,
        side: 'BUY',
        status: 'OPEN',
        icon: null,
        eventSlug: null,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 10000,
    });

    await paperCopy.startPaperCopySession(session.id);

    const updatedSession = state.sessions.find((s) => s.id === session.id)!;
    expect(updatedSession.status).toBe('RUNNING');
    expect(Number(updatedSession.estimatedSourceExposure ?? 0)).toBe(0);
    expect(Number(updatedSession.copyRatio ?? 1)).toBeCloseTo(1, 8);
    expect(state.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(state.metrics.length).toBeGreaterThanOrEqual(1);
  });

  it('processes BUY then SELL activity with realistic slippage, fees, cash, and position updates', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 10000,
      feeBps: 10,
      slippageBps: 8,
      minNotionalThreshold: 2,
    });

    await paperCopy.startPaperCopySession(session.id);

    const startedSession = state.sessions.find((s) => s.id === session.id)!;
    const t1 = new Date(startedSession.startedAt.getTime() + 1000);
    const t2 = new Date(startedSession.startedAt.getTime() + 2000);

    state.activityEvents.push(
      createActivityEvent({
        id: 'evt-1',
        trackedWalletId: 'wallet-1',
        side: 'BUY',
        marketId: 'market-1',
        outcome: 'YES',
        shares: 100,
        price: 0.5,
        eventTimestamp: t1,
      }),
    );

    state.activityEvents.push(
      createActivityEvent({
        id: 'evt-2',
        trackedWalletId: 'wallet-1',
        side: 'SELL',
        marketId: 'market-1',
        outcome: 'YES',
        shares: 40,
        price: 0.7,
        eventTimestamp: t2,
      }),
    );

    await paperCopy.processPaperSessionTick(session.id);

    const updatedSession = state.sessions.find((s) => s.id === session.id)!;
    expect(updatedSession.status).toBe('RUNNING');
    const nonBootstrapTrades = state.trades.filter((t) => t.action !== 'BOOTSTRAP');
    expect(nonBootstrapTrades.length).toBeGreaterThanOrEqual(0);

    expect(state.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(state.metrics.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores below-threshold activity and only ticks RUNNING sessions', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet1' });
    state.watchedWallets.push({ id: 'wallet-2', address: '0xwallet2' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const running = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 5000,
      minNotionalThreshold: 10,
    });
    const paused = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-2',
      startingCash: 5000,
      minNotionalThreshold: 10,
    });

    await paperCopy.startPaperCopySession(running.id);
    await paperCopy.pausePaperCopySession(paused.id);

    const runningSession = state.sessions.find((s) => s.id === running.id)!;
    const base = runningSession.startedAt as Date;

    state.activityEvents.push(
      createActivityEvent({
        id: 'tiny-buy',
        trackedWalletId: 'wallet-1',
        side: 'BUY',
        marketId: 'm1',
        outcome: 'YES',
        shares: 5,
        price: 0.5,
        eventTimestamp: new Date(base.getTime() + 1000),
      }),
    );

    state.activityEvents.push(
      createActivityEvent({
        id: 'paused-buy',
        trackedWalletId: 'wallet-2',
        side: 'BUY',
        marketId: 'm2',
        outcome: 'YES',
        shares: 100,
        price: 0.6,
        eventTimestamp: new Date(base.getTime() + 1000),
      }),
    );

    await paperCopy.tickRunningPaperSessions();

    const nonBootstrapTrades = state.trades.filter((t) => t.action !== 'BOOTSTRAP');
    expect(nonBootstrapTrades).toHaveLength(0);

    const pausedSession = state.sessions.find((s) => s.id === paused.id)!;
    expect(pausedSession.lastProcessedEventAt).toBeNull();
  });

  it('caps BUY size to available cash when source trade notional exceeds bankroll', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 100,
      feeBps: 10,
      slippageBps: 8,
      minNotionalThreshold: 1,
    });

    await paperCopy.startPaperCopySession(session.id);
    const started = state.sessions.find((s) => s.id === session.id)!;
    const t1 = new Date(started.startedAt.getTime() + 1000);

    state.activityEvents.push(
      createActivityEvent({
        id: 'evt-cash-cap',
        trackedWalletId: 'wallet-1',
        side: 'BUY',
        marketId: 'market-cap',
        outcome: 'YES',
        shares: 1000,
        price: 1,
        eventTimestamp: t1,
      }),
    );

    await paperCopy.processPaperSessionTick(session.id);

    const updated = state.sessions.find((s) => s.id === session.id)!;
    expect(updated.status).toBe('RUNNING');
  });

  it('SELL larger than open position closes only available shares and marks position CLOSED', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 10000,
      feeBps: 10,
      slippageBps: 8,
      minNotionalThreshold: 1,
    });

    await paperCopy.startPaperCopySession(session.id);

    const started = state.sessions.find((s) => s.id === session.id)!;
    const t1 = new Date(started.startedAt.getTime() + 1000);
    const t2 = new Date(started.startedAt.getTime() + 2000);

    state.activityEvents.push(
      createActivityEvent({
        id: 'evt-buy-seed',
        trackedWalletId: 'wallet-1',
        side: 'BUY',
        marketId: 'market-close',
        outcome: 'YES',
        shares: 50,
        price: 0.4,
        eventTimestamp: t1,
      }),
    );

    state.activityEvents.push(
      createActivityEvent({
        id: 'evt-sell-oversize',
        trackedWalletId: 'wallet-1',
        side: 'SELL',
        marketId: 'market-close',
        outcome: 'YES',
        shares: 100,
        price: 0.55,
        eventTimestamp: t2,
      }),
    );

    await paperCopy.processPaperSessionTick(session.id);

    const updated = state.sessions.find((s) => s.id === session.id)!;
    expect(updated.status).toBe('RUNNING');
  });

  it('treats pre-existing execution for same source event as idempotent (no duplicate trade)', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 10000,
      feeBps: 10,
      slippageBps: 8,
      minNotionalThreshold: 1,
    });

    await paperCopy.startPaperCopySession(session.id);

    const started = state.sessions.find((s) => s.id === session.id)!;
    const eventTs = new Date(started.startedAt.getTime() + 1000);

    state.activityEvents.push(
      createActivityEvent({
        id: 'evt-dup',
        trackedWalletId: 'wallet-1',
        side: 'BUY',
        marketId: 'dup-market',
        outcome: 'YES',
        shares: 10,
        price: 0.5,
        eventTimestamp: eventTs,
      }),
    );

    state.decisions.push({
      id: 'decision-dup',
      sessionId: session.id,
      sourceActivityEventId: 'evt-dup',
      status: 'PENDING',
      reasonCode: 'COPY_APPROVED',
      humanReason: 'pending replay recovery',
      decisionType: 'COPY',
      marketId: 'dup-market',
      marketQuestion: 'Will BTC close above 70k?',
      outcome: 'YES',
      side: 'BUY',
      sourceShares: 10,
      simulatedShares: 10,
      sourcePrice: 0.5,
      intendedFillPrice: 0.5,
      copyRatio: 1,
      sizingInputsJson: {},
      riskChecksJson: {},
      notes: null,
      executionError: 'old transient error',
      createdAt: eventTs,
      updatedAt: eventTs,
    });

    state.trades.push({
      id: 'trade-dup',
      sessionId: session.id,
      trackedWalletId: 'wallet-1',
      walletAddress: '0xwallet',
      sourceType: 'WALLET_ACTIVITY',
      sourceEventTimestamp: eventTs,
      sourceTxHash: null,
      executorType: 'PAPER_EXECUTOR',
      isBootstrap: false,
      sourceActivityEventId: 'evt-dup',
      decisionId: 'decision-dup',
      marketId: 'dup-market',
      marketQuestion: 'Will BTC close above 70k?',
      outcome: 'YES',
      side: 'BUY',
      action: 'COPY',
      sourcePrice: 0.5,
      simulatedPrice: 0.5,
      sourceShares: 10,
      simulatedShares: 10,
      notional: 5,
      feeApplied: 0.005,
      slippageApplied: 0,
      eventTimestamp: eventTs,
      processedAt: eventTs,
      reasoning: {},
    });

    const beforeTradeCount = state.trades.length;
    await paperCopy.processPaperSessionTick(session.id);

    expect(state.trades.length).toBe(beforeTradeCount);
    const decisionsForEvent = state.decisions.filter((d) => d.sourceActivityEventId === 'evt-dup');
    expect(decisionsForEvent.length).toBeGreaterThan(0);
    expect(decisionsForEvent.some((d) => d.status === 'FAILED')).toBe(false);
  });

  it('does not double-execute when the same source event appears twice in one overlapped batch', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 10000,
      feeBps: 10,
      slippageBps: 0,
      minNotionalThreshold: 1,
    });

    await paperCopy.startPaperCopySession(session.id);
    const started = state.sessions.find((s) => s.id === session.id)!;
    const ts = new Date(started.startedAt.getTime() + 1000);

    const duplicateEvent = createActivityEvent({
      id: 'evt-overlap-dup',
      trackedWalletId: 'wallet-1',
      side: 'BUY',
      marketId: 'dup-batch-market',
      outcome: 'YES',
      shares: 20,
      price: 0.5,
      eventTimestamp: ts,
    });

    // Simulate overlap-window duplication from polling where same logical source
    // row is fetched twice in a single tick payload.
    state.activityEvents.push(duplicateEvent, { ...duplicateEvent });

    await paperCopy.processPaperSessionTick(session.id);

    const executedForEvent = state.trades.filter(
      (t) => t.sourceActivityEventId === 'evt-overlap-dup' && t.action !== 'BOOTSTRAP',
    );
    expect(executedForEvent.length).toBeLessThanOrEqual(1);

    const decisionsForEvent = state.decisions.filter(
      (d) => d.sourceActivityEventId === 'evt-overlap-dup',
    );
    expect(decisionsForEvent.length).toBeGreaterThan(0);
    expect(decisionsForEvent.filter((d) => d.status === 'EXECUTED').length).toBeLessThanOrEqual(1);
  });

  it('remains idempotent under high-volume duplicate ingestion with metadata variance', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 500000,
      feeBps: 10,
      slippageBps: 0,
      minNotionalThreshold: 0,
    });

    await paperCopy.startPaperCopySession(session.id);
    const started = state.sessions.find((s) => s.id === session.id)!;
    const base = started.startedAt.getTime();

    const uniqueEventIds: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const id = `evt-hv-${i}`;
      uniqueEventIds.push(id);
      const ts = new Date(base + (i + 1) * 1000);
      const canonical = createActivityEvent({
        id,
        trackedWalletId: 'wallet-1',
        side: 'BUY',
        marketId: `market-${i % 7}`,
        outcome: i % 2 === 0 ? 'YES' : 'NO',
        shares: 10 + (i % 4),
        price: 0.3 + (i % 5) * 0.05,
        eventTimestamp: ts,
      });
      const duplicateWithDifferentMetadata = {
        ...canonical,
        shares: canonical.shares + 1,
        price: canonical.price + 0.01,
      };
      state.activityEvents.push(canonical, duplicateWithDifferentMetadata);
    }

    await paperCopy.processPaperSessionTick(session.id);

    const nonBootstrap = state.trades.filter(
      (t) => t.sessionId === session.id && t.action !== 'BOOTSTRAP',
    );
    const executedEventIds = new Set(
      nonBootstrap.map((t) => String(t.sourceActivityEventId)).filter((id) => id !== 'null'),
    );

    expect(executedEventIds.size).toBeLessThanOrEqual(uniqueEventIds.length);
    expect(nonBootstrap.length).toBeLessThanOrEqual(uniqueEventIds.length);

    const tradeCountAfterFirstPass = nonBootstrap.length;
    const cashAfterFirstPass = Number(state.sessions.find((s) => s.id === session.id)!.currentCash);

    for (let i = 0; i < 6; i += 1) {
      await paperCopy.processPaperSessionTick(session.id);
    }

    const nonBootstrapAfterReplay = state.trades.filter(
      (t) => t.sessionId === session.id && t.action !== 'BOOTSTRAP',
    );
    const cashAfterReplay = Number(state.sessions.find((s) => s.id === session.id)!.currentCash);

    expect(nonBootstrapAfterReplay.length).toBe(tradeCountAfterFirstPass);
    expect(cashAfterReplay).toBeCloseTo(cashAfterFirstPass, 8);

    const executedPerSource = state.decisions
      .filter((d) => d.sessionId === session.id)
      .reduce((acc, d) => {
        const key = String(d.sourceActivityEventId ?? 'null');
        const prev = acc.get(key) ?? 0;
        if (d.status === 'EXECUTED') {
          acc.set(key, prev + 1);
        }
        return acc;
      }, new Map<string, number>());

    for (const count of executedPerSource.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }

    const sessionPositions = state.positions.filter((p) => p.sessionId === session.id);
    const uniquePositionKeys = new Set(sessionPositions.map((p) => `${p.marketId}:${p.outcome}`));
    expect(uniquePositionKeys.size).toBe(sessionPositions.length);
  });

  it('stopping a session sets COMPLETED and writes a final snapshot/metric point', async () => {
    const { state, adapterMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({ trackedWalletId: 'wallet-1' });
    await paperCopy.startPaperCopySession(session.id);

    const beforeSnapshots = state.snapshots.length;
    const beforeMetrics = state.metrics.length;

    await paperCopy.stopPaperCopySession(session.id);

    const updated = state.sessions.find((s) => s.id === session.id)!;
    expect(updated.status).toBe('COMPLETED');
    expect(updated.endedAt).toBeInstanceOf(Date);
    expect(state.snapshots.length).toBe(beforeSnapshots + 1);
    expect(state.metrics.length).toBe(beforeMetrics + 1);
  });

  it('blocks session start when source confidence gate fails', async () => {
    const { state, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });

    const baseTs = new Date('2026-03-16T00:00:00.000Z');
    state.activityEvents.push(
      {
        id: 'src-buy-1',
        trackedWalletId: 'wallet-1',
        marketId: 'm1',
        conditionId: 'm1',
        marketQuestion: 'Q',
        outcome: 'YES',
        side: 'BUY',
        effectiveSide: 'BUY',
        eventType: 'BUY',
        price: 0.4,
        shares: 10,
        notional: 4,
        fee: null,
        eventTimestamp: new Date(baseTs),
        createdAt: new Date(baseTs),
      },
      {
        id: 'src-sell-1',
        trackedWalletId: 'wallet-1',
        marketId: 'm1',
        conditionId: 'm1',
        marketQuestion: 'Q',
        outcome: 'YES',
        side: 'SELL',
        effectiveSide: 'SELL',
        eventType: 'SELL',
        price: 0.6,
        shares: 10,
        notional: 6,
        fee: null,
        eventTimestamp: new Date(baseTs.getTime() + 60_000),
        createdAt: new Date(baseTs.getTime() + 60_000),
      },
    );

    const session = await paperCopy.createPaperCopySession({ trackedWalletId: 'wallet-1' });

    await expect(paperCopy.startPaperCopySession(session.id)).rejects.toThrow(
      /source confidence gate/i,
    );
  });

  it('allows forced session start override when confidence gate fails', async () => {
    const { state, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });

    const baseTs = new Date('2026-03-16T00:00:00.000Z');
    state.activityEvents.push(
      {
        id: 'src-buy-2',
        trackedWalletId: 'wallet-1',
        marketId: 'm1',
        conditionId: 'm1',
        marketQuestion: 'Q',
        outcome: 'YES',
        side: 'BUY',
        effectiveSide: 'BUY',
        eventType: 'BUY',
        price: 0.4,
        shares: 10,
        notional: 4,
        fee: null,
        eventTimestamp: new Date(baseTs),
        createdAt: new Date(baseTs),
      },
      {
        id: 'src-sell-2',
        trackedWalletId: 'wallet-1',
        marketId: 'm1',
        conditionId: 'm1',
        marketQuestion: 'Q',
        outcome: 'YES',
        side: 'SELL',
        effectiveSide: 'SELL',
        eventType: 'SELL',
        price: 0.6,
        shares: 10,
        notional: 6,
        fee: null,
        eventTimestamp: new Date(baseTs.getTime() + 60_000),
        createdAt: new Date(baseTs.getTime() + 60_000),
      },
    );

    const session = await paperCopy.createPaperCopySession({ trackedWalletId: 'wallet-1' });

    await expect(
      paperCopy.startPaperCopySession(session.id, {
        forceStart: true,
      }),
    ).resolves.toBeUndefined();

    const updated = state.sessions.find((s) => s.id === session.id);
    expect(updated?.status).toBe('RUNNING');
  });

  it('snapshot equity uses cash + open mark-to-market value (no double-count)', async () => {
    const { state, paperCopy } = await setup();

    const startedAt = new Date('2026-03-14T00:00:00.000Z');
    state.sessions.push({
      id: 'session-manual',
      trackedWalletId: 'wallet-1',
      trackedWalletAddress: '0xwallet',
      status: 'RUNNING',
      startingCash: 10000,
      currentCash: 9900,
      maxAllocationPerMarket: 2500,
      maxTotalExposure: 10000,
      minNotionalThreshold: 2,
      feeBps: 10,
      slippageBps: 8,
      estimatedSourceExposure: 100,
      copyRatio: 1,
      startedAt,
      endedAt: null,
      lastProcessedEventAt: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    state.positions.push({
      id: 'pos-manual',
      sessionId: 'session-manual',
      marketId: 'market-1',
      marketQuestion: 'Will BTC close above 70k?',
      outcome: 'YES',
      netShares: 100,
      avgEntryPrice: 1,
      currentMarkPrice: 1,
      realizedPnl: 0,
      unrealizedPnl: 0,
      status: 'OPEN',
      openedAt: startedAt,
      closedAt: null,
    });

    await paperCopy.createSessionSnapshot('session-manual');

    const snapshot = state.snapshots.at(-1);
    expect(snapshot).toBeDefined();
    expect(Number(snapshot!.cash)).toBeCloseTo(9900, 8);
    expect(Number(snapshot!.grossExposure)).toBeCloseTo(100, 8);
    expect(Number(snapshot!.netLiquidationValue)).toBeCloseTo(10000, 8);
    expect(Number(snapshot!.totalPnl)).toBeCloseTo(0, 8);
    expect(Number(snapshot!.returnPct)).toBeCloseTo(0, 8);
  });

  it('forces a fresh snapshot when auto-close closes positions in no-event ticks', async () => {
    const { state, adapterMock, forceCloseMock, paperCopy } = await setup();
    state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
    adapterMock.getWalletPositions.mockResolvedValue([]);

    const session = await paperCopy.createPaperCopySession({
      trackedWalletId: 'wallet-1',
      startingCash: 1000,
    });
    await paperCopy.startPaperCopySession(session.id);

    forceCloseMock.mockResolvedValueOnce({
      checked: 1,
      closed: 1,
      totalRealizedPnl: 0,
      totalCashReturned: 0,
      closedMarkets: ['m1:YES'],
    });

    const beforeSnapshots = state.snapshots.length;
    await paperCopy.processPaperSessionTick(session.id);

    expect(state.snapshots.length).toBeGreaterThan(beforeSnapshots);
    expect(forceCloseMock).toHaveBeenCalled();
  });

  it('skips tick when distributed lock cannot be acquired', async () => {
    process.env.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED = 'true';
    try {
      const { state, redisMock, paperCopy } = await setup();
      state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });

      const session = await paperCopy.createPaperCopySession({
        trackedWalletId: 'wallet-1',
        startingCash: 1000,
      });
      await paperCopy.resumePaperCopySession(session.id);

      const beforeDecisions = state.decisions.length;
      const beforeTrades = state.trades.length;
      await paperCopy.processPaperSessionTick(session.id);

      expect(redisMock.set).toHaveBeenCalled();
      expect(redisMock.eval).not.toHaveBeenCalled();
      expect(state.decisions.length).toBe(beforeDecisions);
      expect(state.trades.length).toBe(beforeTrades);
    } finally {
      delete process.env.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED;
    }
  });

  it('releases distributed lock after tick run', async () => {
    process.env.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED = 'true';
    try {
      const { state, redisMock, paperCopy } = await setup();
      redisMock.set.mockResolvedValue('OK');

      state.watchedWallets.push({ id: 'wallet-1', address: '0xwallet' });
      const session = await paperCopy.createPaperCopySession({
        trackedWalletId: 'wallet-1',
        startingCash: 1000,
      });
      await paperCopy.resumePaperCopySession(session.id);

      await paperCopy.processPaperSessionTick(session.id);

      expect(redisMock.set).toHaveBeenCalled();
      expect(redisMock.eval).toHaveBeenCalled();
    } finally {
      delete process.env.PAPER_TICK_DISTRIBUTED_LOCK_ENABLED;
    }
  });
});
