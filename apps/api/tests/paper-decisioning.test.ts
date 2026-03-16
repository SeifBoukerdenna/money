import { describe, expect, it } from 'vitest';

import {
  evaluatePaperEventDecision,
  type ProjectedPositionState,
} from '../src/modules/paper-decisioning.js';

describe('paper-decisioning accounting guards', () => {
  it('matches close/redeem deterministically when multiple outcomes are open', () => {
    const session = {
      maxAllocationPerMarket: 2500,
      maxTotalExposure: 10000,
      minNotionalThreshold: 1,
      slippageBps: 0,
      copyRatio: 1,
      startedAt: new Date('2026-03-16T00:00:00.000Z'),
      slippageConfig: null,
    } as any;

    const positionStateByKey = new Map<string, ProjectedPositionState>();
    positionStateByKey.set('m-1:YES', {
      marketId: 'm-1',
      outcome: 'YES',
      avgEntryPrice: 0.44,
      netShares: 20,
      marketQuestion: 'Market Q',
    });
    positionStateByKey.set('m-1:NO', {
      marketId: 'm-1',
      outcome: 'NO',
      avgEntryPrice: 0.63,
      netShares: 120,
      marketQuestion: 'Market Q',
    });

    const decision = evaluatePaperEventDecision({
      session,
      event: {
        id: 'redeem-1',
        eventType: 'REDEEM',
        marketId: 'm-1',
        outcome: null,
        marketQuestion: 'Market Q',
        price: null,
        shares: null,
        eventTimestamp: new Date('2026-03-16T00:01:00.000Z'),
      },
      projectedCash: 10000,
      projectedGrossExposure: 0,
      positionStateByKey,
    });

    expect(decision.decisionType).toBe('CLOSE');
    expect(decision.side).toBe('SELL');
    // Largest open lot is selected deterministically when outcome is missing.
    expect(decision.outcome).toBe('NO');
    expect(decision.simulatedShares).toBeCloseTo(120, 8);
  });

  it('respects remaining per-market cap on BUY sizing', () => {
    const session = {
      maxAllocationPerMarket: 100,
      maxTotalExposure: 10000,
      minNotionalThreshold: 1,
      slippageBps: 0,
      copyRatio: 1,
      startedAt: new Date('2026-03-16T00:00:00.000Z'),
      slippageConfig: null,
    } as any;

    const positionStateByKey = new Map<string, ProjectedPositionState>();
    positionStateByKey.set('m-2:YES', {
      marketId: 'm-2',
      outcome: 'YES',
      avgEntryPrice: 0.5,
      netShares: 150,
      marketQuestion: 'Cap test market',
    });

    const decision = evaluatePaperEventDecision({
      session,
      event: {
        id: 'buy-cap',
        eventType: 'BUY',
        marketId: 'm-2',
        outcome: 'YES',
        side: 'BUY',
        price: 0.5,
        shares: 100,
        eventTimestamp: new Date('2026-03-16T00:01:00.000Z'),
      },
      projectedCash: 1000,
      projectedGrossExposure: 0,
      positionStateByKey,
    });

    expect(decision.decisionType).toBe('COPY');
    // Existing exposure is 75 notional, cap is 100, so only 25 notional remains.
    expect(decision.simulatedShares).toBeCloseTo(50, 8);
    expect(decision.intendedFillPrice).toBeCloseTo(0.5, 8);
  });

  it('sizes BUY to cash capacity after accounting for fees', () => {
    const session = {
      maxAllocationPerMarket: 100,
      maxTotalExposure: 10000,
      minNotionalThreshold: 1,
      feeBps: 200,
      slippageBps: 0,
      copyRatio: 1,
      startedAt: new Date('2026-03-16T00:00:00.000Z'),
      slippageConfig: null,
    } as any;

    const decision = evaluatePaperEventDecision({
      session,
      event: {
        id: 'buy-fee-cap',
        eventType: 'BUY',
        marketId: 'm-3',
        outcome: 'YES',
        side: 'BUY',
        price: 1,
        shares: 100,
        eventTimestamp: new Date('2026-03-16T00:01:00.000Z'),
      },
      projectedCash: 100,
      projectedGrossExposure: 0,
      positionStateByKey: new Map(),
    });

    expect(decision.decisionType).toBe('COPY');
    expect(decision.simulatedShares).toBeCloseTo(98.039215686, 6);
  });

  it('uses live ask in BUY slippage and persists price source metadata', () => {
    const session = {
      maxAllocationPerMarket: 10000,
      maxTotalExposure: 10000,
      minNotionalThreshold: 1,
      feeBps: 0,
      slippageBps: 100,
      copyRatio: 1,
      startedAt: new Date('2026-03-16T00:00:00.000Z'),
      slippageConfig: null,
    } as any;

    const decision = evaluatePaperEventDecision({
      session,
      event: {
        id: 'buy-live-book',
        eventType: 'BUY',
        marketId: 'm-4',
        outcome: 'YES',
        side: 'BUY',
        price: 0.2,
        shares: 10,
        eventTimestamp: new Date('2026-03-16T00:01:00.000Z'),
      },
      projectedCash: 10000,
      projectedGrossExposure: 0,
      positionStateByKey: new Map(),
      liveMarketPrice: {
        bestAsk: 0.45,
        bestBid: 0.44,
        spreadBps: 200,
      },
    });

    expect(decision.decisionType).toBe('COPY');
    expect(Number(decision.intendedFillPrice)).toBeGreaterThan(0.45);

    const sizing = decision.sizingInputsJson as Record<string, any>;
    expect(sizing.priceSource).toBe('LIVE_BOOK');
    expect(Number(sizing.liveBookGapBps)).toBeGreaterThanOrEqual(0);
    expect(Number(sizing.slippageResult?.spreadBpsApplied ?? 0)).toBe(200);
  });

  it('drift latency uses total pipeline latency not just polling latency', () => {
    const session = {
      maxAllocationPerMarket: 10000,
      maxTotalExposure: 10000,
      minNotionalThreshold: 1,
      feeBps: 0,
      slippageBps: 0,
      copyRatio: 1,
      startedAt: new Date('2026-03-16T00:00:00.000Z'),
      slippageConfig: {
        enabled: true,
        mode: 'NONE',
        latencyDrift: {
          enabled: true,
          bpsPerSecond: 10,
          maxBps: 200,
        },
      },
    } as any;

    const withTotalLatency = evaluatePaperEventDecision({
      session,
      event: {
        id: 'buy-total-latency',
        eventType: 'BUY',
        marketId: 'm-5',
        outcome: 'YES',
        side: 'BUY',
        price: 0.5,
        shares: 10,
        eventTimestamp: new Date('2026-03-16T00:01:00.000Z'),
      },
      projectedCash: 10000,
      projectedGrossExposure: 0,
      positionStateByKey: new Map(),
      latencyMs: 5000,
    });

    const withPollingLatency = evaluatePaperEventDecision({
      session,
      event: {
        id: 'buy-polling-latency',
        eventType: 'BUY',
        marketId: 'm-5',
        outcome: 'YES',
        side: 'BUY',
        price: 0.5,
        shares: 10,
        eventTimestamp: new Date('2026-03-16T00:01:10.000Z'),
      },
      projectedCash: 10000,
      projectedGrossExposure: 0,
      positionStateByKey: new Map(),
      latencyMs: 1000,
    });

    const highLatencySizing = withTotalLatency.sizingInputsJson as Record<string, any>;
    const lowLatencySizing = withPollingLatency.sizingInputsJson as Record<string, any>;

    expect(Number(highLatencySizing.slippageResult?.driftBps ?? 0)).toBeCloseTo(50, 8);
    expect(Number(lowLatencySizing.slippageResult?.driftBps ?? 0)).toBeCloseTo(10, 8);
  });
});
