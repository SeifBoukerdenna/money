'use client';

import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeHistoryEntry {
    id: string;
    timestamp: string;
    action: string;
    side: 'BUY' | 'SELL';
    shares: number;
    price: number;
    fee: number;
    realizedPnl: number;
    netSharesAfter: number;
    avgEntryPriceAfter: number;
}

interface PositionDetail {
    netShares: number;
    avgEntryPrice: number;
    currentMarkPrice: number;
    realizedPnl: number;
    unrealizedPnl: number;
    status: 'OPEN' | 'CLOSED';
}

interface TradeHistoryResponse {
    marketId: string;
    outcome: string;
    marketQuestion: string | null;
    currentPosition: PositionDetail | null;
    tradeCount: number;
    trades: TradeHistoryEntry[];
}

interface MarketSummaryEntry {
    marketId: string;
    outcome: string;
    marketQuestion: string | null;
    totalInvested: number;
    totalReturned: number;
    netRealizedPnl: number;
    unrealizedPnl: number;
    currentNetShares: number;
    avgEntryPrice: number;
    status: 'OPEN' | 'CLOSED';
    tradeCount: number;
    buyCount: number;
    sellCount: number;
}

interface MarketSummaryResponse {
    sessionId: string;
    marketCount: number;
    markets: MarketSummaryEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API = process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';

function fmtDollar(val: number): string {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : val > 0 ? '+' : '';
    return `${sign}$${abs.toFixed(2)}`;
}

function fmtPrice(val: number): string {
    if (val >= 1) return val.toFixed(2);
    if (val >= 0.01) return val.toFixed(4);
    return val.toFixed(6);
}

function fmtShares(val: number): string {
    if (val >= 100) return val.toFixed(2);
    return val.toFixed(4);
}

function pnlColor(val: number): string {
    if (val > 0.005) return 'text-emerald-400';
    if (val < -0.005) return 'text-red-400';
    return 'text-slate-400';
}

function sideBadge(side: 'BUY' | 'SELL', action: string): string {
    if (action === 'REDEEM') return 'bg-amber-900/50 text-amber-300 border-amber-700/50';
    if (action === 'RECONCILE_CLOSE' || action === 'FORCE_CLOSE')
        return 'bg-purple-900/50 text-purple-300 border-purple-700/50';
    if (side === 'BUY') return 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50';
    return 'bg-red-900/50 text-red-300 border-red-700/50';
}

function actionLabel(action: string, side: 'BUY' | 'SELL'): string {
    switch (action) {
        case 'BOOTSTRAP': return 'BOOTSTRAP';
        case 'REDEEM': return 'REDEEM';
        case 'RECONCILE_CLOSE': return 'RECONCILE';
        case 'FORCE_CLOSE': return 'FORCE CLOSE';
        case 'FORCE_CLOSE_LOT': return 'FORCE CLOSE';
        case 'CLOSE': return 'CLOSE';
        case 'REDUCE': return 'PARTIAL SELL';
        case 'INCREASE': return 'ADD';
        case 'COPY': return side;
        default: return side;
    }
}

// ---------------------------------------------------------------------------
// PositionHistoryPopup — shows the trade sequence for one market:outcome
// ---------------------------------------------------------------------------

export function PositionHistoryPopup({
    sessionId,
    marketId,
    outcome,
    onClose,
}: {
    sessionId: string;
    marketId: string;
    outcome: string;
    onClose: () => void;
}) {
    const [data, setData] = useState<TradeHistoryResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);

        fetch(`${API}/paper-copy-sessions/${sessionId}/positions/${encodeURIComponent(marketId)}/${encodeURIComponent(outcome)}/trades`)
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then((json) => {
                if (!cancelled) setData(json as TradeHistoryResponse);
            })
            .catch((err) => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => { cancelled = true; };
    }, [sessionId, marketId, outcome]);

    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="relative w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-xl border border-slate-700/80 bg-slate-900 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between border-b border-slate-800/70 px-6 py-4">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-slate-100 leading-tight">
                            Position History
                        </h2>
                        {data?.marketQuestion && (
                            <p className="mt-1 text-sm text-slate-400 truncate">
                                {data.marketQuestion}
                            </p>
                        )}
                        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                            <span className="font-mono">{marketId.slice(0, 12)}…</span>
                            <span className={`rounded px-1.5 py-0.5 font-medium ${outcome === 'YES' ? 'bg-emerald-900/40 text-emerald-400' : 'bg-red-900/40 text-red-400'}`}>
                                {outcome}
                            </span>
                        </div>
                    </div>
                    <button
                        className="ml-4 rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Position Summary */}
                {data?.currentPosition && (
                    <div className="grid grid-cols-4 gap-3 border-b border-slate-800/70 px-6 py-3 text-xs">
                        <div>
                            <span className="text-slate-500 block">Net Shares</span>
                            <span className="font-mono text-slate-200">{fmtShares(data.currentPosition.netShares)}</span>
                        </div>
                        <div>
                            <span className="text-slate-500 block">Avg Entry</span>
                            <span className="font-mono text-slate-200">{fmtPrice(data.currentPosition.avgEntryPrice)}</span>
                        </div>
                        <div>
                            <span className="text-slate-500 block">Realized P/L</span>
                            <span className={`font-mono ${pnlColor(data.currentPosition.realizedPnl)}`}>
                                {fmtDollar(data.currentPosition.realizedPnl)}
                            </span>
                        </div>
                        <div>
                            <span className="text-slate-500 block">Unrealized P/L</span>
                            <span className={`font-mono ${pnlColor(data.currentPosition.unrealizedPnl)}`}>
                                {fmtDollar(data.currentPosition.unrealizedPnl)}
                            </span>
                        </div>
                    </div>
                )}

                {/* Trade Table */}
                <div className="overflow-y-auto" style={{ maxHeight: 'calc(85vh - 180px)' }}>
                    {loading && (
                        <div className="flex items-center justify-center py-12">
                            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
                        </div>
                    )}
                    {error && (
                        <div className="px-6 py-8 text-center text-sm text-red-400">{error}</div>
                    )}
                    {data && !loading && data.trades.length === 0 && (
                        <div className="px-6 py-8 text-center text-sm text-slate-500">No trades found for this position.</div>
                    )}
                    {data && !loading && data.trades.length > 0 && (
                        <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur-sm">
                                <tr className="border-b border-slate-800/60 text-left text-[10px] font-medium uppercase tracking-wider text-slate-500">
                                    <th className="px-4 py-2">Time</th>
                                    <th className="px-3 py-2">Action</th>
                                    <th className="px-3 py-2 text-right">Shares</th>
                                    <th className="px-3 py-2 text-right">Price</th>
                                    <th className="px-3 py-2 text-right">Realized P/L</th>
                                    <th className="px-3 py-2 text-right">Position After</th>
                                    <th className="px-3 py-2 text-right">Avg Entry After</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/40">
                                {data.trades.map((trade) => (
                                    <tr key={trade.id} className="hover:bg-slate-800/30 transition-colors">
                                        <td className="px-4 py-2 font-mono text-slate-400 whitespace-nowrap">
                                            {new Date(trade.timestamp).toLocaleString(undefined, {
                                                month: 'short', day: 'numeric',
                                                hour: '2-digit', minute: '2-digit', second: '2-digit',
                                            })}
                                        </td>
                                        <td className="px-3 py-2">
                                            <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${sideBadge(trade.side, trade.action)}`}>
                                                {actionLabel(trade.action, trade.side)}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-200">
                                            {fmtShares(trade.shares)}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-200">
                                            {fmtPrice(trade.price)}
                                        </td>
                                        <td className={`px-3 py-2 text-right font-mono ${pnlColor(trade.realizedPnl)}`}>
                                            {trade.realizedPnl !== 0 ? fmtDollar(trade.realizedPnl) : '—'}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-300">
                                            {fmtShares(trade.netSharesAfter)}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-400">
                                            {fmtPrice(trade.avgEntryPriceAfter)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Footer */}
                {data && (
                    <div className="border-t border-slate-800/70 px-6 py-3 text-xs text-slate-500 flex justify-between">
                        <span>{data.tradeCount} trade{data.tradeCount !== 1 ? 's' : ''}</span>
                        <span className={`font-medium ${data.currentPosition?.status === 'OPEN' ? 'text-emerald-400' : 'text-slate-400'}`}>
                            {data.currentPosition?.status ?? 'UNKNOWN'}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// MarketHistoryView — per-market performance summary table
// ---------------------------------------------------------------------------

export function MarketHistoryView({
    sessionId,
}: {
    sessionId: string;
}) {
    const [data, setData] = useState<MarketSummaryResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
    const [selectedMarket, setSelectedMarket] = useState<{ marketId: string; outcome: string } | null>(null);

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${API}/paper-copy-sessions/${sessionId}/market-summary?status=${statusFilter}&sortBy=pnl`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setData(await res.json() as MarketSummaryResponse);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, [sessionId, statusFilter]);

    useEffect(() => { loadData(); }, [loadData]);

    return (
        <div>
            {/* Filter tabs */}
            <div className="flex items-center justify-between border-b border-slate-800/70 px-4 py-3">
                <h3 className="text-sm font-semibold tracking-wide text-slate-300">Market History</h3>
                <div className="inline-flex rounded-lg border border-slate-700/80 bg-slate-950/50 p-1">
                    {(['ALL', 'OPEN', 'CLOSED'] as const).map((s) => (
                        <button
                            key={s}
                            className={`rounded-md px-3 py-1.5 text-xs ${statusFilter === s ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800'}`}
                            onClick={() => setStatusFilter(s)}
                        >
                            {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            {loading && (
                <div className="flex items-center justify-center py-12">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-slate-300" />
                </div>
            )}
            {error && <div className="px-4 py-8 text-center text-sm text-red-400">{error}</div>}

            {data && !loading && data.markets.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-slate-500">No markets found.</div>
            )}

            {data && !loading && data.markets.length > 0 && (
                <div className="divide-y divide-slate-800/40">
                    {data.markets.map((m) => (
                        <button
                            key={`${m.marketId}:${m.outcome}`}
                            className="w-full text-left px-4 py-3 hover:bg-slate-800/30 transition-colors"
                            onClick={() => setSelectedMarket({ marketId: m.marketId, outcome: m.outcome })}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-slate-200 truncate">
                                        {m.marketQuestion ?? m.marketId}
                                    </p>
                                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                                        <span className={`rounded px-1 py-0.5 font-medium ${m.outcome === 'YES' ? 'bg-emerald-900/40 text-emerald-400' : 'bg-red-900/40 text-red-400'}`}>
                                            {m.outcome}
                                        </span>
                                        <span>{m.tradeCount} trades</span>
                                        <span className={`rounded px-1.5 py-0.5 ${m.status === 'OPEN' ? 'bg-emerald-900/30 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                                            {m.status}
                                        </span>
                                    </div>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className={`text-sm font-mono font-medium ${pnlColor(m.netRealizedPnl)}`}>
                                        {fmtDollar(m.netRealizedPnl)}
                                    </p>
                                    <div className="mt-1 text-[10px] text-slate-500 space-y-0.5">
                                        <div>Invested: ${m.totalInvested.toFixed(2)}</div>
                                        <div>Returned: ${m.totalReturned.toFixed(2)}</div>
                                    </div>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {/* Position History Popup */}
            {selectedMarket && (
                <PositionHistoryPopup
                    sessionId={sessionId}
                    marketId={selectedMarket.marketId}
                    outcome={selectedMarket.outcome}
                    onClose={() => setSelectedMarket(null)}
                />
            )}
        </div>
    );
}