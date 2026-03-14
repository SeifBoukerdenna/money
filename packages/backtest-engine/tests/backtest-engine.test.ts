import { describe, expect, it } from 'vitest';

import { runBacktest } from '../src/index';

describe('runBacktest', () => {
  it('returns summary metrics', () => {
    const result = runBacktest({
      strategyId: crypto.randomUUID(),
      bankrollStart: 1000,
      riskConfig: {
        id: crypto.randomUUID(),
        strategyId: crypto.randomUUID(),
        fixedDollar: 50,
        pctSourceSize: null,
        pctBankroll: null,
        maxExposure: 1000,
        perMarketMaxAllocation: 500,
        dailyLossCap: 999,
        maxSlippageBps: 100,
        minLiquidity: 10,
        maxSpreadBps: 2000,
        inverseMode: false,
        copyBuys: true,
        copySells: true,
        cooldownSeconds: 0,
        fillStrategy: 'AGGRESSIVE_LIMIT',
      },
      events: [
        {
          id: crypto.randomUUID(),
          sourceEventId: '1',
          sourceWalletAddress: '0x1',
          marketId: 'm1',
          outcome: 'YES',
          side: 'BUY',
          size: 10,
          price: 0.45,
          tradedAt: new Date().toISOString(),
          observedAt: new Date().toISOString(),
        },
      ],
      marketById: {
        m1: {
          bestBid: 0.44,
          bestAsk: 0.46,
          midpoint: 0.45,
          spreadBps: 450,
          liquidity: 20000,
          active: true,
          question: 'q',
          slug: 'm1',
        },
      },
    });

    expect(result.executed + result.skipped).toBe(1);
    expect(result).toHaveProperty('totalReturn');
    expect(result).toHaveProperty('maxDrawdown');
    expect(result).toHaveProperty('sharpeLike');
  });
});
