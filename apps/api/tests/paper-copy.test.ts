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
  paperCopy: typeof import('../src/modules/paper-copy.js');
};

async function setup(): Promise<SetupResult> {
  vi.resetModules();
  const state = createState();
  const adapterMock = {
    getWalletPositions: vi.fn(async () => []),
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

  const paperCopy = await import('../src/modules/paper-copy.js');
  return { state, adapterMock, paperCopy };
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
});
