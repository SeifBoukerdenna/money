import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('GET /paper-copy-sessions/:id/analytics contract', () => {
  it('returns sourceComparison with ratio and pct fields and no legacy alias', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const trackedWalletId = '22222222-2222-4222-8222-222222222222';

    const prismaMock = {
      paperCopySession: {
        findUnique: vi.fn(async () => ({
          id: sessionId,
          trackedWalletId,
          createdAt: new Date('2026-03-10T00:00:00.000Z'),
          startedAt: new Date('2026-03-11T00:00:00.000Z'),
        })),
      },
      paperCopyPosition: {
        findMany: vi.fn(async () => [
          { realizedPnl: 120 },
          { realizedPnl: -20 },
          { realizedPnl: 0 },
        ]),
      },
    };

    vi.doMock('../src/lib/prisma.js', () => ({
      prisma: prismaMock,
    }));

    vi.doMock('../src/modules/polymarket.js', () => ({
      createPolymarketDataAdapter: () => ({}),
    }));

    vi.doMock('../src/modules/queue.js', () => ({
      ingestQueue: { getWaitingCount: vi.fn(async () => 0), add: vi.fn(async () => ({})) },
      decisionQueue: { getWaitingCount: vi.fn(async () => 0), add: vi.fn(async () => ({})) },
      executionQueue: { getWaitingCount: vi.fn(async () => 0), add: vi.fn(async () => ({})) },
      createWorker: vi.fn(),
    }));

    vi.doMock('../src/modules/paper-copy.js', () => ({
      createPaperCopySession: vi.fn(),
      deletePaperCopySession: vi.fn(),
      getPaperCopySessionAnalytics: vi.fn(async () => ({
        id: sessionId,
        status: 'RUNNING',
      })),
      getSessionHealth: vi.fn(),
      killAllPaperSessions: vi.fn(),
      pausePaperCopySession: vi.fn(),
      reconcilePaperSessionPositions: vi.fn(),
      repairPaperCopySession: vi.fn(),
      resumePaperCopySession: vi.fn(),
      startPaperCopySession: vi.fn(),
      stopPaperCopySession: vi.fn(),
      updatePaperCopySessionGuardrails: vi.fn(),
    }));

    vi.doMock('../src/modules/profile-parity-routes.js', () => ({
      calculateWalletPnlSummary: vi.fn(async () => ({
        walletId: trackedWalletId,
        range: 'ALL',
        since: null,
        from: null,
        to: null,
        netPnl: 250,
        totalWon: 400,
        totalLost: 150,
        totalVolumeTraded: 3000,
        tradeCount: 10,
        winCount: 6,
        lossCount: 4,
        winRate: 0.6,
        winRatePct: 60,
      })),
      deriveClosedPositionsFromDb: vi.fn(),
      registerProfileParityRoutes: vi.fn(),
    }));

    vi.doMock('../src/modules/event-stream.js', () => ({
      eventBus: { on: vi.fn(), off: vi.fn() },
      loadRecentEvents: vi.fn(async () => []),
    }));

    vi.doMock('../src/modules/runtime-ops.js', () => ({
      getRuntimeOpsSnapshot: vi.fn(async () => ({})),
    }));

    vi.doMock('../src/modules/latency-profile.js', () => ({
      getLatencyProfileState: vi.fn(() => ({})),
      setLatencyProfile: vi.fn(),
    }));

    vi.doMock('../src/modules/ingestion.js', () => ({
      scheduleWalletPolls: vi.fn(),
      processWalletPoll: vi.fn(),
    }));

    vi.doMock('../src/modules/market-intelligence.js', () => ({
      getLatestMarketIntelligence: vi.fn(async () => []),
    }));

    vi.doMock('../src/modules/paper-executor.js', () => ({
      resolvePaperExecutor: vi.fn(() => ({ id: 'mock-executor' })),
    }));

    vi.doMock('../src/modules/paper-accounting.js', () => ({
      materializePaperSessionState: vi.fn(async () => ({ positions: [], closedPositions: [] })),
    }));

    vi.doMock('../src/modules/reconciliation.js', () => ({
      reconcileWalletExposure: vi.fn(),
    }));

    vi.doMock('../src/modules/wallet-input.js', () => ({
      resolveWalletAddress: vi.fn(async (input: string) => input),
      shortenAddress: vi.fn((input: string) => input),
    }));

    vi.doMock('../src/modules/wallet-analytics.js', () => ({
      getWalletLeaderboard: vi.fn(async () => []),
    }));

    vi.doMock('../src/modules/force-close-routes.js', () => ({
      registerForceCloseRoutes: vi.fn(),
    }));

    vi.doMock('../src/modules/system-alerts.js', () => ({
      listSystemAlerts: vi.fn(async () => []),
      raiseSystemAlert: vi.fn(async () => ({})),
    }));

    vi.doMock('../src/modules/profile-parity.js', () => ({
      buildProfileSummary: vi.fn(async () => ({})),
    }));

    vi.doMock('../src/paper-session-market-routes.js', () => ({
      registerPaperSessionMarketRoutes: vi.fn(),
    }));

    const { registerRoutes } = await import('../src/routes.js');

    const app = Fastify();
    await app.register(sensible);
    await registerRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: `/paper-copy-sessions/${sessionId}/analytics`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.sourceComparison.sourceWinRate).toBeCloseTo(0.6, 10);
    expect(body.sourceComparison.sourceWinRatePct).toBeCloseTo(60, 10);
    expect(body.sourceComparison.paperWinRate).toBeCloseTo(0.5, 10);
    expect(body.sourceComparison.paperWinRatePct).toBeCloseTo(50, 10);
    expect(body.sourceComparison.sourceNetPnl).toBe(250);
    expect(body.sourceComparison.paperRealizedPnl).toBe(100);
    expect(body.sourceComparison).not.toHaveProperty('sourceRealizedPnl');

    await app.close();
  });
});
