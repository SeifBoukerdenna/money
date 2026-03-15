import Link from 'next/link';

import { LayoutShell } from '../components/layout-shell';
import { apiFetch } from '../lib/api';

type MarketRow = {
    marketId: string;
    marketQuestion: string | null;
    tradeCount: number;
    lastTradeAt: string | null;
};

export default async function MarketsPage() {
    const markets = await apiFetch<MarketRow[]>('/markets?limit=100').catch(() => []);

    return (
        <LayoutShell>
            <div className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">Markets Tracked by Source Activity</h2>
                    <p className="mt-1 text-sm text-slate-400">
                        Ranked by number of detected source trades.
                    </p>
                </div>

                {markets.length === 0 && <div className="card text-slate-400">No markets detected yet.</div>}

                {markets.map((market) => (
                    <Link key={market.marketId} href={`/markets/${encodeURIComponent(market.marketId)}`} className="card block hover:bg-slate-900">
                        <div className="flex items-center justify-between">
                            <p className="font-medium">{market.marketQuestion ?? market.marketId}</p>
                            <p className="text-xs text-slate-400">
                                {market.lastTradeAt ? new Date(market.lastTradeAt).toLocaleString() : '—'}
                            </p>
                        </div>
                        <p className="mt-2 text-sm text-slate-300">
                            Market ID: {market.marketId}
                        </p>
                        <p className="mt-1 text-sm text-slate-300">Detected source trades: {market.tradeCount}</p>
                    </Link>
                ))}
            </div>
        </LayoutShell>
    );
}
