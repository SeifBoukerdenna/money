import { describe, expect, it } from 'vitest';
import {
  computeCash,
  computePortfolio,
  reconcile,
  reducePosition,
  roundShares,
  scaleShares,
  unrealizedPnl,
  type LedgerEntry,
  type ReducedPosition,
} from '../src/lib/paper-ledger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _entryId = 0;
function entry(
  overrides: Partial<LedgerEntry> & { side: 'BUY' | 'SELL'; shares: number; price: number },
): LedgerEntry {
  _entryId++;
  const shares = overrides.shares;
  const price = overrides.price;
  return {
    id: `e-${_entryId}`,
    sourceEventId: `src-${_entryId}`,
    marketId: 'market-1',
    outcome: 'YES',
    action: overrides.side,
    notional: shares * price,
    fee: 0,
    slippage: 0,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('paper-ledger — pure accounting math', () => {
  // ────────────────────────────────────────────────────────────────────
  // CASE 1: Multiple buys, partial sell → net shares
  // ────────────────────────────────────────────────────────────────────
  describe('Case 1: buy 10, buy 5, sell 8 → net shares = 7', () => {
    const entries: LedgerEntry[] = [
      entry({ side: 'BUY', shares: 10, price: 0.5 }),
      entry({ side: 'BUY', shares: 5, price: 0.6 }),
      entry({ side: 'SELL', shares: 8, price: 0.55 }),
    ];

    it('computes correct net shares', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBeCloseTo(7, 6);
    });

    it('position is OPEN', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.status).toBe('OPEN');
    });

    it('weighted average entry is correct', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      // avg = (10*0.50 + 5*0.60) / 15 = 8.0/15 ≈ 0.5333
      expect(pos.avgEntryPrice).toBeCloseTo((10 * 0.5 + 5 * 0.6) / 15, 6);
    });

    it('realized pnl from the partial sell', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      const avgEntry = (10 * 0.5 + 5 * 0.6) / 15;
      const expectedRealizedPnl = 8 * (0.55 - avgEntry);
      expect(pos.realizedPnl).toBeCloseTo(expectedRealizedPnl, 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CASE 2: Buy then sell all → fully closed
  // ────────────────────────────────────────────────────────────────────
  describe('Case 2: buy 10, sell 10 → closed', () => {
    const entries: LedgerEntry[] = [
      entry({ side: 'BUY', shares: 10, price: 0.5 }),
      entry({ side: 'SELL', shares: 10, price: 0.6 }),
    ];

    it('net shares = 0', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBe(0);
    });

    it('status is CLOSED', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.status).toBe('CLOSED');
    });

    it('realized pnl = (0.60 - 0.50) * 10 = 1.0', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.realizedPnl).toBeCloseTo(1.0, 6);
    });

    it('cash is replenished in portfolio', () => {
      const portfolio = computePortfolio(1000, entries, new Map());
      // Buy: -10*0.50 = -5.0, Sell: +10*0.60 = +6.0 → cash = 1001.0
      expect(portfolio.cash).toBeCloseTo(1001.0, 6);
    });

    it('closed positions list is populated', () => {
      const portfolio = computePortfolio(1000, entries, new Map());
      expect(portfolio.closedPositions).toHaveLength(1);
      expect(portfolio.openPositions).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CASE 3: Two partial sells → fully closed
  // ────────────────────────────────────────────────────────────────────
  describe('Case 3: buy 10, sell 5, sell 5 → closed', () => {
    const entries: LedgerEntry[] = [
      entry({ side: 'BUY', shares: 10, price: 0.5 }),
      entry({ side: 'SELL', shares: 5, price: 0.55 }),
      entry({ side: 'SELL', shares: 5, price: 0.6 }),
    ];

    it('net shares = 0, status CLOSED', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBe(0);
      expect(pos.status).toBe('CLOSED');
    });

    it('realized pnl sums both sells', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      // sell 5 @ 0.55: pnl = 5 * (0.55 - 0.50) = 0.25
      // sell 5 @ 0.60: pnl = 5 * (0.60 - 0.50) = 0.50
      expect(pos.realizedPnl).toBeCloseTo(0.75, 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CASE 4: Oversell → clamp (no negative drift)
  // ────────────────────────────────────────────────────────────────────
  describe('Case 4: buy 10, sell 15 → clamped at 0, no negative shares', () => {
    const entries: LedgerEntry[] = [
      entry({ side: 'BUY', shares: 10, price: 0.5 }),
      entry({ side: 'SELL', shares: 15, price: 0.6 }),
    ];

    it('net shares = 0 (clamped, not -5)', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBe(0);
    });

    it('status is CLOSED', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.status).toBe('CLOSED');
    });

    it('realized pnl only on available 10 shares', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      // Only closes 10 shares (clamped), not 15
      expect(pos.realizedPnl).toBeCloseTo(10 * (0.6 - 0.5), 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CASE 5: Wallet flip (close DOWN, open UP)
  // ────────────────────────────────────────────────────────────────────
  describe('Case 5: buy DOWN 10, sell DOWN 10, buy UP 10 → DOWN closed, UP open', () => {
    const entries: LedgerEntry[] = [
      entry({ side: 'BUY', shares: 10, price: 0.5, outcome: 'NO' }),
      entry({ side: 'SELL', shares: 10, price: 0.55, outcome: 'NO' }),
      entry({ side: 'BUY', shares: 10, price: 0.6, outcome: 'YES' }),
    ];

    it('DOWN position is closed', () => {
      const noEntries = entries.filter((e) => e.outcome === 'NO');
      const pos = reducePosition('market-1', 'NO', noEntries);
      expect(pos.status).toBe('CLOSED');
      expect(pos.netShares).toBe(0);
    });

    it('UP position is open', () => {
      const yesEntries = entries.filter((e) => e.outcome === 'YES');
      const pos = reducePosition('market-1', 'YES', yesEntries);
      expect(pos.status).toBe('OPEN');
      expect(pos.netShares).toBeCloseTo(10, 6);
    });

    it('portfolio shows both correctly', () => {
      const portfolio = computePortfolio(1000, entries, new Map());
      expect(portfolio.closedPositions).toHaveLength(1);
      expect(portfolio.openPositions).toHaveLength(1);
      expect(portfolio.closedPositions[0].outcome).toBe('NO');
      expect(portfolio.openPositions[0].outcome).toBe('YES');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CASE 6: Profitable close
  // ────────────────────────────────────────────────────────────────────
  describe('Case 6: buy 10 @ 0.40, sell 10 @ 0.70 → profit', () => {
    const entries: LedgerEntry[] = [
      entry({ side: 'BUY', shares: 10, price: 0.4 }),
      entry({ side: 'SELL', shares: 10, price: 0.7 }),
    ];

    it('realized pnl = 10 * (0.70 - 0.40) = 3.0', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.realizedPnl).toBeCloseTo(3.0, 6);
    });

    it('cash increases properly', () => {
      const portfolio = computePortfolio(1000, entries, new Map());
      // Buy: -4.0, Sell: +7.0 → net +3.0 → cash = 1003.0
      expect(portfolio.cash).toBeCloseTo(1003.0, 6);
    });

    it('total pnl = +3.0', () => {
      const portfolio = computePortfolio(1000, entries, new Map());
      expect(portfolio.totalPnl).toBeCloseTo(3.0, 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CASE 7: Losing close
  // ────────────────────────────────────────────────────────────────────
  describe('Case 7: buy 10 @ 0.70, sell 10 @ 0.40 → loss', () => {
    const entries: LedgerEntry[] = [
      entry({ side: 'BUY', shares: 10, price: 0.7 }),
      entry({ side: 'SELL', shares: 10, price: 0.4 }),
    ];

    it('realized pnl = 10 * (0.40 - 0.70) = -3.0', () => {
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.realizedPnl).toBeCloseTo(-3.0, 6);
    });

    it('cash replenished but less than started (net -3)', () => {
      const portfolio = computePortfolio(1000, entries, new Map());
      // Buy: -7.0, Sell: +4.0 → net -3.0 → cash = 997.0
      expect(portfolio.cash).toBeCloseTo(997.0, 6);
    });

    it('total pnl = -3.0', () => {
      const portfolio = computePortfolio(1000, entries, new Map());
      expect(portfolio.totalPnl).toBeCloseTo(-3.0, 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Copy ratio scaling
  // ────────────────────────────────────────────────────────────────────
  describe('Copy ratio', () => {
    it('scales shares, not dollars', () => {
      expect(scaleShares(100, 0.5)).toBeCloseTo(50, 6);
      expect(scaleShares(37, 0.3)).toBeCloseTo(11.1, 6);
    });

    it('rounds to 8 decimal places', () => {
      const result = scaleShares(1, 1 / 3);
      // 1/3 = 0.33333333... → rounded to 8 dp = 0.33333333
      expect(result).toBeCloseTo(0.33333333, 8);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Partial reduction with copy ratio
  // ────────────────────────────────────────────────────────────────────
  describe('Partial reduction with copy ratio', () => {
    it('source buys 100, sells 30, ratio 0.5 → sim: buy 50, sell 15, remaining 35', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: scaleShares(100, 0.5), price: 0.5 }),
        entry({ side: 'SELL', shares: scaleShares(30, 0.5), price: 0.55 }),
      ];

      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBeCloseTo(35, 6);
      expect(pos.status).toBe('OPEN');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Fees affect realized PnL and cash
  // ────────────────────────────────────────────────────────────────────
  describe('Fee accounting', () => {
    it('fees reduce realized pnl on sells', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 100, price: 0.5, fee: 1.0 }),
        entry({ side: 'SELL', shares: 100, price: 0.6, fee: 1.2 }),
      ];

      const pos = reducePosition('market-1', 'YES', entries);
      // Raw PnL: 100 * (0.60 - 0.50) = 10.0
      // Sell fee: -1.2
      // Realized PnL = 10.0 - 1.2 = 8.8
      expect(pos.realizedPnl).toBeCloseTo(8.8, 6);
    });

    it('fees reduce cash balance on both buy and sell', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 100, price: 0.5, fee: 1.0, notional: 50 }),
        entry({ side: 'SELL', shares: 100, price: 0.6, fee: 1.2, notional: 60 }),
      ];

      const cash = computeCash(1000, entries);
      // Buy: -(50 + 1.0) = -51.0
      // Sell: +(60 - 1.2) = +58.8
      // Cash = 1000 - 51 + 58.8 = 1007.8
      expect(cash).toBeCloseTo(1007.8, 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Unrealized PnL
  // ────────────────────────────────────────────────────────────────────
  describe('Unrealized PnL', () => {
    it('positive when mark > entry', () => {
      const pos: ReducedPosition = {
        marketId: 'm1',
        outcome: 'YES',
        netShares: 100,
        avgEntryPrice: 0.4,
        totalCostBasis: 40,
        realizedPnl: 0,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      };
      expect(unrealizedPnl(pos, 0.6)).toBeCloseTo(20, 6);
    });

    it('negative when mark < entry', () => {
      const pos: ReducedPosition = {
        marketId: 'm1',
        outcome: 'YES',
        netShares: 100,
        avgEntryPrice: 0.6,
        totalCostBasis: 60,
        realizedPnl: 0,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      };
      expect(unrealizedPnl(pos, 0.4)).toBeCloseTo(-20, 6);
    });

    it('zero for closed positions', () => {
      const pos: ReducedPosition = {
        marketId: 'm1',
        outcome: 'YES',
        netShares: 0,
        avgEntryPrice: 0.5,
        totalCostBasis: 0,
        realizedPnl: 5,
        status: 'CLOSED',
        openedAt: new Date(),
        closedAt: new Date(),
      };
      expect(unrealizedPnl(pos, 0.8)).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Portfolio invariants
  // ────────────────────────────────────────────────────────────────────
  describe('Portfolio invariants', () => {
    it('NLV = cash + mark-to-market of open positions', () => {
      const entries: LedgerEntry[] = [entry({ side: 'BUY', shares: 100, price: 0.5 })];
      const marks = new Map([['market-1:YES', 0.6]]);
      const portfolio = computePortfolio(1000, entries, marks);

      const expectedCash = 1000 - 50; // 950
      const expectedMTM = 100 * 0.6; // 60
      expect(portfolio.cash).toBeCloseTo(expectedCash, 6);
      expect(portfolio.netLiquidationValue).toBeCloseTo(expectedCash + expectedMTM, 6);
    });

    it('totalPnl = NLV - startingCash', () => {
      const entries: LedgerEntry[] = [entry({ side: 'BUY', shares: 100, price: 0.5 })];
      const marks = new Map([['market-1:YES', 0.6]]);
      const portfolio = computePortfolio(1000, entries, marks);

      expect(portfolio.totalPnl).toBeCloseTo(portfolio.netLiquidationValue - 1000, 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Reconciliation
  // ────────────────────────────────────────────────────────────────────
  describe('Reconciliation', () => {
    it('passes when everything matches', () => {
      const entries: LedgerEntry[] = [entry({ side: 'BUY', shares: 10, price: 0.5 })];
      const storedCash = computeCash(1000, entries);
      const result = reconcile(1000, entries, storedCash, [
        { marketId: 'market-1', outcome: 'YES', netShares: 10, status: 'OPEN' },
      ]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects cash mismatch', () => {
      const entries: LedgerEntry[] = [entry({ side: 'BUY', shares: 10, price: 0.5 })];
      const result = reconcile(1000, entries, 999, [
        { marketId: 'market-1', outcome: 'YES', netShares: 10, status: 'OPEN' },
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Cash mismatch'))).toBe(true);
    });

    it('detects position share mismatch', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 10, price: 0.5 }),
        entry({ side: 'SELL', shares: 3, price: 0.55 }),
      ];
      const result = reconcile(1000, entries, computeCash(1000, entries), [
        { marketId: 'market-1', outcome: 'YES', netShares: 8, status: 'OPEN' }, // wrong, should be 7
      ]);
      expect(result.valid).toBe(false);
      expect(result.positionMismatches).toHaveLength(1);
      expect(result.positionMismatches[0].ledgerShares).toBeCloseTo(7, 6);
    });

    it('detects open position with zero shares', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 10, price: 0.5 }),
        entry({ side: 'SELL', shares: 10, price: 0.55 }),
      ];
      const result = reconcile(1000, entries, computeCash(1000, entries), [
        { marketId: 'market-1', outcome: 'YES', netShares: 0, status: 'OPEN' }, // should be CLOSED
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('zero shares but status is OPEN'))).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Round shares helper
  // ────────────────────────────────────────────────────────────────────
  describe('roundShares', () => {
    it('rounds to 8 decimal places', () => {
      expect(roundShares(1.123456789)).toBe(1.12345679);
      expect(roundShares(0.000000001)).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Multiple markets in portfolio
  // ────────────────────────────────────────────────────────────────────
  describe('Multi-market portfolio', () => {
    it('handles multiple independent positions', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 100, price: 0.4, marketId: 'btc-70k', outcome: 'YES' }),
        entry({ side: 'BUY', shares: 50, price: 0.55, marketId: 'eth-4k', outcome: 'NO' }),
        entry({ side: 'SELL', shares: 100, price: 0.8, marketId: 'btc-70k', outcome: 'YES' }),
      ];
      const marks = new Map([['eth-4k:NO', 0.65]]);
      const portfolio = computePortfolio(10000, entries, marks);

      expect(portfolio.closedPositions).toHaveLength(1); // btc closed
      expect(portfolio.openPositions).toHaveLength(1); // eth still open
      expect(portfolio.closedPositions[0].marketId).toBe('btc-70k');
      expect(portfolio.openPositions[0].marketId).toBe('eth-4k');

      // BTC realized: 100 * (0.80 - 0.40) = 40
      expect(portfolio.closedPositions[0].realizedPnl).toBeCloseTo(40, 6);

      // ETH unrealized: 50 * (0.65 - 0.55) = 5
      expect(portfolio.totalUnrealizedPnl).toBeCloseTo(5, 6);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Bootstrap trades
  // ────────────────────────────────────────────────────────────────────
  describe('Bootstrap trades', () => {
    it('bootstrap buys are treated as normal BUY entries for position reduction', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 50, price: 0.45, action: 'BOOTSTRAP' }),
        entry({ side: 'SELL', shares: 20, price: 0.55, action: 'SELL' }),
      ];
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBeCloseTo(30, 6);
      expect(pos.status).toBe('OPEN');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Edge case: empty ledger
  // ────────────────────────────────────────────────────────────────────
  describe('Edge cases', () => {
    it('empty ledger → cash = starting, no positions', () => {
      const portfolio = computePortfolio(10000, [], new Map());
      expect(portfolio.cash).toBe(10000);
      expect(portfolio.positions).toHaveLength(0);
      expect(portfolio.totalPnl).toBe(0);
    });

    it('sell with no prior buy → no effect', () => {
      const entries: LedgerEntry[] = [entry({ side: 'SELL', shares: 10, price: 0.5 })];
      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBe(0);
      expect(pos.realizedPnl).toBe(0);
    });
  });
});
