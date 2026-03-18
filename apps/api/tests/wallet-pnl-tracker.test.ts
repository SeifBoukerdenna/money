/**
 * wallet-pnl-tracker.test.ts
 *
 * Unit tests for the Windowed Wallet PnL Tracker core logic.
 * Mocks Prisma and the Polymarket data adapter.
 * All tests operate on the pure buildPnlSnapshot() function.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPnlSnapshot,
  resolveEventSide,
  resolveFee,
  type FeeMode,
  type PnlEvent,
} from '../src/modules/wallet-pnl-tracker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId(): string {
  return `evt-${++_idCounter}`;
}

function event(input: {
  id?: string;
  ts: string;
  eventType: string;
  side?: 'BUY' | 'SELL' | null;
  effectiveSide?: 'BUY' | 'SELL' | null;
  shares?: number | null;
  price?: number | null;
  notional?: number | null;
  fee?: number | null;
  feeIsInferred?: boolean;
  marketId?: string;
  conditionId?: string | null;
  outcome?: string | null;
}): PnlEvent {
  return {
    id: input.id ?? nextId(),
    marketId: input.marketId ?? 'market-1',
    conditionId: input.conditionId ?? 'cond-1',
    marketQuestion: 'Test market?',
    outcome: input.outcome ?? 'YES',
    side: input.side ?? null,
    effectiveSide: input.effectiveSide ?? null,
    eventType: input.eventType,
    price: input.price ?? null,
    shares: input.shares ?? null,
    notional: input.notional ?? null,
    fee: input.fee ?? null,
    feeIsInferred: input.feeIsInferred ?? false,
    eventTimestamp: new Date(input.ts),
  };
}

/** Convenience: compute delta between two snapshots (mirrors calculateWindowedPnl logic). */
function delta(
  startEvents: PnlEvent[],
  endEvents: PnlEvent[],
  feeMode: FeeMode,
  tStart: Date,
  tEnd: Date,
) {
  const all = [...startEvents, ...endEvents];
  const snapStart = buildPnlSnapshot(all, tStart, feeMode);
  const snapEnd = buildPnlSnapshot(all, tEnd, feeMode);
  return {
    snapStart,
    snapEnd,
    windowRealizedGross: snapEnd.cumulativeRealizedGross - snapStart.cumulativeRealizedGross,
    windowFees: snapEnd.cumulativeFees - snapStart.cumulativeFees,
  };
}

const T0 = '2024-01-01T00:00:00.000Z'; // before window open
const T1 = '2024-01-02T00:00:00.000Z'; // window open (T_start)
const T2 = '2024-01-02T12:00:00.000Z'; // in-window event
const T3 = '2024-01-03T00:00:00.000Z'; // window close (T_end)

// ─── resolveEventSide ─────────────────────────────────────────────────────────

describe('resolveEventSide', () => {
  it('returns BUY for effectiveSide BUY', () => {
    expect(resolveEventSide(event({ ts: T0, eventType: 'TRADE', effectiveSide: 'BUY' }))).toBe(
      'BUY',
    );
  });

  it('returns SELL for effectiveSide SELL', () => {
    expect(resolveEventSide(event({ ts: T0, eventType: 'TRADE', effectiveSide: 'SELL' }))).toBe(
      'SELL',
    );
  });

  it('returns SELL for REDEEM event type', () => {
    expect(resolveEventSide(event({ ts: T0, eventType: 'REDEEM' }))).toBe('SELL');
  });

  it('returns BUY for INCREASE event type', () => {
    expect(resolveEventSide(event({ ts: T0, eventType: 'INCREASE' }))).toBe('BUY');
  });

  it('returns null for non-trade event type', () => {
    expect(resolveEventSide(event({ ts: T0, eventType: 'TRANSFER' }))).toBeNull();
  });
});

// ─── resolveFee ───────────────────────────────────────────────────────────────

describe('resolveFee', () => {
  it('NONE: always returns fee=0', () => {
    expect(resolveFee(0.5, false, 'NONE', 10)).toEqual({ fee: 0, inferred: false, missing: false });
  });

  it('ACTUAL: uses explicit fee', () => {
    expect(resolveFee(0.2, false, 'ACTUAL', 10)).toEqual({
      fee: 0.2,
      inferred: false,
      missing: false,
    });
  });

  it('ACTUAL: missing fee → fee=0 and missing=true', () => {
    expect(resolveFee(null, false, 'ACTUAL', 10)).toEqual({
      fee: 0,
      inferred: false,
      missing: true,
    });
  });

  it('REALISTIC: uses explicit fee when present', () => {
    expect(resolveFee(0.3, false, 'REALISTIC', 10)).toEqual({
      fee: 0.3,
      inferred: false,
      missing: false,
    });
  });

  it('REALISTIC: infers 2% when fee is missing', () => {
    const result = resolveFee(null, false, 'REALISTIC', 10);
    expect(result.fee).toBeCloseTo(0.2);
    expect(result.inferred).toBe(true);
    expect(result.missing).toBe(false);
  });

  it('REALISTIC: marks inferred=true for ingestion-inferred fees', () => {
    expect(resolveFee(0.2, true, 'REALISTIC', 10)).toEqual({
      fee: 0.2,
      inferred: true,
      missing: false,
    });
  });
});

// ─── buildPnlSnapshot — basic accounting ─────────────────────────────────────

describe('buildPnlSnapshot', () => {
  it('1. Simple round-trip: BUY 10 @ 0.40, SELL 10 @ 0.70 → realizedGross = 3.0', () => {
    const events = [
      event({ ts: T2, eventType: 'BUY', effectiveSide: 'BUY', shares: 10, price: 0.4, fee: 0 }),
      event({ ts: T2, eventType: 'SELL', effectiveSide: 'SELL', shares: 10, price: 0.7, fee: 0 }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'NONE');
    expect(snap.cumulativeRealizedGross).toBeCloseTo(3.0);
    // Position should be fully closed
    const pos = snap.positionsByKey.get('cond-1:YES');
    expect(pos?.netShares ?? 0).toBeCloseTo(0);
  });

  it('2. Partial sell: BUY 20 @ 0.50 before window, SELL 8 @ 0.70 in window → realizedGross = 1.6', () => {
    const allEvents = [
      event({
        id: 'e-buy',
        ts: T0,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 20,
        price: 0.5,
        fee: 0,
      }),
      event({
        id: 'e-sell',
        ts: T2,
        eventType: 'SELL',
        effectiveSide: 'SELL',
        shares: 8,
        price: 0.7,
        fee: 0,
      }),
    ];
    const tStart = new Date(T1);
    const tEnd = new Date(T3);

    const snapStart = buildPnlSnapshot(allEvents, tStart, 'NONE');
    const snapEnd = buildPnlSnapshot(allEvents, tEnd, 'NONE');

    const windowRealized = snapEnd.cumulativeRealizedGross - snapStart.cumulativeRealizedGross;
    expect(windowRealized).toBeCloseTo(1.6); // 8 * (0.70 - 0.50)

    // 12 shares should remain open at end
    const endPos = snapEnd.positionsByKey.get('cond-1:YES');
    expect(endPos?.netShares).toBeCloseTo(12);
    expect(endPos?.avgEntryPrice).toBeCloseTo(0.5);
  });

  it('3. Pure unrealized movement: BUY before window, no trades in window; mark moves 0.50→0.60 → realizedGross = 0', () => {
    const allEvents = [
      event({ ts: T0, eventType: 'BUY', effectiveSide: 'BUY', shares: 10, price: 0.4, fee: 0 }),
    ];
    const tStart = new Date(T1);
    const tEnd = new Date(T3);

    const snapStart = buildPnlSnapshot(allEvents, tStart, 'NONE');
    const snapEnd = buildPnlSnapshot(allEvents, tEnd, 'NONE');

    const windowRealized = snapEnd.cumulativeRealizedGross - snapStart.cumulativeRealizedGross;
    expect(windowRealized).toBeCloseTo(0);

    // Shares should be unchanged in both snapshots
    expect(snapStart.positionsByKey.get('cond-1:YES')?.netShares).toBeCloseTo(10);
    expect(snapEnd.positionsByKey.get('cond-1:YES')?.netShares).toBeCloseTo(10);
  });

  it('4a. Fee modes — ACTUAL: uses explicit fee', () => {
    const events = [
      event({
        ts: T2,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: 0.1,
      }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'ACTUAL');
    expect(snap.cumulativeFees).toBeCloseTo(0.1);
  });

  it('4b. Fee modes — REALISTIC: infers 2% when fee missing', () => {
    const events = [
      event({
        ts: T2,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: null, // missing
      }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'REALISTIC');
    // notional = 5.0, fee = 5.0 * 0.02 = 0.10
    expect(snap.cumulativeFees).toBeCloseTo(0.1);
    expect(snap.inferredFeeCount).toBe(1);
  });

  it('4c. Fee modes — NONE: always fee=0 regardless of event fee', () => {
    const events = [
      event({
        ts: T2,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: 0.5,
      }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'NONE');
    expect(snap.cumulativeFees).toBe(0);
  });

  it('4d. Same realized PnL regardless of fee mode', () => {
    const buy = event({ ts: T0, eventType: 'BUY', effectiveSide: 'BUY', shares: 10, price: 0.4 });
    const sell = event({
      ts: T2,
      eventType: 'SELL',
      effectiveSide: 'SELL',
      shares: 10,
      price: 0.7,
      fee: 0.1,
    });
    const allEvents = [buy, sell];

    const snapActual = buildPnlSnapshot(allEvents, new Date(T3), 'ACTUAL');
    const snapRealistic = buildPnlSnapshot(allEvents, new Date(T3), 'REALISTIC');
    const snapNone = buildPnlSnapshot(allEvents, new Date(T3), 'NONE');

    // Realized gross is always the same (fee-independent)
    expect(snapActual.cumulativeRealizedGross).toBeCloseTo(3.0);
    expect(snapRealistic.cumulativeRealizedGross).toBeCloseTo(3.0);
    expect(snapNone.cumulativeRealizedGross).toBeCloseTo(3.0);

    // Fees differ
    expect(snapActual.cumulativeFees).toBeCloseTo(0.1);
    expect(snapNone.cumulativeFees).toBe(0);
  });

  it('5. Multiple positions: two markets, verify per-position realized sums correctly', () => {
    const events = [
      // Market A (YES): BUY 10 @ 0.30, SELL 10 @ 0.80 → realized = 5.0
      event({
        ts: T0,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.3,
        fee: 0,
        conditionId: 'cond-A',
        marketId: 'market-A',
        outcome: 'YES',
      }),
      event({
        ts: T2,
        eventType: 'SELL',
        effectiveSide: 'SELL',
        shares: 10,
        price: 0.8,
        fee: 0,
        conditionId: 'cond-A',
        marketId: 'market-A',
        outcome: 'YES',
      }),
      // Market B (YES): BUY 10 @ 0.70, SELL 10 @ 0.20 → realized = -5.0
      event({
        ts: T0,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.7,
        fee: 0,
        conditionId: 'cond-B',
        marketId: 'market-B',
        outcome: 'YES',
      }),
      event({
        ts: T2,
        eventType: 'SELL',
        effectiveSide: 'SELL',
        shares: 10,
        price: 0.2,
        fee: 0,
        conditionId: 'cond-B',
        marketId: 'market-B',
        outcome: 'YES',
      }),
    ];

    const snap = buildPnlSnapshot(events, new Date(T3), 'NONE');

    const posA = snap.positionsByKey.get('cond-A:YES');
    const posB = snap.positionsByKey.get('cond-B:YES');

    expect(posA?.cumulativeRealizedGross).toBeCloseTo(5.0);
    expect(posB?.cumulativeRealizedGross).toBeCloseTo(-5.0);
    expect(snap.cumulativeRealizedGross).toBeCloseTo(0.0); // net: +5 - 5 = 0
  });

  it('6. Position opened in window: no start position, BUY in window → openedInWindow', () => {
    const allEvents = [
      event({ ts: T2, eventType: 'BUY', effectiveSide: 'BUY', shares: 10, price: 0.4, fee: 0 }),
    ];
    const tStart = new Date(T1);
    const tEnd = new Date(T3);

    const snapStart = buildPnlSnapshot(allEvents, tStart, 'NONE');
    const snapEnd = buildPnlSnapshot(allEvents, tEnd, 'NONE');

    const startPos = snapStart.positionsByKey.get('cond-1:YES');
    const endPos = snapEnd.positionsByKey.get('cond-1:YES');

    const startShares = startPos?.netShares ?? 0;
    const endShares = endPos?.netShares ?? 0;

    expect(startShares).toBeCloseTo(0); // not open at start
    expect(endShares).toBeCloseTo(10); // open at end
    // openedInWindow = startShares ≈ 0 && endShares > 0
    expect(startShares < 1e-9 && endShares > 1e-9).toBe(true);
  });

  it('7. Position closed in window: open at start, SELL all in window → closedInWindow', () => {
    const allEvents = [
      event({
        id: 'e-pre',
        ts: T0,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.4,
        fee: 0,
      }),
      event({
        id: 'e-close',
        ts: T2,
        eventType: 'SELL',
        effectiveSide: 'SELL',
        shares: 10,
        price: 0.6,
        fee: 0,
      }),
    ];
    const tStart = new Date(T1);
    const tEnd = new Date(T3);

    const snapStart = buildPnlSnapshot(allEvents, tStart, 'NONE');
    const snapEnd = buildPnlSnapshot(allEvents, tEnd, 'NONE');

    const startShares = snapStart.positionsByKey.get('cond-1:YES')?.netShares ?? 0;
    const endShares = snapEnd.positionsByKey.get('cond-1:YES')?.netShares ?? 0;

    expect(startShares).toBeCloseTo(10); // open at start
    expect(endShares).toBeCloseTo(0); // closed by end
    // closedInWindow = startShares > 0 && endShares ≈ 0
    expect(startShares > 1e-9 && endShares < 1e-9).toBe(true);
  });

  it('8. REDEEM with null shares/price: BUY 10 @ 0.40 → REDEEM (no price, no notional) → realizedGross = -4.0', () => {
    const allEvents = [
      event({ ts: T0, eventType: 'BUY', effectiveSide: 'BUY', shares: 10, price: 0.4, fee: 0 }),
      event({
        ts: T2,
        eventType: 'REDEEM',
        effectiveSide: 'SELL',
        shares: null,
        price: null,
        notional: null,
        fee: 0,
      }),
    ];

    const snap = buildPnlSnapshot(allEvents, new Date(T3), 'NONE');

    // REDEEM with no price/shares → inferred close at price=0
    // realized = 10 * (0 - 0.40) = -4.0
    expect(snap.cumulativeRealizedGross).toBeCloseTo(-4.0);
    // Position fully closed
    expect(snap.positionsByKey.get('cond-1:YES')?.netShares ?? 0).toBeCloseTo(0);
  });

  it('9. Empty window: no events in window → all deltas = 0', () => {
    const allEvents = [
      event({ ts: T0, eventType: 'BUY', effectiveSide: 'BUY', shares: 5, price: 0.5, fee: 0 }),
    ];
    const tStart = new Date(T1);
    const tEnd = new Date(T3);

    const snapStart = buildPnlSnapshot(allEvents, tStart, 'NONE');
    const snapEnd = buildPnlSnapshot(allEvents, tEnd, 'NONE');

    const windowRealized = snapEnd.cumulativeRealizedGross - snapStart.cumulativeRealizedGross;
    const windowFees = snapEnd.cumulativeFees - snapStart.cumulativeFees;

    expect(windowRealized).toBe(0);
    expect(windowFees).toBe(0);
    // No trades in [T1, T3], so snapshots are identical
    expect(snapStart.cumulativeRealizedGross).toBe(snapEnd.cumulativeRealizedGross);
  });

  it('10a. Confidence — HIGH: full history, no missing fees, no inferred fees', () => {
    const events = [
      event({
        ts: T2,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: 0.1,
        feeIsInferred: false,
      }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'ACTUAL');
    expect(snap.missingFeeCount).toBe(0);
    expect(snap.inferredFeeCount).toBe(0);
  });

  it('10b. Confidence — PARTIAL: inferred fees trigger non-HIGH', () => {
    const events = [
      event({
        ts: T2,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: null, // triggers inferred fee in REALISTIC mode
      }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'REALISTIC');
    expect(snap.inferredFeeCount).toBe(1);
    expect(snap.missingFeeCount).toBe(0);
  });

  it('10c. Confidence — missing fees in ACTUAL mode', () => {
    const events = [
      event({
        ts: T2,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: null,
      }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'ACTUAL');
    expect(snap.missingFeeCount).toBe(1);
    expect(snap.inferredFeeCount).toBe(0);
  });

  it('11. Weighted average cost basis on incremental buys', () => {
    // BUY 10 @ 0.40 → avg = 0.40
    // BUY 10 @ 0.60 → avg = (10*0.40 + 10*0.60) / 20 = 0.50
    const events = [
      event({ ts: T0, eventType: 'BUY', effectiveSide: 'BUY', shares: 10, price: 0.4 }),
      event({ ts: T2, eventType: 'BUY', effectiveSide: 'BUY', shares: 10, price: 0.6 }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'NONE');
    const pos = snap.positionsByKey.get('cond-1:YES');
    expect(pos?.avgEntryPrice).toBeCloseTo(0.5);
    expect(pos?.netShares).toBeCloseTo(20);
  });

  it('12. Sell clamping: cannot sell more shares than held', () => {
    const events = [
      event({ ts: T0, eventType: 'BUY', effectiveSide: 'BUY', shares: 5, price: 0.5 }),
      event({ ts: T2, eventType: 'SELL', effectiveSide: 'SELL', shares: 100, price: 0.8 }), // clamped to 5
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'NONE');
    const pos = snap.positionsByKey.get('cond-1:YES');
    // Only 5 shares could be closed
    expect(snap.cumulativeRealizedGross).toBeCloseTo(1.5); // 5 * (0.8 - 0.5)
    expect(pos?.netShares ?? 0).toBeCloseTo(0);
  });

  it('13. Duplicate event IDs are skipped', () => {
    const sharedId = 'dup-event';
    const events = [
      event({
        id: sharedId,
        ts: T0,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
      }),
      event({
        id: sharedId,
        ts: T0,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
      }), // duplicate
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'NONE');
    const pos = snap.positionsByKey.get('cond-1:YES');
    // Only one BUY processed
    expect(pos?.netShares).toBeCloseTo(10);
  });

  it('14. Non-trade event types are skipped', () => {
    const events = [
      event({ ts: T2, eventType: 'TRANSFER', effectiveSide: null, shares: 100, price: 1.0 }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'NONE');
    expect(snap.positionsByKey.size).toBe(0);
    expect(snap.cumulativeRealizedGross).toBe(0);
  });

  it('15. Per-position fees tracked separately from aggregate', () => {
    const events = [
      event({
        ts: T0,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: 0.2,
        conditionId: 'cond-A',
        marketId: 'mkt-A',
        outcome: 'YES',
      }),
      event({
        ts: T2,
        eventType: 'BUY',
        effectiveSide: 'BUY',
        shares: 10,
        price: 0.5,
        fee: 0.3,
        conditionId: 'cond-B',
        marketId: 'mkt-B',
        outcome: 'YES',
      }),
    ];
    const snap = buildPnlSnapshot(events, new Date(T3), 'ACTUAL');
    expect(snap.cumulativeFees).toBeCloseTo(0.5);
    expect(snap.positionFeesByKey.get('cond-A:YES')).toBeCloseTo(0.2);
    expect(snap.positionFeesByKey.get('cond-B:YES')).toBeCloseTo(0.3);
  });

  it('16. Events after cutoff are excluded from snapshot', () => {
    const inWindow = event({
      ts: T2,
      eventType: 'BUY',
      effectiveSide: 'BUY',
      shares: 10,
      price: 0.5,
    });
    const afterWindow = event({
      ts: '2024-01-10T00:00:00.000Z',
      eventType: 'BUY',
      effectiveSide: 'BUY',
      shares: 999,
      price: 0.9,
    });

    const snap = buildPnlSnapshot([inWindow, afterWindow], new Date(T3), 'NONE');
    const pos = snap.positionsByKey.get('cond-1:YES');
    // Only the in-window BUY should have been processed
    expect(pos?.netShares).toBeCloseTo(10);
  });
});
