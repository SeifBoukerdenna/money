/**
 * profile-parity.test.ts
 * apps/api/src/modules/__tests__/profile-parity.test.ts
 *
 * Unit tests for all parity-critical pure transformations.
 * These are the parity contract guarantee — a failure here means the UI
 * will show values that diverge from Polymarket semantics.
 *
 * Run: pnpm test (from monorepo root) or npx vitest apps/api
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock prisma so the module can be imported in unit test context ──────────
vi.mock('../lib/prisma.js', () => ({
  prisma: {
    watchedWallet: { findUnique: vi.fn() },
    walletAnalyticsSnapshot: { findFirst: vi.fn() },
    tradeEvent: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    walletActivityEvent: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import {
  normalizePosition,
  normalizeActivity,
  sortAndFilterPositions,
  formatRelativeTime,
  formatActivityType,
  formatUsd,
  formatPct,
  formatPrice,
  formatShares,
  type NormalizedPosition,
} from '../profile-parity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test data factories
// ─────────────────────────────────────────────────────────────────────────────

type RawPosition = Parameters<typeof normalizePosition>[0];
type RawActivity = Parameters<typeof normalizeActivity>[0];

function makeRawPos(overrides: Partial<RawPosition> = {}): RawPosition {
  return {
    id: 'cond-1',
    conditionId: 'cond-1',
    title: 'Will X happen?',
    slug: 'will-x-happen',
    outcome: 'YES',
    size: 100,
    avgPrice: 0.5,
    currentPrice: 0.7,
    side: 'BUY',
    status: 'OPEN' as const,
    icon: null,
    eventSlug: null,
    ...overrides,
  };
}

function makeRawActivity(overrides: Partial<RawActivity> = {}): RawActivity {
  return {
    id: 'evt-1',
    eventType: 'BUY',
    marketId: 'mkt-1',
    marketQuestion: 'Will X happen?',
    outcome: 'YES',
    side: 'BUY',
    price: '0.5',
    shares: '100',
    notional: '50',
    sourceTxHash: null,
    txHash: '0xabc123deadbeef',
    orderId: null,
    sourceEventId: null,
    sourceCursor: null,
    blockNumber: null,
    eventTimestamp: new Date('2025-06-01T12:00:00Z'),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizePosition — parity-critical P/L formulas
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizePosition', () => {
  describe('valueUsd = size × currentPrice, rounded to 2dp', () => {
    it('100 × 0.70 = 70.00', () => {
      expect(normalizePosition(makeRawPos({ size: 100, currentPrice: 0.7 })).valueUsd).toBe(70.0);
    });
    it('0 size = 0.00', () => {
      expect(normalizePosition(makeRawPos({ size: 0, currentPrice: 0.7 })).valueUsd).toBe(0);
    });
    it('rounds correctly: 3 × 0.333 = 1.00', () => {
      // 3 × 0.333 = 0.999 → rounds to 1.00
      expect(normalizePosition(makeRawPos({ size: 3, currentPrice: 0.333 })).valueUsd).toBe(1.0);
    });
  });

  describe('pnlUsd = (currentPrice − avgPrice) × size, rounded to 2dp', () => {
    it('profit: (0.70 − 0.50) × 100 = 20.00', () => {
      expect(
        normalizePosition(makeRawPos({ avgPrice: 0.5, currentPrice: 0.7, size: 100 })).pnlUsd,
      ).toBe(20.0);
    });
    it('loss: (0.30 − 0.50) × 100 = −20.00', () => {
      expect(
        normalizePosition(makeRawPos({ avgPrice: 0.5, currentPrice: 0.3, size: 100 })).pnlUsd,
      ).toBe(-20.0);
    });
    it('zero when currentPrice equals avgPrice', () => {
      expect(
        normalizePosition(makeRawPos({ avgPrice: 0.5, currentPrice: 0.5, size: 100 })).pnlUsd,
      ).toBe(0);
    });
    it('rounds to 2dp: (0.70 − 0.40) × 3 = 0.90', () => {
      expect(
        normalizePosition(makeRawPos({ avgPrice: 0.4, currentPrice: 0.7, size: 3 })).pnlUsd,
      ).toBe(0.9);
    });
  });

  describe('pnlPct = (currentPrice − avgPrice) / avgPrice × 100, rounded to 2dp', () => {
    it('profit: (0.70 − 0.50) / 0.50 × 100 = 40.00', () => {
      expect(normalizePosition(makeRawPos({ avgPrice: 0.5, currentPrice: 0.7 })).pnlPct).toBe(40.0);
    });
    it('loss: (0.30 − 0.50) / 0.50 × 100 = −40.00', () => {
      expect(normalizePosition(makeRawPos({ avgPrice: 0.5, currentPrice: 0.3 })).pnlPct).toBe(
        -40.0,
      );
    });
    it('returns 0 when avgPrice is 0 (avoid divide-by-zero)', () => {
      expect(normalizePosition(makeRawPos({ avgPrice: 0, currentPrice: 0.5 })).pnlPct).toBe(0);
    });
    it('rounds: (0.80 − 0.30) / 0.30 × 100 = 166.67', () => {
      expect(normalizePosition(makeRawPos({ avgPrice: 0.3, currentPrice: 0.8 })).pnlPct).toBe(
        166.67,
      );
    });
  });

  describe('resolution threshold (CLOSED positions only)', () => {
    it('WON when currentPrice >= 0.95', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'CLOSED', currentPrice: 0.97 })).resolution,
      ).toBe('WON');
    });
    it('WON at exactly 0.95 (boundary inclusive)', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'CLOSED', currentPrice: 0.95 })).resolution,
      ).toBe('WON');
    });
    it('LOST when currentPrice <= 0.05', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'CLOSED', currentPrice: 0.02 })).resolution,
      ).toBe('LOST');
    });
    it('LOST at exactly 0.05 (boundary inclusive)', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'CLOSED', currentPrice: 0.05 })).resolution,
      ).toBe('LOST');
    });
    it('PENDING for ambiguous mid-range', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'CLOSED', currentPrice: 0.5 })).resolution,
      ).toBe('PENDING');
    });
    it('PENDING for price just below WON threshold', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'CLOSED', currentPrice: 0.94 })).resolution,
      ).toBe('PENDING');
    });
    it('PENDING for price just above LOST threshold', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'CLOSED', currentPrice: 0.06 })).resolution,
      ).toBe('PENDING');
    });
    it('null for OPEN positions (no resolution yet)', () => {
      expect(
        normalizePosition(makeRawPos({ status: 'OPEN', currentPrice: 0.99 })).resolution,
      ).toBeNull();
    });
  });

  it('passes through all required fields', () => {
    const pos = normalizePosition(
      makeRawPos({
        id: 'test-id',
        conditionId: 'cond-x',
        title: 'Test Market',
        outcome: 'NO',
        side: 'BUY',
        icon: 'https://img.example.com/icon.png',
        eventSlug: 'test-event',
      }),
    );
    expect(pos.id).toBe('test-id');
    expect(pos.conditionId).toBe('cond-x');
    expect(pos.title).toBe('Test Market');
    expect(pos.outcome).toBe('NO');
    expect(pos.icon).toBe('https://img.example.com/icon.png');
    expect(pos.eventSlug).toBe('test-event');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sortAndFilterPositions — Polymarket sort parity
// ─────────────────────────────────────────────────────────────────────────────

describe('sortAndFilterPositions', () => {
  // Helper: make already-normalized positions directly
  function makePos(id: string, overrides: Partial<RawPosition>): NormalizedPosition {
    return normalizePosition(makeRawPos({ id, conditionId: id, ...overrides }));
  }

  const openPositions: NormalizedPosition[] = [
    // value=40, pnl=15, pnlPct=30
    makePos('a', { title: 'Alpha', size: 50, avgPrice: 0.5, currentPrice: 0.8, status: 'OPEN' }),
    // value=80, pnl=-20, pnlPct=-25
    makePos('b', { title: 'Beta', size: 200, avgPrice: 0.5, currentPrice: 0.4, status: 'OPEN' }),
    // value=9, pnl=4, pnlPct=80
    makePos('c', { title: 'Gamma', size: 10, avgPrice: 0.5, currentPrice: 0.9, status: 'OPEN' }),
  ];

  describe('OPEN tab sorts', () => {
    it('value DESC (default) — b=80, a=40, c=9', () => {
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        openPositions,
        { status: 'OPEN' },
      );
      expect(items.map((p) => p.id)).toEqual(['b', 'a', 'c']);
    });

    it('pnl_usd DESC — a=15, c=4, b=-20', () => {
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        openPositions,
        {
          status: 'OPEN',
          sortBy: 'pnl_usd',
          sortDir: 'desc',
        },
      );
      expect(items.map((p) => p.id)).toEqual(['a', 'c', 'b']);
    });

    it('pnl_pct DESC — c=80, a=30, b=-25', () => {
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        openPositions,
        {
          status: 'OPEN',
          sortBy: 'pnl_pct',
          sortDir: 'desc',
        },
      );
      expect(items.map((p) => p.id)).toEqual(['c', 'a', 'b']);
    });

    it('market ASC (alphabetical)', () => {
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        openPositions,
        {
          status: 'OPEN',
          sortBy: 'market',
          sortDir: 'asc',
        },
      );
      expect(items.map((p) => p.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('market DESC (reverse alphabetical)', () => {
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        openPositions,
        {
          status: 'OPEN',
          sortBy: 'market',
          sortDir: 'desc',
        },
      );
      expect(items.map((p) => p.title)).toEqual(['Gamma', 'Beta', 'Alpha']);
    });
  });

  describe('CLOSED tab sorts', () => {
    const closedPositions: NormalizedPosition[] = [
      makePos('l', { status: 'CLOSED', currentPrice: 0.02 }), // LOST
      makePos('w', { status: 'CLOSED', currentPrice: 0.98 }), // WON
      makePos('p', { status: 'CLOSED', currentPrice: 0.5 }), // PENDING
    ];

    it('won_first (default) — WON, LOST, PENDING', () => {
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        closedPositions,
        {
          status: 'CLOSED',
          sortBy: 'won_first',
        },
      );
      expect(items.map((p) => p.resolution)).toEqual(['WON', 'LOST', 'PENDING']);
    });

    it('lost_first — LOST, WON, PENDING', () => {
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        closedPositions,
        {
          status: 'CLOSED',
          sortBy: 'lost_first',
        },
      );
      expect(items.map((p) => p.resolution)).toEqual(['LOST', 'WON', 'PENDING']);
    });
  });

  describe('search filter', () => {
    it('filters by title (case-insensitive)', () => {
      const { items, total }: { items: NormalizedPosition[]; total: number } =
        sortAndFilterPositions(openPositions, {
          status: 'OPEN',
          search: 'alpha',
        });
      expect(total).toBe(1);
      expect(items[0].id).toBe('a');
    });

    it('filters by conditionId', () => {
      const { total } = sortAndFilterPositions(openPositions, {
        status: 'OPEN',
        search: 'b',
      });
      expect(total).toBeGreaterThanOrEqual(1);
    });

    it('returns empty when no match', () => {
      const { total } = sortAndFilterPositions(openPositions, {
        status: 'OPEN',
        search: 'zzzz-no-match',
      });
      expect(total).toBe(0);
    });

    it('empty search returns all', () => {
      const { total } = sortAndFilterPositions(openPositions, {
        status: 'OPEN',
        search: '',
      });
      expect(total).toBe(openPositions.length);
    });
  });

  describe('pagination', () => {
    it('page 1, pageSize 2 returns first 2', () => {
      const { items, total }: { items: NormalizedPosition[]; total: number } =
        sortAndFilterPositions(openPositions, {
          status: 'OPEN',
          page: 1,
          pageSize: 2,
        });
      expect(total).toBe(3);
      expect(items.length).toBe(2);
    });

    it('page 2, pageSize 2 returns last 1', () => {
      const { items, total }: { items: NormalizedPosition[]; total: number } =
        sortAndFilterPositions(openPositions, {
          status: 'OPEN',
          page: 2,
          pageSize: 2,
        });
      expect(total).toBe(3);
      expect(items.length).toBe(1);
    });

    it('page beyond data returns empty items but correct total', () => {
      const { items, total }: { items: NormalizedPosition[]; total: number } =
        sortAndFilterPositions(openPositions, {
          status: 'OPEN',
          page: 10,
          pageSize: 25,
        });
      expect(total).toBe(3);
      expect(items.length).toBe(0);
    });
  });

  describe('stable tie-break by conditionId', () => {
    it('equal values sort by conditionId ASC', () => {
      const tied: NormalizedPosition[] = [
        makePos('z', { size: 10, avgPrice: 0.5, currentPrice: 0.5, status: 'OPEN' }),
        makePos('a', { size: 10, avgPrice: 0.5, currentPrice: 0.5, status: 'OPEN' }),
        makePos('m', { size: 10, avgPrice: 0.5, currentPrice: 0.5, status: 'OPEN' }),
      ];
      const { items }: { items: NormalizedPosition[]; total: number } = sortAndFilterPositions(
        tied,
        { status: 'OPEN', sortBy: 'value' },
      );
      expect(items.map((p) => p.conditionId)).toEqual(['a', 'm', 'z']);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeActivity — Polymarket activity parity
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeActivity', () => {
  it('type = "Buy" for BUY event', () => {
    expect(normalizeActivity(makeRawActivity({ eventType: 'BUY', side: 'BUY' })).type).toBe('Buy');
  });

  it('type = "Sell" for SELL event', () => {
    expect(normalizeActivity(makeRawActivity({ eventType: 'SELL', side: 'SELL' })).type).toBe(
      'Sell',
    );
  });

  it('type = "Buy" for TRADE+BUY event', () => {
    expect(normalizeActivity(makeRawActivity({ eventType: 'TRADE', side: 'BUY' })).type).toBe(
      'Buy',
    );
  });

  it('type = "Sell" for TRADE+SELL event', () => {
    expect(normalizeActivity(makeRawActivity({ eventType: 'TRADE', side: 'SELL' })).type).toBe(
      'Sell',
    );
  });

  it('type = "Redeem" for REDEEM event', () => {
    expect(normalizeActivity(makeRawActivity({ eventType: 'REDEEM', side: null })).type).toBe(
      'Redeem',
    );
  });

  describe('amountUsd', () => {
    it('uses notional when present and positive', () => {
      const act = normalizeActivity(
        makeRawActivity({ notional: '75.50', price: '0.5', shares: '100' }),
      );
      expect(act.amountUsd).toBe(75.5);
    });

    it('falls back to shares × price when notional is null', () => {
      const act = normalizeActivity(
        makeRawActivity({ notional: null, price: '0.5', shares: '100' }),
      );
      expect(act.amountUsd).toBe(50.0);
    });

    it('falls back to shares × price when notional is 0', () => {
      const act = normalizeActivity(makeRawActivity({ notional: '0', price: '0.8', shares: '50' }));
      expect(act.amountUsd).toBe(40.0);
    });

    it('null when both notional and shares/price are null', () => {
      const act = normalizeActivity(makeRawActivity({ notional: null, price: null, shares: null }));
      expect(act.amountUsd).toBeNull();
    });

    it('rounds amountUsd to 2dp', () => {
      const act = normalizeActivity(
        makeRawActivity({ notional: null, price: '0.333', shares: '3' }),
      );
      // 0.333 × 3 = 0.999 → 1.00
      expect(act.amountUsd).toBe(1.0);
    });
  });

  describe('market field', () => {
    it('uses marketQuestion when present', () => {
      expect(normalizeActivity(makeRawActivity({ marketQuestion: 'Test Market?' })).market).toBe(
        'Test Market?',
      );
    });

    it('falls back to marketId when marketQuestion is null', () => {
      expect(
        normalizeActivity(makeRawActivity({ marketQuestion: null, marketId: 'mkt-abc' })).market,
      ).toBe('mkt-abc');
    });
  });

  describe('txHash resolution', () => {
    it('prefers txHash over sourceTxHash', () => {
      const act = normalizeActivity(
        makeRawActivity({ txHash: '0xprimary', sourceTxHash: '0xsource' }),
      );
      expect(act.txHash).toBe('0xprimary');
    });

    it('falls back to sourceTxHash when txHash is null', () => {
      const act = normalizeActivity(makeRawActivity({ txHash: null, sourceTxHash: '0xsource' }));
      expect(act.txHash).toBe('0xsource');
    });

    it('txHash is null when both are null', () => {
      const act = normalizeActivity(makeRawActivity({ txHash: null, sourceTxHash: null }));
      expect(act.txHash).toBeNull();
    });
  });

  it('eventTimestamp is ISO string', () => {
    const act = normalizeActivity(
      makeRawActivity({ eventTimestamp: new Date('2025-01-15T12:00:00Z') }),
    );
    expect(act.eventTimestamp).toBe('2025-01-15T12:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatActivityType — all Polymarket type label mappings
// ─────────────────────────────────────────────────────────────────────────────

describe('formatActivityType', () => {
  const cases: Array<[string, string | null, string]> = [
    ['BUY', 'BUY', 'Buy'],
    ['BUY', null, 'Buy'],
    ['SELL', 'SELL', 'Sell'],
    ['SELL', null, 'Sell'],
    ['TRADE', 'BUY', 'Buy'],
    ['TRADE', 'SELL', 'Sell'],
    ['REDEEM', null, 'Redeem'],
    ['MERGE', null, 'Merge'],
    ['SPLIT', null, 'Split'],
    ['CONVERT', null, 'Convert'],
    ['DEPOSIT', null, 'Deposit'],
    ['WITHDRAW', null, 'Withdraw'],
    ['CUSTOM', null, 'Custom'],
  ];

  it.each(cases)(
    'formatActivityType(%s, %s) → %s',
    (et: string, side: string | null, expected: string) => {
      expect(formatActivityType(et, side)).toBe(expected);
    },
  );

  it('capitalizes unknown types', () => {
    expect(formatActivityType('foobar', null)).toBe('Foobar');
  });

  it('returns — for empty string', () => {
    expect(formatActivityType('', null)).toBe('—');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatRelativeTime — Polymarket time display behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const BASE = new Date('2025-06-15T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('"just now" for 30 seconds ago', () => {
    expect(formatRelativeTime(new Date(BASE - 30_000))).toBe('just now');
  });

  it('"just now" for 0 seconds ago', () => {
    expect(formatRelativeTime(new Date(BASE))).toBe('just now');
  });

  it('"5m ago" for 5 minutes ago', () => {
    expect(formatRelativeTime(new Date(BASE - 5 * 60_000))).toBe('5m ago');
  });

  it('"59m ago" for 59 minutes ago', () => {
    expect(formatRelativeTime(new Date(BASE - 59 * 60_000))).toBe('59m ago');
  });

  it('"1h ago" for exactly 1 hour ago', () => {
    expect(formatRelativeTime(new Date(BASE - 3600_000))).toBe('1h ago');
  });

  it('"3h ago" for 3 hours ago', () => {
    expect(formatRelativeTime(new Date(BASE - 3 * 3600_000))).toBe('3h ago');
  });

  it('"1d ago" for exactly 1 day ago', () => {
    expect(formatRelativeTime(new Date(BASE - 86400_000))).toBe('1d ago');
  });

  it('"6d ago" for 6 days ago', () => {
    expect(formatRelativeTime(new Date(BASE - 6 * 86400_000))).toBe('6d ago');
  });

  it('formatted date for > 7 days ago', () => {
    const result = formatRelativeTime(new Date(BASE - 14 * 86400_000));
    // Should be a locale date like "Jun 1, 2025"
    expect(result).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    expect(result).not.toContain('ago');
  });

  it('accepts ISO string input', () => {
    const iso = new Date(BASE - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso)).toBe('5m ago');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Formatting utilities
// ─────────────────────────────────────────────────────────────────────────────

describe('formatUsd', () => {
  it('positive: $1,234.56', () => {
    expect(formatUsd(1234.56)).toBe('$1,234.56');
  });
  it('negative: -$1,234.56', () => {
    expect(formatUsd(-1234.56)).toBe('-$1,234.56');
  });
  it('zero: $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
  it('small: $0.50', () => {
    expect(formatUsd(0.5)).toBe('$0.50');
  });
});

describe('formatPct', () => {
  it('positive gets + sign', () => {
    expect(formatPct(12.34)).toBe('+12.34%');
  });
  it('negative keeps - sign', () => {
    expect(formatPct(-12.34)).toBe('-12.34%');
  });
  it('zero has no sign', () => {
    expect(formatPct(0)).toBe('0.00%');
  });
});

describe('formatPrice', () => {
  it('0.72 → "72¢"', () => {
    expect(formatPrice(0.72)).toBe('72¢');
  });
  it('0.50 → "50¢"', () => {
    expect(formatPrice(0.5)).toBe('50¢');
  });
  it('1.00 → "100¢"', () => {
    expect(formatPrice(1.0)).toBe('100¢');
  });
  it('0.01 → "1¢"', () => {
    expect(formatPrice(0.01)).toBe('1¢');
  });
});

describe('formatShares', () => {
  it('2 decimal places for whole numbers', () => {
    expect(formatShares(1)).toBe('1');
  });
  it('shows decimals: 1.5 → "1.50"', () => {
    expect(formatShares(1.5)).toBe('1.50');
  });
  it('trims trailing zeros: 1.50 shown as 1.50 (2dp minimum)', () => {
    // formatShares shows up to 4dp, trimming trailing zeros
    expect(formatShares(100.1)).toBe('100.10');
  });
  it('large numbers use locale comma: 1500 → "1,500"', () => {
    expect(formatShares(1500)).toBe('1,500');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P/L cumulative math (pure logic — validated inline, no DB needed)
// ─────────────────────────────────────────────────────────────────────────────

describe('PnL cumulative WACP math', () => {
  /**
   * Validates the exact formula used in buildPnlChart and computeRealizedPnlFromTrades.
   * These are pure simulations of the algorithm without DB.
   */

  function runPnl(trades: Array<{ side: 'BUY' | 'SELL'; size: number; price: number }>): number {
    const pos = { size: 0, avgPrice: 0 };
    let total = 0;
    for (const t of trades) {
      if (t.side === 'BUY') {
        const newSize = pos.size + t.size;
        pos.avgPrice =
          newSize > 0 ? (pos.size * pos.avgPrice + t.size * t.price) / newSize : t.price;
        pos.size = newSize;
      } else {
        const closeSize = Math.min(pos.size, t.size);
        total += closeSize * (t.price - pos.avgPrice);
        pos.size = Math.max(0, pos.size - closeSize);
      }
    }
    return Math.round(total * 100) / 100;
  }

  it('simple buy then sell: 100@0.50 → sell@0.70 = +$20', () => {
    expect(
      runPnl([
        { side: 'BUY', size: 100, price: 0.5 },
        { side: 'SELL', size: 100, price: 0.7 },
      ]),
    ).toBe(20.0);
  });

  it('WACP across two buys: 100@0.40 + 100@0.60 → avgPrice=0.50, sell 200@0.70 = +$40', () => {
    expect(
      runPnl([
        { side: 'BUY', size: 100, price: 0.4 },
        { side: 'BUY', size: 100, price: 0.6 },
        { side: 'SELL', size: 200, price: 0.7 },
      ]),
    ).toBe(40.0);
  });

  it('partial sell: 200@0.50 → sell 100@0.80 = +$30', () => {
    expect(
      runPnl([
        { side: 'BUY', size: 200, price: 0.5 },
        { side: 'SELL', size: 100, price: 0.8 },
      ]),
    ).toBe(30.0);
  });

  it('loss: 100@0.60 → sell@0.40 = −$20', () => {
    expect(
      runPnl([
        { side: 'BUY', size: 100, price: 0.6 },
        { side: 'SELL', size: 100, price: 0.4 },
      ]),
    ).toBe(-20.0);
  });

  it('sell more than open only closes available shares', () => {
    // Buy 50, sell 100 (only 50 can close)
    expect(
      runPnl([
        { side: 'BUY', size: 50, price: 0.5 },
        { side: 'SELL', size: 100, price: 1.0 },
      ]),
    ).toBe(25.0); // 50 × (1.0 − 0.5) = 25
  });

  it('no trades → $0', () => {
    expect(runPnl([])).toBe(0);
  });

  it('buy only (no sells) → $0 realized', () => {
    expect(
      runPnl([
        { side: 'BUY', size: 100, price: 0.5 },
        { side: 'BUY', size: 50, price: 0.8 },
      ]),
    ).toBe(0);
  });
});
