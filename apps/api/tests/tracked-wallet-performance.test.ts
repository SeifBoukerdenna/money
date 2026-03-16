import { describe, expect, it } from 'vitest';
import {
  bucketTrackedWalletTimeline,
  compareSourceVsSession,
  reduceTrackedWalletEvents,
  type SessionTimelinePoint,
  type TrackedWalletEvent,
} from '../src/modules/tracked-wallet-performance.js';

function event(input: {
  id: string;
  ts: string;
  side?: 'BUY' | 'SELL' | null;
  effectiveSide?: 'BUY' | 'SELL' | null;
  eventType: string;
  shares?: number | null;
  price?: number | null;
  notional?: number | null;
  fee?: number | null;
  marketId?: string;
  conditionId?: string | null;
  outcome?: string | null;
}): TrackedWalletEvent {
  return {
    id: input.id,
    marketId: input.marketId ?? 'm1',
    conditionId: input.conditionId ?? 'm1',
    marketQuestion: 'Test market',
    outcome: input.outcome ?? 'YES',
    side: input.side ?? null,
    effectiveSide: input.effectiveSide ?? null,
    eventType: input.eventType,
    price: input.price ?? null,
    shares: input.shares ?? null,
    notional: input.notional ?? null,
    fee: input.fee ?? null,
    eventTimestamp: new Date(input.ts),
    createdAt: new Date(input.ts),
  };
}

describe('tracked-wallet-performance reducer', () => {
  it('handles buy/sell accounting with gross realized and separate fees', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'e1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.4,
          fee: 0.1,
        }),
        event({
          id: 'e2',
          ts: '2026-03-01T00:01:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 10,
          price: 0.7,
          fee: 0.2,
        }),
      ],
    });

    expect(reduced.realizedPnlGross).toBeCloseTo(3, 8);
    expect(reduced.fees).toBeCloseTo(0.3, 8);
    expect(reduced.netPnl).toBeCloseTo(2.7, 8);
    expect(reduced.unrealizedPnl).toBeCloseTo(0, 8);
    expect(reduced.positions[0]?.status).toBe('CLOSED');
  });

  it('handles partial sells from accumulated buys without double counting', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'b1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.5,
        }),
        event({
          id: 'b2',
          ts: '2026-03-01T00:01:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.6,
        }),
        event({
          id: 's1',
          ts: '2026-03-01T00:02:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 8,
          price: 0.7,
        }),
      ],
      markPriceByKey: new Map([['m1:YES', 0.62]]),
    });

    const avgEntry = (10 * 0.5 + 10 * 0.6) / 20;
    expect(reduced.realizedPnlGross).toBeCloseTo(8 * (0.7 - avgEntry), 8);
    expect(reduced.positions[0]?.netShares).toBeCloseTo(12, 8);
  });

  it('handles redeem close-at-zero events with missing shares and price', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'buy',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 50,
          price: 0.2,
          fee: 0,
        }),
        event({
          id: 'redeem',
          ts: '2026-03-01T00:10:00.000Z',
          eventType: 'REDEEM',
          side: null,
          effectiveSide: null,
          shares: null,
          price: null,
          notional: 0,
          fee: 0,
        }),
      ],
    });

    expect(reduced.realizedPnlGross).toBeCloseTo(-10, 8);
    expect(reduced.unrealizedPnl).toBeCloseTo(0, 8);
    expect(reduced.positions[0]?.status).toBe('CLOSED');
  });

  it('preserves net decomposition invariants', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'a',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 40,
          price: 0.55,
          fee: 0.1,
        }),
        event({
          id: 'b',
          ts: '2026-03-01T00:05:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 15,
          price: 0.65,
          fee: 0.05,
        }),
      ],
      markPriceByKey: new Map([['m1:YES', 0.6]]),
    });

    const lhs = reduced.realizedPnlGross + reduced.unrealizedPnl - reduced.fees;
    expect(lhs).toBeCloseTo(reduced.netPnl, 8);
    expect(reduced.reconstructedAccountValue).toBeCloseTo(
      reduced.cashDelta + reduced.openMarketValue,
      8,
    );
  });

  it('dedupes duplicate source events by id', () => {
    const e = event({
      id: 'dup',
      ts: '2026-03-01T00:00:00.000Z',
      eventType: 'BUY',
      side: 'BUY',
      shares: 10,
      price: 0.5,
    });
    const reduced = reduceTrackedWalletEvents({ events: [e, e] });
    expect(reduced.summary.duplicateSkipped).toBe(1);
    expect(reduced.summary.tradeLikeEventCount).toBe(1);
    expect(reduced.positions[0]?.netShares).toBeCloseTo(10, 8);
  });

  it('emits timeline with non-decreasing timestamps and fees', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 't1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.5,
          fee: 0.1,
        }),
        event({
          id: 't2',
          ts: '2026-03-01T00:00:30.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 4,
          price: 0.55,
          fee: 0.1,
        }),
        event({
          id: 't3',
          ts: '2026-03-01T00:01:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 6,
          price: 0.7,
          fee: 0.1,
        }),
      ],
    });

    for (let i = 1; i < reduced.timeline.length; i += 1) {
      expect(new Date(reduced.timeline[i]!.eventTimestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(reduced.timeline[i - 1]!.eventTimestamp).getTime(),
      );
      expect(reduced.timeline[i]!.fees).toBeGreaterThanOrEqual(reduced.timeline[i - 1]!.fees);
    }
  });

  it('keeps zero-value scenarios as numeric zeros', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'z1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.5,
          fee: 0,
        }),
        event({
          id: 'z2',
          ts: '2026-03-01T00:01:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 10,
          price: 0.5,
          fee: 0,
        }),
      ],
    });

    expect(reduced.realizedPnlGross).toBe(0);
    expect(reduced.fees).toBe(0);
    expect(reduced.unrealizedPnl).toBe(0);
    expect(reduced.netPnl).toBe(0);
  });

  it('supports strict known-only mode by skipping inference-required events', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'strict-buy',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 25,
          price: 0.4,
        }),
        event({
          id: 'strict-redeem',
          ts: '2026-03-01T00:10:00.000Z',
          eventType: 'REDEEM',
          side: null,
          effectiveSide: null,
          shares: null,
          price: null,
          notional: 0,
        }),
      ],
      inferMissingFields: false,
    });

    expect(reduced.summary.inferenceDisabledSkips).toBeGreaterThan(0);
    expect(reduced.positions[0]?.status).toBe('OPEN');
    expect(reduced.warnings.some((w) => w.code === 'INFERENCE_DISABLED_EVENT_SKIPPED')).toBe(true);
  });

  it('uses inferred mode to process otherwise unknown close events', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'infer-buy',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 25,
          price: 0.4,
        }),
        event({
          id: 'infer-redeem',
          ts: '2026-03-01T00:10:00.000Z',
          eventType: 'REDEEM',
          side: null,
          effectiveSide: null,
          shares: null,
          price: null,
          notional: 0,
        }),
      ],
      inferMissingFields: true,
    });

    expect(reduced.positions[0]?.status).toBe('CLOSED');
    expect(reduced.summary.inferredShareEvents).toBeGreaterThan(0);
  });

  it('buckets timeline using latest cumulative point per bucket', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'bkt-1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.4,
        }),
        event({
          id: 'bkt-2',
          ts: '2026-03-01T00:04:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 2,
          price: 0.6,
        }),
        event({
          id: 'bkt-3',
          ts: '2026-03-01T00:06:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 2,
          price: 0.7,
        }),
      ],
    });

    const bucketed = bucketTrackedWalletTimeline(reduced.timeline, '5M');
    expect(bucketed.length).toBe(2);
    expect(bucketed[0]?.eventId).toBe('bkt-2');
    expect(bucketed[1]?.eventId).toBe('bkt-3');
  });

  it('downgrades confidence and withholds canonical net on truncated history with open positions', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'th-1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 20,
          price: 0.45,
          fee: 0.1,
        }),
      ],
      markPriceByKey: new Map([['m1:YES', 0.6]]),
      markMetaByKey: new Map([['m1:YES', { source: 'LIVE', stale: false }]]),
      hasTruncatedHistory: true,
    });

    expect(reduced.confidenceModel.confidence).toBe('LOW');
    expect(reduced.confidenceModel.hasUnknownCostBasis).toBe(true);
    expect(reduced.canonical.canonicalKnownNetPnl).toBeNull();
    expect(reduced.debugReport.unknownCostBasisPositions.length).toBeGreaterThan(0);
  });

  it('records unsupported event types in append-only ledger', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'u-1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'TRANSFER',
          side: null,
          shares: null,
          price: null,
        }),
      ],
    });

    expect(reduced.summary.unsupportedEventCount).toBe(1);
    expect(reduced.ledger.some((row) => row.type === 'UNSUPPORTED')).toBe(true);
    expect(reduced.confidenceModel.hasUnsupportedEvents).toBe(true);
  });

  it('treats fallback marks as estimated and excludes unrealized from canonical known net', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'm-1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.2,
          fee: 0,
        }),
      ],
      markPriceByKey: new Map([['m1:YES', 0.9]]),
      markMetaByKey: new Map([['m1:YES', { source: 'FALLBACK', stale: true }]]),
    });

    expect(reduced.unrealizedPnl).toBeCloseTo(7, 8);
    expect(reduced.canonical.canonicalUnrealizedPnl).toBe(0);
    expect(reduced.canonical.estimatedNetPnl).toBeCloseTo(7, 8);
    expect(reduced.confidenceModel.hasEstimatedMarks).toBe(true);
  });

  it('warns when sell exceeds known open quantity and clamps closed size', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'sq-1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 5,
          price: 0.4,
        }),
        event({
          id: 'sq-2',
          ts: '2026-03-01T00:01:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 10,
          price: 0.5,
        }),
      ],
    });

    expect(reduced.warnings.some((w) => w.code === 'SELL_EXCEEDS_HELD_SHARES')).toBe(true);
    expect(reduced.positions[0]?.status).toBe('CLOSED');
    expect(reduced.debugReport.impossibleStateTransitions).toBeGreaterThan(0);
  });

  it('replays out-of-order events by timestamp deterministically', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'ord-sell',
          ts: '2026-03-01T00:02:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 10,
          price: 0.7,
          fee: 0.2,
        }),
        event({
          id: 'ord-buy',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.4,
          fee: 0.1,
        }),
      ],
    });

    expect(reduced.realizedPnlGross).toBeCloseTo(3, 8);
    expect(reduced.timeline[0]?.eventId).toBe('ord-buy');
    expect(reduced.timeline[1]?.eventId).toBe('ord-sell');
  });

  it('detects missing fees and avoids authoritative canonical net', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'mf-1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.5,
          fee: null,
        }),
        event({
          id: 'mf-2',
          ts: '2026-03-01T00:01:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 10,
          price: 0.55,
          fee: null,
        }),
      ],
    });

    expect(reduced.summary.missingFeeEvents).toBe(2);
    expect(reduced.confidenceModel.hasMissingFees).toBe(true);
    expect(reduced.canonical.canonicalKnownNetPnl).toBeNull();
  });

  it('keeps canonical formula consistent and reconciliation debug aligned', () => {
    const reduced = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'rc-1',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 20,
          price: 0.3,
          fee: 0.2,
        }),
        event({
          id: 'rc-2',
          ts: '2026-03-01T00:05:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 8,
          price: 0.6,
          fee: 0.1,
        }),
      ],
      markPriceByKey: new Map([['m1:YES', 0.35]]),
      markMetaByKey: new Map([['m1:YES', { source: 'LIVE', stale: false }]]),
    });

    const canonicalNet =
      reduced.canonical.canonicalRealizedPnl +
      reduced.canonical.canonicalUnrealizedPnl -
      reduced.canonical.canonicalFees;
    expect(canonicalNet).toBeCloseTo(reduced.canonical.canonicalKnownNetPnl ?? 0, 8);
    expect(
      reduced.debugReport.eventCountsByType.BUY_FILL +
        reduced.debugReport.eventCountsByType.SELL_FILL +
        reduced.debugReport.eventCountsByType.FEE,
    ).toBeGreaterThan(0);
  });
});

describe('source vs session comparisons', () => {
  const source = reduceTrackedWalletEvents({
    events: [
      event({
        id: 's1',
        ts: '2026-03-01T00:00:00.000Z',
        eventType: 'BUY',
        side: 'BUY',
        shares: 100,
        price: 0.4,
        fee: 0.5,
      }),
      event({
        id: 's2',
        ts: '2026-03-01T00:02:00.000Z',
        eventType: 'SELL',
        side: 'SELL',
        shares: 100,
        price: 0.7,
        fee: 0.7,
      }),
    ],
  });

  const sessionTimeline: SessionTimelinePoint[] = [
    {
      timestamp: '2026-03-01T00:00:00.000Z',
      totalPnl: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      fees: 0,
    },
    {
      timestamp: '2026-03-01T00:02:00.000Z',
      totalPnl: 18,
      realizedPnl: 20,
      unrealizedPnl: 0,
      fees: 2,
    },
  ];

  it('compares source and session over the same window', () => {
    const comparison = compareSourceVsSession({
      sourceTimeline: source.timeline,
      sessionTimeline,
      windowStart: '2026-03-01T00:00:00.000Z',
      windowEnd: '2026-03-01T00:02:00.000Z',
    });

    expect(comparison.source.netPnl).toBeCloseTo(28.8, 6);
    expect(comparison.session.netPnl).toBeCloseTo(18, 6);
    expect(comparison.gaps.netPnlGap).toBeCloseTo(10.8, 6);
    expect(comparison.curves.gap.length).toBeGreaterThan(0);
  });

  it('supports multiple sessions against the same source timeline', () => {
    const secondSession: SessionTimelinePoint[] = [
      {
        timestamp: '2026-03-01T00:00:00.000Z',
        totalPnl: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        fees: 0,
      },
      {
        timestamp: '2026-03-01T00:02:00.000Z',
        totalPnl: 32,
        realizedPnl: 34,
        unrealizedPnl: 0,
        fees: 2,
      },
    ];

    const lagging = compareSourceVsSession({
      sourceTimeline: source.timeline,
      sessionTimeline,
      windowStart: '2026-03-01T00:00:00.000Z',
      windowEnd: '2026-03-01T00:02:00.000Z',
    });

    const outperforming = compareSourceVsSession({
      sourceTimeline: source.timeline,
      sessionTimeline: secondSession,
      windowStart: '2026-03-01T00:00:00.000Z',
      windowEnd: '2026-03-01T00:02:00.000Z',
    });

    expect(lagging.gaps.netPnlGap).toBeGreaterThan(0);
    expect(outperforming.gaps.netPnlGap).toBeLessThan(0);
  });

  it('identifies profitable source while copied session underperforms', () => {
    const degradedSession: SessionTimelinePoint[] = [
      {
        timestamp: '2026-03-01T00:00:00.000Z',
        totalPnl: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        fees: 0,
      },
      {
        timestamp: '2026-03-01T00:02:00.000Z',
        totalPnl: -4,
        realizedPnl: -2,
        unrealizedPnl: -1,
        fees: 1,
      },
    ];

    const comparison = compareSourceVsSession({
      sourceTimeline: source.timeline,
      sessionTimeline: degradedSession,
      windowStart: '2026-03-01T00:00:00.000Z',
      windowEnd: '2026-03-01T00:02:00.000Z',
    });

    expect(comparison.source.netPnl).toBeGreaterThan(0);
    expect(comparison.session.netPnl).toBeLessThan(0);
    expect(comparison.gaps.netPnlGap).toBeGreaterThan(0);
  });

  it('rebases both curves to zero at window start even when source had earlier pnl', () => {
    const sourceWithPriorPnl = reduceTrackedWalletEvents({
      events: [
        event({
          id: 'pre-buy',
          ts: '2026-03-01T00:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 100,
          price: 0.1,
        }),
        event({
          id: 'pre-sell',
          ts: '2026-03-01T00:10:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 100,
          price: 0.6,
        }),
        event({
          id: 'win-b',
          ts: '2026-03-01T01:00:00.000Z',
          eventType: 'BUY',
          side: 'BUY',
          shares: 10,
          price: 0.2,
        }),
        event({
          id: 'win-s',
          ts: '2026-03-01T01:02:00.000Z',
          eventType: 'SELL',
          side: 'SELL',
          shares: 10,
          price: 0.4,
        }),
      ],
    });

    const sessionOnlyWindow: SessionTimelinePoint[] = [
      {
        timestamp: '2026-03-01T01:00:00.000Z',
        totalPnl: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        fees: 0,
      },
      {
        timestamp: '2026-03-01T01:02:00.000Z',
        totalPnl: 1,
        realizedPnl: 1,
        unrealizedPnl: 0,
        fees: 0,
      },
    ];

    const comparison = compareSourceVsSession({
      sourceTimeline: sourceWithPriorPnl.timeline,
      sessionTimeline: sessionOnlyWindow,
      windowStart: '2026-03-01T01:00:00.000Z',
      windowEnd: '2026-03-01T01:02:00.000Z',
    });

    expect(comparison.source.netPnl).toBeCloseTo(2, 8);
    expect(comparison.session.netPnl).toBeCloseTo(1, 8);
    expect(comparison.curves.sourceNetPnl[0]?.timestamp).toBe('2026-03-01T01:00:00.000Z');
    expect(comparison.curves.sourceNetPnl[0]?.value).toBeCloseTo(0, 8);
    expect(comparison.curves.sessionNetPnl[0]?.timestamp).toBe('2026-03-01T01:00:00.000Z');
    expect(comparison.curves.sessionNetPnl[0]?.value).toBeCloseTo(0, 8);
  });

  it('flags mark contamination and negative unrealized asymmetry when source unrealized > session unrealized', () => {
    const now = Date.now();
    const start = new Date(now - 60 * 60 * 1000).toISOString();
    const end = new Date(now).toISOString();

    const sourceTimeline: SessionTimelinePoint[] = [
      { timestamp: start, totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, fees: 0 },
      { timestamp: end, totalPnl: 10, realizedPnl: 4, unrealizedPnl: 6, fees: 0 },
    ];
    const sessionTimelineLocal: SessionTimelinePoint[] = [
      { timestamp: start, totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, fees: 0 },
      { timestamp: end, totalPnl: 4, realizedPnl: 4, unrealizedPnl: 0, fees: 0 },
    ];

    const comparison = compareSourceVsSession({
      sourceTimeline: sourceTimeline.map((p) => ({
        index: 0,
        eventId: p.timestamp,
        eventTimestamp: p.timestamp,
        eventType: 'SNAP',
        marketId: 'm1',
        outcome: 'YES',
        side: null,
        realizedPnlGross: p.realizedPnl,
        unrealizedPnl: p.unrealizedPnl,
        fees: p.fees,
        netPnl: p.totalPnl,
        cashDelta: 0,
        openMarketValue: 0,
        reconstructedAccountValue: 0,
      })),
      sessionTimeline: sessionTimelineLocal,
      windowStart: start,
      windowEnd: end,
    });

    expect(comparison.markContaminationWarning).toBe(true);
    expect(comparison.unrealizedAsymmetryBps).toBeLessThan(0);
    expect(comparison.sourceHasOpenPositions).toBe(true);
    expect(comparison.sessionHasOpenPositions).toBe(false);
  });

  it('does not warn when both source and session unrealized are zero', () => {
    const comparison = compareSourceVsSession({
      sourceTimeline: source.timeline,
      sessionTimeline: [
        {
          timestamp: '2026-03-01T00:00:00.000Z',
          totalPnl: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          fees: 0,
        },
        {
          timestamp: '2026-03-01T00:02:00.000Z',
          totalPnl: 18,
          realizedPnl: 18,
          unrealizedPnl: 0,
          fees: 0,
        },
      ],
      windowStart: '2026-03-01T00:00:00.000Z',
      windowEnd: '2026-03-01T00:02:00.000Z',
    });

    expect(comparison.markContaminationWarning).toBe(false);
  });

  it('still warns for older windows when either side has open unrealized exposure', () => {
    const comparison = compareSourceVsSession({
      sourceTimeline: [
        {
          index: 0,
          eventId: 'old-1',
          eventTimestamp: '2025-01-01T00:00:00.000Z',
          eventType: 'SNAP',
          marketId: 'm1',
          outcome: 'YES',
          side: null,
          realizedPnlGross: 0,
          unrealizedPnl: 2,
          fees: 0,
          netPnl: 2,
          cashDelta: 0,
          openMarketValue: 0,
          reconstructedAccountValue: 0,
        },
      ],
      sessionTimeline: [
        {
          timestamp: '2025-01-01T00:00:00.000Z',
          totalPnl: 1,
          realizedPnl: 0,
          unrealizedPnl: 1,
          fees: 0,
        },
      ],
      windowStart: '2025-01-01T00:00:00.000Z',
      windowEnd: '2025-01-01T00:00:00.000Z',
    });

    expect(comparison.markContaminationWarning).toBe(true);
  });
});
