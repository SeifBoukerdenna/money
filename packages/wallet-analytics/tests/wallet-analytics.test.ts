import { describe, expect, it } from 'vitest';

import { computeWalletAnalytics } from '../src/index';

describe('wallet analytics', () => {
  it('computes core metrics from trades', () => {
    const now = new Date();
    const metrics = computeWalletAnalytics([
      {
        walletId: 'w1',
        marketId: 'm1',
        side: 'BUY',
        size: 10,
        price: 0.4,
        tradedAt: now.toISOString(),
      },
      {
        walletId: 'w1',
        marketId: 'm1',
        side: 'SELL',
        size: 10,
        price: 0.6,
        tradedAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    ]);

    expect(metrics.totalTrades).toBe(2);
    expect(metrics.realizedPnl).toBeGreaterThan(0);
    expect(metrics.winRate).toBe(1);
    expect(metrics.grossWinRate).toBe(1);
    expect(metrics.winRateDefinition).toBe('NET_OF_FEES_PER_CLOSED_POSITION');
    expect(metrics.marketDiversification).toBe(1);
  });

  it('counts gross-profit but net-loss positions as gross win and net loss', () => {
    const now = new Date();
    const metrics = computeWalletAnalytics([
      {
        walletId: 'w1',
        marketId: 'm1',
        side: 'BUY',
        size: 10,
        price: 0.4,
        tradedAt: now.toISOString(),
      },
      {
        walletId: 'w1',
        marketId: 'm1',
        side: 'SELL',
        size: 10,
        price: 0.41,
        fee: 0.2,
        tradedAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    ]);

    expect(metrics.grossWinRate).toBe(1);
    expect(metrics.winRate).toBe(0);
    expect(metrics.winRateDefinition).toBe('NET_OF_FEES_PER_CLOSED_POSITION');
  });
});
