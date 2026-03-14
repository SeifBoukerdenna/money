import { describe, expect, it } from 'vitest';
import { decideCopyOrder } from '../src/index';
const baseInput = {
    strategyId: crypto.randomUUID(),
    riskConfig: {
        id: crypto.randomUUID(),
        strategyId: crypto.randomUUID(),
        fixedDollar: 100,
        pctSourceSize: null,
        pctBankroll: null,
        maxExposure: 1000,
        perMarketMaxAllocation: 400,
        dailyLossCap: 200,
        maxSlippageBps: 100,
        minLiquidity: 1000,
        maxSpreadBps: 1000,
        inverseMode: false,
        copyBuys: true,
        copySells: true,
        cooldownSeconds: 0,
        fillStrategy: 'AGGRESSIVE_LIMIT',
    },
    market: {
        id: 'm1',
        slug: 'm1',
        question: 'q',
        active: true,
        bestBid: 0.49,
        bestAsk: 0.51,
        midpoint: 0.5,
        liquidity: 100000,
        spreadBps: 400,
    },
    event: {
        id: crypto.randomUUID(),
        sourceEventId: 'evt-1',
        sourceWalletAddress: '0xabc',
        marketId: 'm1',
        outcome: 'YES',
        side: 'BUY',
        size: 100,
        price: 0.5,
        tradedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
    },
    bankroll: 500,
    currentExposure: 100,
    perMarketExposure: 50,
    dailyPnl: 10,
};
describe('decideCopyOrder', () => {
    it('executes when constraints pass', () => {
        const decision = decideCopyOrder(baseInput);
        expect(decision.action).toBe('EXECUTE');
        expect(decision.orderSize).toBeGreaterThan(0);
    });
    it('skips on liquidity and spread failures', () => {
        const decision = decideCopyOrder({
            ...baseInput,
            market: { ...baseInput.market, liquidity: 10, spreadBps: 5000 },
        });
        expect(decision.action).toBe('SKIP');
        expect(decision.reasons.map((r) => r.code)).toContain('LOW_LIQUIDITY');
        expect(decision.reasons.map((r) => r.code)).toContain('WIDE_SPREAD');
    });
    it('applies inverse mode', () => {
        const decision = decideCopyOrder({
            ...baseInput,
            riskConfig: { ...baseInput.riskConfig, inverseMode: true },
        });
        expect(decision.side).toBe('SELL');
    });
});
//# sourceMappingURL=risk-engine.test.js.map