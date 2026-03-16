import { afterEach, describe, expect, it, vi } from 'vitest';

import { LivePolymarketAdapter } from '../src/index.js';

describe('LivePolymarketAdapter wallet activity fees', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses explicit fee from raw row field feeAmount when present and does not set feeIsInferred', async () => {
    const adapter = new LivePolymarketAdapter('https://example.invalid');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'evt-1',
            type: 'BUY',
            side: 'BUY',
            user: '0xabc',
            conditionId: 'm-1',
            outcome: 'YES',
            timestamp: '2026-03-16T00:00:00.000Z',
            size: 100,
            price: 0.4,
            feeAmount: 1.23,
          },
        ],
      })),
    );

    const events = await adapter.getWalletActivityFeed('0xabc');

    expect(events).toHaveLength(1);
    expect(events[0]?.fee).toBeCloseTo(1.23, 8);
    expect(events[0]?.feeIsInferred).toBeUndefined();
  });
});
