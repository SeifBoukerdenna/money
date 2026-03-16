import { describe, expect, it } from 'vitest';

import {
  buildTradeAttribution,
  resolveAttributionPositionKey,
  toNullableNumber,
} from '../src/modules/paper-api-mappers.js';

describe('paper-api-mappers', () => {
  it('preserves legitimate zero numeric values', () => {
    expect(toNullableNumber(0)).toBe(0);
    expect(toNullableNumber('0')).toBe(0);
    expect(toNullableNumber(null)).toBeNull();
    expect(toNullableNumber(undefined)).toBeNull();
  });

  it('computes event-level realized pnl separately from cumulative realized pnl', () => {
    const attribution = buildTradeAttribution([
      {
        id: 't1',
        marketId: 'm1',
        outcome: 'YES',
        side: 'BUY',
        simulatedPrice: 0.5,
        simulatedShares: 100,
        feeApplied: 0.1,
      },
      {
        id: 't2',
        marketId: 'm1',
        outcome: 'YES',
        side: 'SELL',
        simulatedPrice: 0.6,
        simulatedShares: 40,
        feeApplied: 0.04,
      },
      {
        id: 't3',
        marketId: 'm1',
        outcome: 'YES',
        side: 'SELL',
        simulatedPrice: 0.7,
        simulatedShares: 60,
        feeApplied: 0.06,
      },
    ]);

    expect(attribution.eventRealizedPnlGrossByTradeId.get('t2')).toBeCloseTo(4, 8);
    expect(attribution.eventRealizedPnlGrossByTradeId.get('t3')).toBeCloseTo(12, 8);
    expect(attribution.cumulativeRealizedPnlGrossByPositionKey.get('m1:YES')).toBeCloseTo(16, 8);
    expect(attribution.feeByTradeId.get('t3')).toBeCloseTo(0.06, 8);
  });

  it('supports close-at-zero event rows', () => {
    const attribution = buildTradeAttribution([
      {
        id: 'b1',
        marketId: 'm2',
        outcome: 'NO',
        side: 'BUY',
        simulatedPrice: 0.2,
        simulatedShares: 50,
        feeApplied: 0,
      },
      {
        id: 's1',
        marketId: 'm2',
        outcome: 'NO',
        side: 'SELL',
        simulatedPrice: 0,
        simulatedShares: 50,
        feeApplied: 0,
      },
    ]);

    expect(attribution.eventRealizedPnlGrossByTradeId.get('s1')).toBeCloseTo(-10, 8);
    expect(attribution.cumulativeRealizedPnlGrossByPositionKey.get('m2:NO')).toBeCloseTo(-10, 8);
  });

  it('builds attribution key from decision/trade outcome when source outcome is null', () => {
    expect(
      resolveAttributionPositionKey({
        marketId: 'm3',
        sourceOutcome: null,
        decisionOutcome: 'yes',
      }),
    ).toBe('m3:YES');

    expect(
      resolveAttributionPositionKey({
        marketId: 'm4',
        sourceOutcome: null,
        decisionOutcome: null,
        tradeOutcome: 'no',
      }),
    ).toBe('m4:NO');
  });
});
