import { LayoutShell } from '../../components/layout-shell';
import { apiFetch } from '../../lib/api';

type Detail = {
    marketId: string;
    marketQuestion: string | null;
    eventCount: number;
    tradeCount: number;
    latestTradeAt: string | null;
    sourceNotional: number;
    decisionsAvailable: boolean;
    decisionsAvailabilityMessage: string;
    recentTrades: Array<{
        id: string;
        side: 'BUY' | 'SELL';
        outcome: string;
        price: number;
        size: number;
        notional: number;
        tradedAt: string;
        sourceWalletAddress: string;
        txHash: string | null;
    }>;
};

export default async function MarketDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const detail = await apiFetch<Detail>(`/markets/${encodeURIComponent(id)}`).catch(
        () => null,
    );

    return (
        <LayoutShell>
            <div className="space-y-4">
                {!detail && (
                    <div className="card text-slate-400">
                        Market detail is unavailable for this market ID.
                    </div>
                )}

                {detail && (
                    <>
                        <div className="card">
                            <h2 className="text-xl font-semibold">{detail.marketQuestion ?? detail.marketId}</h2>
                            <p className="mt-1 text-xs text-slate-500">Market ID: {detail.marketId}</p>
                            <p className="mt-2 text-sm text-slate-300">
                                Source trades: {detail.tradeCount} • Source notional (recent window): ${detail.sourceNotional.toFixed(2)}
                            </p>
                            <p className="mt-1 text-sm text-slate-400">
                                Latest trade: {detail.latestTradeAt ? new Date(detail.latestTradeAt).toLocaleString() : '—'}
                            </p>
                        </div>

                        {!detail.decisionsAvailable && (
                            <div className="card border border-amber-700/40 text-amber-200">
                                {detail.decisionsAvailabilityMessage}
                            </div>
                        )}

                        <div className="card">
                            <h3 className="mb-3 text-sm font-semibold">Recent Source Trades</h3>
                            {detail.recentTrades.length === 0 && (
                                <p className="text-sm text-slate-400">No source trades found for this market.</p>
                            )}
                            <div className="space-y-2">
                                {detail.recentTrades.map((trade) => (
                                    <div key={trade.id} className="rounded-lg border border-slate-800 p-3 text-sm">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <p className="font-medium">{trade.side} {trade.outcome}</p>
                                            <p className="text-xs text-slate-400">{new Date(trade.tradedAt).toLocaleString()}</p>
                                        </div>
                                        <p className="mt-1 text-slate-300">
                                            {trade.size.toFixed(2)} @ {trade.price.toFixed(4)} • ${trade.notional.toFixed(2)}
                                        </p>
                                        <p className="mt-1 text-xs text-slate-500">
                                            Source wallet: {trade.sourceWalletAddress}
                                            {trade.txHash ? ` • tx: ${trade.txHash.slice(0, 10)}…` : ''}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </LayoutShell>
    );
}
