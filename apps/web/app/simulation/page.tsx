'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Area,
    AreaChart,
    CartesianGrid,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { LayoutShell } from '../components/layout-shell';

const API = process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';
const MAX_CHART_POINTS = 200;

// ---------------------------------------------------------------------------
// Polymarket fee presets
// Polymarket taker fee = 2% (200 bps). Makers = 0%.
// As a copy follower you are always a taker (taking liquidity to follow).
// Slippage estimate: 20 bps for liquid markets, 50+ for thin ones.
// ---------------------------------------------------------------------------
const FEE_PRESETS = [
    { label: 'Polymarket (2% fee)', feeBps: 200, slippageBps: 20, note: 'Realistic — 2% taker fee + 0.2% slippage' },
    { label: 'Conservative', feeBps: 200, slippageBps: 50, note: '2% fee + 0.5% slippage for thin markets' },
    { label: 'Zero fees', feeBps: 0, slippageBps: 0, note: 'Theoretical best-case, unrealistic' },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Wallet = {
    id: string;
    label: string;
    address: string;
    enabled: boolean;
    syncStatus: string;
};

type SessionListItem = {
    id: string;
    trackedWalletId: string;
    trackedWalletAddress: string;
    trackedWalletLabel: string;
    status: string;
    startingCash: number;
    currentCash: number;
    startedAt: string | null;
    endedAt: string | null;
    createdAt: string;
    lastProcessedEventAt: string | null;
    totalPnl: number;
    returnPct: number;
    netLiquidationValue: number;
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
    lastProcessedEventAt: string | null;
    estimatedSourceExposure: number | null;
    copyRatio: number | null;
    netLiquidationValue: number;
    totalPnl: number;
    returnPct: number;
    summarySentence: string;
    stats: { openPositionsCount: number };
};

type Health = {
    status: string;
    lastProcessedEventAt: string | null;
    lagSeconds: number;
    isStale: boolean;
    walletSyncStatus: string;
    walletLastSyncAt: string | null;
    walletLastSyncError: string | null;
    walletNextPollAt: string | null;
    latestSourceEventAt: string | null;
};

type ChartPoint = {
    ts: number;
    label: string;
    pnlPct: number;
    pnlAbs: number;
};

type Position = {
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
    openedAt: string | null;
    closedAt: string | null;
};

type Trade = {
    id: string;
    marketId: string;
    marketUrl: string;
    marketQuestion: string | null;
    outcome: string;
    side: 'BUY' | 'SELL';
    action: string;
    sourceActivityEventId: string | null;
    sourceEventTimestamp: string | null;
    sourceTxUrl: string | null;
    sourcePrice: number | null;
    simulatedPrice: number;
    sourceShares: number | null;
    simulatedShares: number;
    notional: number;
    feeApplied: number;
    eventTimestamp: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(n: number, digits = 2): string {
    const abs = Math.abs(n);
    const str =
        abs >= 10000
            ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
            : abs.toFixed(digits);
    return (n < 0 ? '−$' : '$') + str;
}

function fmtPct(n: number): string {
    return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
}

function fmtAge(iso: string | null): string {
    if (!iso) return '—';
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
}

function downsample<T>(arr: T[], max: number): T[] {
    if (arr.length <= max) return arr;
    const step = arr.length / max;
    const result: T[] = [];
    for (let i = 0; i < max; i++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        result.push(arr[Math.round(i * step)]!);
    }
    // Always keep the last point
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    result[result.length - 1] = arr[arr.length - 1]!;
    return result;
}

function pnlClass(n: number): string {
    if (n > 0) return 'text-emerald-400';
    if (n < 0) return 'text-rose-400';
    return 'text-slate-300';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status, isStale }: { status: string; isStale?: boolean }) {
    if (status === 'RUNNING') {
        return (
            <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${isStale
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    }`}
            >
                <span
                    className={`h-1.5 w-1.5 rounded-full ${isStale ? 'bg-amber-400' : 'animate-pulse bg-emerald-400'}`}
                />
                {isStale ? 'STALE' : 'LIVE'}
            </span>
        );
    }
    if (status === 'PAUSED') {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/60 bg-slate-700/20 px-2.5 py-1 text-xs font-semibold text-slate-300">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                PAUSED
            </span>
        );
    }
    if (status === 'COMPLETED') {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-300">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                DONE
            </span>
        );
    }
    return (
        <span className="rounded-full border border-slate-700/60 bg-slate-700/20 px-2.5 py-1 text-xs text-slate-400">
            {status}
        </span>
    );
}

function HealthBar({ health, walletAddress }: { health: Health | null; walletAddress?: string }) {
    if (!health) return null;
    const stale = health.isStale;
    return (
        <div
            className={`rounded-xl border px-4 py-2.5 text-xs ${stale
                ? 'border-amber-500/30 bg-amber-500/8 text-amber-300'
                : 'border-slate-800/50 bg-slate-900/30 text-slate-400'
                }`}
        >
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                <span>
                    Wallet:{' '}
                    <span className={`font-medium ${health.walletSyncStatus === 'ACTIVE' ? 'text-emerald-400' : 'text-slate-300'}`}>
                        {health.walletSyncStatus}
                    </span>
                    {health.walletLastSyncAt && (
                        <span className="ml-1 text-slate-600">({fmtAge(health.walletLastSyncAt)})</span>
                    )}
                    {walletAddress && (
                        <a
                            href={`https://polymarket.com/profile/${walletAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 text-blue-500 hover:text-blue-400"
                            title="View wallet on Polymarket"
                        >
                            View on Polymarket ↗
                        </a>
                    )}
                </span>
                <span>
                    Last event processed:{' '}
                    <span className="font-medium text-slate-300">
                        {fmtAge(health.lastProcessedEventAt)}
                    </span>
                </span>
                <span>
                    Latest source event:{' '}
                    <span className="font-medium text-slate-300">
                        {fmtAge(health.latestSourceEventAt)}
                    </span>
                </span>
                {stale && (
                    <span className="font-semibold text-amber-300">
                        ⚠ No events processed in {health.lagSeconds}s — session may be stalled
                    </span>
                )}
                {health.walletLastSyncError && (
                    <span className="text-rose-400">
                        Sync error: {health.walletLastSyncError.slice(0, 100)}
                    </span>
                )}
            </div>
        </div>
    );
}

function MetricBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="panel p-3">
            <p className="text-[10px] font-medium uppercase tracking-widest text-slate-500">{label}</p>
            <p className="mt-1 text-sm font-semibold text-slate-200">{value}</p>
            {sub && <p className="mt-0.5 text-[10px] text-slate-600">{sub}</p>}
        </div>
    );
}

function PositionsTable({
    positions,
    showClosed = false,
    empty,
}: {
    positions: Position[];
    showClosed?: boolean;
    empty: string;
}) {
    if (!positions.length)
        return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>;

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-slate-800/60 text-[11px] uppercase tracking-wide text-slate-500">
                        <th className="pb-2 text-left font-medium">Market</th>
                        <th className="pb-2 pr-3 text-right font-medium">Side</th>
                        <th className="pb-2 pr-3 text-right font-medium">Shares</th>
                        <th className="pb-2 pr-3 text-right font-medium">Entry</th>
                        <th className="pb-2 pr-3 text-right font-medium">Mark</th>
                        <th className="pb-2 text-right font-medium">PnL</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/30">
                    {positions.map((p) => {
                        const pnl = showClosed ? p.realizedPnl : p.unrealizedPnl;
                        const movePct =
                            p.avgEntryPrice > 0
                                ? ((p.currentMarkPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100
                                : 0;
                        return (
                            <tr key={p.id} className="transition hover:bg-slate-800/20">
                                <td className="max-w-[220px] py-2 pr-4">
                                    <p
                                        className="truncate text-slate-200"
                                        title={p.marketQuestion ?? p.marketId}
                                    >
                                        {p.marketQuestion ?? p.marketId}
                                    </p>
                                    <p className="text-[10px] text-slate-600">
                                        {showClosed && p.closedAt
                                            ? `Closed ${fmtAge(p.closedAt)}`
                                            : p.openedAt
                                                ? `Opened ${fmtAge(p.openedAt)}`
                                                : ''}
                                    </p>
                                </td>
                                <td className="py-2 pr-3 text-right">
                                    <span
                                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${p.outcome === 'YES'
                                            ? 'bg-emerald-500/15 text-emerald-300'
                                            : 'bg-rose-500/15 text-rose-300'
                                            }`}
                                    >
                                        {p.outcome}
                                    </span>
                                </td>
                                <td className="py-2 pr-3 text-right font-mono text-slate-300">
                                    {p.netShares.toFixed(1)}
                                </td>
                                <td className="py-2 pr-3 text-right font-mono text-slate-400">
                                    {p.avgEntryPrice.toFixed(3)}
                                </td>
                                <td className="py-2 pr-3 text-right font-mono">
                                    <span className={movePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                        {p.currentMarkPrice.toFixed(3)}
                                    </span>
                                    <span className="ml-1 text-[10px] text-slate-600">
                                        ({movePct >= 0 ? '+' : ''}
                                        {movePct.toFixed(1)}%)
                                    </span>
                                </td>
                                <td
                                    className={`py-2 text-right font-mono font-semibold tabular-nums ${pnlClass(pnl)}`}
                                >
                                    {pnl >= 0 ? '+' : ''}
                                    {pnl.toFixed(2)}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function TradesLog({ trades }: { trades: Trade[] }) {
    if (!trades.length)
        return (
            <p className="py-6 text-center text-sm text-slate-500">
                No copied trades yet. Start the session to begin mirroring activity.
            </p>
        );

    return (
        <div className="space-y-2">
            {trades.map((t) => {
                const isBootstrap = t.action === 'BOOTSTRAP';
                const isBuy = t.side === 'BUY';
                return (
                    <div key={t.id} className="rounded-xl border border-slate-800/60 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <span
                                    className={`rounded px-2 py-0.5 text-xs font-bold ${isBootstrap
                                        ? 'bg-slate-700/40 text-slate-300'
                                        : isBuy
                                            ? 'bg-emerald-500/15 text-emerald-300'
                                            : 'bg-rose-500/15 text-rose-300'
                                        }`}
                                >
                                    {isBootstrap ? 'BOOTSTRAP' : t.side}
                                </span>
                                <span className="text-xs font-medium text-slate-200">{t.outcome}</span>
                                <span className="text-xs text-slate-500">{t.action}</span>
                            </div>
                            <div className="text-right text-xs">
                                <p className="font-mono text-slate-300">
                                    {t.simulatedShares.toFixed(2)} @ {t.simulatedPrice.toFixed(4)}
                                </p>
                                <p className="text-slate-500">
                                    ${t.notional.toFixed(2)}
                                    {t.feeApplied > 0 ? ` · fee $${t.feeApplied.toFixed(2)}` : ''}
                                </p>
                            </div>
                        </div>
                        <p
                            className="mt-1.5 truncate text-xs text-slate-400"
                            title={t.marketQuestion ?? t.marketId}
                        >
                            {t.marketQuestion ?? t.marketId}
                        </p>
                        {!isBootstrap && t.sourceActivityEventId && (
                            <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800/40 pt-2 text-[11px] text-slate-500">
                                <span>
                                    Source: {t.sourceShares?.toFixed(2) ?? '—'} @{' '}
                                    {t.sourcePrice?.toFixed(4) ?? '—'}
                                </span>
                                {t.sourceEventTimestamp && (
                                    <span>{fmtAge(t.sourceEventTimestamp)}</span>
                                )}
                                {t.sourceTxUrl && (
                                    <a
                                        href={t.sourceTxUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-400 hover:text-blue-300"
                                    >
                                        View tx ↗
                                    </a>
                                )}
                            </div>
                        )}
                        {isBootstrap && (
                            <p className="mt-1.5 text-[11px] text-slate-600">
                                Bootstrapped from source wallet's open positions at session start.
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function EmptyDashboard({
    hasWallets,
    hasSessions,
}: {
    hasWallets: boolean;
    hasSessions: boolean;
}) {
    return (
        <div className="panel flex min-h-[360px] items-center justify-center p-10 text-center">
            <div className="max-w-xs">
                {!hasWallets ? (
                    <>
                        <div className="mb-3 text-4xl">📡</div>
                        <p className="font-semibold text-slate-200">No wallets tracked yet</p>
                        <p className="mt-2 text-sm text-slate-400">
                            Go to <strong>Wallets</strong> and add a Polymarket wallet address first.
                        </p>
                    </>
                ) : !hasSessions ? (
                    <>
                        <div className="mb-3 text-4xl">🎯</div>
                        <p className="font-semibold text-slate-200">Create your first paper session</p>
                        <p className="mt-2 text-sm text-slate-400">
                            Pick a wallet, set a bankroll, and click{' '}
                            <strong>Create Paper Session</strong> in the panel on the left.
                        </p>
                    </>
                ) : (
                    <>
                        <div className="mb-3 text-4xl">👈</div>
                        <p className="font-semibold text-slate-200">Select a session</p>
                        <p className="mt-2 text-sm text-slate-400">
                            Pick a session from the list on the left to open its live dashboard.
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SimulationPage() {
    // ── Setup state ───────────────────────────────────────────────────────────
    const [wallets, setWallets] = useState<Wallet[]>([]);
    const [selectedWalletId, setSelectedWalletId] = useState('');
    const [bankroll, setBankroll] = useState('10000');
    const [feeBps, setFeeBps] = useState('200');
    const [slippageBps, setSlippageBps] = useState('20');
    const [creating, setCreating] = useState(false);
    const [setupError, setSetupError] = useState('');

    // ── Session state ─────────────────────────────────────────────────────────
    const [sessions, setSessions] = useState<SessionListItem[]>([]);
    const [activeSessionId, setActiveSessionId] = useState('');
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [health, setHealth] = useState<Health | null>(null);
    const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
    const [openPositions, setOpenPositions] = useState<Position[]>([]);
    const [closedPositions, setClosedPositions] = useState<Position[]>([]);
    const [trades, setTrades] = useState<Trade[]>([]);
    const [activeTab, setActiveTab] = useState<'positions' | 'trades' | 'closed'>('positions');
    const [chartMode, setChartMode] = useState<'pct' | 'abs'>('pct');
    const [actionLoading, setActionLoading] = useState('');
    const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
    const [killAllConfirm, setKillAllConfirm] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [repairLoading, setRepairLoading] = useState(false);

    // ── Refs (never cause re-renders) ─────────────────────────────────────────
    const activeIdRef = useRef('');
    const fetchInFlight = useRef(false);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        activeIdRef.current = activeSessionId;
    }, [activeSessionId]);

    // ── Toast ─────────────────────────────────────────────────────────────────
    function showToast(msg: string, ok = true) {
        setToast({ msg, ok });
        setTimeout(() => setToast(null), 3500);
    }

    // ── Load wallets ──────────────────────────────────────────────────────────
    useEffect(() => {
        fetch(`${API}/wallets`)
            .then((r) => (r.ok ? r.json() : []))
            .then((data: Wallet[]) => {
                const enabled = data.filter((w) => w.enabled);
                setWallets(enabled);
                const first = enabled[0];
                if (first) setSelectedWalletId((c) => c || first.id);
            })
            .catch(() => undefined);
    }, []);

    // ── Load session list ─────────────────────────────────────────────────────
    const loadSessions = useCallback(async (preferId?: string) => {
        const r = await fetch(`${API}/paper-copy-sessions`).catch(() => null);
        if (!r?.ok) return;
        const data: SessionListItem[] = await r.json();
        setSessions(data);
        setActiveSessionId((cur) => {
            if (preferId) return preferId;
            if (cur && data.some((s) => s.id === cur)) return cur;
            return data[0]?.id ?? '';
        });
    }, []);

    useEffect(() => {
        loadSessions();
    }, [loadSessions]);

    // ── Load detail for active session ────────────────────────────────────────
    const loadDetail = useCallback(
        async (sessionId: string) => {
            if (!sessionId || fetchInFlight.current) return;
            fetchInFlight.current = true;

            try {
                const [detailR, healthR, openR, closedR, tradesR, metricsR] =
                    await Promise.all([
                        fetch(`${API}/paper-copy-sessions/${sessionId}`),
                        fetch(`${API}/paper-copy-sessions/${sessionId}/health`),
                        fetch(`${API}/paper-copy-sessions/${sessionId}/positions?status=OPEN&limit=100`),
                        fetch(`${API}/paper-copy-sessions/${sessionId}/positions?status=CLOSED&limit=50`),
                        fetch(`${API}/paper-copy-sessions/${sessionId}/trades?limit=50`),
                        fetch(`${API}/paper-copy-sessions/${sessionId}/metrics?limit=${MAX_CHART_POINTS}`),
                    ]);

                // Guard: discard if user switched session while this was in flight
                if (sessionId !== activeIdRef.current) return;

                // Parse detail first so we can use startingCash for chart scaling
                const detailData: SessionDetail | null = detailR.ok ? await detailR.json() : null;
                if (detailData) setDetail(detailData);
                else setDetail(null);

                if (healthR.ok) setHealth(await healthR.json());
                else setHealth(null);

                if (openR.ok) setOpenPositions(await openR.json());
                else setOpenPositions([]);

                if (closedR.ok) setClosedPositions(await closedR.json());
                else setClosedPositions([]);

                if (tradesR.ok) setTrades(await tradesR.json());
                else setTrades([]);

                if (metricsR.ok) {
                    const pts: Array<{
                        timestamp: string;
                        totalPnl: number;
                        netLiquidationValue: number;
                    }> = await metricsR.json();

                    const basis = detailData && detailData.startingCash > 0 ? detailData.startingCash : 1;
                    const mapped: ChartPoint[] = pts
                        .map((p) => ({
                            ts: new Date(p.timestamp).getTime(),
                            label: new Date(p.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                            }),
                            pnlAbs: Number(p.totalPnl),
                            pnlPct: (Number(p.totalPnl) / basis) * 100,
                        }))
                        .filter((p) => Number.isFinite(p.ts))
                        .sort((a, b) => a.ts - b.ts);
                    setChartPoints(downsample(mapped, MAX_CHART_POINTS));
                }
            } finally {
                fetchInFlight.current = false;
            }
        },
        [],
    );

    // ── Polling loop — cleaned up on session change and unmount ───────────────
    useEffect(() => {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);

        setDetail(null);
        setHealth(null);
        setChartPoints([]);
        setOpenPositions([]);
        setClosedPositions([]);
        setTrades([]);

        if (!activeSessionId) return;

        loadDetail(activeSessionId);

        pollTimerRef.current = setInterval(() => {
            loadDetail(activeIdRef.current);
        }, 6000);

        return () => {
            if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
            }
        };
    }, [activeSessionId, loadDetail]);

    // ── Create session ────────────────────────────────────────────────────────
    async function createSession() {
        if (!selectedWalletId) {
            setSetupError('Select a wallet first.');
            return;
        }
        const cash = parseFloat(bankroll);
        if (!cash || cash < 100) {
            setSetupError('Bankroll must be at least $100.');
            return;
        }
        setCreating(true);
        setSetupError('');
        try {
            const r = await fetch(`${API}/paper-copy-sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trackedWalletId: selectedWalletId,
                    startingCash: cash,
                    feeBps: parseInt(feeBps) || 0,
                    slippageBps: parseInt(slippageBps) || 0,
                }),
            });
            if (!r.ok) {
                setSetupError(await r.text());
                return;
            }
            const created: { id: string } = await r.json();
            await loadSessions(created.id);
            showToast('Session created — click Start to begin copying.');
        } finally {
            setCreating(false);
        }
    }

    // ── Session actions ───────────────────────────────────────────────────────
    async function act(action: 'start' | 'pause' | 'resume' | 'stop') {
        if (!activeSessionId || actionLoading) return;
        setActionLoading(action);
        try {
            const r = await fetch(
                `${API}/paper-copy-sessions/${activeSessionId}/${action}`,
                { method: 'POST' },
            );
            if (!r.ok) {
                showToast(await r.text(), false);
                return;
            }
            const labels: Record<string, string> = {
                start: 'Session started. Bootstrap positions loaded.',
                pause: 'Session paused.',
                resume: 'Session resumed.',
                stop: 'Session stopped. Final snapshot saved.',
            };
            showToast(labels[action] ?? `Session ${action}d.`);
            await loadSessions(activeSessionId);
            await loadDetail(activeSessionId);
        } finally {
            setActionLoading('');
        }
    }

    async function killAll() {
        setKillAllConfirm(false);
        const r = await fetch(`${API}/paper-copy-sessions/kill-all`, { method: 'POST' });
        if (!r.ok) { showToast('Kill all failed: ' + await r.text(), false); return; }
        const { stopped } = await r.json() as { stopped: number };
        showToast(stopped > 0 ? `Killed ${stopped} running session${stopped > 1 ? 's' : ''}.` : 'No running sessions to kill.');
        await loadSessions();
    }

    async function deleteSession(sessionId: string) {
        setDeleteConfirmId(null);
        const r = await fetch(`${API}/paper-copy-sessions/${sessionId}`, { method: 'DELETE' });
        if (!r.ok) { showToast('Delete failed: ' + await r.text(), false); return; }
        showToast('Session deleted.');
        // If we deleted the active session, clear it
        if (sessionId === activeSessionId) setActiveSessionId('');
        await loadSessions();
    }

    async function repairSession() {
        if (!activeSessionId) return;
        setRepairLoading(true);
        try {
            const r = await fetch(`${API}/paper-copy-sessions/${activeSessionId}/repair`, { method: 'POST' });
            if (!r.ok) { showToast('Repair failed: ' + await r.text(), false); return; }
            const result = await r.json() as {
                previousStatus: string;
                cashBefore: number;
                cashAfter: number;
                positionsFixed: number;
            };
            showToast(
                `Repaired. Cash: $${result.cashBefore.toFixed(0)} → $${result.cashAfter.toFixed(0)}. ` +
                `${result.positionsFixed} position${result.positionsFixed !== 1 ? 's' : ''} fixed. Status → PAUSED.`
            );
            await loadSessions(activeSessionId);
            await loadDetail(activeSessionId);
        } finally {
            setRepairLoading(false);
        }
    }

    async function reconcilePositions() {
        if (!activeSessionId) return;
        setRepairLoading(true);
        try {
            const r = await fetch(`${API}/paper-copy-sessions/${activeSessionId}/reconcile-positions`, { method: 'POST' });
            if (!r.ok) { showToast('Reconcile failed: ' + await r.text(), false); return; }
            const result = await r.json() as {
                openOnChain: number;
                openInSim: number;
                closedByReconciliation: number;
            };
            showToast(
                result.closedByReconciliation > 0
                    ? `Reconciled: ${result.closedByReconciliation} position${result.closedByReconciliation !== 1 ? 's' : ''} closed against Polymarket ground truth. (Chain: ${result.openOnChain} open, Sim had: ${result.openInSim})`
                    : `Reconciled: sim matches Polymarket (${result.openOnChain} open on both).`
            );
            await loadSessions(activeSessionId);
            await loadDetail(activeSessionId);
        } finally {
            setRepairLoading(false);
        }
    }

    // ── Chart config ──────────────────────────────────────────────────────────
    const chartKey = chartMode === 'pct' ? 'pnlPct' : 'pnlAbs';
    const isPositive = (detail?.totalPnl ?? 0) >= 0;

    const chartDomain = useMemo((): [number, number] => {
        if (!chartPoints.length) return [-1, 1];
        const vals = chartPoints.map((p) => p[chartKey] as number);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        if (min === max) return [min - 1, max + 1];
        const pad = (max - min) * 0.1;
        return [min - pad, max + pad];
    }, [chartPoints, chartKey]);

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <LayoutShell>
            {/* Toast notification */}
            {toast && (
                <div
                    className={`fixed right-5 top-5 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-xl transition-all ${toast.ok
                        ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200'
                        : 'border-rose-500/30 bg-rose-500/15 text-rose-200'
                        }`}
                >
                    {toast.msg}
                </div>
            )}

            <div className="space-y-5">
                {/* ── Page header ─────────────────────────────────────────── */}
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-semibold tracking-tight">
                            Paper Copy Trading
                        </h2>
                        <p className="mt-1 text-sm text-slate-400">
                            Mirror a tracked Polymarket wallet with a paper bankroll.
                            Activity-driven — reacts to real trade events.
                        </p>
                    </div>

                    {/* Session action buttons (top-right, only when session selected) */}
                    {detail && (
                        <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge status={detail.status} isStale={health?.isStale === true} />
                            {detail.status === 'PAUSED' && (
                                <button
                                    onClick={() => act(detail.startedAt ? 'resume' : 'start')}
                                    disabled={!!actionLoading}
                                    className="btn-primary"
                                >
                                    {actionLoading === 'start' || actionLoading === 'resume'
                                        ? '…'
                                        : detail.startedAt
                                            ? 'Resume'
                                            : 'Start Copy Session'}
                                </button>
                            )}
                            {detail.status === 'RUNNING' && (
                                <>
                                    <button
                                        onClick={() => act('pause')}
                                        disabled={!!actionLoading}
                                        className="btn-muted"
                                    >
                                        {actionLoading === 'pause' ? '…' : 'Pause'}
                                    </button>
                                    <button
                                        onClick={() => act('stop')}
                                        disabled={!!actionLoading}
                                        className="btn-muted text-rose-300 hover:text-rose-200"
                                    >
                                        {actionLoading === 'stop' ? '…' : 'Stop'}
                                    </button>
                                </>
                            )}
                            {/* Repair — available on any status */}
                            <button
                                onClick={repairSession}
                                disabled={repairLoading}
                                title="Recalculate cash + positions from trade history. Fixes corrupted state."
                                className="btn-muted text-amber-300 hover:text-amber-200"
                            >
                                {repairLoading ? '…' : '⚙ Repair'}
                            </button>
                            {/* Reconcile — close positions no longer open on Polymarket */}
                            <button
                                onClick={reconcilePositions}
                                disabled={repairLoading}
                                title="Close any simulated positions that are no longer open on Polymarket. Fixes missed SELL/CLOSE/REDEEM events."
                                className="btn-muted text-blue-300 hover:text-blue-200"
                            >
                                {repairLoading ? '…' : '⟳ Reconcile'}
                            </button>
                            {/* Delete session */}
                            <button
                                onClick={() => setDeleteConfirmId(activeSessionId)}
                                className="btn-muted text-slate-500 hover:text-rose-400"
                                title="Permanently delete this session and all its data"
                            >
                                Delete
                            </button>
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_1fr]">
                    {/* ── Left panel ──────────────────────────────────────── */}
                    <div className="space-y-4">
                        {/* New session form */}
                        <div className="panel p-4">
                            <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                                New Session
                            </p>
                            <div className="space-y-3">
                                <div>
                                    <label className="mb-1 block text-xs text-slate-400">
                                        Wallet to copy
                                    </label>
                                    <select
                                        className="input text-sm"
                                        value={selectedWalletId}
                                        onChange={(e) => setSelectedWalletId(e.target.value)}
                                    >
                                        <option value="">Select wallet…</option>
                                        {wallets.map((w) => (
                                            <option key={w.id} value={w.id}>
                                                {w.label ||
                                                    w.address.slice(0, 8) + '…' + w.address.slice(-4)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs text-slate-400">
                                        Starting bankroll ($)
                                    </label>
                                    <input
                                        className="input text-sm"
                                        type="number"
                                        min={100}
                                        step={1000}
                                        value={bankroll}
                                        onChange={(e) => setBankroll(e.target.value)}
                                        placeholder="10000"
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="mb-1 block text-xs text-slate-400">
                                            Fee (bps)
                                        </label>
                                        <input
                                            className="input text-sm"
                                            type="number"
                                            min={0}
                                            max={500}
                                            value={feeBps}
                                            onChange={(e) => setFeeBps(e.target.value)}
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1 block text-xs text-slate-400">
                                            Slippage (bps)
                                        </label>
                                        <input
                                            className="input text-sm"
                                            type="number"
                                            min={0}
                                            max={500}
                                            value={slippageBps}
                                            onChange={(e) => setSlippageBps(e.target.value)}
                                        />
                                    </div>
                                </div>
                                {/* Fee presets */}
                                <div>
                                    <p className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-600">Presets</p>
                                    <div className="flex flex-col gap-1">
                                        {FEE_PRESETS.map((p) => {
                                            const active = parseInt(feeBps) === p.feeBps && parseInt(slippageBps) === p.slippageBps;
                                            return (
                                                <button
                                                    key={p.label}
                                                    type="button"
                                                    onClick={() => { setFeeBps(String(p.feeBps)); setSlippageBps(String(p.slippageBps)); }}
                                                    className={`rounded-lg border px-2.5 py-1.5 text-left transition ${active
                                                        ? 'border-blue-500/50 bg-blue-500/10 text-blue-300'
                                                        : 'border-slate-800/60 hover:border-slate-700 text-slate-400 hover:text-slate-200'
                                                        }`}
                                                >
                                                    <p className="text-xs font-medium">{p.label}</p>
                                                    <p className="text-[10px] text-slate-600">{p.note}</p>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                {setupError && (
                                    <p className="text-xs text-rose-400">{setupError}</p>
                                )}
                                <button
                                    onClick={createSession}
                                    disabled={creating || !selectedWalletId}
                                    className="btn-primary w-full"
                                >
                                    {creating ? 'Creating…' : 'Create Paper Session'}
                                </button>
                                <p className="text-[11px] leading-relaxed text-slate-600">
                                    On start, existing positions are bootstrapped. Live wallet
                                    activity drives buys and sells automatically.
                                </p>
                            </div>
                        </div>

                        {/* Session list */}
                        {sessions.length > 0 && (
                            <div className="panel p-3">
                                <div className="mb-2 flex items-center justify-between">
                                    <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                                        Sessions
                                    </p>
                                    {sessions.some(s => s.status === 'RUNNING') && (
                                        <button
                                            onClick={() => setKillAllConfirm(true)}
                                            className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/20 transition"
                                        >
                                            Kill All
                                        </button>
                                    )}
                                </div>
                                <div className="max-h-[440px] space-y-1.5 overflow-y-auto pr-1">
                                    {sessions.map((s) => {
                                        const active = s.id === activeSessionId;
                                        const pnl = s.totalPnl ?? 0;
                                        return (
                                            <div key={s.id} className="group relative">
                                                <button
                                                    onClick={() => setActiveSessionId(s.id)}
                                                    className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${active
                                                        ? 'border-blue-500/50 bg-blue-500/10'
                                                        : 'border-slate-800/80 hover:border-slate-700 hover:bg-slate-800/30'
                                                        }`}
                                                >
                                                    <div className="flex items-center justify-between gap-1">
                                                        <span className="truncate text-xs font-medium text-slate-200">
                                                            {s.trackedWalletLabel ||
                                                                s.trackedWalletAddress.slice(0, 10) + '…'}
                                                        </span>
                                                        <StatusBadge status={s.status} />
                                                    </div>
                                                    <div className="mt-1 flex items-center justify-between text-[11px]">
                                                        <span className="text-slate-500">
                                                            {s.startedAt
                                                                ? new Date(s.startedAt).toLocaleDateString()
                                                                : 'Not started'}
                                                        </span>
                                                        {s.startedAt && (
                                                            <span className={`font-semibold tabular-nums ${pnlClass(pnl)}`}>
                                                                {pnl >= 0 ? '+' : ''}
                                                                {pnl.toFixed(0)}
                                                            </span>
                                                        )}
                                                    </div>
                                                </button>
                                                {/* Delete button — visible on hover */}
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(s.id); }}
                                                    title="Delete session"
                                                    className="absolute right-2 top-2 hidden rounded p-1 text-slate-600 hover:bg-rose-500/15 hover:text-rose-400 group-hover:flex transition"
                                                >
                                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                                        <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                                    </svg>
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ── Right panel: dashboard ───────────────────────────── */}
                    <div className="min-w-0 space-y-4">
                        {!detail ? (
                            <EmptyDashboard
                                hasWallets={wallets.length > 0}
                                hasSessions={sessions.length > 0}
                            />
                        ) : (
                            <>
                                {/* ── Hero: total PnL ──────────────────────── */}
                                <div className="panel p-5">
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div>
                                            <p className="text-[11px] font-medium uppercase tracking-widest text-slate-500">
                                                Total PnL
                                            </p>
                                            <div
                                                className={`mt-1 text-5xl font-bold tabular-nums tracking-tight ${pnlClass(detail.totalPnl)}`}
                                            >
                                                {fmt$(detail.totalPnl)}
                                            </div>
                                            <div
                                                className={`mt-1.5 text-sm font-medium ${pnlClass(detail.returnPct)}`}
                                            >
                                                {fmtPct(detail.returnPct)} since start
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-3 gap-3 text-right">
                                            <div>
                                                <p className="text-[10px] uppercase tracking-widest text-slate-500">
                                                    Portfolio
                                                </p>
                                                <p className="mt-0.5 text-sm font-semibold text-slate-200">
                                                    {fmt$(detail.netLiquidationValue, 0)}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-widest text-slate-500">
                                                    Cash
                                                </p>
                                                <p className="mt-0.5 text-sm font-semibold text-slate-200">
                                                    {fmt$(detail.currentCash, 0)}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-widest text-slate-500">
                                                    Open
                                                </p>
                                                <p className="mt-0.5 text-sm font-semibold text-slate-200">
                                                    {detail.stats.openPositionsCount}
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Session metadata */}
                                    <div className="mt-4 flex flex-wrap gap-4 border-t border-slate-800/50 pt-4 text-xs text-slate-500">
                                        <span>
                                            Wallet:{' '}
                                            <a
                                                href={`https://polymarket.com/profile/${detail.trackedWalletAddress}`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="font-medium text-blue-400 hover:text-blue-300 hover:underline"
                                                title="View on Polymarket"
                                            >
                                                {detail.trackedWalletLabel || detail.trackedWalletAddress.slice(0, 14) + '…'} ↗
                                            </a>
                                        </span>
                                        {detail.copyRatio !== null && (
                                            <span>
                                                Copy ratio:{' '}
                                                <span className="text-slate-300">
                                                    {(detail.copyRatio * 100).toFixed(1)}%
                                                </span>
                                            </span>
                                        )}
                                        <span>
                                            Bankroll:{' '}
                                            <span className="text-slate-300">
                                                {fmt$(detail.startingCash, 0)}
                                            </span>
                                        </span>
                                        {detail.startedAt && (
                                            <span>
                                                Started:{' '}
                                                <span className="text-slate-300">
                                                    {new Date(detail.startedAt).toLocaleString()}
                                                </span>
                                            </span>
                                        )}
                                        {detail.endedAt && (
                                            <span>
                                                Ended:{' '}
                                                <span className="text-slate-300">
                                                    {new Date(detail.endedAt).toLocaleString()}
                                                </span>
                                            </span>
                                        )}
                                    </div>

                                    {/* Summary sentence */}
                                    {detail.summarySentence && (
                                        <p className="mt-3 border-t border-slate-800/50 pt-3 text-sm leading-relaxed text-slate-300">
                                            {detail.summarySentence}
                                        </p>
                                    )}
                                </div>

                                {/* ── Health bar ───────────────────────────── */}
                                <HealthBar health={health} walletAddress={detail.trackedWalletAddress} />

                                {/* ── Secondary metrics row ─────────────────── */}
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                    <MetricBox
                                        label="Bankroll"
                                        value={fmt$(detail.startingCash, 0)}
                                        sub="starting capital"
                                    />
                                    <MetricBox
                                        label="Exposure est."
                                        value={
                                            detail.estimatedSourceExposure
                                                ? fmt$(detail.estimatedSourceExposure, 0)
                                                : '—'
                                        }
                                        sub="source wallet (est.)"
                                    />
                                    <MetricBox
                                        label="Last event"
                                        value={fmtAge(detail.lastProcessedEventAt)}
                                        sub="processed watermark"
                                    />
                                    <MetricBox
                                        label="Copy ratio"
                                        value={
                                            detail.copyRatio !== null
                                                ? (detail.copyRatio * 100).toFixed(1) + '%'
                                                : '—'
                                        }
                                        sub="bankroll / source exposure"
                                    />
                                </div>

                                {/* ── Equity chart ─────────────────────────── */}
                                <div className="panel p-4">
                                    <div className="mb-3 flex items-center justify-between">
                                        <p className="text-sm font-medium text-slate-200">
                                            Equity curve
                                        </p>
                                        <div className="flex gap-1">
                                            {(['pct', 'abs'] as const).map((m) => (
                                                <button
                                                    key={m}
                                                    onClick={() => setChartMode(m)}
                                                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${chartMode === m
                                                        ? 'bg-blue-500/20 text-blue-300'
                                                        : 'text-slate-500 hover:text-slate-200'
                                                        }`}
                                                >
                                                    {m === 'pct' ? '% return' : '$ PnL'}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {chartPoints.length === 0 ? (
                                        <div className="flex h-36 items-center justify-center text-sm text-slate-500">
                                            Equity curve appears once trades are copied.
                                        </div>
                                    ) : (
                                        <ResponsiveContainer width="100%" height={200}>
                                            <AreaChart
                                                data={chartPoints}
                                                margin={{ top: 4, right: 6, left: 0, bottom: 0 }}
                                            >
                                                <defs>
                                                    <linearGradient
                                                        id="pnlGradient"
                                                        x1="0"
                                                        y1="0"
                                                        x2="0"
                                                        y2="1"
                                                    >
                                                        <stop
                                                            offset="5%"
                                                            stopColor={
                                                                isPositive ? '#10b981' : '#f43f5e'
                                                            }
                                                            stopOpacity={0.3}
                                                        />
                                                        <stop
                                                            offset="95%"
                                                            stopColor={
                                                                isPositive ? '#10b981' : '#f43f5e'
                                                            }
                                                            stopOpacity={0}
                                                        />
                                                    </linearGradient>
                                                </defs>
                                                <CartesianGrid
                                                    strokeDasharray="3 3"
                                                    stroke="#1e293b"
                                                    vertical={false}
                                                />
                                                <XAxis
                                                    dataKey="label"
                                                    tick={{ fontSize: 10, fill: '#475569' }}
                                                    tickLine={false}
                                                    axisLine={false}
                                                    interval="preserveStartEnd"
                                                />
                                                <YAxis
                                                    domain={chartDomain}
                                                    tick={{ fontSize: 10, fill: '#475569' }}
                                                    tickLine={false}
                                                    axisLine={false}
                                                    tickFormatter={(v) =>
                                                        chartMode === 'pct'
                                                            ? v.toFixed(1) + '%'
                                                            : '$' + v.toFixed(0)
                                                    }
                                                    width={54}
                                                />
                                                <Tooltip
                                                    contentStyle={{
                                                        background: '#0f172a',
                                                        border: '1px solid #1e293b',
                                                        borderRadius: 10,
                                                        fontSize: 12,
                                                    }}
                                                    formatter={(value: unknown) => {
                                                        const v = Number(value);
                                                        return chartMode === 'pct'
                                                            ? ([v.toFixed(2) + '%', 'Return'] as [string, string])
                                                            : (['$' + v.toFixed(2), 'PnL'] as [string, string]);
                                                    }}
                                                    labelStyle={{ color: '#94a3b8' }}
                                                />
                                                <ReferenceLine
                                                    y={0}
                                                    stroke="#334155"
                                                    strokeDasharray="4 4"
                                                />
                                                <Area
                                                    type="monotone"
                                                    dataKey={chartKey}
                                                    stroke={isPositive ? '#10b981' : '#f43f5e'}
                                                    strokeWidth={2}
                                                    fill="url(#pnlGradient)"
                                                    dot={false}
                                                    activeDot={{ r: 4 }}
                                                    connectNulls
                                                />
                                            </AreaChart>
                                        </ResponsiveContainer>
                                    )}
                                    <p className="mt-2 text-[11px] text-slate-700">
                                        Capped at {MAX_CHART_POINTS} points · downsampled for memory
                                        safety
                                    </p>
                                </div>

                                {/* ── Tab panel ────────────────────────────── */}
                                <div className="panel overflow-hidden">
                                    <div className="flex border-b border-slate-800/60">
                                        {(
                                            [
                                                {
                                                    key: 'positions' as const,
                                                    label: `Open positions (${openPositions.length})`,
                                                },
                                                {
                                                    key: 'trades' as const,
                                                    label: `Copy log (${trades.length})`,
                                                },
                                                {
                                                    key: 'closed' as const,
                                                    label: `Closed (${closedPositions.length})`,
                                                },
                                            ] as const
                                        ).map((tab) => (
                                            <button
                                                key={tab.key}
                                                onClick={() => setActiveTab(tab.key)}
                                                className={`px-4 py-3 text-sm font-medium transition ${activeTab === tab.key
                                                    ? 'border-b-2 border-blue-400 text-blue-300'
                                                    : 'text-slate-400 hover:text-slate-200'
                                                    }`}
                                            >
                                                {tab.label}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="p-4">
                                        {activeTab === 'positions' && (
                                            <PositionsTable
                                                positions={openPositions}
                                                empty="No open positions. Start the session to bootstrap and copy activity."
                                            />
                                        )}
                                        {activeTab === 'closed' && (
                                            <PositionsTable
                                                positions={closedPositions}
                                                showClosed
                                                empty="No closed positions yet."
                                            />
                                        )}
                                        {activeTab === 'trades' && (
                                            <TradesLog trades={trades} />
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Kill All confirmation modal ───────────────────────────── */}
            {killAllConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-full max-w-sm rounded-2xl border border-rose-500/30 bg-[#0c1524] p-6 shadow-2xl">
                        <h3 className="text-base font-semibold text-rose-300">Kill all running sessions?</h3>
                        <p className="mt-2 text-sm text-slate-400">
                            All RUNNING sessions will be stopped and marked COMPLETED.
                            Data is kept — sessions can be reviewed but not restarted.
                        </p>
                        <div className="mt-5 flex gap-3">
                            <button
                                onClick={killAll}
                                className="flex-1 rounded-xl bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-300 hover:bg-rose-500/30 transition border border-rose-500/30"
                            >
                                Kill all sessions
                            </button>
                            <button
                                onClick={() => setKillAllConfirm(false)}
                                className="flex-1 btn-muted"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Delete session confirmation modal ─────────────────────── */}
            {deleteConfirmId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-full max-w-sm rounded-2xl border border-rose-500/30 bg-[#0c1524] p-6 shadow-2xl">
                        <h3 className="text-base font-semibold text-rose-300">Delete this session?</h3>
                        <p className="mt-2 text-sm text-slate-400">
                            This permanently deletes the session, all copied trades, positions,
                            snapshots and metric history. <strong className="text-slate-300">This cannot be undone.</strong>
                        </p>
                        <div className="mt-5 flex gap-3">
                            <button
                                onClick={() => deleteSession(deleteConfirmId)}
                                className="flex-1 rounded-xl bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-300 hover:bg-rose-500/30 transition border border-rose-500/30"
                            >
                                Delete permanently
                            </button>
                            <button
                                onClick={() => setDeleteConfirmId(null)}
                                className="flex-1 btn-muted"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </LayoutShell>
    );
}