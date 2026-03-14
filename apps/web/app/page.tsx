import { LayoutShell } from './components/layout-shell';
import { AddWalletCard } from './components/add-wallet-card';
import { apiFetch } from './lib/api';

type Overview = {
    trackedWallets: number;
    activeWallets: number;
    totalTrades: number;
    tradesToday: number;
    recentWalletActivity: Array<{
        walletId: string;
        label: string;
        address: string;
        marketId: string;
        marketQuestion: string | null;
        side: 'BUY' | 'SELL';
        price: number;
        size: number;
        tradedAt: string;
    }>;
};

export default async function HomePage() {
    const overview = await apiFetch<Overview>('/dashboard/overview').catch(() => null);

    return (
        <LayoutShell>
            <div className="space-y-5">
                {!overview && (
                    <div className="panel border-rose-500/40 p-4 text-sm text-rose-200">
                        Unable to load live API data. Check backend connectivity and try again.
                    </div>
                )}

                <section className="space-y-4">
                    <div>
                        <h2 className="text-2xl font-semibold tracking-tight">Track real Polymarket wallets</h2>
                        <p className="mt-1 text-sm text-slate-400">Paste a profile URL or wallet address to start ingesting real trade activity.</p>
                    </div>
                    <AddWalletCard />
                </section>

                {overview && overview.trackedWallets === 0 && (
                    <section className="panel flex min-h-[220px] items-center justify-center p-8 text-center">
                        <div className="max-w-xl">
                            <p className="text-lg font-medium">No wallets tracked yet</p>
                            <p className="mt-2 text-sm text-slate-400">Add a Polymarket profile URL or wallet above. Real trades will appear here as soon as sync begins.</p>
                        </div>
                    </section>
                )}

                {overview && overview.trackedWallets > 0 && (
                    <>
                        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
                            <Metric label="Tracked Wallets" value={String(overview.trackedWallets)} />
                            <Metric label="Active Wallets" value={String(overview.activeWallets)} />
                            <Metric label="Total Trades" value={String(overview.totalTrades)} />
                            <Metric label="Trades Today" value={String(overview.tradesToday)} />
                        </section>

                        <section className="panel p-4">
                            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Latest detected trades</h3>
                            {overview.recentWalletActivity.length === 0 && <p className="text-sm text-slate-400">No trade history yet.</p>}
                            <div className="space-y-2">
                                {overview.recentWalletActivity.slice(0, 20).map((trade) => (
                                    <div key={`${trade.walletId}-${trade.tradedAt}-${trade.marketId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 px-3 py-2 text-sm">
                                        <div>
                                            <p className="font-medium">{trade.label || trade.address}</p>
                                            <p className="text-xs text-slate-400">{trade.marketQuestion ?? trade.marketId}</p>
                                        </div>
                                        <div className="text-right">
                                            <p>{trade.side} • {trade.size.toFixed(2)} @ {trade.price.toFixed(4)}</p>
                                            <p className="text-xs text-slate-400">{new Date(trade.tradedAt).toLocaleString()}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </>
                )}
            </div>
        </LayoutShell>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="panel p-4">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
            <p className="mt-1 text-2xl font-semibold leading-none">{value}</p>
        </div>
    );
}
