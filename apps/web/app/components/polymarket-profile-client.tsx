'use client';

/**
 * polymarket-profile-client.tsx
 * apps/web/app/components/polymarket-profile-client.tsx
 *
 * FIXES IN THIS VERSION:
 *   1. Hydration errors — all Date.now()/toLocaleString() calls are gated on
 *      `mounted` state and use suppressHydrationWarning so SSR and client
 *      never produce mismatched HTML.
 *   2. Duplicate key errors — closed positions now use a composite key
 *      (id already fixed in backend to be conditionId:outcome:timestamp).
 *   3. Closed positions now default to "Most Recent" sort (date DESC).
 *   4. P&L panel shows Total Volume Traded tile.
 *   5. ↺ Refresh Stats button in the header stats row.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ProfileSummary = {
    walletId: string;
    address: string;
    handle: string;
    joinedAt: string;
    positionsValueUsd: number;
    biggestWinUsd: number;
    predictionsCount: number;
    realizedPnlUsd: number;
    snapshotAt: string | null;
};

type PnlRange = '1D' | '1W' | '1M' | 'ALL';
type PnlPoint = { t: string; v: number };
type PnlChart = { range: PnlRange; totalPnl: number; isPositive: boolean; points: PnlPoint[] };

type Position = {
    id: string;
    conditionId: string;
    title: string;
    outcome: string;
    shares: number;
    avgPrice: number;
    currentPrice: number;
    valueUsd: number;
    pnlUsd: number;
    pnlPct: number;
    totalTraded: number;
    status: 'OPEN' | 'CLOSED';
    resolution: 'WON' | 'LOST' | 'PENDING' | null;
    noCostBasis: boolean;
    icon: string | null;
    updatedAt: string;
};

type ActivityItem = {
    id: string;
    type: string;
    market: string;
    outcome: string | null;
    side: string | null;
    amountUsd: number | null;
    shares: number | null;
    price: number | null;
    eventTimestamp: string;
    relativeTime: string;
    txHash: string | null;
    orderId: string | null;
    sourceEventId: string | null;
};

type PnlSummary = {
    range: string;
    netPnl: number;
    totalWon: number;
    totalLost: number;
    totalVolumeTraded: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const POS_PAGE_SIZE = 50;
const ACT_PAGE_SIZE = 50;
const REFRESH_SUMMARY = 60_000;
const REFRESH_CHART = 60_000;
const REFRESH_POS = 30_000;
const REFRESH_ACT = 15_000;

// Matches Polymarket Active tab dropdown exactly
const OPEN_SORT_OPTIONS = [
    { value: 'value', label: 'Value' },
    { value: 'pnl_usd', label: 'Profit/Loss $' },
    { value: 'pnl_pct', label: 'Profit/Loss %' },
    { value: 'traded', label: 'Traded' },
    { value: 'alphabetically', label: 'Alphabetically' },
    { value: 'avg_price', label: 'Average Price' },
    { value: 'cur_price', label: 'Current Price' },
] as const;

// Most Recent is first and default for closed
const CLOSED_SORT_OPTIONS = [
    { value: 'date', label: 'Most Recent' },
    { value: 'won_first', label: 'Profit/Loss' },
    { value: 'lost_first', label: 'Losses first' },
    { value: 'pnl_usd', label: 'P/L $' },
    { value: 'market', label: 'Alphabetically' },
] as const;

const ACTIVITY_TYPES = ['ALL', 'BUY', 'SELL', 'REDEEM', 'MERGE', 'SPLIT'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

function getApiBase(): string {
    if (typeof window === 'undefined') return 'http://localhost:4000';
    return process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';
}

async function apiFetch<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const res = await fetch(`${getApiBase()}${path}`, { method, cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function fmtUsd(v: number, compact = false): string {
    if (compact) {
        const a = Math.abs(v);
        const pfx = v < 0 ? '-$' : '$';
        if (a >= 1_000_000) return `${pfx}${(a / 1_000_000).toFixed(1)}M`;
        if (a >= 1_000) return `${pfx}${(a / 1_000).toFixed(1)}K`;
    }
    const abs = Math.abs(v);
    return (v < 0 ? '-$' : '$') +
        abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(v: number): string {
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtPctAbs(v: number): string {
    return `${Math.abs(v).toFixed(2)}%`;
}

function fmtPrice(v: number): string {
    return `${Math.round(v * 100)}¢`;
}

function fmtShares(v: number): string {
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
    return parseFloat(v.toFixed(4)).toString() || '0';
}

function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** Exact timestamp — only rendered client-side to avoid hydration mismatch */
function fmtDatetime(iso: string): string {
    const d = new Date(iso);
    return (
        d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    );
}

function shortAddr(addr: string): string {
    if (!addr || addr.length < 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function shortId(id: string): string {
    if (!id || id.length <= 14) return id;
    return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function capFirst(s: string): string {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function Identicon({ address, size = 52 }: { address: string; size?: number }) {
    const seed = address.replace(/^0x/i, '').toLowerCase().padEnd(40, '0');
    const hue = (parseInt(seed.slice(0, 4), 16) || 0) % 360;
    const G = 5;
    const cs = size / G;
    const cells: boolean[] = [];
    for (let r = 0; r < G; r++) {
        for (let c = 0; c < Math.ceil(G / 2); c++) {
            const bi = (r * 3 + c) * 2;
            const v = (parseInt(seed.slice(bi % (seed.length - 1), bi % (seed.length - 1) + 2) || '00', 16) & 1) === 1;
            cells[r * G + c] = v;
            cells[r * G + (G - 1 - c)] = v;
        }
    }
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ borderRadius: '50%', display: 'block' }}>
            <rect width={size} height={size} fill={`hsl(${hue},45%,10%)`} rx={size / 2} />
            {cells.map((on, i) => on ? (
                <rect key={i} x={(i % G) * cs} y={Math.floor(i / G) * cs} width={cs} height={cs} fill={`hsl(${hue},70%,60%)`} />
            ) : null)}
        </svg>
    );
}

function TrendLine({ points, isPositive }: { points: PnlPoint[]; isPositive: boolean }) {
    if (points.length < 2) return <div className="pm-chart-empty">No data for this range</div>;
    const W = 560, H = 80, PX = 4, PY = 8;
    const vals = points.map(p => p.v);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    const rng = maxV === minV ? 1 : maxV - minV;
    const toX = (i: number) => PX + (i / (points.length - 1)) * (W - 2 * PX);
    const toY = (v: number) => H - PY - ((v - minV) / rng) * (H - 2 * PY);
    const xs = points.map((_, i) => toX(i));
    const ys = points.map(p => toY(p.v));
    const lp = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
    const fp = `M${xs[0]},${H - PY} ` + xs.map((x, i) => `L${x},${ys[i]}`).join(' ') + ` L${xs[xs.length - 1]},${H - PY} Z`;
    const color = isPositive ? '#7c3aed' : '#ef4444';
    const fill = isPositive ? 'rgba(124,58,237,0.10)' : 'rgba(239,68,68,0.10)';
    const zeroY = minV < 0 && maxV > 0 ? toY(0) : null;
    return (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="pm-chart-svg">
            <path d={fp} fill={fill} />
            {zeroY !== null && <line x1={PX} y1={zeroY} x2={W - PX} y2={zeroY} stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="4 3" />}
            <polyline points={lp} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="2.5" fill={color} />
        </svg>
    );
}

function WonChip() {
    return (
        <span className="pm-result-won">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
                <circle cx="7" cy="7" r="7" fill="#22c55e" />
                <path d="M3.5 7L5.8 9.3L10.5 4.7" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Won
        </span>
    );
}

function LostChip() {
    return (
        <span className="pm-result-lost">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
                <circle cx="7" cy="7" r="7" fill="#ef4444" />
                <path d="M4.5 4.5L9.5 9.5M9.5 4.5L4.5 9.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Lost
        </span>
    );
}

function OutcomeChip({ outcome }: { outcome: string }) {
    const u = outcome.toUpperCase();
    const pos = u === 'YES' || u === 'UP';
    return <span className={`pm-chip ${pos ? 'pm-chip-yes' : 'pm-chip-no'}`}>{capFirst(outcome)}</span>;
}

function ActOutcomeChip({ outcome, price }: { outcome: string; price: number | null }) {
    const u = outcome.toUpperCase();
    const pos = u === 'YES' || u === 'UP';
    return (
        <span className={`pm-act-chip ${pos ? 'pm-act-chip-up' : 'pm-act-chip-down'}`}>
            {capFirst(outcome)}{price != null ? ` ${fmtPrice(price)}` : ''}
        </span>
    );
}

function LiveBadge({ updatedAt }: { updatedAt: Date | null }) {
    return (
        <span className="pm-live">
            <span className="pm-live-dot" />
            Live
            {updatedAt && <span className="pm-live-ts" suppressHydrationWarning>{updatedAt.toLocaleTimeString()}</span>}
        </span>
    );
}

function Pager({ page, pageSize, total, onPrev, onNext }: {
    page: number; pageSize: number; total: number;
    onPrev: () => void; onNext: () => void;
}) {
    return (
        <div className="pm-pager">
            <span className="pm-pager-info">{total.toLocaleString()} result{total !== 1 ? 's' : ''}</span>
            <div className="pm-pager-btns">
                <button className="pm-pager-btn" disabled={page <= 1} onClick={onPrev} type="button">← Prev</button>
                <span className="pm-pager-cur">Page {page}</span>
                <button className="pm-pager-btn" disabled={page * pageSize >= total} onClick={onNext} type="button">Next →</button>
            </div>
        </div>
    );
}

function SearchIcon() {
    return (
        <svg className="pm-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="2" />
            <line x1="14.5" y1="14.5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function PolymarketProfileClient({ walletId }: { walletId: string }) {

    // mounted: gates all Date.now()/locale calls to client-only to prevent
    // React hydration mismatch (SSR renders empty, client fills in)
    const [mounted, setMounted] = useState(false);
    const [summary, setSummary] = useState<ProfileSummary | null>(null);
    const [summaryErr, setSummaryErr] = useState<string | null>(null);
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

    const [range, setRange] = useState<PnlRange>('1D');
    const [chart, setChart] = useState<PnlChart | null>(null);
    const [chartLoading, setChartLoading] = useState(false);

    const [mainTab, setMainTab] = useState<'positions' | 'activity'>('positions');

    const [posTab, setPosTab] = useState<'OPEN' | 'CLOSED'>('OPEN');
    const [posSearch, setPosSearch] = useState('');
    const [posSort, setPosSort] = useState('value');
    const [positions, setPositions] = useState<Position[]>([]);
    const [posTotal, setPosTotal] = useState(0);
    const [posPage, setPosPage] = useState(1);
    const [posLoading, setPosLoading] = useState(false);
    const [posErr, setPosErr] = useState<string | null>(null);

    const [pnlRange, setPnlRange] = useState<'1D' | '7D' | '30D' | 'ALL'>('1D');
    const [pnlSummary, setPnlSummary] = useState<PnlSummary | null>(null);
    const [pnlSummaryLoad, setPnlSummaryLoad] = useState(false);
    const [showPnlPanel, setShowPnlPanel] = useState(false);

    const [actType, setActType] = useState<string>('ALL');
    const [actSearch, setActSearch] = useState('');
    const [actItems, setActItems] = useState<ActivityItem[]>([]);
    const [actTotal, setActTotal] = useState(0);
    const [actPage, setActPage] = useState(1);
    const [actLoading, setActLoading] = useState(false);
    const [actErr, setActErr] = useState<string | null>(null);

    // ── Query strings ──────────────────────────────────────────────────────
    const posQuery = useMemo(() => {
        const p = new URLSearchParams();
        p.set('status', posTab);
        p.set('page', String(posPage));
        p.set('pageSize', String(POS_PAGE_SIZE));
        p.set('sortBy', posSort);
        if (posSearch.trim()) p.set('search', posSearch.trim());
        return p.toString();
    }, [posTab, posPage, posSort, posSearch]);

    const actQuery = useMemo(() => {
        const p = new URLSearchParams();
        p.set('page', String(actPage));
        p.set('pageSize', String(ACT_PAGE_SIZE));
        if (actType !== 'ALL') p.set('eventType', actType);
        if (actSearch.trim()) p.set('search', actSearch.trim());
        return p.toString();
    }, [actPage, actType, actSearch]);

    // ── Fetchers ───────────────────────────────────────────────────────────
    const fetchSummary = useCallback(() => {
        apiFetch<ProfileSummary>(`/wallets/${walletId}/profile-summary`)
            .then(d => { setSummary(d); setSummaryErr(null); setUpdatedAt(new Date()); })
            .catch(e => setSummaryErr((e as Error).message));
    }, [walletId]);

    const fetchChart = useCallback(() => {
        setChartLoading(true);
        apiFetch<PnlChart>(`/wallets/${walletId}/pnl-chart?range=${range}`)
            .then(d => { setChart(d); setChartLoading(false); })
            .catch(() => setChartLoading(false));
    }, [walletId, range]);

    const fetchPositions = useCallback(() => {
        setPosLoading(true); setPosErr(null);
        apiFetch<{ items: Position[]; total: number }>(`/wallets/${walletId}/positions-v2?${posQuery}`)
            .then(r => { setPositions(r.items); setPosTotal(r.total); setPosLoading(false); })
            .catch(e => { setPosErr((e as Error).message); setPosLoading(false); });
    }, [walletId, posQuery]);

    const fetchActivity = useCallback(() => {
        setActLoading(true); setActErr(null);
        apiFetch<{ items: ActivityItem[]; total: number }>(`/wallets/${walletId}/activity-v2?${actQuery}`)
            .then(r => { setActItems(r.items); setActTotal(r.total); setActLoading(false); })
            .catch(e => { setActErr((e as Error).message); setActLoading(false); });
    }, [walletId, actQuery]);

    const fetchPnlSummary = useCallback(() => {
        setPnlSummaryLoad(true);
        apiFetch<PnlSummary>(`/wallets/${walletId}/pnl-summary?range=${pnlRange}`)
            .then(d => { setPnlSummary(d); setPnlSummaryLoad(false); })
            .catch(() => setPnlSummaryLoad(false));
    }, [walletId, pnlRange]);

    // Force refresh: triggers backend poll then re-fetches everything immediately
    const forceSync = useCallback(() => {
        apiFetch(`/wallets/${walletId}/sync`, 'POST').catch(() => { });
        fetchSummary();
        fetchChart();
        fetchPositions();
        if (mainTab === 'activity') fetchActivity();
    }, [walletId, fetchSummary, fetchChart, fetchPositions, fetchActivity, mainTab]);

    // ── Effects ────────────────────────────────────────────────────────────
    useEffect(() => { setMounted(true); }, []);
    useEffect(() => { fetchSummary(); }, [fetchSummary]);
    useEffect(() => { fetchChart(); }, [fetchChart]);
    useEffect(() => { fetchPositions(); }, [fetchPositions]);
    useEffect(() => { if (mainTab === 'activity') fetchActivity(); }, [fetchActivity, mainTab]);
    useEffect(() => { if (showPnlPanel) fetchPnlSummary(); }, [fetchPnlSummary, showPnlPanel]);

    useEffect(() => { const id = setInterval(fetchSummary, REFRESH_SUMMARY); return () => clearInterval(id); }, [fetchSummary]);
    useEffect(() => { const id = setInterval(fetchChart, REFRESH_CHART); return () => clearInterval(id); }, [fetchChart]);
    useEffect(() => {
        if (mainTab !== 'positions') return;
        const id = setInterval(fetchPositions, REFRESH_POS);
        return () => clearInterval(id);
    }, [fetchPositions, mainTab]);
    useEffect(() => {
        if (mainTab !== 'activity') return;
        const id = setInterval(fetchActivity, REFRESH_ACT);
        return () => clearInterval(id);
    }, [fetchActivity, mainTab]);

    useEffect(() => { setPosPage(1); }, [posTab, posSort, posSearch]);
    useEffect(() => { setActPage(1); }, [actType, actSearch]);

    // ── Handlers ───────────────────────────────────────────────────────────
    const copyAddr = useCallback(() => {
        if (summary?.address) navigator.clipboard.writeText(summary.address).catch(() => { });
    }, [summary?.address]);

    const changePosTab = useCallback((tab: 'OPEN' | 'CLOSED') => {
        setPosTab(tab);
        setPosSort(tab === 'OPEN' ? 'value' : 'date'); // closed defaults to Most Recent
        setPosPage(1);
    }, []);

    const pnlPos = (summary?.realizedPnlUsd ?? 0) >= 0;
    const sortOptions = posTab === 'OPEN' ? OPEN_SORT_OPTIONS : CLOSED_SORT_OPTIONS;
    const rangeLabel = { '1D': 'Past Day', '1W': 'Past Week', '1M': 'Past Month', 'ALL': 'All Time' } as const;

    // ─────────────────────────────────────────────────────────────────────
    return (
        <>
            <style>{CSS}</style>
            <div className="pm-root">

                {/* ── A) TWO-COLUMN HEADER ──────────────────────────────── */}
                <div className="pm-top-grid">

                    {/* Left: Profile card */}
                    <div className="pm-profile-card">
                        {summaryErr && <div className="pm-err-banner">{summaryErr}</div>}
                        <div className="pm-profile-top">
                            <div className="pm-avatar">
                                {summary ? <Identicon address={summary.address} size={56} /> : <div className="pm-avatar-skel" />}
                            </div>
                            <div className="pm-identity">
                                <h1 className="pm-handle">
                                    {summary ? summary.handle : <span className="pm-skel pm-skel-lg" />}
                                </h1>
                                <div className="pm-meta">
                                    {summary ? (
                                        <>
                                            <button className="pm-addr-btn" onClick={copyAddr} title="Copy full address">
                                                {shortAddr(summary.address)}
                                            </button>
                                            <span className="pm-dot">·</span>
                                            <span>Joined {fmtDate(summary.joinedAt)}</span>
                                        </>
                                    ) : (
                                        <span className="pm-skel pm-skel-sm" />
                                    )}
                                </div>
                            </div>
                            <div className="pm-profile-right">
                                {/* Only render live badge client-side — avoids hydration mismatch */}
                                {mounted && <LiveBadge updatedAt={updatedAt} />}
                                <div className="pm-profile-actions">
                                    <button type="button" className="pm-refresh-btn" onClick={forceSync} title="Force refresh from Polymarket">
                                        ↺ Refresh
                                    </button>
                                    {summary && (
                                        <a href={`https://polymarket.com/profile/${summary.address}`} target="_blank" rel="noreferrer" className="pm-ext-link" title="View on Polymarket">↗</a>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Stats row + refresh stats button */}
                        <div className="pm-stats-row">
                            <div className="pm-stat">
                                <span className="pm-stat-val">{summary ? fmtUsd(summary.positionsValueUsd, true) : '—'}</span>
                                <span className="pm-stat-lbl">Positions Value</span>
                            </div>
                            <div className="pm-stat-sep" />
                            <div className="pm-stat">
                                <span className={`pm-stat-val${summary && summary.biggestWinUsd > 0 ? ' pm-pos' : ''}`}>
                                    {summary ? fmtUsd(summary.biggestWinUsd, true) : '—'}
                                </span>
                                <span className="pm-stat-lbl">Biggest Win</span>
                            </div>
                            <div className="pm-stat-sep" />
                            <div className="pm-stat">
                                <span className="pm-stat-val">{summary ? summary.predictionsCount.toLocaleString() : '—'}</span>
                                <span className="pm-stat-lbl">Predictions</span>
                            </div>
                            <div className="pm-stat-sep" />
                            {/* Refresh Stats button lives inline in the stats row */}
                            <button
                                type="button"
                                className="pm-stats-refresh-btn"
                                onClick={fetchSummary}
                                title="Refresh header stats"
                            >
                                ↺ Refresh Stats
                            </button>
                        </div>
                    </div>

                    {/* Right: P/L card */}
                    <div className="pm-pnl-card">
                        <div className="pm-pnl-top">
                            <div>
                                <p className="pm-pnl-label">
                                    <span className={pnlPos ? 'pm-pos' : 'pm-neg'}>{pnlPos ? '▲' : '▼'}</span>{' '}Profit/Loss
                                </p>
                                <p className={`pm-pnl-value${pnlPos ? ' pm-pos' : ' pm-neg'}`}>
                                    {summary ? fmtUsd(summary.realizedPnlUsd) : '—'}
                                </p>
                                {chart && (
                                    <p className={`pm-pnl-sub${chart.isPositive ? ' pm-pos' : ' pm-neg'}`}>
                                        {chart.totalPnl >= 0 ? '+' : ''}{fmtUsd(chart.totalPnl)}
                                    </p>
                                )}
                                {chart && <p className="pm-pnl-period">{rangeLabel[range]}</p>}
                            </div>
                            <div className="pm-range-group" role="group" aria-label="P/L time range">
                                {(['1D', '1W', '1M', 'ALL'] as PnlRange[]).map(r => (
                                    <button key={r} type="button" className={`pm-range-btn${range === r ? ' pm-range-on' : ''}`} onClick={() => setRange(r)}>{r}</button>
                                ))}
                            </div>
                        </div>
                        <div className="pm-chart-area">
                            {chartLoading && <div className="pm-chart-empty">Loading…</div>}
                            {!chartLoading && chart && <TrendLine points={chart.points} isPositive={chart.isPositive} />}
                            {!chartLoading && !chart && <div className="pm-chart-empty">No chart data</div>}
                        </div>
                    </div>
                </div>

                {/* ── P&L SUMMARY PANEL ─────────────────────────────────── */}
                <div className="pm-pnl-summary-bar">
                    <button
                        type="button"
                        className={`pm-pnl-calc-btn${showPnlPanel ? ' pm-pnl-calc-btn--on' : ''}`}
                        onClick={() => setShowPnlPanel(v => !v)}
                    >
                        📊 Calculate P&amp;L
                    </button>
                    {showPnlPanel && (
                        <div className="pm-pnl-summary-panel">
                            <div className="pm-pnl-summary-top">
                                <span className="pm-pnl-summary-title">Realized P&amp;L from closed trades</span>
                                <div className="pm-pnl-range-btns" role="group">
                                    {(['1D', '7D', '30D', 'ALL'] as const).map(r => (
                                        <button
                                            key={r}
                                            type="button"
                                            className={`pm-pnl-range-pill${pnlRange === r ? ' pm-pnl-range-pill--on' : ''}`}
                                            onClick={() => setPnlRange(r)}
                                        >
                                            {r === '1D' ? 'Last 24h' : r === '7D' ? 'Last 7d' : r === '30D' ? 'Last 30d' : 'All Time'}
                                        </button>
                                    ))}
                                    <button
                                        type="button"
                                        className="pm-pnl-recalc-btn"
                                        onClick={fetchPnlSummary}
                                        disabled={pnlSummaryLoad}
                                    >
                                        {pnlSummaryLoad ? '…' : '⟳ Recalculate'}
                                    </button>
                                </div>
                            </div>

                            {pnlSummary && !pnlSummaryLoad && (
                                <div className="pm-pnl-summary-grid">
                                    <div className="pm-pnl-summary-tile pm-pnl-summary-tile--large">
                                        <span className="pm-pnl-summary-label">Net P&amp;L</span>
                                        <span className={`pm-pnl-summary-val ${pnlSummary.netPnl >= 0 ? 'pm-pos' : 'pm-neg'}`}>
                                            {pnlSummary.netPnl >= 0 ? '+' : ''}{fmtUsd(pnlSummary.netPnl)}
                                        </span>
                                    </div>
                                    <div className="pm-pnl-summary-tile">
                                        <span className="pm-pnl-summary-label">Total Won</span>
                                        <span className="pm-pnl-summary-val pm-pos">+{fmtUsd(pnlSummary.totalWon)}</span>
                                    </div>
                                    <div className="pm-pnl-summary-tile">
                                        <span className="pm-pnl-summary-label">Total Lost</span>
                                        <span className="pm-pnl-summary-val pm-neg">-{fmtUsd(pnlSummary.totalLost)}</span>
                                    </div>
                                    <div className="pm-pnl-summary-tile">
                                        <span className="pm-pnl-summary-label">Total Traded</span>
                                        <span className="pm-pnl-summary-val">{fmtUsd(pnlSummary.totalVolumeTraded)}</span>
                                    </div>
                                    <div className="pm-pnl-summary-tile">
                                        <span className="pm-pnl-summary-label">Win Rate</span>
                                        <span className="pm-pnl-summary-val">{pnlSummary.winRate.toFixed(1)}%</span>
                                    </div>
                                    <div className="pm-pnl-summary-tile">
                                        <span className="pm-pnl-summary-label">Trades</span>
                                        <span className="pm-pnl-summary-val">{pnlSummary.tradeCount}</span>
                                    </div>
                                    <div className="pm-pnl-summary-tile">
                                        <span className="pm-pnl-summary-label">Wins / Losses</span>
                                        <span className="pm-pnl-summary-val">
                                            <span className="pm-pos">{pnlSummary.winCount}W</span>
                                            {' / '}
                                            <span className="pm-neg">{pnlSummary.lossCount}L</span>
                                        </span>
                                    </div>
                                </div>
                            )}
                            {pnlSummaryLoad && <div className="pm-pnl-summary-loading">Calculating…</div>}
                        </div>
                    )}
                </div>

                {/* ── MAIN TABS ──────────────────────────────────────────── */}
                <div className="pm-tab-bar">
                    <button type="button" className={`pm-tab${mainTab === 'positions' ? ' pm-tab-on' : ''}`} onClick={() => setMainTab('positions')}>Positions</button>
                    <button type="button" className={`pm-tab${mainTab === 'activity' ? ' pm-tab-on' : ''}`} onClick={() => setMainTab('activity')}>Activity</button>
                </div>

                {/* ── C) POSITIONS ─────────────────────────────────────────── */}
                {mainTab === 'positions' && (
                    <div className="pm-panel">
                        <div className="pm-panel-hdr">
                            <div className="pm-subtabs">
                                <button type="button" className={`pm-subtab${posTab === 'OPEN' ? ' pm-subtab-on' : ''}`} onClick={() => changePosTab('OPEN')}>Active</button>
                                <button type="button" className={`pm-subtab${posTab === 'CLOSED' ? ' pm-subtab-on' : ''}`} onClick={() => changePosTab('CLOSED')}>Closed</button>
                            </div>
                            <div className="pm-panel-ctrls">
                                <label className="pm-search-wrap">
                                    <SearchIcon />
                                    <input className="pm-search" placeholder="Search positions" value={posSearch} onChange={e => setPosSearch(e.target.value)} />
                                </label>
                                <select className="pm-select" value={posSort} onChange={e => setPosSort(e.target.value)} aria-label="Sort positions">
                                    {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                            </div>
                        </div>

                        <div className="pm-tbl-wrap">
                            {posTab === 'OPEN' ? (
                                <table className="pm-tbl">
                                    <thead>
                                        <tr>
                                            <th className="pm-th pm-th-mkt">MARKET</th>
                                            <th className="pm-th pm-th-r">SHARES</th>
                                            <th className="pm-th pm-th-r">AVG</th>
                                            <th className="pm-th pm-th-r">CURRENT</th>
                                            <th className="pm-th pm-th-r">VALUE</th>
                                            <th className="pm-th pm-th-r">P/L $</th>
                                            <th className="pm-th pm-th-r">P/L %</th>
                                            <th className="pm-th pm-th-r">OPENED</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {posLoading && <tr><td colSpan={8} className="pm-td-msg">Loading…</td></tr>}
                                        {!posLoading && posErr && <tr><td colSpan={8} className="pm-td-err">{posErr}</td></tr>}
                                        {!posLoading && !posErr && positions.length === 0 && <tr><td colSpan={8} className="pm-td-msg">No active positions.</td></tr>}
                                        {!posLoading && !posErr && positions.map(pos => {
                                            const pp = pos.pnlUsd >= 0;
                                            return (
                                                <tr key={pos.id} className="pm-tr">
                                                    <td className="pm-td pm-td-mkt">
                                                        <div className="pm-mkt-cell">
                                                            {pos.icon && <img src={pos.icon} alt="" className="pm-mkt-icon" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                                                            <span className="pm-mkt-title" title={pos.title}>{pos.title}</span>
                                                            <OutcomeChip outcome={pos.outcome} />
                                                        </div>
                                                    </td>
                                                    <td className="pm-td pm-td-r">{fmtShares(pos.shares)}</td>
                                                    <td className="pm-td pm-td-r">{fmtPrice(pos.avgPrice)}</td>
                                                    <td className="pm-td pm-td-r">{fmtPrice(pos.currentPrice)}</td>
                                                    <td className="pm-td pm-td-r">{fmtUsd(pos.valueUsd)}</td>
                                                    <td className={`pm-td pm-td-r${pp ? ' pm-pos' : ' pm-neg'}`}>{fmtUsd(pos.pnlUsd)}</td>
                                                    <td className={`pm-td pm-td-r${pp ? ' pm-pos' : ' pm-neg'}`}>{fmtPct(pos.pnlPct)}</td>
                                                    {/* suppressHydrationWarning: date formatting differs server vs client */}
                                                    <td className="pm-td pm-td-r pm-td-date" suppressHydrationWarning>
                                                        {mounted ? fmtDatetime(pos.updatedAt) : ''}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            ) : (
                                /* Closed positions — RESULT | MARKET | TOTAL TRADED | AMOUNT WON | CLOSED */
                                <table className="pm-tbl">
                                    <thead>
                                        <tr>
                                            <th className="pm-th" style={{ width: 90 }}>RESULT</th>
                                            <th className="pm-th pm-th-mkt">MARKET</th>
                                            <th className="pm-th pm-th-r">TOTAL TRADED</th>
                                            <th className="pm-th pm-th-r">AMOUNT WON</th>
                                            <th className="pm-th pm-th-r">CLOSED</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {posLoading && <tr><td colSpan={5} className="pm-td-msg">Loading…</td></tr>}
                                        {!posLoading && posErr && <tr><td colSpan={5} className="pm-td-err">{posErr}</td></tr>}
                                        {!posLoading && !posErr && positions.length === 0 && <tr><td colSpan={5} className="pm-td-msg">No closed positions found.</td></tr>}
                                        {!posLoading && !posErr && positions.map(pos => {
                                            const isWon = pos.resolution === 'WON';
                                            const isLost = pos.resolution === 'LOST';
                                            const outcomePart = pos.outcome ? ` ${capFirst(pos.outcome)}` : '';
                                            const pricePart = pos.avgPrice > 0 ? ` at ${fmtPrice(pos.avgPrice)}` : pos.noCostBasis ? ' · No buy data' : '';
                                            const subtitle = `${fmtShares(pos.shares)}${outcomePart}${pricePart}`;
                                            return (
                                                <tr key={pos.id} className="pm-tr">
                                                    <td className="pm-td">
                                                        {isWon ? <WonChip /> : isLost ? <LostChip /> : <span className="pm-muted">—</span>}
                                                    </td>
                                                    <td className="pm-td pm-td-mkt">
                                                        <div className="pm-closed-mkt-cell">
                                                            {pos.icon && <img src={pos.icon} alt="" className="pm-mkt-icon" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                                                            <div className="pm-closed-mkt-text">
                                                                <span className="pm-mkt-title" title={pos.title}>{pos.title}</span>
                                                                <span className="pm-closed-sub">{subtitle}</span>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="pm-td pm-td-r">
                                                        {pos.noCostBasis ? <span className="pm-muted">—</span> : fmtUsd(pos.totalTraded)}
                                                    </td>
                                                    <td className="pm-td pm-td-r">
                                                        <div className="pm-amount-won-cell">
                                                            <span className={isLost ? 'pm-neg' : pos.valueUsd > 0 ? 'pm-pos' : ''}>{fmtUsd(pos.valueUsd)}</span>
                                                            {!pos.noCostBasis && (
                                                                <span className={isLost ? 'pm-neg' : 'pm-pos'}>{fmtUsd(pos.pnlUsd)} ({fmtPctAbs(pos.pnlPct)})</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    {/* suppressHydrationWarning: date formatting differs server vs client */}
                                                    <td className="pm-td pm-td-r pm-td-date" suppressHydrationWarning>
                                                        {mounted ? fmtDatetime(pos.updatedAt) : ''}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                        <Pager page={posPage} pageSize={POS_PAGE_SIZE} total={posTotal} onPrev={() => setPosPage(v => Math.max(1, v - 1))} onNext={() => setPosPage(v => v + 1)} />
                    </div>
                )}

                {/* ── D) ACTIVITY ─────────────────────────────────────────── */}
                {mainTab === 'activity' && (
                    <div className="pm-panel">
                        <div className="pm-panel-hdr">
                            <div className="pm-type-filters">
                                {ACTIVITY_TYPES.map(t => (
                                    <button key={t} type="button" className={`pm-type-btn${actType === t ? ' pm-type-on' : ''}`} onClick={() => setActType(t)}>{t}</button>
                                ))}
                            </div>
                            <label className="pm-search-wrap">
                                <SearchIcon />
                                <input className="pm-search" placeholder="Search markets…" value={actSearch} onChange={e => setActSearch(e.target.value)} />
                            </label>
                        </div>
                        <div className="pm-tbl-wrap">
                            <table className="pm-tbl">
                                <thead>
                                    <tr>
                                        <th className="pm-th" style={{ width: 60 }}>TYPE</th>
                                        <th className="pm-th pm-th-mkt">MARKET</th>
                                        <th className="pm-th pm-th-r">AMOUNT ↕</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {actLoading && <tr><td colSpan={3} className="pm-td-msg">Loading…</td></tr>}
                                    {!actLoading && actErr && <tr><td colSpan={3} className="pm-td-err">{actErr}</td></tr>}
                                    {!actLoading && !actErr && actItems.length === 0 && <tr><td colSpan={3} className="pm-td-msg">No activity found.</td></tr>}
                                    {!actLoading && !actErr && actItems.map(act => {
                                        const isBuy = act.type === 'Buy';
                                        const isSell = act.type === 'Sell';
                                        return (
                                            <tr key={act.id} className="pm-tr">
                                                <td className="pm-td">
                                                    <span className={`pm-act-type${isBuy ? ' pm-act-buy' : isSell ? ' pm-act-sell' : ' pm-act-other'}`}>{act.type}</span>
                                                </td>
                                                <td className="pm-td pm-td-mkt">
                                                    <div className="pm-act-mkt-cell">
                                                        <span className="pm-mkt-title" title={act.market}>{act.market}</span>
                                                        <div className="pm-act-sub-row">
                                                            {act.outcome && <ActOutcomeChip outcome={act.outcome} price={act.price} />}
                                                            {act.shares != null && <span className="pm-act-shares">{fmtShares(act.shares)} shares</span>}
                                                            {act.txHash && (
                                                                <a className="pm-trace-link" href={`https://polygonscan.com/tx/${act.txHash}`} target="_blank" rel="noreferrer" title={act.txHash}>
                                                                    tx:{shortId(act.txHash)}
                                                                </a>
                                                            )}
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="pm-td pm-td-r">
                                                    <div className="pm-act-amount-cell">
                                                        <span>{act.amountUsd != null ? fmtUsd(act.amountUsd) : '—'}</span>
                                                        {/* suppressHydrationWarning: relativeTime differs server vs client */}
                                                        <span className="pm-act-time" suppressHydrationWarning>
                                                            {mounted ? act.relativeTime : ''}
                                                        </span>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <Pager page={actPage} pageSize={ACT_PAGE_SIZE} total={actTotal} onPrev={() => setActPage(v => Math.max(1, v - 1))} onNext={() => setActPage(v => v + 1)} />
                    </div>
                )}

            </div>
        </>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
.pm-root {
  --bg:      #0e0f13;
  --surf:    #16181e;
  --surf2:   #1c1f27;
  --border:  rgba(255,255,255,0.07);
  --text:    #e6e8ed;
  --muted:   #5c6370;
  --pos:     #22c55e;
  --neg:     #ef4444;
  --acc:     #6366f1;
  --acc-dim: rgba(99,102,241,0.14);
  --r:       12px;
  --rsm:     6px;
  font-family: -apple-system,'Inter','Segoe UI',Helvetica,sans-serif;
  font-size: 14px; color: var(--text); background: var(--bg);
  display: flex; flex-direction: column; gap: 10px;
  padding: 20px; max-width: 1140px; margin: 0 auto;
  box-sizing: border-box; min-height: 100vh;
}
.pm-root *, .pm-root *::before, .pm-root *::after { box-sizing: border-box; }
.pm-top-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.pm-profile-card {
  background: var(--surf); border: 1px solid var(--border);
  border-radius: var(--r); padding: 20px 22px 18px;
  display: flex; flex-direction: column;
}
.pm-err-banner {
  background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.25);
  border-radius: var(--rsm); color: #fca5a5; padding: 7px 11px;
  font-size: 12px; margin-bottom: 12px;
}
.pm-profile-top { display: flex; align-items: flex-start; gap: 12px; }
.pm-avatar { flex-shrink: 0; }
.pm-avatar-skel { width: 56px; height: 56px; border-radius: 50%; background: var(--surf2); }
.pm-identity { flex: 1; min-width: 0; }
.pm-handle { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; line-height: 1.2; }
.pm-meta { display: flex; align-items: center; gap: 5px; margin-top: 4px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.pm-dot { opacity: 0.4; }
.pm-addr-btn { background: none; border: none; padding: 0; cursor: pointer; color: var(--muted); font-size: 12px; font-family: 'SF Mono','Fira Code',monospace; transition: color .15s; }
.pm-addr-btn:hover { color: var(--text); }
.pm-profile-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
.pm-profile-actions { display: flex; align-items: center; gap: 6px; }
.pm-ext-link { font-size: 13px; color: var(--muted); text-decoration: none; border: 1px solid var(--border); border-radius: var(--rsm); padding: 4px 9px; transition: color .15s, border-color .15s; }
.pm-ext-link:hover { color: var(--text); border-color: rgba(255,255,255,0.2); }
.pm-live { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--pos); }
.pm-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--pos); animation: pm-pulse 2s infinite; flex-shrink: 0; }
@keyframes pm-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.85)} }
.pm-live-ts { color: var(--muted); font-weight: 400; }
.pm-stats-row { display: flex; align-items: center; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); gap: 0; }
.pm-stat { flex: 1; min-width: 0; }
.pm-stat-sep { width: 1px; height: 34px; background: var(--border); margin: 0 16px; flex-shrink: 0; }
.pm-stat-val { display: block; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.pm-stat-lbl { display: block; font-size: 11px; color: var(--muted); margin-top: 4px; }
.pm-stats-refresh-btn {
  background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm);
  color: var(--muted); font-size: 11px; padding: 5px 10px; cursor: pointer;
  white-space: nowrap; transition: color .15s, background .15s; flex-shrink: 0;
}
.pm-stats-refresh-btn:hover { color: var(--text); background: rgba(255,255,255,0.06); }
.pm-pnl-card { background: var(--surf); border: 1px solid var(--border); border-radius: var(--r); padding: 20px 22px 16px; }
.pm-pnl-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.pm-pnl-label { font-size: 12px; font-weight: 600; color: var(--muted); margin: 0; text-transform: uppercase; letter-spacing: 0.05em; }
.pm-pnl-value { font-size: 30px; font-weight: 800; letter-spacing: -0.03em; margin: 5px 0 2px; line-height: 1; }
.pm-pnl-sub { font-size: 13px; margin: 0; }
.pm-pnl-period { font-size: 12px; color: var(--muted); margin: 2px 0 0; }
.pm-range-group { display: flex; gap: 2px; background: var(--surf2); border: 1px solid var(--border); border-radius: 8px; padding: 3px; flex-shrink: 0; }
.pm-range-btn { background: none; border: none; padding: 5px 13px; border-radius: 6px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; transition: background .15s, color .15s; }
.pm-range-btn:hover { color: var(--text); }
.pm-range-on { background: var(--acc); color: #fff !important; }
.pm-chart-area { margin-top: 16px; height: 80px; }
.pm-chart-svg { width: 100%; height: 100%; }
.pm-chart-empty { height: 80px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; }
.pm-tab-bar { display: flex; border-bottom: 1px solid var(--border); margin-bottom: -1px; }
.pm-tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 10px 20px; font-size: 14px; font-weight: 600; color: var(--muted); cursor: pointer; margin-bottom: -1px; transition: color .15s; }
.pm-tab:hover { color: var(--text); }
.pm-tab-on { color: var(--text); border-bottom-color: var(--acc); }
.pm-panel { background: var(--surf); border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; }
.pm-panel-hdr { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); gap: 10px; flex-wrap: wrap; }
.pm-panel-ctrls { display: flex; align-items: center; gap: 8px; }
.pm-subtabs { display: flex; gap: 4px; }
.pm-subtab { background: none; border: none; padding: 5px 16px; border-radius: var(--rsm); font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; transition: background .15s, color .15s; }
.pm-subtab:hover { background: var(--surf2); color: var(--text); }
.pm-subtab-on { background: var(--acc-dim); color: var(--acc); }
.pm-type-filters { display: flex; gap: 4px; flex-wrap: wrap; }
.pm-type-btn { background: none; border: 1px solid transparent; padding: 4px 12px; border-radius: var(--rsm); font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer; transition: all .15s; }
.pm-type-btn:hover { background: var(--surf2); color: var(--text); }
.pm-type-on { background: var(--acc-dim); border-color: rgba(99,102,241,0.3); color: var(--acc); }
.pm-search-wrap { position: relative; display: flex; align-items: center; }
.pm-search-icon { position: absolute; left: 8px; width: 13px; height: 13px; color: var(--muted); pointer-events: none; }
.pm-search { background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm); color: var(--text); font-size: 13px; padding: 6px 10px 6px 27px; width: 190px; outline: none; transition: border-color .15s; }
.pm-search:focus { border-color: var(--acc); }
.pm-search::placeholder { color: var(--muted); }
.pm-select { background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm); color: var(--text); font-size: 13px; padding: 6px 10px; cursor: pointer; outline: none; }
.pm-select:focus { border-color: var(--acc); }
.pm-tbl-wrap { overflow-x: auto; }
.pm-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.pm-th { text-align: left; padding: 9px 14px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
.pm-th-r { text-align: right; }
.pm-th-mkt { min-width: 220px; }
.pm-tr { transition: background .1s; }
.pm-tr:hover { background: rgba(255,255,255,0.025); }
.pm-td { padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; white-space: nowrap; }
.pm-td-r { text-align: right; font-variant-numeric: tabular-nums; }
.pm-td-mkt { max-width: 320px; }
.pm-td-msg { text-align: center; padding: 32px; color: var(--muted); font-size: 13px; }
.pm-td-err { text-align: center; padding: 32px; color: #f87171; font-size: 13px; }
.pm-td-date { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.pm-mkt-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pm-mkt-icon { width: 22px; height: 22px; border-radius: 5px; object-fit: cover; flex-shrink: 0; }
.pm-mkt-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.pm-closed-mkt-cell { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.pm-closed-mkt-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pm-closed-sub { font-size: 12px; color: var(--muted); }
.pm-amount-won-cell { display: flex; flex-direction: column; gap: 2px; align-items: flex-end; }
.pm-act-mkt-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pm-act-sub-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pm-act-shares { font-size: 12px; color: var(--muted); }
.pm-act-chip { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pm-act-chip-up   { background: rgba(34,197,94,0.12); color: #4ade80; }
.pm-act-chip-down { background: rgba(239,68,68,0.12); color: #f87171; }
.pm-act-amount-cell { display: flex; flex-direction: column; gap: 2px; align-items: flex-end; }
.pm-act-time { font-size: 12px; color: var(--muted); min-height: 1em; }
.pm-act-type { font-weight: 600; font-size: 13px; }
.pm-act-buy   { color: #4ade80; }
.pm-act-sell  { color: #f87171; }
.pm-act-other { color: var(--muted); }
.pm-trace-link { font-size: 11px; font-family: 'SF Mono','Fira Code',monospace; color: #60a5fa; text-decoration: none; transition: color .15s; }
.pm-trace-link:hover { color: #93c5fd; text-decoration: underline; }
.pm-result-won  { display: inline-flex; align-items: center; gap: 5px; color: #22c55e; font-weight: 600; font-size: 13px; }
.pm-result-lost { display: inline-flex; align-items: center; gap: 5px; color: #ef4444; font-weight: 600; font-size: 13px; }
.pm-chip { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.pm-chip-yes { background: rgba(34,197,94,0.14); color: #22c55e; }
.pm-chip-no  { background: rgba(239,68,68,0.14); color: #ef4444; }
.pm-pager { display: flex; align-items: center; justify-content: space-between; padding: 9px 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.pm-pager-btns { display: flex; align-items: center; gap: 8px; }
.pm-pager-btn { background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm); color: var(--text); padding: 4px 12px; font-size: 12px; cursor: pointer; transition: background .15s; }
.pm-pager-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); }
.pm-pager-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.pm-pager-cur { color: var(--muted); }
.pm-pos   { color: var(--pos) !important; }
.pm-neg   { color: var(--neg) !important; }
.pm-muted { color: var(--muted); }
.pm-skel { display: inline-block; background: linear-gradient(90deg, var(--surf2) 25%, rgba(255,255,255,0.04) 50%, var(--surf2) 75%); background-size: 200% 100%; animation: pm-shimmer 1.5s infinite; border-radius: 4px; vertical-align: middle; }
.pm-skel-lg { width: 130px; height: 1em; }
.pm-skel-sm { width: 90px; height: 0.85em; }
@keyframes pm-shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
.pm-refresh-btn { background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm); color: var(--text); font-size: 12px; padding: 5px 10px; cursor: pointer; transition: background .15s, border-color .15s; white-space: nowrap; }
.pm-refresh-btn:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.18); }
.pm-refresh-btn:active { transform: scale(0.97); }
.pm-pnl-summary-bar { display: flex; flex-direction: column; gap: 8px; }
.pm-pnl-calc-btn { align-self: flex-start; background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm); color: var(--text); font-size: 13px; font-weight: 600; padding: 7px 14px; cursor: pointer; transition: background .15s, border-color .15s; }
.pm-pnl-calc-btn:hover { background: rgba(255,255,255,0.06); }
.pm-pnl-calc-btn--on { background: var(--acc-dim); border-color: rgba(99,102,241,0.35); color: var(--acc); }
.pm-pnl-summary-panel { background: var(--surf); border: 1px solid var(--border); border-radius: var(--r); padding: 16px 18px; }
.pm-pnl-summary-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.pm-pnl-summary-title { font-size: 13px; font-weight: 600; color: var(--muted); }
.pm-pnl-range-btns { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.pm-pnl-range-pill { background: none; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 12px; font-weight: 600; padding: 4px 12px; cursor: pointer; transition: all .15s; }
.pm-pnl-range-pill:hover { color: var(--text); border-color: rgba(255,255,255,0.2); }
.pm-pnl-range-pill--on { background: var(--acc); border-color: var(--acc); color: #fff; }
.pm-pnl-recalc-btn { background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm); color: var(--text); font-size: 12px; padding: 4px 10px; cursor: pointer; transition: background .15s; margin-left: 4px; }
.pm-pnl-recalc-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); }
.pm-pnl-recalc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pm-pnl-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.pm-pnl-summary-tile { background: var(--surf2); border: 1px solid var(--border); border-radius: var(--rsm); padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.pm-pnl-summary-tile--large { background: rgba(99,102,241,0.07); border-color: rgba(99,102,241,0.2); }
.pm-pnl-summary-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.pm-pnl-summary-val { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.pm-pnl-summary-tile--large .pm-pnl-summary-val { font-size: 19px; }
.pm-pnl-summary-loading { text-align: center; padding: 20px; color: var(--muted); font-size: 13px; }
@media (max-width: 768px) { .pm-top-grid { grid-template-columns: 1fr; } .pm-pnl-top { flex-direction: column; } }
@media (max-width: 600px) { .pm-root { padding: 12px; } .pm-panel-hdr { flex-direction: column; align-items: flex-start; } .pm-search { width: 100%; } .pm-stat-val { font-size: 17px; } .pm-pnl-value { font-size: 24px; } }
`;