import { LayoutShell } from '../components/layout-shell';
import { apiFetch } from '../lib/api';

type IntelligencePayload = {
    topWallets: Array<{ wallet: string; label: string; profit: number; winRate: number; sharpeLike: number }>;
    recentWhaleTrades: Array<{ id: string; label: string; marketId: string; side: 'BUY' | 'SELL'; notionalUsd: number }>;
    clusterSignals: Array<{ id: string; marketId: string; side: 'BUY' | 'SELL'; thresholdWallets: number; windowSeconds: number }>;
    marketSentiment: Array<{ marketId: string; netSentimentScore: number; uniqueWallets: number }>;
    mostActiveMarkets: Array<{ marketId: string; trades: number }>;
};

export default async function IntelligencePage() {
    const data = await apiFetch<IntelligencePayload>('/dashboard/intelligence').catch(
        () =>
            ({
                topWallets: [],
                recentWhaleTrades: [],
                clusterSignals: [],
                marketSentiment: [],
                mostActiveMarkets: [],
            }) as IntelligencePayload,
    );

    return (
        <LayoutShell>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Top Performing Wallets</h2>
                    {data.topWallets.slice(0, 8).map((row) => (
                        <div key={row.wallet} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.label}</div>
                            <div className="text-slate-400">{row.wallet}</div>
                            <div className="text-slate-300">PnL {row.profit.toFixed(2)} • Win {(row.winRate * 100).toFixed(1)}%</div>
                        </div>
                    ))}
                </section>

                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Recent Whale Trades</h2>
                    {data.recentWhaleTrades.slice(0, 8).map((row) => (
                        <div key={row.id} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.label}</div>
                            <div className="text-slate-300">
                                {row.side} {row.marketId} • ${row.notionalUsd.toFixed(2)}
                            </div>
                        </div>
                    ))}
                </section>

                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Cluster Signals</h2>
                    {data.clusterSignals.slice(0, 8).map((row) => (
                        <div key={row.id} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.marketId}</div>
                            <div className="text-slate-300">
                                {row.side} • {row.thresholdWallets}+ wallets / {row.windowSeconds}s
                            </div>
                        </div>
                    ))}
                </section>

                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Market Sentiment</h2>
                    {data.marketSentiment.slice(0, 8).map((row) => (
                        <div key={row.marketId} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.marketId}</div>
                            <div className="text-slate-300">
                                Sentiment {(row.netSentimentScore * 100).toFixed(1)}% • Wallets {row.uniqueWallets}
                            </div>
                        </div>
                    ))}
                </section>
            </div>
        </LayoutShell>
    );
}
