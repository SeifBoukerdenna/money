export type WhaleThresholds = {
  largeTradeUsd: number;
  largePositionSize: number;
  rapidMarketEntry: number;
};

export type WhaleInput = {
  wallet: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  liquidity: number;
  tradedAt: string;
  recentEntriesInWindow: number;
};

export type WhaleAlert = {
  triggered: boolean;
  reasons: string[];
  notional: number;
  message: string;
};

export function detectWhaleAlert(input: WhaleInput, thresholds: WhaleThresholds): WhaleAlert {
  const notional = input.size * input.price;
  const reasons: string[] = [];
  if (notional >= thresholds.largeTradeUsd) {
    reasons.push('LARGE_TRADE_USD');
  }
  if (input.size >= thresholds.largePositionSize) {
    reasons.push('LARGE_POSITION_SIZE');
  }
  if (input.recentEntriesInWindow >= thresholds.rapidMarketEntry) {
    reasons.push('RAPID_MARKET_ENTRY');
  }

  return {
    triggered: reasons.length > 0,
    reasons,
    notional,
    message: `${input.wallet} ${input.side} ${input.marketId} size=${input.size.toFixed(2)} price=${input.price.toFixed(4)} notional=${notional.toFixed(2)} liquidity=${input.liquidity.toFixed(2)} @ ${input.tradedAt}`,
  };
}
