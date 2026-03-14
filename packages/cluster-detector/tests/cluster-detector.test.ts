import { describe, expect, it } from 'vitest';

import { detectTradeCluster } from '../src/index';

describe('detectTradeCluster', () => {
  it('triggers when threshold wallets enter same market quickly', () => {
    const now = Date.now();
    const result = detectTradeCluster([
      { walletId: 'w1', marketId: 'm1', side: 'BUY', tradedAt: new Date(now).toISOString() },
      {
        walletId: 'w2',
        marketId: 'm1',
        side: 'BUY',
        tradedAt: new Date(now + 30_000).toISOString(),
      },
      {
        walletId: 'w3',
        marketId: 'm1',
        side: 'BUY',
        tradedAt: new Date(now + 60_000).toISOString(),
      },
    ]);
    expect(result?.triggered).toBe(true);
    expect(result?.walletIds.length).toBe(3);
  });
});
