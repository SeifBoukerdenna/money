import { describe, expect, it, vi } from 'vitest';

describe('force-close lock hardening', () => {
  it('skips overlapping closeResolvedPositions calls for the same session', async () => {
    vi.resetModules();

    let releaseFirstCall: () => void = () => {};
    const firstCallGate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });

    const sessionFindUnique = vi.fn(async () => {
      await firstCallGate;
      return {
        id: 's1',
        trackedWalletId: 'w1',
        trackedWalletAddress: '0xwallet',
        feeBps: 200,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
    });

    vi.doMock('../src/lib/prisma.js', () => ({
      prisma: {
        paperCopySession: {
          findUnique: sessionFindUnique,
        },
        paperCopyPosition: {
          findMany: vi.fn(async () => []),
        },
        walletActivityEvent: {
          findMany: vi.fn(async () => []),
        },
        paperCopyTrade: {
          create: vi.fn(async () => null),
        },
      },
    }));

    vi.doMock('../src/lib/logger.js', () => ({
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    vi.doMock('../src/modules/polymarket.js', () => ({
      createPolymarketDataAdapter: () => ({
        getWalletPositions: vi.fn(async () => []),
      }),
    }));

    vi.doMock('../src/modules/profile-parity-routes.js', () => ({
      deriveClosedPositionsFromDb: vi.fn(async () => []),
    }));

    vi.doMock('../src/modules/paper-accounting.js', () => ({
      materializePaperSessionState: vi.fn(async () => null),
    }));

    const { closeResolvedPositions } = await import('../src/modules/force-close.js');

    const inFlight = closeResolvedPositions('s1');
    // Give the first call a tick to acquire lock and block in mocked DB call.
    await Promise.resolve();

    const overlapped = await closeResolvedPositions('s1');
    expect(overlapped.skipped).toBe(true);
    expect(overlapped.closed).toBe(0);

    releaseFirstCall();
    const first = await inFlight;

    expect(first.skipped).toBeUndefined();
    expect(first.checked).toBe(0);
    expect(first.closed).toBe(0);
    expect(sessionFindUnique).toHaveBeenCalledTimes(1);
  });
});
