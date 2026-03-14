import type { WalletActivityFeedEvent } from '@copytrader/polymarket-adapter';

export function buildActivityDedupeKey(event: WalletActivityFeedEvent): string {
  if (event.externalEventId) {
    return `ext:${event.externalEventId}`;
  }
  if (event.txHash) {
    return `tx:${event.txHash}`;
  }
  if (event.orderId) {
    return `ord:${event.orderId}`;
  }

  const timestampSec = Math.floor(new Date(event.eventTimestamp).getTime() / 1000);
  // Use effectiveSide derived from eventType when side is null
  const side = event.side ?? _effectiveSideFromType(event.eventType);
  const shares = event.shares?.toFixed(6) ?? '0';
  const price = event.price?.toFixed(6) ?? '0';
  const outcome = event.outcome ?? 'UNKNOWN';
  return `f:${timestampSec}:${event.marketId}:${outcome}:${side}:${shares}:${price}`;
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
