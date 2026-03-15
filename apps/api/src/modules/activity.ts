import type { WalletActivityFeedEvent } from '@copytrader/polymarket-adapter';

export function buildActivityDedupeKey(event: WalletActivityFeedEvent): string {
  if (event.externalEventId) {
    return `src:POLYMARKET_DATA_API:event:${event.externalEventId}`;
  }

  if (event.txHash && Number.isInteger(event.logIndex)) {
    return `src:POLYMARKET_DATA_API:txlog:${event.txHash}:${event.logIndex}`;
  }

  if (event.txHash && event.orderId) {
    return `src:POLYMARKET_DATA_API:txord:${event.txHash}:${event.orderId}`;
  }

  if (event.blockNumber !== null && event.marketId) {
    const side = event.effectiveSide ?? event.side ?? _effectiveSideFromType(event.eventType);
    const shares = event.shares?.toFixed(8) ?? '0';
    const price = event.price?.toFixed(8) ?? '0';
    const outcome = event.outcome ?? 'UNKNOWN';
    return `src:POLYMARKET_DATA_API:block:${event.blockNumber}:${event.marketId}:${outcome}:${side}:${shares}:${price}:${event.eventType}`;
  }

  const timestampMs = new Date(event.eventTimestamp).getTime();
  const side = event.effectiveSide ?? event.side ?? _effectiveSideFromType(event.eventType);
  const shares = event.shares?.toFixed(8) ?? '0';
  const price = event.price?.toFixed(8) ?? '0';
  const outcome = event.outcome ?? 'UNKNOWN';
  const conditionId = event.conditionId ?? 'NONE';
  return `src:POLYMARKET_DATA_API:fallback:${timestampMs}:${event.marketId}:${conditionId}:${outcome}:${side}:${shares}:${price}:${event.eventType}`;
}

/**
 * Determines whether an activity event should be processed as a trade-like action.
 *
 * KEY FIX: REDEEM events for worthless positions have price=null, shares=null.
 * They MUST still close the simulated position. We allow all REDEEM/CLOSE events
 * through regardless of price/shares, and handle the null case in _applyEvent.
 */
export function isTradeLikeActivity(event: WalletActivityFeedEvent): boolean {
  const tradeLikeTypes = ['BUY', 'SELL', 'TRADE', 'INCREASE', 'REDUCE', 'CLOSE', 'REDEEM'];
  if (!tradeLikeTypes.includes(event.eventType)) return false;

  // REDEEM and CLOSE are always valid close signals — let them through even with
  // null/zero price and shares. The paper-copy engine handles close-at-zero.
  const exitTypes = ['CLOSE', 'REDEEM', 'REDUCE'];
  if (exitTypes.includes(event.eventType)) return true;

  // For BUY/SELL/TRADE/INCREASE: need valid price and shares to size the trade
  return (
    event.price !== null &&
    event.shares !== null &&
    event.price > 0 &&
    event.shares > 0 &&
    event.side !== null
  );
}

function _effectiveSideFromType(eventType: string): string {
  const exitTypes = ['SELL', 'CLOSE', 'REDEEM', 'REDUCE'];
  return exitTypes.includes(eventType.toUpperCase()) ? 'SELL' : 'BUY';
}
