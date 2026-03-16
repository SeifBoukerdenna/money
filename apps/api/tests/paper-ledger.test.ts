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
  type PortfolioState,
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
  function createRng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (1664525 * x + 1013904223) >>> 0;
      return x / 0x100000000;
    };
  }

  function randBetween(rng: () => number, min: number, max: number): number {
    return min + (max - min) * rng();
  }

  function randInt(rng: () => number, min: number, maxInclusive: number): number {
    return Math.floor(randBetween(rng, min, maxInclusive + 1));
  }

  function assertPortfolioInvariants(
    portfolio: PortfolioState,
    startingCash: number,
    marks: Map<string, number>,
  ) {
    const openValue = portfolio.openPositions.reduce((sum, pos) => {
      const key = `${pos.marketId}:${pos.outcome}`;
      const mark = marks.get(key) ?? pos.avgEntryPrice;
      return sum + pos.netShares * mark;
    }, 0);

    expect(portfolio.netLiquidationValue).toBeCloseTo(portfolio.cash + openValue, 6);
    expect(portfolio.netPnl).toBeCloseTo(
      portfolio.totalRealizedPnl + portfolio.totalUnrealizedPnl - portfolio.totalFees,
      6,
    );
    expect(startingCash + portfolio.netPnl).toBeCloseTo(portfolio.netLiquidationValue, 6);
    expect(portfolio.totalPnl).toBeCloseTo(portfolio.netPnl, 8);

    expect(portfolio.positions.every((p) => p.netShares >= -1e-8)).toBe(true);
    expect(portfolio.openPositions.every((p) => p.netShares > 1e-8 && p.status === 'OPEN')).toBe(
      true,
    );
    expect(
      portfolio.closedPositions.every(
        (p) => Math.abs(p.netShares) <= 1e-8 && p.status === 'CLOSED',
      ),
    ).toBe(true);
  }

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
  // Fees are separate from realized PnL
  // ────────────────────────────────────────────────────────────────────
  describe('Fee accounting', () => {
    it('realized pnl stays gross while fees remain separate', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 100, price: 0.5, fee: 1.0 }),
        entry({ side: 'SELL', shares: 100, price: 0.6, fee: 1.2 }),
      ];

      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.realizedPnl).toBeCloseTo(10.0, 6);

      const portfolio = computePortfolio(1000, entries, new Map());
      expect(portfolio.totalFees).toBeCloseTo(2.2, 6);
      expect(portfolio.totalRealizedPnl).toBeCloseTo(10.0, 6);
      expect(portfolio.totalPnl).toBeCloseTo(7.8, 6);
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
  // BUY/SELL with slippage-like fill prices
  // ────────────────────────────────────────────────────────────────────
  describe('Fill-price accounting', () => {
    it('BUY uses fill price for cost basis and cash', () => {
      const entries: LedgerEntry[] = [entry({ side: 'BUY', shares: 100, price: 0.525, fee: 0.52 })];

      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.avgEntryPrice).toBeCloseTo(0.525, 8);

      const portfolio = computePortfolio(1000, entries, new Map([['market-1:YES', 0.525]]));
      expect(portfolio.cash).toBeCloseTo(946.98, 6);
      expect(portfolio.totalFees).toBeCloseTo(0.52, 6);
    });

    it('SELL realizes only sold portion; repeated partial sells do not drift', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 100, price: 0.5 }),
        entry({ side: 'SELL', shares: 40, price: 0.6, fee: 0.24 }),
        entry({ side: 'SELL', shares: 30, price: 0.7, fee: 0.21 }),
      ];

      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBeCloseTo(30, 6);
      expect(pos.avgEntryPrice).toBeCloseTo(0.5, 8);
      expect(pos.realizedPnl).toBeCloseTo(40 * 0.1 + 30 * 0.2, 6);

      const portfolio = computePortfolio(1000, entries, new Map([['market-1:YES', 0.55]]));
      expect(portfolio.totalFees).toBeCloseTo(0.45, 6);
      expect(portfolio.totalPnl).toBeCloseTo(
        portfolio.totalRealizedPnl + portfolio.totalUnrealizedPnl - portfolio.totalFees,
        8,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // REDEEM / close at zero should remain valid
  // ────────────────────────────────────────────────────────────────────
  describe('Zero-price close', () => {
    it('SELL at zero closes position and keeps accounting finite', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 50, price: 0.2, fee: 0.1 }),
        entry({ side: 'SELL', shares: 50, price: 0, action: 'REDEEM', fee: 0 }),
      ];

      const pos = reducePosition('market-1', 'YES', entries);
      expect(pos.netShares).toBe(0);
      expect(pos.status).toBe('CLOSED');
      expect(pos.realizedPnl).toBeCloseTo(-10, 6);

      const portfolio = computePortfolio(1000, entries, new Map());
      expect(Number.isFinite(portfolio.cash)).toBe(true);
      expect(portfolio.totalFees).toBeCloseTo(0.1, 6);
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

    it('starting + realized + unrealized - fees = accountValue', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 100, price: 0.5, fee: 0.5 }),
        entry({ side: 'SELL', shares: 60, price: 0.65, fee: 0.39 }),
      ];
      const marks = new Map([['market-1:YES', 0.58]]);
      const portfolio = computePortfolio(1000, entries, marks);

      const lhs =
        1000 + portfolio.totalRealizedPnl + portfolio.totalUnrealizedPnl - portfolio.totalFees;
      expect(lhs).toBeCloseTo(portfolio.netLiquidationValue, 6);
      expect(portfolio.netPnl).toBeCloseTo(portfolio.totalPnl, 8);
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

    it('ignores status metadata and reconciles based on shares only', () => {
      const entries: LedgerEntry[] = [
        entry({ side: 'BUY', shares: 10, price: 0.5 }),
        entry({ side: 'SELL', shares: 10, price: 0.55 }),
      ];
      const result = reconcile(1000, entries, computeCash(1000, entries), [
        { marketId: 'market-1', outcome: 'YES', netShares: 0, status: 'OPEN' },
      ]);
      expect(result.valid).toBe(true);
      expect(result.positionMismatches).toHaveLength(0);
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

    it('skipped trade represented by no ledger row mutates nothing', () => {
      const portfolio = computePortfolio(1000, [], new Map());
      expect(portfolio.cash).toBe(1000);
      expect(portfolio.positions).toHaveLength(0);
      expect(portfolio.totalFees).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Adversarial randomized invariants
  // ────────────────────────────────────────────────────────────────────
  describe('Adversarial randomized invariants', () => {
    it('preserves accounting identities across randomized BUY/SELL/REDEEM-like streams', () => {
      const runs = 120;
      const startingCash = 25_000;
      const marketIds = ['m-a', 'm-b', 'm-c', 'm-d'];
      const outcomes = ['YES', 'NO'];

      for (let run = 0; run < runs; run += 1) {
        const rng = createRng(10_000 + run * 31);
        const entries: LedgerEntry[] = [];
        const trackedShares = new Map<string, number>();
        const seenKeys = new Set<string>();
        let ts = new Date('2026-01-01T00:00:00.000Z').getTime();

        const steps = randInt(rng, 35, 85);
        for (let i = 0; i < steps; i += 1) {
          const marketId = marketIds[randInt(rng, 0, marketIds.length - 1)]!;
          const outcome = outcomes[randInt(rng, 0, outcomes.length - 1)]!;
          const key = `${marketId}:${outcome}`;
          const held = trackedShares.get(key) ?? 0;
          const openShareTotal = Array.from(trackedShares.values()).reduce((a, b) => a + b, 0);

          let side: 'BUY' | 'SELL';
          if (openShareTotal <= 1e-8) {
            side = 'BUY';
          } else {
            side = rng() < 0.58 ? 'BUY' : 'SELL';
          }

          let shares: number;
          let price: number;
          let action = side;

          if (side === 'BUY') {
            shares = roundShares(randBetween(rng, 1, 220));
            price = randBetween(rng, 0.03, 0.97);
            trackedShares.set(key, roundShares(held + shares));
            seenKeys.add(key);
          } else {
            // Keep random sequences economically valid: SELL never exceeds held.
            shares = roundShares(Math.max(0.00000001, held * randBetween(rng, 0.1, 1)));

            // Randomly simulate REDEEM-like closes at terminal prices 0/1.
            if (rng() < 0.2) {
              action = 'REDEEM';
              price = rng() < 0.5 ? 0 : 1;
            } else {
              price = randBetween(rng, 0, 1);
            }

            const closeShares = Math.min(held, shares);
            trackedShares.set(key, roundShares(Math.max(0, held - closeShares)));
            seenKeys.add(key);
          }

          const notional = shares * price;
          const feeRate = randBetween(rng, 0, 0.03);
          const fee = notional * feeRate;

          entries.push({
            id: `rand-${run}-${i}`,
            sourceEventId: `src-rand-${run}-${i}`,
            marketId,
            outcome,
            side,
            action,
            shares,
            price,
            notional,
            fee,
            slippage: 0,
            timestamp: new Date(ts),
          });

          ts += randInt(rng, 1, 20) * 1000;
        }

        const marks = new Map<string, number>();
        for (const key of seenKeys) {
          marks.set(key, randBetween(rng, 0, 1));
        }

        const live = computePortfolio(startingCash, entries, marks);
        const replay = computePortfolio(startingCash, entries, marks);

        const recomposedOpenValue = live.openPositions.reduce((sum, pos) => {
          const k = `${pos.marketId}:${pos.outcome}`;
          const mark = marks.get(k) ?? pos.avgEntryPrice;
          return sum + pos.netShares * mark;
        }, 0);

        expect(live.netLiquidationValue).toBeCloseTo(live.cash + recomposedOpenValue, 6);
        expect(live.netPnl).toBeCloseTo(
          live.totalRealizedPnl + live.totalUnrealizedPnl - live.totalFees,
          6,
        );
        expect(startingCash + live.netPnl).toBeCloseTo(live.netLiquidationValue, 6);
        expect(live.totalPnl).toBeCloseTo(live.netPnl, 8);

        expect(
          live.openPositions.every((p) => p.netShares > 0 && p.status === 'OPEN'),
        ).toBeTruthy();
        expect(
          live.closedPositions.every((p) => Math.abs(p.netShares) <= 1e-8 && p.status === 'CLOSED'),
        ).toBeTruthy();
        expect(live.closedPositions.every((p) => unrealizedPnl(p, 0.77) === 0)).toBeTruthy();

        const reconcileResult = reconcile(
          startingCash,
          entries,
          live.cash,
          live.openPositions.map((p) => ({
            marketId: p.marketId,
            outcome: p.outcome,
            netShares: p.netShares,
          })),
        );
        expect(reconcileResult.valid).toBe(true);

        expect(replay.cash).toBeCloseTo(live.cash, 8);
        expect(replay.totalRealizedPnl).toBeCloseTo(live.totalRealizedPnl, 8);
        expect(replay.totalUnrealizedPnl).toBeCloseTo(live.totalUnrealizedPnl, 8);
        expect(replay.netLiquidationValue).toBeCloseTo(live.netLiquidationValue, 8);
      }
    });
  });

  describe('Pre-flight long-run stability', () => {
    it(
      'runs 5,000 deterministic mixed events with invariant checks after every step',
      { timeout: 30000 },
      () => {
        const rng = createRng(20260316);
        const startingCash = 75_000;
        const marketIds = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
        const outcomes = ['YES', 'NO'];
        const entries: LedgerEntry[] = [];
        const trackedShares = new Map<string, number>();
        const marks = new Map<string, number>();
        let ts = new Date('2026-01-01T00:00:00.000Z').getTime();

        for (let i = 0; i < 5000; i += 1) {
          const marketId = marketIds[randInt(rng, 0, marketIds.length - 1)]!;
          const outcome = outcomes[randInt(rng, 0, outcomes.length - 1)]!;
          const key = `${marketId}:${outcome}`;
          const held = trackedShares.get(key) ?? 0;

          let side: 'BUY' | 'SELL' = 'BUY';
          let action = 'BUY';
          let shares = 0;
          let price = 0;

          if (held <= 1e-8 || rng() < 0.48) {
            side = 'BUY';
            action = 'BUY';
            shares = roundShares(randBetween(rng, 0.05, 120));
            price = randBetween(rng, 0.02, 0.98);
            trackedShares.set(key, roundShares(held + shares));
          } else {
            side = 'SELL';
            const modeRoll = rng();
            if (modeRoll < 0.65) {
              action = 'SELL';
              shares = roundShares(Math.max(0.00000001, held * randBetween(rng, 0.05, 0.8)));
              price = randBetween(rng, 0.01, 0.99);
            } else if (modeRoll < 0.85) {
              action = 'REDEEM';
              shares = roundShares(held);
              price = rng() < 0.5 ? 0 : 1;
            } else {
              action = 'AUTO_CLOSED';
              shares = roundShares(held);
              price = rng() < 0.5 ? 0 : 1;
            }

            const closeShares = Math.min(held, shares);
            trackedShares.set(key, roundShares(Math.max(0, held - closeShares)));
          }

          marks.set(key, price);
          const notional = shares * price;
          const fee = notional * randBetween(rng, 0, 0.02);

          entries.push({
            id: `long-${i}`,
            sourceEventId: `src-long-${i}`,
            marketId,
            outcome,
            side,
            action,
            shares,
            price,
            notional,
            fee,
            slippage: randBetween(rng, 0, 0.01),
            timestamp: new Date(ts),
          });
          ts += 1000;

          const portfolio = computePortfolio(startingCash, entries, marks);
          assertPortfolioInvariants(portfolio, startingCash, marks);

          for (const [trackedKey, expectedShares] of trackedShares) {
            if (expectedShares <= 1e-8) continue;
            const position = portfolio.openPositions.find(
              (p) => `${p.marketId}:${p.outcome}` === trackedKey,
            );
            expect(position).toBeDefined();
            expect(position!.netShares).toBeCloseTo(expectedShares, 6);
          }
        }
      },
    );

    it('keeps replay state equal to live state across repeated replay cycles', () => {
      const rng = createRng(77777);
      const startingCash = 50_000;
      const entries: LedgerEntry[] = [];
      const marks = new Map<string, number>();
      let ts = new Date('2026-01-02T00:00:00.000Z').getTime();
      const heldByKey = new Map<string, number>();

      for (let i = 0; i < 2500; i += 1) {
        const marketId = `r-${randInt(rng, 0, 4)}`;
        const outcome = rng() < 0.5 ? 'YES' : 'NO';
        const key = `${marketId}:${outcome}`;
        const held = heldByKey.get(key) ?? 0;
        const side: 'BUY' | 'SELL' = held <= 1e-8 || rng() < 0.55 ? 'BUY' : 'SELL';
        const price = randBetween(rng, 0.03, 0.97);
        let shares = roundShares(randBetween(rng, 0.01, 80));
        if (side === 'SELL') {
          shares = roundShares(Math.min(shares, held));
          heldByKey.set(key, roundShares(Math.max(0, held - shares)));
        } else {
          heldByKey.set(key, roundShares(held + shares));
        }

        marks.set(key, price);
        entries.push({
          id: `replay-${i}`,
          sourceEventId: `src-replay-${i}`,
          marketId,
          outcome,
          side,
          action: side,
          shares,
          price,
          notional: shares * price,
          fee: shares * price * 0.005,
          slippage: 0,
          timestamp: new Date(ts),
        });
        ts += 500;
      }

      const live = computePortfolio(startingCash, entries, marks);
      assertPortfolioInvariants(live, startingCash, marks);

      for (let replayCycle = 0; replayCycle < 200; replayCycle += 1) {
        const replay = computePortfolio(startingCash, entries, marks);
        expect(replay.cash).toBeCloseTo(live.cash, 8);
        expect(replay.totalRealizedPnl).toBeCloseTo(live.totalRealizedPnl, 8);
        expect(replay.totalUnrealizedPnl).toBeCloseTo(live.totalUnrealizedPnl, 8);
        expect(replay.totalFees).toBeCloseTo(live.totalFees, 8);
        expect(replay.netLiquidationValue).toBeCloseTo(live.netLiquidationValue, 8);

        const replayOpen = replay.openPositions
          .map((p) => `${p.marketId}:${p.outcome}:${p.netShares.toFixed(8)}`)
          .sort();
        const liveOpen = live.openPositions
          .map((p) => `${p.marketId}:${p.outcome}:${p.netShares.toFixed(8)}`)
          .sort();
        expect(replayOpen).toEqual(liveOpen);
      }
    });

    it('eliminates dust after repeated tiny partial closes', () => {
      const startingCash = 1000;
      const entries: LedgerEntry[] = [];
      const marks = new Map<string, number>([['dust-market:YES', 0.5]]);
      const initialShares = 0.00012345;

      entries.push(
        entry({
          side: 'BUY',
          marketId: 'dust-market',
          outcome: 'YES',
          shares: initialShares,
          price: 0.5,
          fee: 0,
        }),
      );

      let remaining = initialShares;
      for (let i = 0; i < 12; i += 1) {
        const close = roundShares(Math.max(0.00000001, remaining * 0.37));
        entries.push(
          entry({
            side: 'SELL',
            marketId: 'dust-market',
            outcome: 'YES',
            shares: close,
            price: 0.55,
            fee: 0,
          }),
        );
        remaining = roundShares(Math.max(0, remaining - Math.min(remaining, close)));
      }

      if (remaining > 0) {
        entries.push(
          entry({
            side: 'SELL',
            marketId: 'dust-market',
            outcome: 'YES',
            shares: remaining,
            price: 0.55,
            action: 'REDEEM',
            fee: 0,
          }),
        );
      }

      const portfolio = computePortfolio(startingCash, entries, marks);
      assertPortfolioInvariants(portfolio, startingCash, marks);
      const dustPos = portfolio.positions.find((p) => p.marketId === 'dust-market');
      expect(dustPos).toBeDefined();
      expect(Math.abs(dustPos!.netShares)).toBeLessThanOrEqual(1e-8);
      expect(dustPos!.status).toBe('CLOSED');
      expect(portfolio.openPositions.some((p) => p.marketId === 'dust-market')).toBe(false);
    });
  });
});
