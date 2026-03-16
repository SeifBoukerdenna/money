import { describe, expect, it, vi } from 'vitest';

type TradeRow = {
  id: string;
  sessionId: string;
  marketId: string;
  marketQuestion: string | null;
  outcome: string;
  side: 'BUY' | 'SELL';
  action: string;
  simulatedPrice: number;
  simulatedShares: number;
  feeApplied: number;
  eventTimestamp: Date;
};

function buildRows(count: number): TradeRow[] {
  const rows: TradeRow[] = [];
  const baseTs = new Date('2026-03-16T00:00:00.000Z').getTime();
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `b-${i}`,
      sessionId: 'session-1',
      marketId: `m-${i}`,
      marketQuestion: 'Q',
      outcome: 'YES',
      side: 'BUY',
      action: 'COPY',
      simulatedPrice: 0.001,
      simulatedShares: 1,
      feeApplied: 0,
      eventTimestamp: new Date(baseTs + i * 2000),
    });
    rows.push({
      id: `s-${i}`,
      sessionId: 'session-1',
      marketId: `m-${i}`,
      marketQuestion: 'Q',
      outcome: 'YES',
      side: 'SELL',
      action: 'CLOSE',
      simulatedPrice: 0.0019,
      simulatedShares: 1,
      feeApplied: 0,
      eventTimestamp: new Date(baseTs + i * 2000 + 1000),
    });
  }
  return rows;
}

async function setup(
  startingCash: number,
  rows: TradeRow[],
  opts?: { forceNormalizationDrift?: boolean },
) {
  vi.resetModules();

  vi.doMock('../src/lib/prisma.js', () => ({
    prisma: {
      paperCopySession: {
        findUnique: vi.fn(async () => ({
          id: 'session-1',
          trackedWalletId: 'wallet-1',
          trackedWalletAddress: '0xwallet',
          startingCash,
        })),
        update: vi.fn(async () => ({})),
      },
      paperCopyTrade: {
        findMany: vi.fn(async () => rows),
      },
      walletActivityEvent: {
        findMany: vi.fn(async () => []),
      },
      paperCopyPosition: {
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => ({})),
        create: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({})),
      },
      auditLog: {
        create: vi.fn(async () => ({})),
      },
    },
  }));

  vi.doMock('../src/modules/polymarket.js', () => ({
    createPolymarketDataAdapter: () => ({
      getWalletPositions: vi.fn(async () => []),
    }),
  }));

  vi.doMock('../src/lib/logger.js', () => ({
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  }));

  if (opts?.forceNormalizationDrift) {
    vi.doMock('../src/lib/money-utils.js', () => ({
      normalizeMoney: (value: number) => Math.trunc(value),
    }));
  }

  return await import('../src/modules/paper-accounting.js');
}

describe('paper-accounting invariant tolerance and drift context', () => {
  it('uses $5.00 tolerance for a $50k session', async () => {
    const mod = await setup(50000, buildRows(10));
    const reduced = await mod.reducePaperSessionLedger('session-1');
    expect(reduced.invariants.tolerance).toBeCloseTo(5, 8);
  });

  it('uses $0.01 tolerance for a $100 session', async () => {
    const mod = await setup(100, buildRows(10));
    const reduced = await mod.reducePaperSessionLedger('session-1');
    expect(reduced.invariants.tolerance).toBeCloseTo(0.01, 8);
  });

  it('includes driftAsFractionOfNetPnl in accounting identity mismatch warning context', async () => {
    const mod = await setup(100, buildRows(150), { forceNormalizationDrift: true });
    const reduced = await mod.reducePaperSessionLedger('session-1');

    const identityWarning = reduced.warnings.find(
      (w) => w.code === 'INVARIANT_ACCOUNTING_IDENTITY_MISMATCH',
    );

    expect(identityWarning).toBeDefined();
    expect(identityWarning?.context).toBeDefined();
    expect(identityWarning?.context?.driftAsFractionOfNetPnl).not.toBeNull();
  });
});
