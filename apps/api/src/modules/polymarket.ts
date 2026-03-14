import {
  LivePolymarketAdapter,
  type PolymarketDataPort,
  type PolymarketTradingPort,
} from '@copytrader/polymarket-adapter';

import { config } from '../config.js';

export function createPolymarketDataAdapter(): PolymarketDataPort {
  return new LivePolymarketAdapter(config.POLYMARKET_API_BASE);
}

export function createPolymarketTradingAdapter(mode: 'PAPER' | 'LIVE'): PolymarketTradingPort {
  if (mode === 'PAPER') {
    return {
      async submitOrder() {
        throw new Error('Paper execution should use internal simulator, not Polymarket adapter');
      },
    } as PolymarketTradingPort;
  }
  return new LivePolymarketAdapter(config.POLYMARKET_API_BASE);
}
