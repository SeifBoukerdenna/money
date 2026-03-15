import { LayoutShell } from '../components/layout-shell';
import { apiFetch } from '../lib/api';

type TradesResponse = {
    page: number;
    pageSize: number;
    total: number;
    items: Array<{
        id: string;
        timestamp: string;
        marketId: string;
        marketQuestion: string | null;
        outcome: string;
        side: 'BUY' | 'SELL';
        price: number;
        size: number;
        notional: number;
        txHash: string | null;
        orderId: string | null;
    }>;
};

export default async function TradesPage() {
    const payload = await apiFetch<TradesResponse>('/trades?page=1&pageSize=100').catch(
        () =>
            ({
                page: 1,
                pageSize: 100,
                total: 0,
                items: [],
            }) as TradesResponse,
    );

    return (
        <LayoutShell>
            <div className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">Detected Source Trades</h2>
                    <p className="mt-1 text-sm text-slate-400">
                        This view shows normalized source wallet trades from ingestion, not copy decisions.
                    </p>
                </div>

                <div className="card">
                    <p className="text-sm text-slate-300">
                        Showing {payload.items.length} of {payload.total} trades
                    </p>
                </div>

                {payload.items.length === 0 && (
                    <div className="card text-slate-400">No source trades detected yet.</div>
                )}

                {payload.items.map((trade) => (
                    <div key={trade.id} className="card">
                        <div className="flex flex-wrap items-center gap-3">
                            <Badge label={trade.side} tone={trade.side === 'BUY' ? 'good' : 'warn'} />
                            <span className="text-sm text-slate-300">{trade.marketQuestion ?? trade.marketId}</span>
                            <span className="text-sm text-slate-400">{new Date(trade.timestamp).toLocaleString()}</span>
                        </div>

                        <p className="mt-2 text-sm text-slate-300">
                            {trade.size.toFixed(2)} @ {trade.price.toFixed(4)} ({trade.outcome}) • Notional ${trade.notional.toFixed(2)}
                        </p>

                        <p className="mt-1 text-xs text-slate-400">
                            tx: {trade.txHash ? shortId(trade.txHash) : '—'} • order: {trade.orderId ? shortId(trade.orderId) : '—'}
                        </p>
                    </div>
                ))}
            </div>
        </LayoutShell>
    );
}

function Badge({ label, tone }: { label: string; tone: 'good' | 'warn' }) {
    const classes =
        tone === 'good'
            ? 'border-emerald-600/50 bg-emerald-600/10 text-emerald-200'
            : 'border-amber-600/50 bg-amber-600/10 text-amber-200';
    return <span className={`rounded-md border px-2 py-1 text-xs font-medium ${classes}`}>{label}</span>;
}

function shortId(value: string): string {
    if (value.length <= 16) return value;
    return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
