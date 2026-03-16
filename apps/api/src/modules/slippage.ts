import seedrandom from 'seedrandom';

export type SlippageMode =
  | 'NONE'
  | 'FIXED_BPS'
  | 'FIXED_PERCENT'
  | 'RANDOM_RANGE'
  | 'LATENCY_BUCKETED'
  | 'SIZE_AWARE'
  | 'COMBINED';

export interface LatencyBucket {
  maxMs: number | null; // null means "infinity"
  slippagePercent: number;
  skipTrade?: boolean;
}

export interface SizeBucket {
  maxNotional: number | null; // null means "infinity"
  slippagePercent: number;
}

export interface SlippageConfig {
  enabled: boolean;
  mode: SlippageMode;
  fixedPercent?: number;
  fixedBps?: number;
  randomRange?: { min: number; max: number };
  latencyBuckets?: LatencyBucket[];
  sizeBuckets?: SizeBucket[];
  combined?: {
    basePercent?: number;
    useLatencyBuckets?: boolean;
    useSizeBuckets?: boolean;
  };
  maxAdverseMovePercent?: number;
  seed?: number | string;
}

export interface SlippageInput {
  side: 'BUY' | 'SELL';
  sourcePrice: number;
  simulatedShares: number;
  latencyMs?: number;
}

export interface SlippageResult {
  fillPrice: number;
  originalPrice: number;
  slippagePercent: number;
  slippageBps: number;
  slippageModeUsed: SlippageMode;
  isSkipped: boolean;
  latencyApplied?: number;
  sizeApplied?: number;
  skipReason?: string;
}

export function calculateSlippage(
  input: SlippageInput,
  config?: SlippageConfig | null,
): SlippageResult {
  const { side, sourcePrice, simulatedShares, latencyMs } = input;
  const notional = simulatedShares * sourcePrice;

  // Base case: No slippage
  const noSlippageResult: any = {
    fillPrice: sourcePrice,
    originalPrice: sourcePrice,
    slippagePercent: 0,
    slippageBps: 0,
    slippageModeUsed: 'NONE',
    isSkipped: false,
    sizeApplied: notional,
  };

  if (latencyMs !== undefined) {
    noSlippageResult.latencyApplied = latencyMs;
  }

  if (!config || !config.enabled || config.mode === 'NONE') {
    return noSlippageResult;
  }

  let adverseSlippagePercent = 0;
  let isSkipped = false;
  let skipReason: string | undefined = undefined;

  const mode = config.mode;

  if (mode === 'FIXED_PERCENT') {
    adverseSlippagePercent = config.fixedPercent ?? 0;
  } else if (mode === 'FIXED_BPS') {
    adverseSlippagePercent = (config.fixedBps ?? 0) / 10000;
  } else if (mode === 'RANDOM_RANGE') {
    if (config.randomRange) {
      const { min, max } = config.randomRange;
      const prng = config.seed ? seedrandom(String(config.seed)) : Math.random;
      adverseSlippagePercent = min + prng() * (max - min);
    }
  } else if (mode === 'LATENCY_BUCKETED') {
    const res = getLatencySlippage(latencyMs, config.latencyBuckets);
    adverseSlippagePercent = res.val;
    if (res.skipped) {
      isSkipped = true;
      skipReason = 'Trade skipped due to latency bucket skip policy';
    }
  } else if (mode === 'SIZE_AWARE') {
    adverseSlippagePercent = getSizeSlippage(notional, config.sizeBuckets);
  } else if (mode === 'COMBINED') {
    let combinedPct = config.combined?.basePercent ?? 0;

    if (config.combined?.useLatencyBuckets) {
      const res = getLatencySlippage(latencyMs, config.latencyBuckets);
      combinedPct += res.val;
      if (res.skipped) {
        isSkipped = true;
        skipReason = 'Trade skipped due to latency bucket skip policy in COMBINED mode';
      }
    }

    if (config.combined?.useSizeBuckets) {
      combinedPct += getSizeSlippage(notional, config.sizeBuckets);
    }
    
    adverseSlippagePercent = combinedPct;
  }

  // Enforce Max Adverse Move skipping
  if (config.maxAdverseMovePercent !== undefined && adverseSlippagePercent > config.maxAdverseMovePercent) {
    isSkipped = true;
    skipReason = `Trade skipped: adverse slippage ${(adverseSlippagePercent * 100).toFixed(3)}% exceeds max allowed ${(config.maxAdverseMovePercent * 100).toFixed(3)}%`;
  }

  // Calculate actual fill price
  let fillPrice = sourcePrice;
  if (!isSkipped) {
    if (side === 'BUY') {
      fillPrice = sourcePrice * (1 + adverseSlippagePercent);
    } else {
      fillPrice = sourcePrice * (1 - adverseSlippagePercent);
    }
    // Prevent price out of bounds for Polymarket (0.0001 to 0.9999 usually, but we clamp aggressively to 0)
    fillPrice = Math.max(0.0001, fillPrice);
  }

  const result: any = {
    fillPrice,
    originalPrice: sourcePrice,
    slippagePercent: adverseSlippagePercent,
    slippageBps: adverseSlippagePercent * 10000,
    slippageModeUsed: mode,
    isSkipped,
    sizeApplied: notional,
  };

  if (skipReason !== undefined) {
    result.skipReason = skipReason;
  }
  if (latencyMs !== undefined) {
    result.latencyApplied = latencyMs;
  }

  return result as SlippageResult;
}

function getLatencySlippage(latencyMs: number | undefined, buckets: LatencyBucket[] | undefined): { val: number, skipped: boolean } {
  if (!latencyMs || !buckets || buckets.length === 0) return { val: 0, skipped: false };
  
  // Sort buckets ascending by maxMs just in case
  const sorted = [...buckets].sort((a, b) => {
    if (a.maxMs === null) return 1;
    if (b.maxMs === null) return -1;
    return a.maxMs - b.maxMs;
  });

  for (const b of sorted) {
    if (b.maxMs === null || latencyMs <= b.maxMs) {
      return { val: b.slippagePercent, skipped: !!b.skipTrade };
    }
  }

  return { val: 0, skipped: false };
}

function getSizeSlippage(notional: number, buckets: SizeBucket[] | undefined): number {
  if (!notional || !buckets || buckets.length === 0) return 0;

  const sorted = [...buckets].sort((a, b) => {
    if (a.maxNotional === null) return 1;
    if (b.maxNotional === null) return -1;
    return a.maxNotional - b.maxNotional;
  });

  for (const b of sorted) {
    if (b.maxNotional === null || notional <= b.maxNotional) {
      return b.slippagePercent;
    }
  }
  
  return 0;
}
