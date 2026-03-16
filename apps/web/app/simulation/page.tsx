'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutShell } from '../components/layout-shell';
import { MarketHistoryView } from '../components/position-history';
import { TrendLine } from '../components/trend-line';
import { CompareCurves } from '../components/compare-curves';

const API = process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';

type Wallet = {
    id: string;
    label: string;
    enabled: boolean;
};

type SessionStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED';

type SessionListItem = {
    id: string;
    trackedWalletLabel: string;
    status: SessionStatus;
    currentCash: number;
    startedAt: string | null;
    totalPnl: number;
    fees: number;
    winRate?: number;
    returnPct: number;
    winRatePct?: number;
};

type SessionDetail = {
    id: string;
    trackedWalletLabel: string;
    status: SessionStatus;
    currentCash: number;
    startedAt: string | null;
    totalPnl: number;
    netLiquidationValue: number;
    realizedPnl: number;
    unrealizedPnl: number;
    fees: number;
    returnPct: number;
    slippageBps?: number;
    slippageConfig?: {
        enabled?: boolean;
        mode?: string;
        fixedBps?: number;
        fixedPercent?: number;
        randomRange?: { min: number; max: number };
        latencyDrift?: {
            enabled?: boolean;
            bpsPerSecond?: number;
            maxBps?: number;
        };
        maxAdverseMovePercent?: number;
    } | null;
    winCount: number;
    lossCount: number;
    winRate?: number;
    winRatePct: number;
    stats?: { openPositionsCount?: number };
};

type SessionAnalytics = {
    summary: {
        runtimeSeconds: number;
        tradeHistory: {
            buys: number;
            sells: number;
            redeems: number;
            totalTrades: number;
        };
        executionFriction: {
            samples: number;
            avgLatencyMs: number;
            avgSlippageBps: number;
            avgDriftBps: number;
            avgTotalAdverseBps: number;
        };
    };
};

type LatencyProfileState = {
    profile: 'NORMAL' | 'TURBO';
    turboEnabled: boolean;
    updatedAt: string;
};

type SourceSummary = {
    positionsValueUsd: number;
};

type SourcePnlSummary = {
    netPnl: number;
    winRate: number;
    winRatePct?: number;
    tradeCount: number;
};

type MetricPoint = {
    timestamp: string;
    totalPnl: number;
    realizedPnl: number;
    unrealizedPnl: number;
    netLiquidationValue: number;
    openPositionsCount: number;
    fees?: number;
};

type TrackedPerformance = {
    walletId: string;
    totals: {
        realizedPnlGross: number;
        unrealizedPnl: number;
        fees: number;
        netPnl: number;
        reconstructedAccountValue: number;
    };
    knowability: {
        startingCashKnown: boolean;
        accountValueMode: string;
        feeCoveragePct: number;
        strictKnownOnly?: boolean;
        inferredShareEvents?: number;
        inferredPriceEvents?: number;
        historyTruncatedByCap?: boolean;
        scannedEventCount?: number;
        maxEventCap?: number;
    };
    compute?: {
        historyTruncatedByCap?: boolean;
        scannedEventCount?: number;
        maxEventCap?: number;
    };
};

type SourceSessionComparison = {
    sessionId: string;
    sessionStatus: string;
    window: { start: string; end: string; mode: string };
    source: { realizedPnlGross: number; unrealizedPnl: number; fees: number; netPnl: number };
    session: { realizedPnlGross: number; unrealizedPnl: number; fees: number; netPnl: number };
    gaps: {
        netPnlGap: number;
        feeGap: number;
        frictionDrag: number;
        executionDrag: number;
        percentGap: number | null;
    };
    curves: {
        sourceNetPnl: Array<{ timestamp: string; value: number }>;
        sessionNetPnl: Array<{ timestamp: string; value: number }>;
        gap: Array<{ timestamp: string; value: number }>;
    };
    diagnosis: { dominantDriver: string; summary: string };
};

type SourceVsSessionsResponse = {
    walletId: string;
    alignment: 'SESSION_WINDOW' | 'SHARED_WINDOW';
    sourceKnowability?: {
        strictKnownOnly?: boolean;
        feeCoveragePct?: number;
        inferredShareEvents?: number;
        inferredPriceEvents?: number;
        scannedEventCount?: number;
        maxEventCap?: number;
        historyTruncatedByCap?: boolean;
    };
    compute?: {
        cacheHit?: boolean;
        curveBucket?: 'RAW' | '5M' | '15M' | '1H';
        scannedEventCount?: number;
        maxEventCap?: number;
        historyTruncatedByCap?: boolean;
    };
    warnings?: Array<{ code: string; message: string; severity?: string }>;
    sessions: SourceSessionComparison[];
};

type LiveFeedItem = {
    id: string;
    eventType: string;
    market: string;
    outcome: string | null;
    shares: number | null;
    amountUsd: number | null;
    relativeTime: string;
    ourAction: 'COPIED' | 'SKIPPED' | 'AUTO_CLOSED' | 'OPEN' | null;
    ourPnl: number | null;
    ourPnlCumulative?: number | null;
    ourFeeUsd?: number | null;
    ourAmountUsd?: number | null;
    ourLatencyMs?: number | null;
    ourSlippageBps?: number | null;
    ourDriftBps?: number | null;
    ourTotalAdverseBps?: number | null;
    skipReason: string | null;
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
    openedAt: string;
    closedAt: string | null;
};

type TabKey = 'live' | 'positions' | 'history' | 'market-history';
type PnlRange = '1H' | '6H' | '24H' | 'ALL';
type PositionSortKey = 'market' | 'outcome' | 'shares' | 'entry' | 'mark' | 'value' | 'pnl' | 'since';
type SortDir = 'asc' | 'desc';

const normMoney = (v?: number | null) => (Math.abs(v ?? 0) < 1e-9 ? 0 : (v ?? 0));
const fmtUsd = (n?: number | null, dp = 2) =>
    `$${normMoney(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const fmtPnl = (n?: number | null) => {
    const v = normMoney(n);
    if (v > 0) return `+${fmtUsd(v)}`;
    if (v < 0) return `-${fmtUsd(Math.abs(v))}`;
    return `${fmtUsd(0)}`;
};

function formatDuration(seconds: number): string {
    const safe = Math.max(0, Math.floor(seconds));
    const days = Math.floor(safe / 86_400);
    const hours = Math.floor((safe % 86_400) / 3_600);
    const mins = Math.floor((safe % 3_600) / 60);
    const secs = safe % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

function slippageLabel(detail: SessionDetail): string {
    const cfg = detail.slippageConfig;
    const driftLabel =
        cfg?.latencyDrift?.enabled && typeof cfg.latencyDrift.bpsPerSecond === 'number'
            ? ` + DRIFT(${cfg.latencyDrift.bpsPerSecond}bps/s${typeof cfg.latencyDrift.maxBps === 'number' ? ` cap ${cfg.latencyDrift.maxBps}bps` : ''})`
            : '';
    if (cfg && cfg.enabled && cfg.mode) {
        if (cfg.mode === 'FIXED_BPS' && typeof cfg.fixedBps === 'number') {
            return `FIXED_BPS (${cfg.fixedBps} bps)${driftLabel}`;
        }
        if (cfg.mode === 'FIXED_PERCENT' && typeof cfg.fixedPercent === 'number') {
            return `FIXED_PERCENT (${(cfg.fixedPercent * 100).toFixed(3)}%)${driftLabel}`;
        }
        if (
            cfg.mode === 'RANDOM_RANGE' &&
            cfg.randomRange &&
            typeof cfg.randomRange.min === 'number' &&
            typeof cfg.randomRange.max === 'number'
        ) {
            return `RANDOM_RANGE (${(cfg.randomRange.min * 100).toFixed(3)}% - ${(cfg.randomRange.max * 100).toFixed(3)}%)${driftLabel}`;
        }
        return `${cfg.mode}${driftLabel}`;
    }

    const legacyBps = Number(detail.slippageBps ?? 0);
    if (legacyBps > 0) {
        return `FIXED_BPS (${legacyBps} bps)`;
    }
    return 'NONE';
}

const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const shortDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '-');
const pnlClass = (n: number) =>
    n > 0.001 ? 'text-emerald-400' : n < -0.001 ? 'text-rose-400' : 'text-slate-300';
const statusPill = (status: SessionStatus) => {
    if (status === 'RUNNING') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    if (status === 'PAUSED') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
};

function extractErrorMessage(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as {
            message?: string | Array<{ message?: string }>;
            error?: string;
        };
        if (Array.isArray(parsed.message) && parsed.message.length > 0) {
            return parsed.message.map((m) => m?.message ?? '').filter(Boolean).join(' | ') || raw;
        }
        if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
        if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
        return raw;
    } catch {
        return raw;
    }
}

export default function SimulationPage() {
    const [wallets, setWallets] = useState<Wallet[]>([]);
    const [sessions, setSessions] = useState<SessionListItem[]>([]);

    const [walletId, setWalletId] = useState('');
    const [startingCash, setStartingCash] = useState('1000');
    const [copyRatio, setCopyRatio] = useState<'1' | '0.5' | '0.25'>('1');
    const [minNotional, setMinNotional] = useState('2');

    const [slippageMode, setSlippageMode] = useState<string>('FIXED_BPS');
    const [slippageValue1, setSlippageValue1] = useState('20');
    const [slippageValue2, setSlippageValue2] = useState('');
    const [maxAdverse, setMaxAdverse] = useState('');
    const [driftEnabled, setDriftEnabled] = useState(true);
    const [driftBpsPerSecond, setDriftBpsPerSecond] = useState('4');
    const [driftMaxBps, setDriftMaxBps] = useState('40');

    const [sourceSummary, setSourceSummary] = useState<SourceSummary | null>(null);
    const [sourcePnl, setSourcePnl] = useState<SourcePnlSummary | null>(null);
    const [sourceTracked, setSourceTracked] = useState<TrackedPerformance | null>(null);
    const [sourceComparisons, setSourceComparisons] = useState<SourceVsSessionsResponse | null>(null);
    const [comparisonAlignment, setComparisonAlignment] = useState<'SESSION_WINDOW' | 'SHARED_WINDOW'>('SESSION_WINDOW');
    const [comparisonStrictKnownOnly, setComparisonStrictKnownOnly] = useState(true);
    const [comparisonCurveBucket, setComparisonCurveBucket] = useState<'RAW' | '5M' | '15M' | '1H'>('5M');

    const [activeSessionId, setActiveSessionId] = useState('');
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>('live');
    const [feedLimit, setFeedLimit] = useState(50);

    const [liveFeed, setLiveFeed] = useState<LiveFeedItem[]>([]);
    const [openPositions, setOpenPositions] = useState<Position[]>([]);
    const [closedPositions, setClosedPositions] = useState<Position[]>([]);
    const [metricPoints, setMetricPoints] = useState<MetricPoint[]>([]);

    const [creating, setCreating] = useState(false);
    const [forceStartOnLowConfidence, setForceStartOnLowConfidence] = useState(false);
    const [err, setErr] = useState('');
    const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
    const [nowMs, setNowMs] = useState(Date.now());
    const [positionSortBy, setPositionSortBy] = useState<PositionSortKey>('since');
    const [positionSortDir, setPositionSortDir] = useState<SortDir>('desc');
    const [pnlRange, setPnlRange] = useState<PnlRange>('24H');
    const [latencyProfile, setLatencyProfile] = useState<LatencyProfileState | null>(null);
    const [latencyProfileSaving, setLatencyProfileSaving] = useState(false);

    const loadWallets = useCallback(async () => {
        const r = await fetch(`${API}/wallets`).catch(() => null);
        if (!r?.ok) return;
        const d = (await r.json()) as Wallet[];
        const enabled = d.filter((w) => w.enabled);
        setWallets(enabled);
        setWalletId((cur) => cur || enabled[0]?.id || '');
    }, []);

    const loadLatencyProfile = useCallback(async () => {
        const r = await fetch(`${API}/admin/latency-profile`).catch(() => null);
        if (!r?.ok) return;
        const d = (await r.json()) as LatencyProfileState;
        setLatencyProfile(d);
    }, []);

    const loadSessions = useCallback(async () => {
        const r = await fetch(`${API}/paper-copy-sessions`).catch(() => null);
        if (!r?.ok) return;
        const d = (await r.json()) as SessionListItem[];
        setSessions(d);
        setActiveSessionId((cur) => {
            if (cur && d.some((s) => s.id === cur)) return cur;
            return d[0]?.id ?? '';
        });
    }, []);

    const loadSourceStrip = useCallback(async (wid: string) => {
        if (!wid) {
            setSourceSummary(null);
            setSourcePnl(null);
            setSourceTracked(null);
            setSourceComparisons(null);
            return;
        }
        const [a, b, c] = await Promise.all([
            fetch(`${API}/wallets/${wid}/profile-summary`).catch(() => null),
            fetch(`${API}/wallets/${wid}/pnl-summary?range=ALL`).catch(() => null),
            fetch(`${API}/wallets/${wid}/tracked-performance?bucket=5M&strictKnownOnly=${comparisonStrictKnownOnly ? 'true' : 'false'}`).catch(() => null),
        ]);
        setSourceSummary(a?.ok ? ((await a.json()) as SourceSummary) : null);
        setSourcePnl(b?.ok ? ((await b.json()) as SourcePnlSummary) : null);
        setSourceTracked(c?.ok ? ((await c.json()) as TrackedPerformance) : null);
    }, [comparisonStrictKnownOnly]);

    const loadSourceComparisons = useCallback(async (
        wid: string,
        opts?: {
            alignment?: 'SESSION_WINDOW' | 'SHARED_WINDOW';
            strictKnownOnly?: boolean;
            curveBucket?: 'RAW' | '5M' | '15M' | '1H';
        },
    ) => {
        if (!wid) {
            setSourceComparisons(null);
            return;
        }
        const alignment = opts?.alignment ?? comparisonAlignment;
        const strictKnownOnly = opts?.strictKnownOnly ?? comparisonStrictKnownOnly;
        const curveBucket = opts?.curveBucket ?? comparisonCurveBucket;
        const qs = new URLSearchParams({
            alignment,
            strictKnownOnly: strictKnownOnly ? 'true' : 'false',
            curveBucket,
        });
        const r = await fetch(`${API}/wallets/${wid}/source-vs-sessions?${qs.toString()}`).catch(() => null);
        if (!r?.ok) return;
        setSourceComparisons((await r.json()) as SourceVsSessionsResponse);
    }, [comparisonAlignment, comparisonStrictKnownOnly, comparisonCurveBucket]);

    const loadDetail = useCallback(async (sid: string) => {
        if (!sid) return;
        const r = await fetch(`${API}/paper-copy-sessions/${sid}`).catch(() => null);
        if (!r?.ok) return;
        setDetail((await r.json()) as SessionDetail);
        setLastUpdatedAt(Date.now());
    }, []);

    const loadAnalytics = useCallback(async (sid: string) => {
        if (!sid) return;
        const r = await fetch(`${API}/paper-copy-sessions/${sid}/analytics`).catch(() => null);
        if (!r?.ok) return;
        setAnalytics((await r.json()) as SessionAnalytics);
        setLastUpdatedAt(Date.now());
    }, []);

    const loadLiveFeed = useCallback(async (sid: string, limit: number) => {
        if (!sid) return;
        const r = await fetch(`${API}/paper-copy-sessions/${sid}/live-feed?limit=${limit}`).catch(
            () => null,
        );
        if (!r?.ok) return;
        const d = (await r.json()) as { items: LiveFeedItem[] };
        setLiveFeed(d.items);
        setLastUpdatedAt(Date.now());
    }, []);

    const loadOpenPositions = useCallback(async (sid: string) => {
        if (!sid) return;
        const r = await fetch(`${API}/paper-copy-sessions/${sid}/positions?status=OPEN&limit=500`).catch(
            () => null,
        );
        if (!r?.ok) return;
        setOpenPositions((await r.json()) as Position[]);
        setLastUpdatedAt(Date.now());
    }, []);

    const loadClosedPositions = useCallback(async (sid: string) => {
        if (!sid) return;
        const r = await fetch(`${API}/paper-copy-sessions/${sid}/positions?status=CLOSED&limit=1000`).catch(
            () => null,
        );
        if (!r?.ok) return;
        setClosedPositions((await r.json()) as Position[]);
        setLastUpdatedAt(Date.now());
    }, []);

    const loadMetrics = useCallback(async (sid: string) => {
        if (!sid) return;
        const r = await fetch(`${API}/paper-copy-sessions/${sid}/metrics?limit=400`).catch(() => null);
        if (!r?.ok) return;
        const points = (await r.json()) as MetricPoint[];
        setMetricPoints(points);
        setLastUpdatedAt(Date.now());
    }, []);

    useEffect(() => {
        loadWallets();
        loadSessions();
        loadLatencyProfile();
    }, [loadWallets, loadSessions, loadLatencyProfile]);

    useEffect(() => {
        const timer = setInterval(() => {
            loadSessions();
        }, 10_000);
        return () => clearInterval(timer);
    }, [loadSessions]);

    useEffect(() => {
        const timer = setInterval(() => {
            loadLatencyProfile();
        }, 15_000);
        return () => clearInterval(timer);
    }, [loadLatencyProfile]);

    useEffect(() => {
        loadSourceStrip(walletId);
        loadSourceComparisons(walletId, {
            alignment: comparisonAlignment,
            strictKnownOnly: comparisonStrictKnownOnly,
            curveBucket: comparisonCurveBucket,
        });
    }, [walletId, loadSourceStrip, loadSourceComparisons]);

    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!activeSessionId) return;
        loadDetail(activeSessionId);
        loadAnalytics(activeSessionId);
        loadClosedPositions(activeSessionId);
        loadMetrics(activeSessionId);
        if (activeTab === 'live') loadLiveFeed(activeSessionId, feedLimit);
        if (activeTab === 'positions') {
            loadOpenPositions(activeSessionId);
        }
    }, [
        activeSessionId,
        activeTab,
        feedLimit,
        loadDetail,
        loadAnalytics,
        loadLiveFeed,
        loadOpenPositions,
        loadClosedPositions,
        loadMetrics,
    ]);

    useEffect(() => {
        if (!activeSessionId) return;
        const timer = setInterval(() => {
            loadDetail(activeSessionId);
            loadAnalytics(activeSessionId);
            loadMetrics(activeSessionId);
            loadSourceComparisons(walletId, {
                alignment: comparisonAlignment,
                strictKnownOnly: comparisonStrictKnownOnly,
                curveBucket: comparisonCurveBucket,
            });
        }, 60_000);
        return () => clearInterval(timer);
    }, [
        activeSessionId,
        loadDetail,
        loadAnalytics,
        loadMetrics,
        loadSourceComparisons,
        walletId,
        comparisonAlignment,
        comparisonStrictKnownOnly,
        comparisonCurveBucket,
    ]);

    useEffect(() => {
        if (!walletId || !activeSessionId) return;
        const timer = setInterval(() => {
            loadSourceComparisons(walletId, {
                alignment: comparisonAlignment,
                strictKnownOnly: comparisonStrictKnownOnly,
                curveBucket: comparisonCurveBucket,
            });
        }, 90_000);
        return () => clearInterval(timer);
    }, [
        walletId,
        activeSessionId,
        loadSourceComparisons,
        comparisonAlignment,
        comparisonStrictKnownOnly,
        comparisonCurveBucket,
    ]);

    useEffect(() => {
        if (!activeSessionId) return;
        const timer = setInterval(() => loadMetrics(activeSessionId), 10_000);
        return () => clearInterval(timer);
    }, [activeSessionId, loadMetrics]);

    useEffect(() => {
        if (!activeSessionId) return;
        const timer = setInterval(() => loadClosedPositions(activeSessionId), 30_000);
        return () => clearInterval(timer);
    }, [activeSessionId, loadClosedPositions]);

    useEffect(() => {
        if (!activeSessionId) return;
        if (activeTab === 'live') {
            const timer = setInterval(() => loadLiveFeed(activeSessionId, feedLimit), 10_000);
            return () => clearInterval(timer);
        }
        const timer = setInterval(() => {
            if (activeTab === 'positions') {
                loadOpenPositions(activeSessionId);
            }
            if (activeTab === 'history') loadClosedPositions(activeSessionId);
        }, 30_000);
        return () => clearInterval(timer);
    }, [
        activeSessionId,
        activeTab,
        feedLimit,
        loadLiveFeed,
        loadOpenPositions,
        loadClosedPositions,
    ]);

    const createAndStart = async () => {
        setErr('');
        const cash = Number(startingCash);
        const minNotionalValue = Number(minNotional);
        if (!walletId) return setErr('Select a wallet.');
        if (!Number.isFinite(cash) || cash < 100) return setErr('Starting cash must be at least $100.');
        if (!Number.isFinite(minNotionalValue) || minNotionalValue < 0) {
            return setErr('Min notional must be a non-negative number.');
        }

        setCreating(true);
        try {
            const driftBpsPerSecNum = Math.max(0, Number(driftBpsPerSecond) || 0);
            const driftMaxBpsNum = Math.max(0, Number(driftMaxBps) || 0);
            const hasBaseSlippage = slippageMode !== 'NONE';
            const hasLatencyDrift = driftEnabled && driftBpsPerSecNum > 0;

            let slippageConfig = null;
            if (hasBaseSlippage || hasLatencyDrift) {
                slippageConfig = {
                    enabled: true,
                    mode: slippageMode,
                    maxAdverseMovePercent: maxAdverse ? Number(maxAdverse) / 100 : undefined,
                    ...(slippageMode === 'FIXED_PERCENT' ? { fixedPercent: Number(slippageValue1) / 100 } : {}),
                    ...(slippageMode === 'FIXED_BPS' ? { fixedBps: Number(slippageValue1) } : {}),
                    ...(slippageMode === 'RANDOM_RANGE'
                        ? {
                            randomRange: {
                                min: Number(slippageValue1) / 100,
                                max: Number(slippageValue2) / 100,
                            },
                        }
                        : {}),
                    ...(hasLatencyDrift
                        ? {
                            latencyDrift: {
                                enabled: true,
                                bpsPerSecond: driftBpsPerSecNum,
                                maxBps: driftMaxBpsNum > 0 ? driftMaxBpsNum : undefined,
                            },
                        }
                        : {}),
                };
            }

            const createResp = await fetch(`${API}/paper-copy-sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trackedWalletId: walletId,
                    startingCash: cash,
                    copyRatio: Number(copyRatio),
                    minNotionalThreshold: minNotionalValue,
                    maxAllocationPerMarket: cash,
                    maxTotalExposure: cash,
                    slippageConfig
                }),
            });
            if (!createResp.ok) {
                setErr(extractErrorMessage(await createResp.text()));
                return;
            }
            const created = (await createResp.json()) as { id: string };
            const startResp = await fetch(`${API}/paper-copy-sessions/${created.id}/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ forceStart: forceStartOnLowConfidence }),
            }).catch(() => null);

            if (!startResp?.ok) {
                const body = startResp ? await startResp.text() : 'Unable to start session.';
                setErr(extractErrorMessage(body));
                await loadSessions();
                setActiveSessionId(created.id);
                return;
            }

            await loadSessions();
            setActiveSessionId(created.id);
            setActiveTab('live');
            setFeedLimit(50);
        } finally {
            setCreating(false);
        }
    };

    const setLatencyProfileMode = async (profile: 'NORMAL' | 'TURBO') => {
        setErr('');
        setLatencyProfileSaving(true);
        try {
            const r = await fetch(`${API}/admin/latency-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile }),
            }).catch(() => null);
            if (!r?.ok) {
                const body = r ? await r.text() : 'Unable to update latency profile.';
                setErr(extractErrorMessage(body));
                return;
            }
            const d = (await r.json()) as LatencyProfileState;
            setLatencyProfile(d);
        } finally {
            setLatencyProfileSaving(false);
        }
    };

    const sessionAction = async (action: 'pause' | 'resume' | 'stop') => {
        if (!activeSessionId) return;
        await fetch(`${API}/paper-copy-sessions/${activeSessionId}/${action}`, { method: 'POST' });
        await loadSessions();
        await Promise.all([loadDetail(activeSessionId), loadAnalytics(activeSessionId)]);
    };

    const deleteSession = async (id: string) => {
        if (!window.confirm('Delete this session permanently?')) return;
        await fetch(`${API}/paper-copy-sessions/${id}`, { method: 'DELETE' });
        await loadSessions();
    };

    const forceClose = async (positionId: string | null) => {
        if (!activeSessionId) return;
        if (positionId) {
            await fetch(`${API}/paper-copy-sessions/${activeSessionId}/positions/${positionId}/force-close`, {
                method: 'POST',
            });
        } else {
            return;
        }
        await Promise.all([
            loadOpenPositions(activeSessionId),
            loadClosedPositions(activeSessionId),
            loadDetail(activeSessionId),
            loadAnalytics(activeSessionId),
        ]);
    };

    // FIX: Use normMoney so breakeven (0 PnL) isn't counted as LOST
    const historySummary = useMemo(() => {
        const total = closedPositions.length;
        const won = closedPositions.filter((p) => normMoney(p.realizedPnl) > 0).length;
        const lost = closedPositions.filter((p) => normMoney(p.realizedPnl) < 0).length;
        const totalPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
        const decisive = won + lost;
        return {
            total,
            won,
            lost,
            winRate: decisive > 0 ? (won / decisive) * 100 : 0,
            totalPnl,
        };
    }, [closedPositions]);

    const openPositionRows = useMemo(
        () => [...openPositions].sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()),
        [openPositions],
    );

    const openLotsSummary = useMemo(() => {
        const totalValue = openPositionRows.reduce((sum, pos) => sum + pos.netShares * pos.currentMarkPrice, 0);
        const totalUnrealizedPnl = openPositionRows.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
        const totalShares = openPositionRows.reduce((sum, pos) => sum + pos.netShares, 0);
        return { totalValue, totalUnrealizedPnl, totalShares };
    }, [openPositionRows]);

    const realizedPnlSummary = useMemo(
        () => {
            const closedSum = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
            const openSum = openPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
            return closedSum + openSum;
        },
        [closedPositions, openPositions],
    );

    // FIX: Win rate excludes breakeven from denominator
    const closedWinRatePct = useMemo(() => {
        const wins = closedPositions.filter((p) => normMoney(p.realizedPnl) > 0).length;
        const losses = closedPositions.filter((p) => normMoney(p.realizedPnl) < 0).length;
        const decisive = wins + losses;
        if (decisive === 0) return 0;
        return (wins / decisive) * 100;
    }, [closedPositions]);

    const sortedOpenLots = useMemo(() => {
        const rows = [...openPositionRows];
        rows.sort((a, b) => {
            const aValue = a.netShares * a.currentMarkPrice;
            const bValue = b.netShares * b.currentMarkPrice;
            const aSince = new Date(a.openedAt).getTime();
            const bSince = new Date(b.openedAt).getTime();

            let cmp = 0;
            if (positionSortBy === 'market') cmp = (a.marketQuestion ?? a.marketId).localeCompare(b.marketQuestion ?? b.marketId);
            if (positionSortBy === 'outcome') cmp = a.outcome.localeCompare(b.outcome);
            if (positionSortBy === 'shares') cmp = a.netShares - b.netShares;
            if (positionSortBy === 'entry') cmp = a.avgEntryPrice - b.avgEntryPrice;
            if (positionSortBy === 'mark') cmp = a.currentMarkPrice - b.currentMarkPrice;
            if (positionSortBy === 'value') cmp = aValue - bValue;
            if (positionSortBy === 'pnl') cmp = a.unrealizedPnl - b.unrealizedPnl;
            if (positionSortBy === 'since') cmp = aSince - bSince;

            return positionSortDir === 'asc' ? cmp : -cmp;
        });
        return rows;
    }, [openPositionRows, positionSortBy, positionSortDir]);

    const togglePositionSort = (key: PositionSortKey) => {
        if (positionSortBy === key) {
            setPositionSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
            return;
        }
        setPositionSortBy(key);
        setPositionSortDir(key === 'market' ? 'asc' : 'desc');
    };

    const sortLabel = (key: PositionSortKey) => {
        if (positionSortBy !== key) return '';
        return positionSortDir === 'asc' ? ' ↑' : ' ↓';
    };

    const selected = sessions.find((s) => s.id === activeSessionId) ?? null;
    const activeComparison = useMemo(
        () => sourceComparisons?.sessions.find((row) => row.sessionId === activeSessionId) ?? null,
        [sourceComparisons, activeSessionId],
    );
    const lastUpdatedSeconds = lastUpdatedAt
        ? Math.max(0, Math.floor((nowMs - lastUpdatedAt) / 1000))
        : null;
    const runtimeSeconds = analytics?.summary?.runtimeSeconds ??
        (detail?.startedAt ? Math.max(0, Math.floor((nowMs - new Date(detail.startedAt).getTime()) / 1000)) : 0);
    const tradeHistory = analytics?.summary?.tradeHistory ?? {
        buys: 0,
        sells: 0,
        redeems: 0,
        totalTrades: 0,
    };
    const friction = analytics?.summary?.executionFriction ?? {
        samples: 0,
        avgLatencyMs: 0,
        avgSlippageBps: 0,
        avgDriftBps: 0,
        avgTotalAdverseBps: 0,
    };
    const accountValue = detail?.netLiquidationValue ?? detail?.currentCash ?? 0;
    const realizedValue = detail?.realizedPnl ?? realizedPnlSummary;
    const unrealizedValue = detail?.unrealizedPnl ?? openLotsSummary.totalUnrealizedPnl;
    const feesPaid = Math.abs(detail?.fees ?? 0);
    const openCount = detail?.stats?.openPositionsCount ?? openPositionRows.length;
    const openValueCanonical = detail
        ? Math.max(0, detail.netLiquidationValue - detail.currentCash)
        : openLotsSummary.totalValue;
    const sourceHistoryTruncated = Boolean(
        sourceComparisons?.sourceKnowability?.historyTruncatedByCap ??
        sourceComparisons?.compute?.historyTruncatedByCap ??
        sourceTracked?.knowability?.historyTruncatedByCap ??
        sourceTracked?.compute?.historyTruncatedByCap,
    );
    const sourceComparisonWarnings = sourceComparisons?.warnings ?? [];
    const filteredMetricPoints = useMemo(() => {
        if (metricPoints.length === 0) return [] as MetricPoint[];
        if (pnlRange === 'ALL') return metricPoints;

        const now = Date.now();
        const rangeMs =
            pnlRange === '1H' ? 60 * 60 * 1000 : pnlRange === '6H' ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        const cutoff = now - rangeMs;
        const rows = metricPoints.filter((p) => {
            const ts = new Date(p.timestamp).getTime();
            return Number.isFinite(ts) && ts >= cutoff;
        });
        return rows.length > 1 ? rows : metricPoints;
    }, [metricPoints, pnlRange]);

    const pnlTrendPoints = useMemo(
        () =>
            filteredMetricPoints.map((p) => ({
                t: p.timestamp,
                v: Number(p.totalPnl ?? 0),
            })),
        [filteredMetricPoints],
    );
    const pnlTrendDelta =
        pnlTrendPoints.length >= 2
            ? (pnlTrendPoints[pnlTrendPoints.length - 1]?.v ?? 0) - (pnlTrendPoints[0]?.v ?? 0)
            : detail?.totalPnl ?? 0;
    const pnlTrendPositive = pnlTrendDelta >= 0;

    return (
        <LayoutShell>
            <div className="space-y-5">
                <div className="panel p-5">
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-[220px] flex-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Wallet</label>
                            <select className="input mt-1" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
                                {wallets.map((w) => (
                                    <option key={w.id} value={w.id}>{w.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="w-40">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Starting Cash</label>
                            <input className="input mt-1" value={startingCash} onChange={(e) => setStartingCash(e.target.value)} />
                        </div>
                        <div className="w-44">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Copy Ratio</label>
                            <select className="input mt-1" value={copyRatio} onChange={(e) => setCopyRatio(e.target.value as '1' | '0.5' | '0.25')}>
                                <option value="1">1x</option>
                                <option value="0.5">0.5x</option>
                                <option value="0.25">0.25x</option>
                            </select>
                        </div>
                        <div className="w-44">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Min Notional</label>
                            <input className="input mt-1" value={minNotional} onChange={(e) => setMinNotional(e.target.value)} placeholder="0" />
                        </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-3 rounded border border-slate-800/50 bg-slate-900/30 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Latency Profile</p>
                        <span
                            className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold ${latencyProfile?.profile === 'TURBO'
                                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                : 'border-slate-700 bg-slate-800/60 text-slate-300'
                                }`}
                        >
                            {latencyProfile?.profile ?? 'UNKNOWN'}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                className="btn-muted text-xs"
                                disabled={latencyProfileSaving || latencyProfile?.profile === 'NORMAL'}
                                onClick={() => setLatencyProfileMode('NORMAL')}
                            >
                                Normal
                            </button>
                            <button
                                className="btn-primary h-8 px-3 text-xs"
                                disabled={latencyProfileSaving || latencyProfile?.profile === 'TURBO'}
                                onClick={() => setLatencyProfileMode('TURBO')}
                            >
                                Turbo
                            </button>
                        </div>
                        <p className="text-xs text-slate-500">
                            {latencyProfile
                                ? `Updated ${shortDateTime(latencyProfile.updatedAt)}`
                                : 'Profile status unavailable'}
                        </p>
                    </div>

                    <div className="mt-4 flex flex-wrap items-end gap-3 rounded border border-slate-800/50 bg-slate-900/30 p-4">
                        <div className="w-44">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Slippage Mode</label>
                            <select className="input mt-1 bg-slate-950/50" value={slippageMode} onChange={(e) => setSlippageMode(e.target.value)}>
                                <option value="NONE">None</option>
                                <option value="FIXED_BPS">Fixed BPS</option>
                                <option value="FIXED_PERCENT">Fixed Percent</option>
                                <option value="RANDOM_RANGE">Random Range</option>
                            </select>
                        </div>

                        {slippageMode === 'FIXED_BPS' && (
                            <div className="w-32">
                                <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Penalty (BPS)</label>
                                <input className="input mt-1 bg-slate-950/50" value={slippageValue1} onChange={(e) => setSlippageValue1(e.target.value)} placeholder="e.g. 20" />
                            </div>
                        )}
                        {slippageMode === 'FIXED_PERCENT' && (
                            <div className="w-32">
                                <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Penalty (%)</label>
                                <input className="input mt-1 bg-slate-950/50" value={slippageValue1} onChange={(e) => setSlippageValue1(e.target.value)} placeholder="e.g. 0.5" />
                            </div>
                        )}
                        {slippageMode === 'RANDOM_RANGE' && (
                            <>
                                <div className="w-32">
                                    <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Min (%)</label>
                                    <input className="input mt-1 bg-slate-950/50" value={slippageValue1} onChange={(e) => setSlippageValue1(e.target.value)} placeholder="0.1" />
                                </div>
                                <div className="w-32">
                                    <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Max (%)</label>
                                    <input className="input mt-1 bg-slate-950/50" value={slippageValue2} onChange={(e) => setSlippageValue2(e.target.value)} placeholder="1.0" />
                                </div>
                            </>
                        )}

                        <div className="w-48">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-amber-500/80">Max Adverse Skip (%)</label>
                            <input className="input mt-1 bg-slate-950/50 border-amber-500/20 focus:border-amber-500/50 placeholder-slate-600" value={maxAdverse} onChange={(e) => setMaxAdverse(e.target.value)} placeholder="Optional (e.g. 2.0)" />
                        </div>

                        <div className="w-44">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Latency Drift</label>
                            <select
                                className="input mt-1 bg-slate-950/50"
                                value={driftEnabled ? 'ON' : 'OFF'}
                                onChange={(e) => setDriftEnabled(e.target.value === 'ON')}
                            >
                                <option value="ON">Enabled</option>
                                <option value="OFF">Disabled</option>
                            </select>
                        </div>

                        {driftEnabled && (
                            <>
                                <div className="w-36">
                                    <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Drift Bps/Sec</label>
                                    <input
                                        className="input mt-1 bg-slate-950/50"
                                        value={driftBpsPerSecond}
                                        onChange={(e) => setDriftBpsPerSecond(e.target.value)}
                                        placeholder="e.g. 4"
                                    />
                                </div>
                                <div className="w-36">
                                    <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Max Drift Bps</label>
                                    <input
                                        className="input mt-1 bg-slate-950/50"
                                        value={driftMaxBps}
                                        onChange={(e) => setDriftMaxBps(e.target.value)}
                                        placeholder="e.g. 40"
                                    />
                                </div>
                            </>
                        )}

                        <div className="flex-1"></div>
                        <label className="inline-flex h-10 items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 text-xs text-amber-200">
                            <input
                                type="checkbox"
                                checked={forceStartOnLowConfidence}
                                onChange={(e) => setForceStartOnLowConfidence(e.target.checked)}
                            />
                            Force Start (override confidence gate)
                        </label>
                        <button className="btn-primary h-10 px-8" disabled={creating} onClick={createAndStart}>
                            {creating ? 'Starting...' : 'Start Copy Trading ->'}
                        </button>
                    </div>

                    {err && <p className="mt-3 text-sm text-rose-400 font-medium">{err}</p>}

                    {walletId && sourceSummary && sourcePnl && (
                        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-500">Positions Value</p><p className="text-sm font-semibold text-slate-200">{fmtUsd(sourceSummary.positionsValueUsd, 0)}</p></div>
                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-500">Net PnL (All Time)</p><p className={`text-sm font-semibold ${pnlClass(sourcePnl.netPnl)}`}>{fmtPnl(sourcePnl.netPnl)}</p></div>
                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-500">Win Rate</p><p className="text-sm font-semibold text-slate-200">{((sourcePnl.winRatePct ?? sourcePnl.winRate * 100)).toFixed(1)}%</p></div>
                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-500">Trades</p><p className="text-sm font-semibold text-slate-200">{sourcePnl.tradeCount}</p></div>
                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-500">Source Realized (Gross)</p><p className={`text-sm font-semibold ${pnlClass(sourceTracked?.totals.realizedPnlGross ?? 0)}`}>{fmtPnl(sourceTracked?.totals.realizedPnlGross ?? 0)}</p></div>
                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-500">Source Fee Coverage</p><p className="text-sm font-semibold text-slate-200">{(sourceTracked?.knowability.feeCoveragePct ?? 0).toFixed(1)}%</p></div>
                        </div>
                    )}
                </div>

                <div className="panel p-4">
                    <h3 className="mb-3 text-sm font-semibold text-slate-200">Sessions</h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-800/60 text-[10px] uppercase tracking-wider text-slate-500">
                                    <th className="py-2 text-left">Wallet</th><th className="py-2 text-right">Status</th><th className="py-2 text-right">Cash</th><th className="py-2 text-right">Net P&amp;L</th><th className="py-2 text-right">Return%</th><th className="py-2 text-right">Win Rate</th><th className="py-2 text-right">Started</th><th className="py-2 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/30">
                                {sessions.map((s) => (
                                    <tr key={s.id} onClick={() => setActiveSessionId(s.id)} className={`cursor-pointer transition hover:bg-slate-800/20 ${activeSessionId === s.id ? 'bg-slate-800/25' : ''}`}>
                                        <td className="py-2 text-slate-200">{s.trackedWalletLabel}</td>
                                        <td className="py-2 text-right"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${s.status === 'RUNNING' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : s.status === 'PAUSED' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-slate-500/15 text-slate-300 border-slate-500/30'}`}>{s.status}</span></td>
                                        <td className="py-2 text-right text-slate-300">{fmtUsd(s.currentCash, 0)}</td>
                                        <td className={`py-2 text-right font-semibold ${pnlClass(s.totalPnl)}`}>{fmtPnl(s.totalPnl)}</td>
                                        <td className={`py-2 text-right font-semibold ${pnlClass(s.returnPct)}`}>{fmtPct(s.returnPct)}</td>
                                        <td className="py-2 text-right text-slate-300">{s.winRate != null ? `${(s.winRate * 100).toFixed(1)}%` : s.winRatePct != null ? `${s.winRatePct.toFixed(1)}%` : '-'}</td>
                                        <td className="py-2 text-right text-slate-400">{shortDateTime(s.startedAt)}</td>
                                        <td className="py-2 text-right"><button className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20" onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}>x</button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {detail && selected && (
                    <div className="space-y-4">
                        <div className="panel p-4">
                            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                                <div>
                                    <p className="text-lg font-semibold text-slate-100">{detail.trackedWalletLabel} | Started {shortDateTime(detail.startedAt)}</p>
                                    <p className="text-xs text-slate-400">Running for {formatDuration(runtimeSeconds)}</p>
                                    <p className="text-xs text-slate-400">Active Slippage: <span className="text-slate-200">{slippageLabel(detail)}</span></p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusPill(detail.status)}`}>{detail.status}</span>
                                    {detail.status === 'RUNNING' && <button className="btn-muted text-xs" onClick={() => sessionAction('pause')}>Pause</button>}
                                    {detail.status === 'PAUSED' && <button className="btn-muted text-xs" onClick={() => sessionAction('resume')}>Resume</button>}
                                    {detail.status !== 'COMPLETED' && <button className="btn-muted text-xs text-rose-300" onClick={() => sessionAction('stop')}>Stop</button>}
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8 mb-2">
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Account Value</p>
                                    <p className="mt-1 text-sm font-semibold text-slate-200">{fmtUsd(accountValue, 2)}</p>
                                </div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Cash</p>
                                    <p className="mt-1 text-sm font-semibold text-slate-200">{fmtUsd(detail.currentCash, 0)}</p>
                                </div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Open</p>
                                    <p className="mt-1 text-sm font-semibold text-slate-200">{openCount} positions</p>
                                </div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Net P&amp;L</p>
                                    <p className={`mt-1 text-sm font-semibold flex items-baseline gap-1 ${pnlClass(detail.totalPnl)}`}>
                                        {fmtPnl(detail.totalPnl)} <span className="text-[10px] font-normal opacity-80">({fmtPct(detail.returnPct)})</span>
                                    </p>
                                </div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Unrealized</p>
                                    <p className={`mt-1 text-sm font-semibold ${pnlClass(unrealizedValue)}`}>{fmtPnl(unrealizedValue)}</p>
                                </div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Realized</p>
                                    <p className={`mt-1 text-sm font-semibold ${pnlClass(realizedValue)}`}>{fmtPnl(realizedValue)}</p>
                                </div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Fees</p>
                                    <p className="mt-1 text-sm font-semibold text-slate-300">{fmtUsd(feesPaid)}</p>
                                </div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/40 p-3">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Win Rate</p>
                                    <p className="mt-1 text-sm font-semibold text-slate-200">{closedWinRatePct.toFixed(1)}%</p>
                                </div>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                                <div className="rounded border border-slate-700/50 bg-slate-800/30 p-2 text-xs text-slate-300">Total Trades: <span className="font-semibold text-slate-100">{tradeHistory.totalTrades}</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/30 p-2 text-xs text-slate-300">Buys: <span className="font-semibold text-emerald-300">{tradeHistory.buys}</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/30 p-2 text-xs text-slate-300">Sells: <span className="font-semibold text-amber-300">{tradeHistory.sells}</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/30 p-2 text-xs text-slate-300">Redeems: <span className="font-semibold text-sky-300">{tradeHistory.redeems}</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/30 p-2 text-xs text-slate-300">Uptime: <span className="font-semibold text-slate-100">{formatDuration(runtimeSeconds)}</span></div>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                                <div className="rounded border border-slate-700/50 bg-slate-800/20 p-2 text-xs text-slate-300">Friction Samples: <span className="font-semibold text-slate-100">{friction.samples}</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/20 p-2 text-xs text-slate-300">Avg Latency: <span className="font-semibold text-slate-100">{friction.avgLatencyMs.toFixed(0)} ms</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/20 p-2 text-xs text-slate-300">Avg Slippage: <span className="font-semibold text-amber-300">{friction.avgSlippageBps.toFixed(2)} bps</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/20 p-2 text-xs text-slate-300">Avg Drift: <span className="font-semibold text-sky-300">{friction.avgDriftBps.toFixed(2)} bps</span></div>
                                <div className="rounded border border-slate-700/50 bg-slate-800/20 p-2 text-xs text-slate-300">Avg Total Adverse: <span className="font-semibold text-rose-300">{friction.avgTotalAdverseBps.toFixed(2)} bps</span></div>
                            </div>
                            <div className="mt-3 rounded border border-slate-700/50 bg-slate-900/40 p-3">
                                <div className="mb-2 flex items-center justify-between">
                                    <div>
                                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Net P&amp;L Progress</p>
                                        <p className={`text-sm font-semibold ${pnlClass(pnlTrendDelta)}`}>
                                            {fmtPnl(detail.totalPnl)}
                                            <span className="ml-2 text-[11px] font-normal text-slate-400">
                                                ({filteredMetricPoints.length} points, trend {pnlTrendPositive ? 'up' : 'down'} {fmtPnl(pnlTrendDelta)})
                                            </span>
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <div className="flex overflow-hidden rounded border border-slate-700/60 bg-slate-900/50 text-[10px]">
                                            {(['1H', '6H', '24H', 'ALL'] as PnlRange[]).map((range) => (
                                                <button
                                                    key={range}
                                                    className={`px-2 py-1 ${pnlRange === range ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
                                                    onClick={() => setPnlRange(range)}
                                                >
                                                    {range}
                                                </button>
                                            ))}
                                        </div>
                                        <p className="text-[10px] text-slate-500">Auto-refresh: 10s</p>
                                    </div>
                                </div>
                                <TrendLine points={pnlTrendPoints} isPositive={pnlTrendPositive} />
                            </div>
                            <p className="mt-2 text-[11px] text-slate-500">Last updated: {lastUpdatedSeconds != null ? `${lastUpdatedSeconds}s ago` : '-'}</p>
                        </div>

                        {activeComparison && (
                            <div className="panel p-4">
                                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <p className="text-sm font-semibold text-slate-100">Source Wallet vs Session</p>
                                        <p className="text-xs text-slate-400">
                                            Window {shortDateTime(activeComparison.window.start)} to {shortDateTime(activeComparison.window.end)}
                                        </p>
                                    </div>
                                    <span className="rounded border border-slate-700/60 bg-slate-900/50 px-2 py-1 text-[10px] text-slate-300">
                                        {activeComparison.window.mode}
                                    </span>
                                </div>

                                <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                    <div className="rounded border border-slate-700/60 bg-slate-900/35 p-2">
                                        <label className="text-[10px] uppercase tracking-wider text-slate-500">Alignment</label>
                                        <select
                                            className="input mt-1 h-8 text-xs"
                                            value={comparisonAlignment}
                                            onChange={(e) => setComparisonAlignment(e.target.value as 'SESSION_WINDOW' | 'SHARED_WINDOW')}
                                        >
                                            <option value="SESSION_WINDOW">Per Session Window</option>
                                            <option value="SHARED_WINDOW">Shared Overlap Window</option>
                                        </select>
                                    </div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/35 p-2">
                                        <label className="text-[10px] uppercase tracking-wider text-slate-500">Curve Bucket</label>
                                        <select
                                            className="input mt-1 h-8 text-xs"
                                            value={comparisonCurveBucket}
                                            onChange={(e) => setComparisonCurveBucket(e.target.value as 'RAW' | '5M' | '15M' | '1H')}
                                        >
                                            <option value="RAW">Raw Events</option>
                                            <option value="5M">5m</option>
                                            <option value="15M">15m</option>
                                            <option value="1H">1h</option>
                                        </select>
                                    </div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/35 p-2">
                                        <label className="text-[10px] uppercase tracking-wider text-slate-500">Source Confidence</label>
                                        <select
                                            className="input mt-1 h-8 text-xs"
                                            value={comparisonStrictKnownOnly ? 'STRICT' : 'INFERRED'}
                                            onChange={(e) => setComparisonStrictKnownOnly(e.target.value === 'STRICT')}
                                        >
                                            <option value="INFERRED">Include inferred close events</option>
                                            <option value="STRICT">Strict known-only events</option>
                                        </select>
                                    </div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/35 p-2 text-xs text-slate-300">
                                        <p className="text-[10px] uppercase tracking-wider text-slate-500">Backend Compute</p>
                                        <p className="mt-1">Cache: {sourceComparisons?.compute?.cacheHit ? 'HIT' : 'MISS'}</p>
                                        <p>Fee Coverage: {(sourceComparisons?.sourceKnowability?.feeCoveragePct ?? sourceTracked?.knowability.feeCoveragePct ?? 0).toFixed(1)}%</p>
                                        <p>Strict Mode: {sourceComparisons?.sourceKnowability?.strictKnownOnly ? 'ON' : 'OFF'}</p>
                                        <p>Inferred Events: {(sourceComparisons?.sourceKnowability?.inferredShareEvents ?? 0) + (sourceComparisons?.sourceKnowability?.inferredPriceEvents ?? 0)}</p>
                                        <p>Scan: {sourceComparisons?.sourceKnowability?.scannedEventCount ?? sourceComparisons?.compute?.scannedEventCount ?? 0}/{sourceComparisons?.sourceKnowability?.maxEventCap ?? sourceComparisons?.compute?.maxEventCap ?? 0}</p>
                                    </div>
                                </div>

                                {(sourceHistoryTruncated || sourceComparisonWarnings.length > 0) && (
                                    <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                                        {sourceHistoryTruncated && (
                                            <p>Source history is truncated by event cap. Headline parity metrics may omit older source events.</p>
                                        )}
                                        {sourceComparisonWarnings.map((warning) => (
                                            <p key={`${warning.code}:${warning.message}`}>{warning.message}</p>
                                        ))}
                                    </div>
                                )}

                                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6 mb-3">
                                    <div className="rounded border border-slate-700/60 bg-slate-900/45 p-2 text-xs text-slate-300">Source Net: <span className={`font-semibold ${pnlClass(activeComparison.source.netPnl)}`}>{fmtPnl(activeComparison.source.netPnl)}</span></div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/45 p-2 text-xs text-slate-300">Session Net: <span className={`font-semibold ${pnlClass(activeComparison.session.netPnl)}`}>{fmtPnl(activeComparison.session.netPnl)}</span></div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/45 p-2 text-xs text-slate-300">Gap: <span className={`font-semibold ${pnlClass(activeComparison.gaps.netPnlGap)}`}>{fmtPnl(activeComparison.gaps.netPnlGap)}</span></div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/45 p-2 text-xs text-slate-300">Fee Gap: <span className={`font-semibold ${pnlClass(-activeComparison.gaps.feeGap)}`}>{fmtPnl(-activeComparison.gaps.feeGap)}</span></div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/45 p-2 text-xs text-slate-300">Friction Drag: <span className="font-semibold text-amber-300">{fmtUsd(activeComparison.gaps.frictionDrag)}</span></div>
                                    <div className="rounded border border-slate-700/60 bg-slate-900/45 p-2 text-xs text-slate-300">Gap %: <span className="font-semibold text-slate-100">{activeComparison.gaps.percentGap == null ? '-' : `${activeComparison.gaps.percentGap.toFixed(2)}%`}</span></div>
                                </div>

                                <CompareCurves
                                    curves={[
                                        {
                                            name: 'Source Net PnL',
                                            color: '#22c55e',
                                            points: activeComparison.curves.sourceNetPnl,
                                        },
                                        {
                                            name: 'Session Net PnL',
                                            color: '#38bdf8',
                                            points: activeComparison.curves.sessionNetPnl,
                                        },
                                        {
                                            name: 'Gap (Source - Session)',
                                            color: '#f97316',
                                            points: activeComparison.curves.gap,
                                        },
                                    ]}
                                />

                                <div className="mt-3 rounded border border-slate-700/60 bg-slate-900/35 p-3 text-xs text-slate-300">
                                    <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Underperformance Diagnosis</p>
                                    <p className="font-semibold text-slate-100">{activeComparison.diagnosis.dominantDriver}</p>
                                    <p className="mt-1 text-slate-300">{activeComparison.diagnosis.summary}</p>
                                </div>

                                {sourceComparisons && sourceComparisons.sessions.length > 1 && (
                                    <div className="mt-3 overflow-x-auto">
                                        <table className="w-full text-xs">
                                            <thead>
                                                <tr className="border-b border-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500">
                                                    <th className="py-2 text-left">Session</th>
                                                    <th className="py-2 text-right">Source Net</th>
                                                    <th className="py-2 text-right">Session Net</th>
                                                    <th className="py-2 text-right">Gap</th>
                                                    <th className="py-2 text-right">Friction Drag</th>
                                                    <th className="py-2 text-right">Driver</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-800/25">
                                                {sourceComparisons.sessions.map((row) => (
                                                    <tr key={row.sessionId} className={row.sessionId === activeSessionId ? 'bg-slate-800/20' : ''}>
                                                        <td className="py-2 text-slate-200">{row.sessionId.slice(0, 8)}</td>
                                                        <td className={`py-2 text-right font-semibold ${pnlClass(row.source.netPnl)}`}>{fmtPnl(row.source.netPnl)}</td>
                                                        <td className={`py-2 text-right font-semibold ${pnlClass(row.session.netPnl)}`}>{fmtPnl(row.session.netPnl)}</td>
                                                        <td className={`py-2 text-right font-semibold ${pnlClass(row.gaps.netPnlGap)}`}>{fmtPnl(row.gaps.netPnlGap)}</td>
                                                        <td className="py-2 text-right text-amber-300">{fmtUsd(row.gaps.frictionDrag)}</td>
                                                        <td className="py-2 text-right text-slate-300">{row.diagnosis.dominantDriver}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="panel overflow-hidden">
                            <div className="flex border-b border-slate-800/50">
                                {(['live', 'positions', 'history', 'market-history'] as TabKey[]).map((t) => (
                                    <button key={t} onClick={() => setActiveTab(t)} className={`px-5 py-3 text-xs font-semibold ${activeTab === t ? 'border-b-2 border-blue-400 text-blue-300' : 'text-slate-500 hover:text-slate-300'}`}>
                                        {t === 'live' ? 'Live Feed' : t === 'positions' ? 'Positions' : t === 'market-history' ? 'market-history' : 'History'}
                                    </button>
                                ))}
                            </div>

                            <div className="p-4">
                                {activeTab === 'live' && (
                                    <div className="space-y-3 overflow-x-auto">
                                        <table className="w-full text-xs">
                                            <thead><tr className="border-b border-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500"><th className="py-2 text-left">Type</th><th className="py-2 text-left">Market</th><th className="py-2 text-right">Amount</th><th className="py-2 text-right">Time</th><th className="py-2 text-right">Our Action</th></tr></thead>
                                            <tbody className="divide-y divide-slate-800/25">
                                                {liveFeed.map((item) => (
                                                    <tr key={item.id}>
                                                        <td className="py-2 text-slate-300">{item.eventType}</td>
                                                        <td className="py-2"><p className="max-w-[360px] truncate text-slate-200">{item.market}</p><p className="text-[10px] text-slate-500">{item.outcome ?? '-'} | {item.shares != null ? `${item.shares.toFixed(2)} shares` : '-'}</p></td>
                                                        <td className="py-2 text-right text-slate-300">{item.amountUsd != null ? fmtUsd(item.amountUsd) : '-'}</td>
                                                        <td className="py-2 text-right text-slate-500">{item.relativeTime}</td>
                                                        <td className="py-2 text-right">
                                                            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${item.ourAction === 'COPIED' ? 'bg-emerald-500/15 text-emerald-300' : item.ourAction === 'AUTO_CLOSED' ? ((item.ourPnl ?? 0) >= 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300') : item.ourAction === 'OPEN' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-700/50 text-slate-300'}`}>
                                                                {item.ourAction ?? '-'}{item.ourAction === 'AUTO_CLOSED' ? ` (${fmtPnl(item.ourPnl ?? 0)} event)` : ''}
                                                            </span>
                                                            {item.ourAction === 'AUTO_CLOSED' && item.ourPnlCumulative != null && (
                                                                <p className="mt-1 text-[10px] text-slate-500">
                                                                    cumulative position realized: {fmtPnl(item.ourPnlCumulative)}
                                                                    {item.ourFeeUsd != null ? ` | fee: ${fmtUsd(item.ourFeeUsd)}` : ''}
                                                                </p>
                                                            )}
                                                            {item.ourAction === 'COPIED' && item.ourAmountUsd != null && (
                                                                <p className="mt-1 text-[10px] text-slate-500">
                                                                    our fill: {fmtUsd(item.ourAmountUsd)}
                                                                </p>
                                                            )}
                                                            {item.ourAction === 'COPIED' && (
                                                                <p className="mt-1 text-[10px] text-slate-500">
                                                                    latency: {item.ourLatencyMs != null ? `${item.ourLatencyMs.toFixed(0)}ms` : 'n/a'} | slippage: {item.ourSlippageBps != null ? `${item.ourSlippageBps.toFixed(2)}bps` : 'n/a'} | drift: {item.ourDriftBps != null ? `${item.ourDriftBps.toFixed(2)}bps` : 'n/a'} | total adverse: {item.ourTotalAdverseBps != null ? `${item.ourTotalAdverseBps.toFixed(2)}bps` : 'n/a'}
                                                                </p>
                                                            )}
                                                            {item.ourAction === 'SKIPPED' && item.skipReason && (
                                                                <p className="mt-1 max-w-[260px] truncate text-[10px] text-amber-300/90" title={item.skipReason}>
                                                                    {item.skipReason}
                                                                </p>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {liveFeed.length >= feedLimit && <button className="btn-muted text-xs" onClick={() => setFeedLimit((n) => n + 50)}>Load more</button>}
                                    </div>
                                )}

                                {activeTab === 'positions' && (
                                    <div className="overflow-x-auto">
                                        {openPositionRows.length === 0 ? (
                                            <p className="py-8 text-center text-sm text-slate-500">No open positions.</p>
                                        ) : (
                                            <>
                                                <p className="mb-2 text-xs text-slate-400">{openCount} open positions — Value: {fmtUsd(openValueCanonical)} — Unrealized: <span className={pnlClass(unrealizedValue)}>{fmtPnl(unrealizedValue)}</span></p>
                                                <table className="w-full text-xs">
                                                    <thead>
                                                        <tr className="border-b border-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500">
                                                            <th className="cursor-pointer py-2 text-left" onClick={() => togglePositionSort('market')}>Market{sortLabel('market')}</th>
                                                            <th className="cursor-pointer py-2 text-right" onClick={() => togglePositionSort('outcome')}>Outcome{sortLabel('outcome')}</th>
                                                            <th className="cursor-pointer py-2 text-right" onClick={() => togglePositionSort('shares')}>Shares{sortLabel('shares')}</th>
                                                            <th className="cursor-pointer py-2 text-right" onClick={() => togglePositionSort('entry')}>Entry{sortLabel('entry')}</th>
                                                            <th className="cursor-pointer py-2 text-right" onClick={() => togglePositionSort('mark')}>Mark{sortLabel('mark')}</th>
                                                            <th className="cursor-pointer py-2 text-right" onClick={() => togglePositionSort('value')}>Value{sortLabel('value')}</th>
                                                            <th className="cursor-pointer py-2 text-right" onClick={() => togglePositionSort('pnl')}>P&L{sortLabel('pnl')}</th>
                                                            <th className="cursor-pointer py-2 text-right" onClick={() => togglePositionSort('since')}>Since{sortLabel('since')}</th>
                                                            <th className="py-2 text-right">Close</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-slate-800/25">
                                                        {sortedOpenLots.map((p) => {
                                                            const value = p.netShares * p.currentMarkPrice;
                                                            return (
                                                                <tr key={p.id}>
                                                                    <td className="max-w-[280px] truncate py-2 text-slate-200">{p.marketQuestion ?? p.marketId}</td>
                                                                    <td className="py-2 text-right text-slate-300">{p.outcome}</td>
                                                                    <td className="py-2 text-right text-slate-300">{p.netShares.toFixed(2)}</td>
                                                                    <td className="py-2 text-right text-slate-400">{p.avgEntryPrice.toFixed(3)}</td>
                                                                    <td className="py-2 text-right text-slate-300">{p.currentMarkPrice.toFixed(3)}</td>
                                                                    <td className="py-2 text-right text-slate-300">{fmtUsd(value)}</td>
                                                                    <td className={`py-2 text-right font-semibold ${pnlClass(p.unrealizedPnl)}`}>{fmtPnl(p.unrealizedPnl)}</td>
                                                                    <td className="py-2 text-right text-slate-500">{shortDateTime(p.openedAt)}</td>
                                                                    <td className="py-2 text-right">
                                                                        {p.id ? (
                                                                            <button className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300" onClick={() => forceClose(p.id)}>x</button>
                                                                        ) : (
                                                                            <span className="text-slate-600">-</span>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </>
                                        )}
                                    </div>
                                )}

                                {activeTab === 'history' && (
                                    <div className="space-y-3">
                                        <div className="grid gap-2 sm:grid-cols-5">
                                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-2 text-xs text-slate-300">Total Trades: {historySummary.total}</div>
                                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-2 text-xs text-emerald-300">Won: {historySummary.won}</div>
                                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-2 text-xs text-rose-300">Lost: {historySummary.lost}</div>
                                            <div className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-2 text-xs text-slate-300">Win Rate: {historySummary.winRate.toFixed(1)}%</div>
                                            <div className={`rounded-lg border border-slate-800/50 bg-slate-900/40 p-2 text-xs font-semibold ${pnlClass(historySummary.totalPnl)}`}>Total P&L: {fmtPnl(historySummary.totalPnl)}</div>
                                        </div>
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-xs">
                                                <thead>
                                                    <tr className="border-b border-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500">
                                                        <th className="py-2 text-left">Market</th>
                                                        <th className="py-2 text-right">Outcome</th>
                                                        <th className="py-2 text-right">Entry to Exit</th>
                                                        <th className="py-2 text-right">Shares</th>
                                                        <th className="py-2 text-right">P&amp;L</th>
                                                        <th className="py-2 text-right">Won/Lost</th>
                                                        <th className="py-2 text-right">Closed</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-slate-800/25">
                                                    {closedPositions.map((p) => (
                                                        <tr key={p.id}>
                                                            <td className="max-w-[280px] truncate py-2 text-slate-200">{p.marketQuestion ?? p.marketId}</td>
                                                            <td className="py-2 text-right text-slate-300">{p.outcome}</td>
                                                            <td className="py-2 text-right text-slate-400">{p.avgEntryPrice.toFixed(3)} to {p.currentMarkPrice.toFixed(3)}</td>
                                                            <td className="py-2 text-right text-slate-300">{p.netShares.toFixed(2)}</td>
                                                            <td className={`py-2 text-right font-semibold ${pnlClass(p.realizedPnl)}`}>{fmtPnl(p.realizedPnl)}</td>
                                                            {/* FIX: zero PnL shows EVEN instead of LOST */}
                                                            <td className={`py-2 text-right ${normMoney(p.realizedPnl) > 0 ? 'text-emerald-300' : normMoney(p.realizedPnl) < 0 ? 'text-rose-300' : 'text-slate-400'}`}>{normMoney(p.realizedPnl) > 0 ? 'WON' : normMoney(p.realizedPnl) < 0 ? 'LOST' : 'EVEN'}</td>
                                                            <td className="py-2 text-right text-slate-500">{shortDateTime(p.closedAt)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}
                                {activeTab === 'market-history' && (
                                    <MarketHistoryView sessionId={activeSessionId} />
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </LayoutShell>
    );
}