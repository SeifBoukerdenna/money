'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    CartesianGrid,
    Line,
    LineChart,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';

import { LayoutShell } from '../components/layout-shell';

const API_BASE = process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';

type Wallet = {
    id: string;
    label: string;
    address: string;
    enabled: boolean;
};

type Session = {
    id: string;
    trackedWalletId: string;
    trackedWalletAddress: string;
    label: string;
    status: string;
    startingCash: number;
    currentCash: number;
    startedAt: string | null;
    endedAt: string | null;
    createdAt: string;
};

type SessionDetail = {
    id: string;
    trackedWalletId: string;
    trackedWalletAddress: string;
    trackedWalletLabel: string;
    status: string;
    startingCash: number;
    currentCash: number;
    startedAt: string | null;
    endedAt: string | null;
    estimatedSourceExposure: number | null;
    copyRatio: number | null;
    netLiquidationValue: number;
    totalPnl: number;
    returnPct: number;
    summarySentence: string;
    stats: {
        openPositionsCount: number;
        bestNotionalTrade: number | null;
        worstNotionalTrade: number | null;
    };
};

type MetricPoint = {
    timestamp: string;
    totalPnl: number;
    realizedPnl: number;
    unrealizedPnl: number;
    netLiquidationValue: number;
    openPositionsCount: number;
};

type PaperPosition = {
    id: string;
    marketId: string;
    marketQuestion: string | null;
    outcome: string;
    netShares: number;
    avgEntryPrice: number;
    currentMarkPrice: number;
    realizedPnl: number;
    unrealizedPnl: number;
    status: string;
    openedAt?: string | null;
    closedAt?: string | null;
    updatedAt?: string | null;
};

type PositionSortKey =
    | 'market'
    | 'shares'
    | 'entry'
    | 'mark'
    | 'exposure'
    | 'unrealized'
    | 'realized'
    | 'movePct'
    | 'openedAt'
    | 'closedAt'
    | 'updatedAt';

type SessionPanelTab = 'open' | 'closed' | 'comparisons';
type ChartMode = 'pct' | 'abs';

type PaperTrade = {
    id: string;
    marketId: string;
    marketUrl: string;
    marketQuestion: string | null;
    outcome: string;
    side: 'BUY' | 'SELL';
    action: string;
    sourceActivityEventId: string | null;
    sourceWalletAddress: string | null;
    sourceEventTimestamp: string | null;
    sourceTxHash: string | null;
    sourceTxUrl: string | null;
    sourceOrderId: string | null;
    sourceExternalEventId: string | null;
    sourcePrice: number | null;
    simulatedPrice: number;
    sourceShares: number | null;
    simulatedShares: number;
    notional: number;
    feeApplied: number;
    eventTimestamp: string;
};

export default function SimulationPage() {
    const [wallets, setWallets] = useState<Wallet[]>([]);
    const [selectedWalletId, setSelectedWalletId] = useState('');
    const [sessions, setSessions] = useState<Session[]>([]);
    const [activeSessionId, setActiveSessionId] = useState('');
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [metrics, setMetrics] = useState<MetricPoint[]>([]);
    const [openPositions, setOpenPositions] = useState<PaperPosition[]>([]);
    const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
    const [recentTrades, setRecentTrades] = useState<PaperTrade[]>([]);
    const [status, setStatus] = useState('');
    const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
    const [highlightedTradeId, setHighlightedTradeId] = useState<string | null>(null);
    const [openPrimarySort, setOpenPrimarySort] = useState<PositionSortKey>('unrealized');
    const [openSecondarySort, setOpenSecondarySort] = useState<PositionSortKey>('exposure');
    const [openSortDir, setOpenSortDir] = useState<'asc' | 'desc'>('desc');
    const [closedPrimarySort, setClosedPrimarySort] = useState<PositionSortKey>('realized');
    const [closedSecondarySort, setClosedSecondarySort] = useState<PositionSortKey>('closedAt');
    const [closedSortDir, setClosedSortDir] = useState<'asc' | 'desc'>('desc');
    const [activePanelTab, setActivePanelTab] = useState<SessionPanelTab>('open');
    const [chartMode, setChartMode] = useState<ChartMode>('pct');
    const activeSessionRef = useRef('');

    useEffect(() => {
        activeSessionRef.current = activeSessionId;
    }, [activeSessionId]);

    async function loadWallets() {
        const response = await fetch(`${API_BASE}/wallets`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as Wallet[];
        setWallets(data.filter((row) => row.enabled));
        if (!selectedWalletId && data[0]) {
            setSelectedWalletId(data[0].id);
        }
    }

    async function loadSessions(preferredSessionId?: string) {
        const response = await fetch(`${API_BASE}/paper-copy-sessions`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as Session[];
        setSessions(data);
        setActiveSessionId((current) => {
            if (preferredSessionId) {
                return preferredSessionId;
            }
            if (current && data.some((session) => session.id === current)) {
                return current;
            }
            return data[0]?.id ?? '';
        });
    }

    async function loadActiveSessionData(sessionId?: string) {
        const targetSessionId = sessionId ?? activeSessionId;
        if (!targetSessionId) return;
        const [detailRes, metricsRes, openRes, closedRes, tradesRes] = await Promise.all([
            fetch(`${API_BASE}/paper-copy-sessions/${targetSessionId}`, { cache: 'no-store' }),
            fetch(`${API_BASE}/paper-copy-sessions/${targetSessionId}/metrics?limit=400`, { cache: 'no-store' }),
            fetch(`${API_BASE}/paper-copy-sessions/${targetSessionId}/positions?status=OPEN`, { cache: 'no-store' }),
            fetch(`${API_BASE}/paper-copy-sessions/${targetSessionId}/positions?status=CLOSED`, { cache: 'no-store' }),
            fetch(`${API_BASE}/paper-copy-sessions/${targetSessionId}/trades?limit=100`, { cache: 'no-store' }),
        ]);

        if (targetSessionId !== activeSessionRef.current) {
            return;
        }

        if (detailRes.ok) {
            setDetail((await detailRes.json()) as SessionDetail);
        } else {
            setDetail(null);
        }
        if (metricsRes.ok) {
            setMetrics((await metricsRes.json()) as MetricPoint[]);
        } else {
            setMetrics([]);
        }
        if (openRes.ok) {
            setOpenPositions((await openRes.json()) as PaperPosition[]);
        } else {
            setOpenPositions([]);
        }
        if (closedRes.ok) {
            setClosedPositions((await closedRes.json()) as PaperPosition[]);
        } else {
            setClosedPositions([]);
        }
        if (tradesRes.ok) {
            setRecentTrades((await tradesRes.json()) as PaperTrade[]);
        } else {
            setRecentTrades([]);
        }
        setLastRefreshedAt(new Date().toISOString());
    }

    useEffect(() => {
        loadWallets();
        loadSessions();
    }, []);

    useEffect(() => {
        setDetail(null);
        setMetrics([]);
        setOpenPositions([]);
        setClosedPositions([]);
        setRecentTrades([]);
        setHighlightedTradeId(null);
        setLastRefreshedAt(null);
        setStatus('');

        if (!activeSessionId) {
            return;
        }

        loadActiveSessionData(activeSessionId);
        const interval = setInterval(() => {
            loadActiveSessionData(activeSessionId);
        }, 5000);
        return () => clearInterval(interval);
    }, [activeSessionId]);

    async function createSession() {
        if (!selectedWalletId) return;
        setStatus('Creating session...');
        const response = await fetch(`${API_BASE}/paper-copy-sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackedWalletId: selectedWalletId, startingCash: 50000 }),
        });
        if (!response.ok) {
            setStatus(await response.text());
            return;
        }
        const created = (await response.json()) as Session;
        setActiveSessionId(created.id);
        setStatus('Session created');
        await loadSessions(created.id);
    }

    async function act(action: 'start' | 'pause' | 'resume' | 'stop') {
        if (!activeSessionId) return;
        const response = await fetch(`${API_BASE}/paper-copy-sessions/${activeSessionId}/${action}`, {
            method: 'POST',
        });
        if (!response.ok) {
            setStatus(await response.text());
            return;
        }
        setStatus(`Session ${action}ed`);
        await loadSessions();
        await loadActiveSessionData();
    }

    const chartData = useMemo(() => {
        const basis = detail?.startingCash && detail.startingCash > 0 ? detail.startingCash : 1;
        return metrics
            .map((point) => ({
                ...point,
                totalPnlAbs: Number(point.totalPnl),
                totalPnlPct: (Number(point.totalPnl) / basis) * 100,
                ts: new Date(point.timestamp).getTime(),
                timeLabel: new Date(point.timestamp).toLocaleTimeString(),
            }))
            .filter((point) => Number.isFinite(point.ts))
            .sort((a, b) => a.ts - b.ts);
    }, [metrics, detail?.startingCash]);

    const chartValueKey = chartMode === 'pct' ? 'totalPnlPct' : 'totalPnlAbs';

    const chartYDomain = useMemo(() => {
        if (chartData.length === 0) {
            return [-1, 1] as [number, number];
        }
        const values = chartData.map((row) => Number(row[chartValueKey]));
        const min = Math.min(...values);
        const max = Math.max(...values);
        if (min === max) {
            const pad = Math.max(1, Math.abs(max) * 0.05);
            return [min - pad, max + pad] as [number, number];
        }
        const pad = Math.max(1, (max - min) * 0.08);
        return [min - pad, max + pad] as [number, number];
    }, [chartData, chartValueKey]);

    function positionMetric(row: PaperPosition, key: PositionSortKey): number | string {
        switch (key) {
            case 'market':
                return (row.marketQuestion ?? row.marketId).toLowerCase();
            case 'shares':
                return row.netShares;
            case 'entry':
                return row.avgEntryPrice;
            case 'mark':
                return row.currentMarkPrice;
            case 'exposure':
                return row.netShares * row.currentMarkPrice;
            case 'unrealized':
                return row.unrealizedPnl;
            case 'realized':
                return row.realizedPnl;
            case 'movePct':
                return row.avgEntryPrice > 0 ? ((row.currentMarkPrice - row.avgEntryPrice) / row.avgEntryPrice) * 100 : 0;
            case 'openedAt':
                return row.openedAt ? new Date(row.openedAt).getTime() : 0;
            case 'closedAt':
                return row.closedAt ? new Date(row.closedAt).getTime() : 0;
            case 'updatedAt':
                return row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
            default:
                return 0;
        }
    }

    function sortPositions(
        rows: PaperPosition[],
        primary: PositionSortKey,
        secondary: PositionSortKey,
        direction: 'asc' | 'desc',
    ) {
        const sign = direction === 'asc' ? 1 : -1;
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        return [...rows].sort((a, b) => {
            const aPrimary = positionMetric(a, primary);
            const bPrimary = positionMetric(b, primary);
            let cmp = 0;
            if (typeof aPrimary === 'string' && typeof bPrimary === 'string') {
                cmp = collator.compare(aPrimary, bPrimary);
            } else {
                cmp = Number(aPrimary) - Number(bPrimary);
            }

            if (cmp === 0) {
                const aSecondary = positionMetric(a, secondary);
                const bSecondary = positionMetric(b, secondary);
                if (typeof aSecondary === 'string' && typeof bSecondary === 'string') {
                    cmp = collator.compare(aSecondary, bSecondary);
                } else {
                    cmp = Number(aSecondary) - Number(bSecondary);
                }
            }

            return cmp * sign;
        });
    }

    const sortedOpenPositions = useMemo(
        () => sortPositions(openPositions, openPrimarySort, openSecondarySort, openSortDir),
        [openPositions, openPrimarySort, openSecondarySort, openSortDir],
    );

    const sortedClosedPositions = useMemo(
        () => sortPositions(closedPositions, closedPrimarySort, closedSecondarySort, closedSortDir),
        [closedPositions, closedPrimarySort, closedSecondarySort, closedSortDir],
    );

    return (
        <LayoutShell>
            <div className="space-y-4">
                <div className="panel p-4">
                    <h2 className="text-xl font-semibold">Paper Copy Session</h2>
                    <p className="mt-1 text-sm text-slate-400">Activity-driven simulator that mirrors a tracked wallet using real activity events.</p>

                    <div className="mt-3 grid gap-3 rounded-xl border border-slate-800/70 bg-slate-900/30 p-3 md:grid-cols-3">
                        <div>
                            <p className="text-[11px] uppercase tracking-wide text-slate-400">Step 1</p>
                            <p className="text-sm font-medium">Choose a tracked wallet</p>
                        </div>
                        <div>
                            <p className="text-[11px] uppercase tracking-wide text-slate-400">Step 2</p>
                            <p className="text-sm font-medium">Create/select a paper session</p>
                        </div>
                        <div>
                            <p className="text-[11px] uppercase tracking-wide text-slate-400">Step 3</p>
                            <p className="text-sm font-medium">Start and monitor copied activity</p>
                        </div>
                    </div>

                    <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
                        <select className="input" value={selectedWalletId} onChange={(e) => setSelectedWalletId(e.target.value)}>
                            <option value="">Select wallet</option>
                            {wallets.map((wallet) => (
                                <option key={wallet.id} value={wallet.id}>{wallet.label} ({wallet.address})</option>
                            ))}
                        </select>
                        <button className="btn-primary" onClick={createSession}>Create $50k Paper Session</button>
                    </div>

                    <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto_auto_auto_auto]">
                        <select className="input" value={activeSessionId} onChange={(e) => setActiveSessionId(e.target.value)}>
                            <option value="">Select session</option>
                            {sessions.map((session) => (
                                <option key={session.id} value={session.id}>{session.label} • {session.status} • {new Date(session.createdAt).toLocaleString()}</option>
                            ))}
                        </select>
                        <button className="btn-muted" onClick={() => act('start')}>Start Paper Copy</button>
                        <button className="btn-muted" onClick={() => act('pause')}>Pause</button>
                        <button className="btn-muted" onClick={() => act('resume')}>Resume</button>
                        <button className="btn-muted" onClick={() => act('stop')}>Stop</button>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <p className="text-slate-300">{status || 'Create or select a session to begin.'}</p>
                        {lastRefreshedAt && <p className="text-slate-400">Last refresh: {new Date(lastRefreshedAt).toLocaleTimeString()}</p>}
                    </div>
                </div>

                {detail && (
                    <>
                        <div className="panel p-3 text-sm text-slate-300">
                            <p>
                                <span className="font-semibold">How to read PnL:</span> Portfolio value is computed as cash + current mark-to-market value of open positions.
                            </p>
                        </div>

                        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                            <Stat label="Status" value={detail.status} />
                            <Stat label="Portfolio Value" value={`$${detail.netLiquidationValue.toFixed(2)}`} />
                            <Stat label="Total PnL" value={`$${detail.totalPnl.toFixed(2)}`} />
                            <Stat label="Return" value={`${detail.returnPct.toFixed(2)}%`} />
                            <Stat label="Cash" value={`$${detail.currentCash.toFixed(2)}`} />
                            <Stat label="Open Positions" value={String(detail.stats.openPositionsCount)} />
                            <Stat label="Copy Ratio" value={detail.copyRatio ? detail.copyRatio.toFixed(4) : '—'} />
                            <Stat label="Source Exposure" value={detail.estimatedSourceExposure ? `$${detail.estimatedSourceExposure.toFixed(2)}` : '—'} />
                            <Stat label="Best Trade" value={detail.stats.bestNotionalTrade ? `$${detail.stats.bestNotionalTrade.toFixed(2)}` : '—'} />
                            <Stat label="Worst Trade" value={detail.stats.worstNotionalTrade ? `$${detail.stats.worstNotionalTrade.toFixed(2)}` : '—'} />
                        </div>

                        <div className="panel p-4">
                            <p className="text-sm font-medium">{detail.summarySentence}</p>
                        </div>

                        <div className="panel p-4">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">PnL Evolution</h3>
                                <div className="flex items-center gap-1">
                                    <button
                                        className={`btn-muted ${chartMode === 'pct' ? 'ring-1 ring-blue-400' : ''}`}
                                        onClick={() => setChartMode('pct')}
                                    >
                                        % PnL
                                    </button>
                                    <button
                                        className={`btn-muted ${chartMode === 'abs' ? 'ring-1 ring-blue-400' : ''}`}
                                        onClick={() => setChartMode('abs')}
                                    >
                                        $ PnL
                                    </button>
                                </div>
                            </div>
                            {metrics.length === 0 && <p className="text-sm text-slate-400">No metric points yet.</p>}
                            {metrics.length > 0 && (
                                <div className="h-64 w-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                                            <XAxis
                                                type="number"
                                                dataKey="ts"
                                                domain={['dataMin', 'dataMax']}
                                                tickFormatter={(value) => new Date(value).toLocaleTimeString()}
                                                minTickGap={20}
                                                stroke="#94a3b8"
                                            />
                                            <YAxis
                                                stroke="#94a3b8"
                                                domain={[chartYDomain[0], chartYDomain[1]]}
                                                tickFormatter={(value) =>
                                                    chartMode === 'pct'
                                                        ? `${Number(value).toFixed(2)}%`
                                                        : `$${Number(value).toFixed(2)}`
                                                }
                                            />
                                            <ReferenceLine y={0} stroke="#334155" strokeDasharray="4 4" />
                                            <Tooltip
                                                labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                                                formatter={(value: number) =>
                                                    chartMode === 'pct'
                                                        ? [`${Number(value).toFixed(2)}%`, 'Total PnL']
                                                        : [`$${Number(value).toFixed(2)}`, 'Total PnL']
                                                }
                                                contentStyle={{
                                                    background: '#0f172a',
                                                    border: '1px solid #334155',
                                                    borderRadius: 12,
                                                }}
                                                labelStyle={{ color: '#e2e8f0' }}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey={chartValueKey}
                                                name={chartMode === 'pct' ? 'Total PnL %' : 'Total PnL $'}
                                                stroke="#60a5fa"
                                                strokeWidth={2.8}
                                                dot={{ r: 2.5 }}
                                                activeDot={{ r: 6 }}
                                                connectNulls
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            )}
                            <p className="mt-2 text-xs text-slate-400">
                                Chart shows total PnL over time for the selected session ({chartMode === 'pct' ? 'percentage' : 'dollar'} view).
                            </p>
                        </div>

                        <div className="panel p-2">
                            <div className="flex flex-wrap gap-2">
                                <button
                                    className={`btn-muted ${activePanelTab === 'open' ? 'ring-1 ring-blue-400' : ''}`}
                                    onClick={() => setActivePanelTab('open')}
                                >
                                    Open Positions
                                </button>
                                <button
                                    className={`btn-muted ${activePanelTab === 'closed' ? 'ring-1 ring-blue-400' : ''}`}
                                    onClick={() => setActivePanelTab('closed')}
                                >
                                    Closed Positions
                                </button>
                                <button
                                    className={`btn-muted ${activePanelTab === 'comparisons' ? 'ring-1 ring-blue-400' : ''}`}
                                    onClick={() => setActivePanelTab('comparisons')}
                                >
                                    Trade Comparisons
                                </button>
                            </div>
                        </div>

                        {activePanelTab === 'open' && (
                            <div className="panel p-4">
                                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Open Simulated Positions</h3>
                                <div className="mb-3 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                                    <select className="input" value={openPrimarySort} onChange={(e) => setOpenPrimarySort(e.target.value as PositionSortKey)}>
                                        <option value="unrealized">Sort by Unrealized</option>
                                        <option value="exposure">Sort by Exposure</option>
                                        <option value="movePct">Sort by Move %</option>
                                        <option value="shares">Sort by Shares</option>
                                        <option value="entry">Sort by Entry</option>
                                        <option value="mark">Sort by Mark</option>
                                        <option value="market">Sort by Market</option>
                                        <option value="openedAt">Sort by Opened Time</option>
                                        <option value="updatedAt">Sort by Updated Time</option>
                                    </select>
                                    <select className="input" value={openSecondarySort} onChange={(e) => setOpenSecondarySort(e.target.value as PositionSortKey)}>
                                        <option value="exposure">Then Exposure</option>
                                        <option value="unrealized">Then Unrealized</option>
                                        <option value="movePct">Then Move %</option>
                                        <option value="shares">Then Shares</option>
                                        <option value="market">Then Market</option>
                                        <option value="openedAt">Then Opened Time</option>
                                    </select>
                                    <button className="btn-muted" onClick={() => setOpenSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))}>
                                        {openSortDir === 'asc' ? 'Ascending' : 'Descending'}
                                    </button>
                                </div>
                                {sortedOpenPositions.length === 0 && <p className="text-sm text-slate-400">No open positions.</p>}
                                <div className="space-y-2">
                                    {sortedOpenPositions.map((row) => {
                                        const exposure = row.netShares * row.currentMarkPrice;
                                        const pnlPct = row.avgEntryPrice > 0
                                            ? ((row.currentMarkPrice - row.avgEntryPrice) / row.avgEntryPrice) * 100
                                            : 0;
                                        return (
                                            <div key={row.id} className="rounded-xl border border-slate-800/80 px-3 py-3 text-sm">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <p className="font-medium">{row.marketQuestion ?? row.marketId}</p>
                                                    <p className="text-xs text-slate-400">{row.outcome}</p>
                                                </div>
                                                <div className="mt-2 grid gap-2 text-xs text-slate-300 md:grid-cols-2 lg:grid-cols-4">
                                                    <p>Shares: <span className="font-semibold">{row.netShares.toFixed(2)}</span></p>
                                                    <p>Entry: <span className="font-semibold">{row.avgEntryPrice.toFixed(4)}</span></p>
                                                    <p>Mark: <span className="font-semibold">{row.currentMarkPrice.toFixed(4)}</span></p>
                                                    <p>Exposure: <span className="font-semibold">${exposure.toFixed(2)}</span></p>
                                                </div>
                                                <div className="mt-1 grid gap-2 text-xs text-slate-400 md:grid-cols-2 lg:grid-cols-4">
                                                    <p>Unrealized: {row.unrealizedPnl >= 0 ? '+' : ''}${row.unrealizedPnl.toFixed(2)}</p>
                                                    <p>Realized: {row.realizedPnl >= 0 ? '+' : ''}${row.realizedPnl.toFixed(2)}</p>
                                                    <p>Move: {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</p>
                                                    <p>Opened: {row.openedAt ? new Date(row.openedAt).toLocaleString() : '—'}</p>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {activePanelTab === 'closed' && (
                            <div className="panel p-4">
                                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Closed Simulated Positions (This Session)</h3>
                                <div className="mb-3 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                                    <select className="input" value={closedPrimarySort} onChange={(e) => setClosedPrimarySort(e.target.value as PositionSortKey)}>
                                        <option value="realized">Sort by Realized</option>
                                        <option value="closedAt">Sort by Closed Time</option>
                                        <option value="exposure">Sort by Exposure</option>
                                        <option value="movePct">Sort by Move %</option>
                                        <option value="shares">Sort by Shares</option>
                                        <option value="market">Sort by Market</option>
                                        <option value="openedAt">Sort by Opened Time</option>
                                    </select>
                                    <select className="input" value={closedSecondarySort} onChange={(e) => setClosedSecondarySort(e.target.value as PositionSortKey)}>
                                        <option value="closedAt">Then Closed Time</option>
                                        <option value="realized">Then Realized</option>
                                        <option value="movePct">Then Move %</option>
                                        <option value="exposure">Then Exposure</option>
                                        <option value="market">Then Market</option>
                                    </select>
                                    <button className="btn-muted" onClick={() => setClosedSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))}>
                                        {closedSortDir === 'asc' ? 'Ascending' : 'Descending'}
                                    </button>
                                </div>
                                {sortedClosedPositions.length === 0 && <p className="text-sm text-slate-400">No closed positions for this session yet.</p>}
                                <div className="space-y-2">
                                    {sortedClosedPositions.map((row) => {
                                        const exposure = row.netShares * row.currentMarkPrice;
                                        const pnlPct = row.avgEntryPrice > 0
                                            ? ((row.currentMarkPrice - row.avgEntryPrice) / row.avgEntryPrice) * 100
                                            : 0;
                                        return (
                                            <div key={row.id} className="rounded-xl border border-slate-800/80 px-3 py-3 text-sm">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <p className="font-medium">{row.marketQuestion ?? row.marketId}</p>
                                                    <p className="text-xs text-slate-400">{row.outcome}</p>
                                                </div>
                                                <div className="mt-2 grid gap-2 text-xs text-slate-300 md:grid-cols-2 lg:grid-cols-4">
                                                    <p>Shares: <span className="font-semibold">{row.netShares.toFixed(2)}</span></p>
                                                    <p>Entry: <span className="font-semibold">{row.avgEntryPrice.toFixed(4)}</span></p>
                                                    <p>Exit Mark: <span className="font-semibold">{row.currentMarkPrice.toFixed(4)}</span></p>
                                                    <p>Exposure: <span className="font-semibold">${exposure.toFixed(2)}</span></p>
                                                </div>
                                                <div className="mt-1 grid gap-2 text-xs text-slate-400 md:grid-cols-2 lg:grid-cols-4">
                                                    <p>Realized: {row.realizedPnl >= 0 ? '+' : ''}${row.realizedPnl.toFixed(2)}</p>
                                                    <p>Unrealized: {row.unrealizedPnl >= 0 ? '+' : ''}${row.unrealizedPnl.toFixed(2)}</p>
                                                    <p>Move: {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</p>
                                                    <p>Closed: {row.closedAt ? new Date(row.closedAt).toLocaleString() : '—'}</p>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {activePanelTab === 'comparisons' && (
                            <div className="panel p-4">
                                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Copied Trades vs Source Wallet Activity</h3>
                                {recentTrades.length === 0 && <p className="text-sm text-slate-400">No copied trades yet.</p>}
                                <div className="space-y-2">
                                    {recentTrades.map((row) => (
                                        <div
                                            id={`trade-card-${row.id}`}
                                            key={row.id}
                                            onMouseEnter={() => setHighlightedTradeId(row.id)}
                                            onMouseLeave={() => setHighlightedTradeId(null)}
                                            className={`rounded-xl border px-3 py-3 text-sm transition ${highlightedTradeId === row.id
                                                ? 'border-blue-400/70 bg-blue-500/5'
                                                : 'border-slate-800/80'
                                                }`}
                                        >
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <p className="font-medium">{row.action} {row.side} {row.marketQuestion ?? row.marketId} ({row.outcome})</p>
                                                <a href={row.marketUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-300 hover:text-blue-200">Open on Polymarket</a>
                                            </div>

                                            <div className="mt-2 grid gap-2 md:grid-cols-2">
                                                <div className="rounded-lg border border-slate-800/70 p-2">
                                                    <p className="text-[11px] uppercase tracking-wide text-slate-400">Source Wallet Did</p>
                                                    <p className="mt-1 text-xs text-slate-300">
                                                        {row.sourceShares !== null ? row.sourceShares.toFixed(2) : '—'} @ {row.sourcePrice !== null ? row.sourcePrice.toFixed(4) : '—'}
                                                    </p>
                                                    <p className="mt-1 text-xs text-slate-400">{row.sourceEventTimestamp ? new Date(row.sourceEventTimestamp).toLocaleString() : 'No source timestamp'}</p>
                                                    <div className="mt-1 flex flex-wrap gap-2">
                                                        {row.sourceTxUrl && (
                                                            <a href={row.sourceTxUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-300 hover:text-blue-200">View source tx</a>
                                                        )}
                                                        {row.sourceOrderId && <span className="text-xs text-slate-500">Order: {row.sourceOrderId.slice(0, 10)}…</span>}
                                                    </div>
                                                </div>

                                                <div className="rounded-lg border border-slate-800/70 p-2">
                                                    <p className="text-[11px] uppercase tracking-wide text-slate-400">Paper Copy Did</p>
                                                    <p className="mt-1 text-xs text-slate-300">
                                                        {row.simulatedShares.toFixed(2)} @ {row.simulatedPrice.toFixed(4)}
                                                    </p>
                                                    <p className="mt-1 text-xs text-slate-400">
                                                        {new Date(row.eventTimestamp).toLocaleString()} • Notional ${row.notional.toFixed(2)} • Fee ${row.feeApplied.toFixed(2)}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
                )}

                {!detail && (
                    <div className="panel p-4 text-sm text-slate-400">
                        No active session selected yet. Choose a wallet, create a paper session, then click <span className="font-semibold text-slate-200">Start Paper Copy</span>.
                    </div>
                )}
            </div>
        </LayoutShell>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="panel p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
            <p className="mt-1 text-sm font-semibold">{value}</p>
        </div>
    );
}

function Section({ title, rows }: { title: string; rows: Array<{ key: string; left: string; right: string }> }) {
    return (
        <div className="panel p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
            {rows.length === 0 && <p className="text-sm text-slate-400">No data yet.</p>}
            <div className="space-y-2">
                {rows.map((row) => (
                    <div key={row.key} className="rounded-xl border border-slate-800/80 px-3 py-2 text-sm">
                        <p className="font-medium">{row.left}</p>
                        <p className="mt-1 text-xs text-slate-400">{row.right}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}
