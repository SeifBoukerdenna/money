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
  const side = event.side ?? 'UNKNOWN';
  const shares = event.shares?.toFixed(6) ?? '0';
  const price = event.price?.toFixed(6) ?? '0';
  const outcome = event.outcome ?? 'UNKNOWN';
  return `f:${timestampSec}:${event.marketId}:${outcome}:${side}:${shares}:${price}`;
}

export function isTradeLikeActivity(event: WalletActivityFeedEvent): boolean {
  return (
    event.side !== null &&
    event.price !== null &&
    event.shares !== null &&
    event.price > 0 &&
    event.shares > 0 &&
    ['BUY', 'SELL', 'TRADE', 'INCREASE', 'REDUCE', 'CLOSE'].includes(event.eventType)
  );
}
