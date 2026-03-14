import { describe, expect, it } from 'vitest';

import { computeMarketIntelligence } from '../src/index';

describe('computeMarketIntelligence', () => {
  it('computes sentiment and wallet counts', () => {
    const result = computeMarketIntelligence([
      { marketId: 'm1', walletId: 'w1', side: 'BUY', size: 10, price: 0.5 },
      { marketId: 'm1', walletId: 'w2', side: 'SELL', size: 5, price: 0.5 },
    ]);
    expect(result[0]?.uniqueWallets).toBe(2);
    expect(result[0]?.netSentimentScore).toBeGreaterThan(0);
  });
});
