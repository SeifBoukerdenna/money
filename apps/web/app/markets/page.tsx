import Link from 'next/link';

import { LayoutShell } from '../components/layout-shell';
import { apiFetch } from '../lib/api';

type MarketRow = {
    marketId: string;
    events: number;
    notional: number;
    latestPrice: number;
    latestAt: string;
};

export default async function MarketsPage() {
    const markets = await apiFetch<MarketRow[]>('/markets').catch(() => []);
    return (
        <LayoutShell>
            <div className="space-y-4">
                <h2 className="text-xl font-semibold">Markets Traded</h2>
                {markets.length === 0 && <div className="card text-slate-400">No markets detected yet.</div>}
                {markets.map((market) => (
                    <Link key={market.marketId} href={`/markets/${market.marketId}`} className="card block hover:bg-slate-900">
                        <div className="flex items-center justify-between">
                            <p className="font-medium">{market.marketId}</p>
                            <p className="text-xs text-slate-400">{new Date(market.latestAt).toLocaleString()}</p>
                        </div>
                        <p className="mt-2 text-sm text-slate-300">
                            Events {market.events} • Notional {market.notional.toFixed(2)} • Latest {market.latestPrice.toFixed(4)}
                        </p>
                    </Link>
                ))}
            </div>
        </LayoutShell>
    );
}
