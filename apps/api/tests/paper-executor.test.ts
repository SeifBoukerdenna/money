import { beforeEach, describe, expect, it, vi } from 'vitest';

type TradeRow = {
  id: string;
  sessionId: string;
  sourceActivityEventId: string | null;
};

function createPrismaMock(state: { trades: TradeRow[]; duplicateOnCreate: boolean }) {
  return {
    paperCopyTrade: {
      create: vi.fn(async ({ data }) => {
        if (state.duplicateOnCreate) {
          const err = new Error(
            'Unique constraint failed on the fields: (`sessionId`,`sourceActivityEventId`)',
          ) as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }

        const row: TradeRow = {
          id: `trade-${state.trades.length + 1}`,
          sessionId: String(data.sessionId),
          sourceActivityEventId: data.sourceActivityEventId
            ? String(data.sourceActivityEventId)
            : null,
        };
        state.trades.push(row);
        return { id: row.id };
      }),
      findFirst: vi.fn(async ({ where }) => {
        return (
          state.trades.find(
            (t) =>
              t.sessionId === where.sessionId &&
              t.sourceActivityEventId === where.sourceActivityEventId,
          ) ?? null
        );
      }),
    },
  };
}

describe('paper-executor idempotency', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('executes SELL at zero price for worthless close events', async () => {
    const state = {
      trades: [] as TradeRow[],
      duplicateOnCreate: false,
    };

    vi.doMock('../src/lib/prisma.js', () => ({
      prisma: createPrismaMock(state),
    }));

    const { resolvePaperExecutor } = await import('../src/modules/paper-executor.js');
    const executor = resolvePaperExecutor('PAPER');

    const result = await executor.execute({
      session: {
        id: 's1',
        trackedWalletId: 'w1',
        trackedWalletAddress: '0xw',
        feeBps: 200,
        slippageBps: 20,
      } as any,
      decision: {
        id: 'd-zero',
        status: 'PENDING',
        decisionType: 'CLOSE',
        reasonCode: 'CLOSE_ON_SOURCE_EXIT',
        humanReason: 'worthless close',
        sourceActivityEventId: 'evt-zero',
        marketId: 'm1',
        outcome: 'YES',
        side: 'SELL',
        intendedFillPrice: 0,
        simulatedShares: 10,
        sourcePrice: 0,
      },
    });

    expect(result.status).toBe('EXECUTED');
    expect(result.fillPrice).toBe(0);
    expect(result.fillShares).toBe(10);
    expect(result.cashDelta).toBe(0);
    expect(result.tradeId).toBeTruthy();
  });

  it('returns EXECUTED idempotently on duplicate source-event insert conflict', async () => {
    const state = {
      trades: [{ id: 'trade-existing', sessionId: 's1', sourceActivityEventId: 'evt-1' }],
      duplicateOnCreate: true,
    };

    vi.doMock('../src/lib/prisma.js', () => ({
      prisma: createPrismaMock(state),
    }));

    const { resolvePaperExecutor } = await import('../src/modules/paper-executor.js');
    const executor = resolvePaperExecutor('PAPER');

    const result = await executor.execute({
      session: {
        id: 's1',
        trackedWalletId: 'w1',
        trackedWalletAddress: '0xw',
        feeBps: 200,
        slippageBps: 20,
      } as any,
      decision: {
        id: 'd1',
        status: 'PENDING',
        decisionType: 'COPY',
        reasonCode: 'COPY_APPROVED',
        humanReason: 'copy',
        sourceActivityEventId: 'evt-1',
        marketId: 'm1',
        outcome: 'YES',
        side: 'BUY',
        intendedFillPrice: 0.5,
        simulatedShares: 10,
        sourcePrice: 0.5,
      },
    });

    expect(result.status).toBe('EXECUTED');
    expect(result.tradeId).toBe('trade-existing');
    expect(result.cashDelta).toBe(0);
    expect(result.fillShares).toBe(0);
  });

  it('returns FAILED on non-duplicate insert errors', async () => {
    const state = {
      trades: [] as TradeRow[],
      duplicateOnCreate: false,
    };

    const prisma = {
      paperCopyTrade: {
        create: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
        findFirst: vi.fn(async () => null),
      },
    };

    vi.doMock('../src/lib/prisma.js', () => ({ prisma }));

    const { resolvePaperExecutor } = await import('../src/modules/paper-executor.js');
    const executor = resolvePaperExecutor('PAPER');

    const result = await executor.execute({
      session: {
        id: 's1',
        trackedWalletId: 'w1',
        trackedWalletAddress: '0xw',
        feeBps: 200,
        slippageBps: 20,
      } as any,
      decision: {
        id: 'd1',
        status: 'PENDING',
        decisionType: 'COPY',
        reasonCode: 'COPY_APPROVED',
        humanReason: 'copy',
        sourceActivityEventId: 'evt-1',
        marketId: 'm1',
        outcome: 'YES',
        side: 'BUY',
        intendedFillPrice: 0.5,
        simulatedShares: 10,
        sourcePrice: 0.5,
      },
    });

    expect(result.status).toBe('FAILED');
    expect(result.reasonCode).toBe('EXECUTION_FAILED_INSERT');
  });
});
