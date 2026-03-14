import { LayoutShell } from '../components/layout-shell';
import { apiFetch } from '../lib/api';

type TradeRow = {
    id: string;
    action: 'EXECUTE' | 'SKIP';
    side: 'BUY' | 'SELL';
    orderSize: string;
    limitPrice: string;
    createdAt: string;
    reasonsJson: Array<{ code: string; message: string }>;
    tradeEvent: { sourceWalletAddress: string; marketId: string; outcome: string };
    execution?: { status: string; errorMessage: string | null };
};

export default async function TradesPage() {
    const payload = await apiFetch<TradeRow[] | { recentWalletActivity?: unknown[] }>('/trades').catch(() => [] as TradeRow[]);
    const trades = Array.isArray(payload) ? payload : [];
    return (
        <LayoutShell>
            <div className="space-y-4">
                <h2 className="text-xl font-semibold">Trade Log</h2>
                {trades.length === 0 && <div className="card text-slate-400">No trade decisions yet.</div>}
                {trades.map((trade) => (
                    <div key={trade.id} className="card">
                        <div className="flex flex-wrap items-center gap-3">
                            <Badge label={trade.action} tone={trade.action === 'EXECUTE' ? 'good' : 'warn'} />
                            <Badge label={trade.side} tone="neutral" />
                            <span className="text-sm text-slate-300">{trade.tradeEvent.marketId}</span>
                            <span className="text-sm text-slate-400">{new Date(trade.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="mt-2 text-sm text-slate-300">
                            Size {Number(trade.orderSize).toFixed(2)} @ {Number(trade.limitPrice).toFixed(4)} • Wallet {trade.tradeEvent.sourceWalletAddress}
                        </p>
                        {trade.reasonsJson?.length > 0 && (
                            <p className="mt-2 text-xs text-amber-300">Reasons: {trade.reasonsJson.map((r) => r.code).join(', ')}</p>
                        )}
                        {trade.execution && (
                            <p className="mt-1 text-xs text-slate-400">
                                Execution: {trade.execution.status}
                                {trade.execution.errorMessage ? ` (${trade.execution.errorMessage})` : ''}
                            </p>
                        )}
                    </div>
                ))}
            </div>
        </LayoutShell>
    );
}

function Badge({ label, tone }: { label: string; tone: 'good' | 'warn' | 'neutral' }) {
    const classes =
        tone === 'good'
            ? 'border-emerald-600/50 bg-emerald-600/10 text-emerald-200'
            : tone === 'warn'
                ? 'border-amber-600/50 bg-amber-600/10 text-amber-200'
                : 'border-slate-600 bg-slate-700/40 text-slate-200';
    return <span className={`rounded-md border px-2 py-1 text-xs font-medium ${classes}`}>{label}</span>;
}
