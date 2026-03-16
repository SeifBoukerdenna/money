import { describe, expect, it, vi } from 'vitest';

import { calculateWalletPnlSummary } from '../src/modules/profile-parity-routes.js';
import { buildSessionSourceComparison } from '../src/modules/session-analytics-contract.js';

describe('win-rate response contracts', () => {
  it('returns pnl-summary winRate as ratio and winRatePct as percentage', async () => {
    const walletId = 'wallet-1';

    const exits = [
      {
        eventType: 'SELL',
        outcome: 'YES',
        side: 'SELL',
        price: 0.7,
        shares: 10,
        notional: 7,
        marketId: 'm1',
        conditionId: 'c1',
      },
      {
        eventType: 'SELL',
        outcome: 'YES',
        side: 'SELL',
        price: 0.2,
        shares: 10,
        notional: 2,
        marketId: 'm2',
        conditionId: 'c2',
      },
    ];

    const buyRows = [
      {
        marketId: 'm1',
        conditionId: 'c1',
        outcome: 'YES',
        shares: 10,
        price: 0.4,
      },
      {
        marketId: 'm2',
        conditionId: 'c2',
        outcome: 'YES',
        shares: 10,
        price: 0.4,
      },
    ];

    const buyVolumeRows = [
      { notional: 4, shares: 10, price: 0.4 },
      { notional: 4, shares: 10, price: 0.4 },
    ];

    const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const eventTypes = (where.eventType as { in?: string[] } | undefined)?.in ?? [];
      const side = where.side;
      const hasMarketOr = Array.isArray(where.OR);

      if (eventTypes.includes('SELL')) return exits;
      if (eventTypes.includes('BUY') && side === 'BUY' && hasMarketOr) return buyRows;
      if (eventTypes.includes('BUY') && side === 'BUY' && !hasMarketOr) return buyVolumeRows;
      return [];
    });

    const prisma = {
      watchedWallet: {
        findUnique: vi.fn(async () => ({ id: walletId })),
      },
      walletActivityEvent: {
        findMany,
      },
    };

    const summary = await calculateWalletPnlSummary(prisma, walletId, { range: 'ALL' });

    expect(summary.winCount).toBe(1);
    expect(summary.lossCount).toBe(1);
    expect(summary.tradeCount).toBe(2);
    expect(summary.winRate).toBeCloseTo(0.5, 10);
    expect(summary.winRatePct).toBeCloseTo(50, 10);
  });

  it('returns zeroed win-rate fields when there are no decisive trades', async () => {
    const walletId = 'wallet-2';

    const prisma = {
      watchedWallet: {
        findUnique: vi.fn(async () => ({ id: walletId })),
      },
      walletActivityEvent: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const eventTypes = (where.eventType as { in?: string[] } | undefined)?.in ?? [];
          if (eventTypes.includes('SELL')) return [];
          return [];
        }),
      },
    };

    const summary = await calculateWalletPnlSummary(prisma, walletId, { range: 'ALL' });

    expect(summary.tradeCount).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.winRatePct).toBe(0);
  });

  it('builds session analytics sourceComparison with ratio and pct fields', () => {
    const comparison = buildSessionSourceComparison({
      sourceWinRate: 0.625,
      sourceNetPnl: 200,
      closedPositions: [{ realizedPnl: 50 }, { realizedPnl: -20 }, { realizedPnl: 0 }],
      startedAt: '2026-03-16T00:00:00.000Z',
      createdAtIso: '2026-03-15T00:00:00.000Z',
    });

    expect(comparison.sourceWinRate).toBeCloseTo(0.625, 10);
    expect(comparison.sourceWinRatePct).toBeCloseTo(62.5, 10);
    expect(comparison.paperWinRate).toBeCloseTo(0.5, 10);
    expect(comparison.paperWinRatePct).toBeCloseTo(50, 10);
    expect(comparison.sourceNetPnl).toBe(200);
    expect(comparison).not.toHaveProperty('sourceRealizedPnl');
  });

  it('trackingEfficiency uses NET_VS_NET when paperNetPnl is provided', () => {
    const comparison = buildSessionSourceComparison({
      sourceWinRate: 0.6,
      sourceNetPnl: 200,
      paperNetPnl: 180,
      closedPositions: [{ realizedPnl: 150 }],
      startedAt: '2026-03-16T00:00:00.000Z',
      createdAtIso: '2026-03-15T00:00:00.000Z',
    });

    expect(comparison.trackingEfficiencyPct).toBeCloseTo(90, 10);
    expect(comparison.trackingEfficiencyBasis).toBe('NET_VS_NET');
  });

  it('falls back to REALIZED_VS_NET when paperNetPnl is omitted', () => {
    const comparison = buildSessionSourceComparison({
      sourceWinRate: 0.6,
      sourceNetPnl: 200,
      closedPositions: [{ realizedPnl: 150 }],
      startedAt: '2026-03-16T00:00:00.000Z',
      createdAtIso: '2026-03-15T00:00:00.000Z',
    });

    expect(comparison.trackingEfficiencyPct).toBeCloseTo(75, 10);
    expect(comparison.trackingEfficiencyBasis).toBe('REALIZED_VS_NET');
  });
});
