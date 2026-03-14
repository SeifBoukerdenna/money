import { describe, expect, it } from 'vitest';

import { detectWhaleAlert } from '../src/index';

describe('detectWhaleAlert', () => {
  it('triggers on large trade threshold', () => {
    const result = detectWhaleAlert(
      {
        wallet: '0xabc',
        marketId: 'm1',
        side: 'BUY',
        size: 1000,
        price: 0.8,
        liquidity: 100000,
        tradedAt: new Date().toISOString(),
        recentEntriesInWindow: 1,
      },
      {
        largeTradeUsd: 500,
        largePositionSize: 1500,
        rapidMarketEntry: 5,
      },
    );
    expect(result.triggered).toBe(true);
    expect(result.reasons).toContain('LARGE_TRADE_USD');
  });
});
