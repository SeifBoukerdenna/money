import { LayoutShell } from '../../components/layout-shell';
import { apiFetch } from '../../lib/api';

type Detail = {
    marketId: string;
    eventCount: number;
    latestTradeAt: string | null;
    sourceNotional: number;
    decisions: Array<{
        id: string;
        action: 'EXECUTE' | 'SKIP';
        side: 'BUY' | 'SELL';
        orderSize: string;
        limitPrice: string;
        createdAt: string;
        execution?: { status: string };
    }>;
};

export default async function MarketDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const detail = await apiFetch<Detail>(`/markets/${id}`).catch(
        () => ({ marketId: id, eventCount: 0, latestTradeAt: null, sourceNotional: 0, decisions: [] }) as Detail,
    );
    return (
        <LayoutShell>
            <div className="space-y-4">
                <div className="card">
                    <h2 className="text-xl font-semibold">{detail.marketId}</h2>
                    <p className="text-sm text-slate-400">
                        Events {detail.eventCount} • Source Notional {detail.sourceNotional.toFixed(2)}
                    </p>
                </div>
                {detail.decisions.map((decision) => (
                    <div key={decision.id} className="card">
                        <p className="text-sm">
                            {decision.action} {decision.side} {Number(decision.orderSize).toFixed(2)} @ {Number(decision.limitPrice).toFixed(4)}
                        </p>
                        <p className="text-xs text-slate-400">
                            {new Date(decision.createdAt).toLocaleString()} • {decision.execution?.status ?? 'Pending'}
                        </p>
                    </div>
                ))}
            </div>
        </LayoutShell>
    );
}
