import { describe, expect, it } from 'vitest';
import { calculateSlippage, type SlippageConfig } from '../src/modules/slippage.js';

describe('Slippage Engine unit tests', () => {
  it('handles NONE mode correctly', () => {
    const res = calculateSlippage(
      { side: 'BUY', sourcePrice: 0.5, simulatedShares: 100 },
      { enabled: true, mode: 'NONE' }
    );
    expect(res.fillPrice).toBe(0.5);
    expect(res.slippageModeUsed).toBe('NONE');
    expect(res.isSkipped).toBe(false);
  });

  describe('FIXED_PERCENT', () => {
    it('applies fixed percent slippage to BUY (worse fill = higher price)', () => {
      const res = calculateSlippage(
        { side: 'BUY', sourcePrice: 0.5, simulatedShares: 100 },
        { enabled: true, mode: 'FIXED_PERCENT', fixedPercent: 0.01 }
      );
      expect(res.fillPrice).toBe(0.505);
      expect(res.isSkipped).toBe(false);
    });

    it('applies fixed percent slippage to SELL (worse fill = lower price)', () => {
      const res = calculateSlippage(
        { side: 'SELL', sourcePrice: 0.5, simulatedShares: 100 },
        { enabled: true, mode: 'FIXED_PERCENT', fixedPercent: 0.01 }
      );
      expect(res.fillPrice).toBe(0.495);
      expect(res.isSkipped).toBe(false);
    });
  });

  describe('FIXED_BPS', () => {
    it('applies fixed bps slippage to BUY', () => {
      const res = calculateSlippage(
        { side: 'BUY', sourcePrice: 0.5, simulatedShares: 100 },
        { enabled: true, mode: 'FIXED_BPS', fixedBps: 100 } // 100 bps = 1%
      );
      expect(res.fillPrice).toBe(0.505);
      expect(res.isSkipped).toBe(false);
    });
  });

  describe('RANDOM_RANGE', () => {
    it('applies deterministic random slippage with seed', () => {
      const config: SlippageConfig = {
        enabled: true,
        mode: 'RANDOM_RANGE',
        randomRange: { min: 0.005, max: 0.015 },
        seed: 42,
      };
      
      const res1 = calculateSlippage({ side: 'BUY', sourcePrice: 0.5, simulatedShares: 100 }, config);
      const res2 = calculateSlippage({ side: 'BUY', sourcePrice: 0.5, simulatedShares: 100 }, config);
      
      expect(res1.fillPrice).toBe(res2.fillPrice);
      expect(res1.fillPrice).toBeGreaterThanOrEqual(0.5025); // 0.5 * 1.005
      expect(res1.fillPrice).toBeLessThanOrEqual(0.5075);    // 0.5 * 1.015
    });
  });

  describe('LATENCY_BUCKETED', () => {
    const config: SlippageConfig = {
      enabled: true,
      mode: 'LATENCY_BUCKETED',
      latencyBuckets: [
        { maxMs: 1000, slippagePercent: 0.002 },
        { maxMs: 3000, slippagePercent: 0.005 },
        { maxMs: 5000, slippagePercent: 0.01 },
        { maxMs: null, slippagePercent: 0.02, skipTrade: true },
      ],
    };

    it('uses first bucket (1s)', () => {
      const res = calculateSlippage({ side: 'BUY', sourcePrice: 0.5, simulatedShares: 100, latencyMs: 500 }, config);
      expect(res.fillPrice).toBe(0.501); // 0.2%
      expect(res.isSkipped).toBe(false);
    });

    it('uses second bucket (3s)', () => {
      const res = calculateSlippage({ side: 'BUY', sourcePrice: 0.5, simulatedShares: 100, latencyMs: 2000 }, config);
      expect(res.fillPrice).toBe(0.5025); // 0.5%
    });

    it('skips trade if bucket has skipTrade', () => {
      const res = calculateSlippage({ side: 'BUY', sourcePrice: 0.5, simulatedShares: 100, latencyMs: 6000 }, config);
      expect(res.isSkipped).toBe(true);
      expect(res.skipReason).toContain('latency bucket skip policy');
    });
  });

  describe('SIZE_AWARE', () => {
    const config: SlippageConfig = {
      enabled: true,
      mode: 'SIZE_AWARE',
      sizeBuckets: [
        { maxNotional: 50, slippagePercent: 0.002 },
        { maxNotional: 200, slippagePercent: 0.006 },
        { maxNotional: null, slippagePercent: 0.012 },
      ],
    };

    it('uses <50 bucket', () => {
      // Notional = 100 * 0.4 = 40
      const res = calculateSlippage({ side: 'SELL', sourcePrice: 0.4, simulatedShares: 100 }, config);
      expect(res.fillPrice).toBe(0.3992); // 0.4 * (1 - 0.002)
    });

    it('uses >200 bucket', () => {
      // Notional = 1000 * 0.5 = 500
      const res = calculateSlippage({ side: 'SELL', sourcePrice: 0.5, simulatedShares: 1000 }, config);
      expect(res.fillPrice).toBe(0.494); // 0.5 * (1 - 0.012)
    });
  });

  describe('COMBINED', () => {
    it('adds base + size + latency correctly', () => {
      const config: SlippageConfig = {
        enabled: true,
        mode: 'COMBINED',
        latencyBuckets: [{ maxMs: 1000, slippagePercent: 0.002 }, { maxMs: null, slippagePercent: 0.01 }],
        sizeBuckets: [{ maxNotional: 100, slippagePercent: 0.003 }, { maxNotional: null, slippagePercent: 0.005 }],
        combined: { basePercent: 0.001, useLatencyBuckets: true, useSizeBuckets: true },
      };

      // Latency = 500 -> 0.002
      // Size = 200 * 0.5 = 100 -> 0.003
      // Base = 0.001
      // Total = 0.006
      const res = calculateSlippage({ side: 'BUY', sourcePrice: 0.5, simulatedShares: 200, latencyMs: 500 }, config);
      expect(res.slippagePercent).toBeCloseTo(0.006, 5);
      expect(res.fillPrice).toBe(0.503);
    });
  });

  describe('MAX_ADVERSE_MOVE', () => {
    it('skips trade if slippage exceeds maxAdverseMovePercent', () => {
      const res = calculateSlippage(
        { side: 'BUY', sourcePrice: 0.5, simulatedShares: 100 },
        { enabled: true, mode: 'FIXED_PERCENT', fixedPercent: 0.03, maxAdverseMovePercent: 0.02 }
      );
      expect(res.isSkipped).toBe(true);
      expect(res.skipReason).toContain('exceeds max allowed');
    });

    it('allows trade if slippage is exactly maxAdverseMovePercent', () => {
      const res = calculateSlippage(
        { side: 'BUY', sourcePrice: 0.5, simulatedShares: 100 },
        { enabled: true, mode: 'FIXED_PERCENT', fixedPercent: 0.02, maxAdverseMovePercent: 0.02 }
      );
      expect(res.isSkipped).toBe(false);
    });
  });

  describe('Clamping', () => {
    it('clamps BUY so price does not exceed bounds (polymarket prices are usually 0.0001-0.9999, but we just want to ensure it doesnt go negative or weird long tails)', () => {
      const res = calculateSlippage(
        { side: 'SELL', sourcePrice: 0.01, simulatedShares: 100 },
        { enabled: true, mode: 'FIXED_PERCENT', fixedPercent: 2.0 } // -200% drop
      );
      expect(res.fillPrice).toBe(0.0001); // bounded above 0
    });
  });
});
