export type ClusterCandidate = {
  walletId: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  tradedAt: string;
};

export type ClusterDetectionResult = {
  triggered: boolean;
  marketId: string;
  side: 'BUY' | 'SELL';
  walletIds: string[];
  windowSeconds: number;
  firstTradeAt: string;
  lastTradeAt: string;
};

export function detectTradeCluster(
  trades: ClusterCandidate[],
  thresholdWallets = 3,
  windowSeconds = 120,
): ClusterDetectionResult | null {
  if (trades.length === 0) {
    return null;
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.tradedAt).getTime() - new Date(b.tradedAt).getTime(),
  );

  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) {
    return null;
  }
  const delta = (new Date(last.tradedAt).getTime() - new Date(first.tradedAt).getTime()) / 1000;
  const uniqueWallets = Array.from(new Set(sorted.map((trade) => trade.walletId)));
  if (delta <= windowSeconds && uniqueWallets.length >= thresholdWallets) {
    return {
      triggered: true,
      marketId: first.marketId,
      side: first.side,
      walletIds: uniqueWallets,
      windowSeconds,
      firstTradeAt: first.tradedAt,
      lastTradeAt: last.tradedAt,
    };
  }
  return null;
}
