'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Area, AreaChart, CartesianGrid, ReferenceLine,
    ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { LayoutShell } from '../components/layout-shell';

const API = process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';
const MAX_CHART_POINTS = 200;
const POLL_INTERVAL = 6000;
const RESOLVED_TOLERANCE = 0.02; // match backend

const FEE_PRESETS = [
    { label: 'Polymarket taker (2%)', feeBps: 200, slippageBps: 20 },
    { label: 'Conservative', feeBps: 200, slippageBps: 50 },
    { label: 'Zero (theoretical)', feeBps: 0, slippageBps: 0 },
] as const;

// Types
type Wallet = { id: string; label: string; address: string; enabled: boolean; syncStatus: string };
type SessionListItem = { id: string; trackedWalletId: string; trackedWalletAddress: string; trackedWalletLabel: string; status: string; startingCash: number; currentCash: number; startedAt: string | null; endedAt: string | null; createdAt: string; lastProcessedEventAt: string | null; totalPnl: number; returnPct: number; netLiquidationValue: number };
type SessionDetail = { id: string; trackedWalletId: string; trackedWalletAddress: string; trackedWalletLabel: string; status: string; startingCash: number; currentCash: number; startedAt: string | null; endedAt: string | null; lastProcessedEventAt: string | null; estimatedSourceExposure: number | null; copyRatio: number | null; netLiquidationValue: number; totalPnl: number; returnPct: number; summarySentence: string; stats: { openPositionsCount: number } };
type Health = { status: string; lastProcessedEventAt: string | null; lagSeconds: number; isStale: boolean; walletSyncStatus: string; walletLastSyncAt: string | null; walletLastSyncError: string | null; walletNextPollAt: string | null; latestSourceEventAt: string | null };
type ChartPoint = { ts: number; label: string; pnlPct: number; pnlAbs: number };
type Position = { id: string; marketId: string; marketQuestion: string | null; outcome: string; netShares: number; avgEntryPrice: number; currentMarkPrice: number; realizedPnl: number; unrealizedPnl: number; status: string; openedAt: string; closedAt: string | null };
type Trade = { id: string; marketId: string; marketUrl?: string; marketQuestion: string | null; outcome: string; side: 'BUY' | 'SELL'; action: string; sourcePrice: number | null; simulatedPrice: number; sourceShares: number | null; simulatedShares: number; notional: number; feeApplied: number; slippageApplied: number; eventTimestamp: string; processedAt: string; reasoning: Record<string, unknown>; sourceEventTimestamp: string | null; sourceTxHash: string | null; sourceTxUrl: string | null; sourceWalletAddress?: string | null };
type SortDir = 'asc' | 'desc';

// Formatters
const fmt$ = (n: number, dp = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtPnl = (n: number) => `${n >= 0 ? '+' : ''}${fmt$(n)}`;
const fmtAge = (iso: string | null | undefined) => { if (!iso) return '—'; const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 0) return 'now'; if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; };
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pnlColor = (n: number) => n > 0.005 ? 'text-emerald-400' : n < -0.005 ? 'text-rose-400' : 'text-slate-400';
const pnlBg = (n: number) => n > 0.005 ? 'bg-emerald-500/10 border-emerald-500/20' : n < -0.005 ? 'bg-rose-500/10 border-rose-500/20' : 'bg-slate-800/50 border-slate-700/50';
const shortAddr = (a: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const pmLink = (mId: string, url?: string) => url ?? `https://polymarket.com/event/${encodeURIComponent(mId)}`;
const isResolved = (mark: number) => mark <= RESOLVED_TOLERANCE || mark >= (1 - RESOLVED_TOLERANCE);

// Status helpers
const RSTYLE = { dot: 'bg-emerald-400 animate-pulse', text: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-500/25' } as const;
const PSTYLE = { dot: 'bg-amber-400', text: 'text-amber-300', bg: 'bg-amber-500/10 border-amber-500/25' } as const;
const DSTYLE = { dot: 'bg-slate-500', text: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/25' } as const;
function sStyle(s: string) { return s === 'RUNNING' ? RSTYLE : s === 'PAUSED' ? PSTYLE : DSTYLE; }

function sortedBy<T>(items: T[], key: string, dir: SortDir): T[] {
    return [...items].sort((a, b) => { const av = (a as Record<string, unknown>)[key]; const bv = (b as Record<string, unknown>)[key]; if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1; const c = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number); return dir === 'asc' ? c : -c; });
}

// Micro-components
function StatusPill({ status, isStale = false }: { status: string; isStale?: boolean }) { const st = sStyle(status); if (isStale && status === 'RUNNING') return <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-300"><span className="h-2 w-2 rounded-full bg-rose-400 animate-pulse" /> STALE</span>; return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${st.bg} ${st.text}`}><span className={`h-2 w-2 rounded-full ${st.dot}`} /> {status}</span>; }
function KPI({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) { return <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p><p className={`mt-0.5 text-lg font-bold tabular-nums ${accent ?? 'text-slate-100'}`}>{value}</p>{sub && <p className="mt-0.5 text-[10px] text-slate-600">{sub}</p>}</div>; }
function Pill({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick?: () => void }) { return <button onClick={onClick} className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${active ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/30' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'}`}>{children}</button>; }
function SortTh({ label, sk, cur, dir, onSort, left }: { label: string; sk: string; cur: string; dir: SortDir; onSort: (k: string) => void; left?: boolean }) { return <th className={`py-2 ${left ? 'text-left' : 'text-right'} pr-3 font-semibold cursor-pointer select-none hover:text-slate-300`} onClick={() => onSort(sk)}>{label}{cur === sk ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>; }

function SessionSidebar({ sessions, activeId, onSelect }: { sessions: SessionListItem[]; activeId: string; onSelect: (id: string) => void }) { if (!sessions.length) return <p className="px-4 py-8 text-center text-sm text-slate-600">No sessions.</p>; return <div className="space-y-1.5">{sessions.map(s => <button key={s.id} onClick={() => onSelect(s.id)} className={`w-full rounded-xl border px-3.5 py-2.5 text-left transition-all ${s.id === activeId ? 'border-blue-500/30 bg-blue-500/8 ring-1 ring-blue-500/20' : 'border-transparent hover:bg-slate-800/40'}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-slate-200">{s.trackedWalletLabel}</span><StatusPill status={s.status} /></div><div className="mt-1.5 flex items-center gap-3 text-xs"><span className="text-slate-500">{fmt$(s.startingCash, 0)}</span><span className={`font-semibold tabular-nums ${pnlColor(s.totalPnl)}`}>{fmtPnl(s.totalPnl)}</span></div></button>)}</div>; }

function HealthBar({ health, walletAddress }: { health: Health | null; walletAddress: string }) { if (!health) return null; return <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border px-4 py-2.5 text-xs ${health.isStale || health.walletLastSyncError ? 'border-amber-500/25 bg-amber-500/5' : 'border-slate-800/60 bg-slate-900/40'}`}><span className="text-slate-500">Wallet: <a href={`https://polymarket.com/portfolio/${walletAddress}`} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{shortAddr(walletAddress)}</a></span><span className="text-slate-500">Sync: <span className={health.walletSyncStatus === 'ACTIVE' ? 'text-emerald-400' : 'text-amber-300'}>{health.walletSyncStatus}</span></span><span className="text-slate-500">Lag: <span className={health.isStale ? 'text-rose-400 font-semibold' : 'text-slate-400'}>{health.lagSeconds}s</span></span>{health.walletLastSyncError && <span className="text-rose-400 truncate max-w-xs">⚠ {health.walletLastSyncError}</span>}</div>; }

function ActionButtons({ detail, actionLoading, act, repairSession, reconcilePositions, closeResolved, repairLoading, onDelete, resolvedCount }: { detail: SessionDetail; actionLoading: string; act: (a: 'start' | 'pause' | 'resume' | 'stop') => void; repairSession: () => void; reconcilePositions: () => void; closeResolved: () => void; repairLoading: boolean; onDelete: () => void; resolvedCount: number }) {
    const [help, setHelp] = useState(false);
    return <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
            {detail.status === 'PAUSED' && <button onClick={() => act(detail.startedAt ? 'resume' : 'start')} disabled={!!actionLoading} className="btn-primary text-xs">{actionLoading === 'start' || actionLoading === 'resume' ? '…' : detail.startedAt ? '▶ Resume' : '▶ Start'}</button>}
            {detail.status === 'RUNNING' && <><button onClick={() => act('pause')} disabled={!!actionLoading} className="btn-muted text-xs">⏸ Pause</button><button onClick={() => act('stop')} disabled={!!actionLoading} className="btn-muted text-xs text-rose-300">⏹ Stop</button></>}
            <button onClick={repairSession} disabled={repairLoading} className="btn-muted text-xs text-amber-300/80">🔧 Repair</button>
            <button onClick={reconcilePositions} disabled={repairLoading} className="btn-muted text-xs text-blue-400/80">🔄 Reconcile</button>
            {resolvedCount > 0 && <button onClick={closeResolved} disabled={repairLoading} className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition">⚡ Close {resolvedCount} Resolved</button>}
            <button onClick={onDelete} className="btn-muted text-xs text-slate-500 hover:text-rose-400">🗑</button>
            <button onClick={() => setHelp(!help)} className="btn-muted text-xs text-slate-500">❓</button>
        </div>
        {help && <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-3 text-xs text-slate-400 space-y-1.5">
            <p><strong className="text-slate-300">▶ Start/Resume</strong> — Begin copying. Bootstraps on first start.</p>
            <p><strong className="text-slate-300">⏸ Pause / ⏹ Stop</strong> — Pause temporarily or end permanently.</p>
            <p><strong className="text-slate-300">🔧 Repair</strong> — Recalculates cash + positions from trade log.</p>
            <p><strong className="text-slate-300">🔄 Reconcile</strong> — Checks Polymarket chain for closed markets our poller missed.</p>
            <p><strong className="text-emerald-300">⚡ Close Resolved</strong> — Closes positions where the mark price is ~0 or ~1, meaning the market has resolved. This is the fastest way to settle expired markets.</p>
            <p><strong className="text-slate-300">🗑 Delete</strong> — Permanently deletes this session.</p>
        </div>}
    </div>;
}

// Activity Timeline
function ActivityTimeline({ trades }: { trades: Trade[] }) {
    const recent = trades.slice(0, 30);
    if (!recent.length) return <p className="py-6 text-center text-sm text-slate-600">No activity yet.</p>;
    return <div className="relative space-y-0"><div className="absolute left-4 top-2 bottom-2 w-px bg-slate-800/60" />
        {recent.map(t => {
            const isB = t.action === 'BOOTSTRAP'; const isR = t.action === 'RECONCILE_CLOSE' || t.action === 'FORCE_CLOSE' || t.action === 'AUTO_CLOSE_RESOLVED'; const isBuy = t.side === 'BUY';
            const icon = isB ? '📦' : isR ? '🔄' : isBuy ? '🟢' : '🔴';
            const verb = isB ? 'Bootstrapped' : isR ? 'Closed (resolved)' : isBuy ? 'Bought' : 'Sold';
            const hasSrc = t.sourceShares != null && !isB;
            return <div key={t.id} className="relative pl-10 py-3 border-b border-slate-800/20 last:border-0">
                <div className="absolute left-2.5 top-4 text-[10px]">{icon}</div>
                {hasSrc && <div className="text-[11px] text-slate-500 mb-1">
                    <span className="text-slate-600">Tracked wallet {isBuy ? 'bought' : 'sold'}</span> <span className="font-mono text-slate-400">{t.sourceShares?.toFixed(1)}</span> shares of <span className="text-slate-400">{t.outcome}</span> @ <span className="font-mono text-slate-400">{t.sourcePrice?.toFixed(3)}</span>
                    {t.sourceTxUrl && <> · <a href={t.sourceTxUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">tx↗</a></>}
                </div>}
                <div className="text-xs">
                    <span className={`font-semibold ${isBuy ? 'text-emerald-300' : isR ? 'text-amber-300' : 'text-rose-300'}`}>{hasSrc ? '→ We copied: ' : ''}{verb} {t.simulatedShares.toFixed(1)} shares</span> <span className="text-slate-500">of</span> <span className="text-slate-300">{t.outcome}</span> <span className="text-slate-500">@</span> <span className="font-mono text-slate-300">{t.simulatedPrice.toFixed(3)}</span> <span className="text-slate-600">= {fmt$(t.notional)}</span>
                    {t.feeApplied > 0.001 && <span className="text-amber-500/70"> (fee {fmt$(t.feeApplied)})</span>}
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-600">
                    <a href={pmLink(t.marketId, t.marketUrl)} target="_blank" rel="noreferrer" className="truncate max-w-[300px] hover:text-blue-400 hover:underline">{t.marketQuestion ?? t.marketId}</a>
                    <span className="shrink-0">{fmtTime(t.eventTimestamp)}</span>
                </div>
            </div>;
        })}
    </div>;
}

// Open Positions with force-close per row
function OpenPositionsTable({ positions, trades, sessionId, onForceClose }: { positions: Position[]; trades: Trade[]; sessionId: string; onForceClose: (posId: string) => void }) {
    const [sk, setSk] = useState<string>('unrealizedPnl');
    const [sd, setSd] = useState<SortDir>('desc');
    function toggle(k: string) { if (sk === k) setSd(d => d === 'asc' ? 'desc' : 'asc'); else { setSk(k); setSd('desc'); } }
    const sorted = useMemo(() => sortedBy(positions, sk, sd), [positions, sk, sd]);
    const urlMap = useMemo(() => { const m = new Map<string, string>(); for (const t of trades) { if (t.marketUrl) m.set(t.marketId, t.marketUrl); } return m; }, [trades]);

    if (!positions.length) return <p className="py-10 text-center text-sm text-slate-600">No open positions.</p>;
    const resolvedCount = positions.filter(p => isResolved(p.currentMarkPrice)).length;

    return <div className="space-y-2">
        {resolvedCount > 0 && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-400">⚡ {resolvedCount} position{resolvedCount > 1 ? 's' : ''} appear resolved (mark ≈ 0 or 1). Use the <strong>Close Resolved</strong> button or close individually below.</div>}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500">
            <SortTh label="Market" sk="marketQuestion" cur={sk} dir={sd} onSort={toggle} left />
            <SortTh label="Outcome" sk="outcome" cur={sk} dir={sd} onSort={toggle} />
            <SortTh label="Shares" sk="netShares" cur={sk} dir={sd} onSort={toggle} />
            <SortTh label="Entry" sk="avgEntryPrice" cur={sk} dir={sd} onSort={toggle} />
            <SortTh label="Mark" sk="currentMarkPrice" cur={sk} dir={sd} onSort={toggle} />
            <SortTh label="Value" sk="unrealizedPnl" cur={sk} dir={sd} onSort={toggle} />
            <SortTh label="PnL" sk="unrealizedPnl" cur={sk} dir={sd} onSort={toggle} />
            <th className="py-2 text-right font-semibold">Actions</th>
        </tr></thead><tbody className="divide-y divide-slate-800/25">
                {sorted.map(p => {
                    const val = p.netShares * p.currentMarkPrice;
                    const resolved = isResolved(p.currentMarkPrice);
                    const won = p.currentMarkPrice >= (1 - RESOLVED_TOLERANCE);
                    return <tr key={p.id} className={`transition hover:bg-slate-800/20 ${resolved ? 'bg-amber-500/5' : ''}`}>
                        <td className="max-w-[200px] py-2.5 pr-3">
                            <p className="truncate text-slate-200" title={p.marketQuestion ?? p.marketId}>{p.marketQuestion ?? p.marketId}</p>
                            <p className="text-[10px] text-slate-600">{fmtAge(p.openedAt)}</p>
                            {resolved && <span className={`text-[10px] font-bold ${won ? 'text-emerald-400' : 'text-rose-400'}`}>{won ? '✅ RESOLVED WON' : '❌ RESOLVED LOST'}</span>}
                        </td>
                        <td className="py-2.5 pr-3 text-right"><span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${p.outcome === 'YES' || p.outcome === 'UP' ? 'bg-emerald-500/12 text-emerald-300' : 'bg-rose-500/12 text-rose-300'}`}>{p.outcome}</span></td>
                        <td className="py-2.5 pr-3 text-right font-mono text-slate-300">{p.netShares.toFixed(1)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono text-slate-400">{p.avgEntryPrice.toFixed(3)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono"><span className={resolved ? (won ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold') : p.currentMarkPrice >= p.avgEntryPrice ? 'text-emerald-400' : 'text-rose-400'}>{p.currentMarkPrice.toFixed(3)}</span></td>
                        <td className="py-2.5 pr-3 text-right font-mono text-slate-300">{fmt$(val)}</td>
                        <td className={`py-2.5 pr-3 text-right font-mono font-semibold tabular-nums ${pnlColor(p.unrealizedPnl)}`}>{fmtPnl(p.unrealizedPnl)}</td>
                        <td className="py-2.5 text-right space-x-1">
                            <a href={pmLink(p.marketId, urlMap.get(p.marketId))} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline text-[10px]">View↗</a>
                            <button onClick={() => onForceClose(p.id)} className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-300 hover:bg-rose-500/20 transition" title="Force-close this position at current mark price">Close</button>
                        </td>
                    </tr>;
                })}
            </tbody></table></div>
    </div>;
}

// Closed Positions
function ClosedPositionsTable({ positions, trades }: { positions: Position[]; trades: Trade[] }) {
    const [sk, setSk] = useState<string>('realizedPnl'); const [sd, setSd] = useState<SortDir>('desc');
    function toggle(k: string) { if (sk === k) setSd(d => d === 'asc' ? 'desc' : 'asc'); else { setSk(k); setSd('desc'); } }
    const sorted = useMemo(() => sortedBy(positions, sk, sd), [positions, sk, sd]);
    const urlMap = useMemo(() => { const m = new Map<string, string>(); for (const t of trades) { if (t.marketUrl) m.set(t.marketId, t.marketUrl); } return m; }, [trades]);
    if (!positions.length) return <div className="py-10 text-center space-y-3"><p className="text-sm text-slate-500">No closed positions yet.</p><p className="text-xs text-slate-600 max-w-md mx-auto">Positions close when: the tracked wallet sells all shares, a market resolves (REDEEM), or you click <strong className="text-emerald-400">⚡ Close Resolved</strong> above for markets where mark ≈ 0 or 1.</p></div>;
    return <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500">
        <SortTh label="Market" sk="marketQuestion" cur={sk} dir={sd} onSort={toggle} left />
        <SortTh label="Outcome" sk="outcome" cur={sk} dir={sd} onSort={toggle} />
        <SortTh label="Entry" sk="avgEntryPrice" cur={sk} dir={sd} onSort={toggle} />
        <SortTh label="Exit" sk="currentMarkPrice" cur={sk} dir={sd} onSort={toggle} />
        <SortTh label="PnL" sk="realizedPnl" cur={sk} dir={sd} onSort={toggle} />
        <th className="py-2 text-right font-semibold">Closed</th>
        <th className="py-2 text-right font-semibold">Link</th>
    </tr></thead><tbody className="divide-y divide-slate-800/25">{sorted.map(p => <tr key={p.id} className="transition hover:bg-slate-800/20">
        <td className="max-w-[200px] py-2.5 pr-3"><p className="truncate text-slate-200">{p.marketQuestion ?? p.marketId}</p></td>
        <td className="py-2.5 pr-3 text-right"><span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${p.outcome === 'YES' || p.outcome === 'UP' ? 'bg-emerald-500/12 text-emerald-300' : 'bg-rose-500/12 text-rose-300'}`}>{p.outcome}</span></td>
        <td className="py-2.5 pr-3 text-right font-mono text-slate-400">{p.avgEntryPrice.toFixed(3)}</td>
        <td className="py-2.5 pr-3 text-right font-mono text-slate-400">{p.currentMarkPrice.toFixed(3)}</td>
        <td className={`py-2.5 pr-3 text-right font-mono font-semibold tabular-nums ${pnlColor(p.realizedPnl)}`}>{fmtPnl(p.realizedPnl)}</td>
        <td className="py-2.5 pr-3 text-right text-[11px] text-slate-500">{fmtAge(p.closedAt)}</td>
        <td className="py-2.5 text-right"><a href={pmLink(p.marketId, urlMap.get(p.marketId))} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline text-[10px]">View↗</a></td>
    </tr>)}</tbody></table></div>;
}

// Trade Log
function TradeLog({ trades }: { trades: Trade[] }) {
    const [sk, setSk] = useState<string>('eventTimestamp'); const [sd, setSd] = useState<SortDir>('desc');
    const [fSide, setFSide] = useState<'ALL' | 'BUY' | 'SELL'>('ALL'); const [fAction, setFAction] = useState('ALL'); const [search, setSearch] = useState('');
    function toggle(k: string) { if (sk === k) setSd(d => d === 'asc' ? 'desc' : 'asc'); else { setSk(k); setSd('desc'); } }
    const filtered = useMemo(() => { let r = trades; if (fSide !== 'ALL') r = r.filter(t => t.side === fSide); if (fAction !== 'ALL') r = r.filter(t => t.action === fAction); if (search.trim()) { const q = search.toLowerCase(); r = r.filter(t => (t.marketQuestion ?? t.marketId).toLowerCase().includes(q) || t.outcome.toLowerCase().includes(q)); } return sortedBy(r, sk, sd); }, [trades, fSide, fAction, search, sk, sd]);
    const actions = useMemo(() => [...new Set(trades.map(t => t.action))].sort(), [trades]);
    if (!trades.length) return <p className="py-10 text-center text-sm text-slate-600">No trades.</p>;
    return <div className="space-y-3">
        <div className="flex flex-wrap gap-2"><select className="input text-xs w-auto" value={fSide} onChange={e => setFSide(e.target.value as 'ALL' | 'BUY' | 'SELL')}><option value="ALL">All sides</option><option value="BUY">BUY</option><option value="SELL">SELL</option></select><select className="input text-xs w-auto" value={fAction} onChange={e => setFAction(e.target.value)}><option value="ALL">All actions</option>{actions.map(a => <option key={a} value={a}>{a}</option>)}</select><input className="input text-xs flex-1 min-w-[120px]" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} /><span className="self-center text-[10px] text-slate-600">{filtered.length}/{trades.length}</span></div>
        <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="border-b border-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-2 text-left font-semibold cursor-pointer" onClick={() => toggle('eventTimestamp')}>Time{sk === 'eventTimestamp' ? (sd === 'asc' ? ' ↑' : ' ↓') : ''}</th><th className="py-2 text-left font-semibold">Market</th><th className="py-2 pr-2 text-right font-semibold">Side</th><th className="py-2 pr-2 text-right font-semibold">Action</th>
            <th className="py-2 pr-2 text-right font-semibold" colSpan={2}>Source wallet</th><th className="py-2 pr-2 text-right font-semibold" colSpan={2}>Our copy</th>
            <SortTh label="Cost" sk="notional" cur={sk} dir={sd} onSort={toggle} /><SortTh label="Fee" sk="feeApplied" cur={sk} dir={sd} onSort={toggle} /><th className="py-2 text-right font-semibold">Links</th>
        </tr><tr className="text-[9px] text-slate-600 border-b border-slate-800/30"><th /><th /><th /><th /><th className="py-1 pr-2 text-right">Shares</th><th className="py-1 pr-2 text-right">Price</th><th className="py-1 pr-2 text-right">Shares</th><th className="py-1 pr-2 text-right">Price</th><th /><th /><th /></tr></thead>
            <tbody className="divide-y divide-slate-800/20">{filtered.map(t => <tr key={t.id} className={`transition hover:bg-slate-800/20 ${t.action === 'BOOTSTRAP' ? 'opacity-50' : ''}`}>
                <td className="py-2 pr-2 text-slate-500 whitespace-nowrap">{fmtTime(t.eventTimestamp)}</td>
                <td className="py-2 pr-2 max-w-[160px]"><p className="truncate text-slate-300">{t.marketQuestion ?? t.marketId}</p><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.outcome === 'YES' || t.outcome === 'UP' ? 'bg-emerald-500/12 text-emerald-300' : 'bg-rose-500/12 text-rose-300'}`}>{t.outcome}</span></td>
                <td className="py-2 pr-2 text-right"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.side === 'BUY' ? 'bg-emerald-500/12 text-emerald-300' : 'bg-rose-500/12 text-rose-300'}`}>{t.side}</span></td>
                <td className="py-2 pr-2 text-right text-slate-500">{t.action}</td>
                <td className="py-2 pr-2 text-right font-mono text-slate-500">{t.sourceShares != null ? t.sourceShares.toFixed(1) : '—'}</td>
                <td className="py-2 pr-2 text-right font-mono text-slate-500">{t.sourcePrice != null ? t.sourcePrice.toFixed(3) : '—'}</td>
                <td className="py-2 pr-2 text-right font-mono text-slate-300">{t.simulatedShares.toFixed(1)}</td>
                <td className="py-2 pr-2 text-right font-mono text-slate-300">{t.simulatedPrice.toFixed(3)}</td>
                <td className="py-2 pr-2 text-right font-mono text-slate-400">{fmt$(t.notional)}</td>
                <td className="py-2 pr-2 text-right font-mono text-amber-500/70">{t.feeApplied > 0.001 ? fmt$(t.feeApplied) : '—'}</td>
                <td className="py-2 text-right space-x-1">{t.sourceTxUrl && <a href={t.sourceTxUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">tx↗</a>}{t.marketUrl && <a href={t.marketUrl} target="_blank" rel="noreferrer" className="text-slate-500 hover:underline">mkt↗</a>}</td>
            </tr>)}</tbody></table></div>
    </div>;
}

function CreateSessionForm({ wallets, onCreated, showToast }: { wallets: Wallet[]; onCreated: () => void; showToast: (msg: string, ok?: boolean) => void }) {
    const [wid, setWid] = useState(''); const [bank, setBank] = useState('10000'); const [fee, setFee] = useState('200'); const [slip, setSlip] = useState('20'); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
    useEffect(() => { const f = wallets[0] as Wallet | undefined; if (!wid && f) setWid(f.id); }, [wallets, wid]);
    async function go() { if (!wid) { setErr('Select wallet.'); return; } const c = parseFloat(bank); if (!c || c < 100) { setErr('Min $100.'); return; } setBusy(true); setErr(''); try { const r = await fetch(`${API}/paper-copy-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackedWalletId: wid, startingCash: c, feeBps: parseInt(fee) || 0, slippageBps: parseInt(slip) || 0 }) }); if (!r.ok) { setErr(await r.text()); return; } showToast('Created — click Start.'); onCreated(); } finally { setBusy(false); } }
    return <div className="panel p-5 space-y-4"><h3 className="text-sm font-semibold text-slate-200">New Session</h3><div className="grid gap-3 sm:grid-cols-2"><div><label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Source Wallet</label><select className="input mt-1" value={wid} onChange={e => setWid(e.target.value)}>{wallets.map(w => <option key={w.id} value={w.id}>{w.label} ({shortAddr(w.address)})</option>)}</select></div><div><label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Bankroll ($)</label><input className="input mt-1" type="number" value={bank} onChange={e => setBank(e.target.value)} /></div></div><div><label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Fee Preset</label><div className="mt-1.5 flex flex-wrap gap-2">{FEE_PRESETS.map(p => <button key={p.label} onClick={() => { setFee(String(p.feeBps)); setSlip(String(p.slippageBps)); }} className={`rounded-lg border px-3 py-1.5 text-xs transition ${Number(fee) === p.feeBps && Number(slip) === p.slippageBps ? 'border-blue-500/40 bg-blue-500/10 text-blue-300' : 'border-slate-700/50 text-slate-400 hover:border-slate-600'}`}>{p.label}</button>)}</div></div>{err && <p className="text-xs text-rose-400">{err}</p>}<button onClick={go} disabled={busy} className="btn-primary w-full">{busy ? '…' : 'Create Session'}</button></div>;
}

function EquityChart({ points, mode, setMode, isPositive }: { points: ChartPoint[]; mode: 'pct' | 'abs'; setMode: (m: 'pct' | 'abs') => void; isPositive: boolean }) {
    const ck = mode === 'pct' ? 'pnlPct' : 'pnlAbs';
    const dom = useMemo((): [number, number] => { if (!points.length) return [-1, 1]; const v = points.map(p => p[ck] as number); const mn = Math.min(...v); const mx = Math.max(...v); if (mn === mx) return [mn - 1, mx + 1]; const pd = (mx - mn) * 0.12; return [mn - pd, mx + pd]; }, [points, ck]);
    if (!points.length) return <div className="flex h-44 items-center justify-center rounded-xl border border-slate-800/50 bg-slate-900/30 text-sm text-slate-600">Equity curve appears once trades are copied.</div>;
    const sc = isPositive ? '#10b981' : '#f43f5e';
    return <div className="panel p-4"><div className="mb-3 flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Equity Curve</p><div className="flex gap-1"><Pill active={mode === 'pct'} onClick={() => setMode('pct')}>%</Pill><Pill active={mode === 'abs'} onClick={() => setMode('abs')}>$</Pill></div></div>
        <ResponsiveContainer width="100%" height={180}><AreaChart data={points}><defs><linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={sc} stopOpacity={0.25} /><stop offset="100%" stopColor={sc} stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#1e293b" /><XAxis dataKey="label" tick={{ fill: '#475569', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" /><YAxis domain={dom} tick={{ fill: '#475569', fontSize: 10 }} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => mode === 'pct' ? `${v.toFixed(1)}%` : `$${v.toFixed(0)}`} /><Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, fontSize: 11, color: '#e2e8f0' }} formatter={(v) => { const n = Number(Array.isArray(v) ? v[0] : (v ?? 0)); return [mode === 'pct' ? `${n.toFixed(2)}%` : `$${n.toFixed(2)}`, 'PnL']; }} labelFormatter={(l) => String(l)} /><ReferenceLine y={0} stroke="#334155" strokeDasharray="4 4" /><Area type="monotone" dataKey={ck} stroke={sc} strokeWidth={2} fill="url(#eqG)" dot={false} activeDot={{ r: 3 }} connectNulls /></AreaChart></ResponsiveContainer>
    </div>;
}

// ---------------------------------------------------------------------------
// MAIN PAGE
// ---------------------------------------------------------------------------
export default function SimulationPage() {
    const [wallets, setWallets] = useState<Wallet[]>([]);
    const [sessions, setSessions] = useState<SessionListItem[]>([]);
    const [activeSessionId, setActiveSessionId] = useState('');
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [health, setHealth] = useState<Health | null>(null);
    const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
    const [openPositions, setOpenPositions] = useState<Position[]>([]);
    const [closedPositions, setClosedPositions] = useState<Position[]>([]);
    const [trades, setTrades] = useState<Trade[]>([]);
    const [activeTab, setActiveTab] = useState<'timeline' | 'open' | 'closed' | 'log'>('timeline');
    const [chartMode, setChartMode] = useState<'pct' | 'abs'>('pct');
    const [actionLoading, setActionLoading] = useState('');
    const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [killAllConfirm, setKillAllConfirm] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [repairLoading, setRepairLoading] = useState(false);
    const activeIdRef = useRef(''); const fetchInFlight = useRef(false); const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    useEffect(() => { activeIdRef.current = activeSessionId; }, [activeSessionId]);
    function showToast(msg: string, ok = true) { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000); }

    useEffect(() => { fetch(`${API}/wallets`).then(r => r.ok ? r.json() : []).then((d: Wallet[]) => setWallets(d.filter(w => w.enabled))).catch(() => { /**/ }); }, []);
    const loadSessions = useCallback(async (pref?: string) => { const r = await fetch(`${API}/paper-copy-sessions`).catch(() => null); if (!r?.ok) return; const d: SessionListItem[] = await r.json(); setSessions(d); setActiveSessionId(c => { if (pref) return pref; if (c && d.some(s => s.id === c)) return c; const f = d[0] as SessionListItem | undefined; return f?.id ?? ''; }); }, []);
    useEffect(() => { loadSessions(); }, [loadSessions]);

    const loadDetail = useCallback(async (sid: string) => {
        if (!sid || fetchInFlight.current) return; fetchInFlight.current = true;
        try {
            const [dR, hR, oR, cR, tR, mR] = await Promise.all([fetch(`${API}/paper-copy-sessions/${sid}`), fetch(`${API}/paper-copy-sessions/${sid}/health`), fetch(`${API}/paper-copy-sessions/${sid}/positions?status=OPEN&limit=200`), fetch(`${API}/paper-copy-sessions/${sid}/positions?status=CLOSED&limit=200`), fetch(`${API}/paper-copy-sessions/${sid}/trades?limit=200`), fetch(`${API}/paper-copy-sessions/${sid}/metrics?limit=${MAX_CHART_POINTS}`)]);
            if (sid !== activeIdRef.current) return;
            const dd: SessionDetail | null = dR.ok ? await dR.json() : null; setDetail(dd); setHealth(hR.ok ? await hR.json() : null); setOpenPositions(oR.ok ? await oR.json() : []); setClosedPositions(cR.ok ? await cR.json() : []); setTrades(tR.ok ? await tR.json() : []);
            const md: Array<{ timestamp: string; totalPnl: number }> = mR.ok ? await mR.json() : [];
            if (dd && md.length) { const sc = dd.startingCash || 1; const pts = md.map(m => ({ ts: new Date(m.timestamp).getTime(), label: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), pnlPct: (m.totalPnl / sc) * 100, pnlAbs: m.totalPnl })); if (pts.length > MAX_CHART_POINTS) { const step = Math.ceil(pts.length / MAX_CHART_POINTS); setChartPoints(pts.filter((_, i) => i % step === 0 || i === pts.length - 1)); } else setChartPoints(pts); } else setChartPoints([]);
        } finally { fetchInFlight.current = false; }
    }, []);

    useEffect(() => { if (activeSessionId) loadDetail(activeSessionId); if (pollTimerRef.current) clearInterval(pollTimerRef.current); if (activeSessionId) { pollTimerRef.current = setInterval(() => { if (activeIdRef.current) { loadSessions(); loadDetail(activeIdRef.current); } }, POLL_INTERVAL); } return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); }; }, [activeSessionId, loadDetail, loadSessions]);

    const reload = useCallback(async () => { if (activeSessionId) { await loadSessions(activeSessionId); await loadDetail(activeSessionId); } }, [activeSessionId, loadSessions, loadDetail]);

    async function act(a: 'start' | 'pause' | 'resume' | 'stop') { if (!activeSessionId || actionLoading) return; setActionLoading(a); try { const r = await fetch(`${API}/paper-copy-sessions/${activeSessionId}/${a}`, { method: 'POST' }); if (!r.ok) { showToast(await r.text(), false); return; } showToast({ start: 'Started.', pause: 'Paused.', resume: 'Resumed.', stop: 'Stopped.' }[a]); await reload(); } finally { setActionLoading(''); } }
    async function repairSession() { if (!activeSessionId) return; setRepairLoading(true); try { const r = await fetch(`${API}/paper-copy-sessions/${activeSessionId}/repair`, { method: 'POST' }); if (!r.ok) { showToast('Repair failed.', false); return; } const res = await r.json() as { cashBefore: number; cashAfter: number; positionsFixed: number }; showToast(`Repaired. Cash ${fmt$(res.cashBefore, 0)}→${fmt$(res.cashAfter, 0)}. ${res.positionsFixed} fixed.`); await reload(); } finally { setRepairLoading(false); } }
    async function reconcilePositions() { if (!activeSessionId) return; setRepairLoading(true); try { const r = await fetch(`${API}/paper-copy-sessions/${activeSessionId}/reconcile-positions`, { method: 'POST' }); if (!r.ok) { showToast('Failed.', false); return; } const res = await r.json() as { closedByReconciliation: number; openOnChain: number; openInSim: number }; showToast(res.closedByReconciliation > 0 ? `Closed ${res.closedByReconciliation} via chain check.` : `Chain shows ${res.openOnChain} open. Try "Close Resolved" for expired markets.`); await reload(); } finally { setRepairLoading(false); } }

    async function closeResolved() {
        if (!activeSessionId) return; setRepairLoading(true);
        try {
            const r = await fetch(`${API}/paper-copy-sessions/${activeSessionId}/close-resolved`, { method: 'POST' });
            if (!r.ok) { showToast('Close resolved failed. Did you add the route? See force-close-routes.ts', false); return; }
            const res = await r.json() as { checked: number; closed: number; closedMarkets: string[] };
            if (res.closed > 0) { showToast(`Closed ${res.closed} resolved position(s): ${res.closedMarkets.slice(0, 3).join(', ')}${res.closedMarkets.length > 3 ? '…' : ''}`); } else { showToast(`Checked ${res.checked} positions — none have mark ≈ 0 or 1. Markets may not be resolved yet.`); }
            await reload();
        } finally { setRepairLoading(false); }
    }

    async function forceClosePos(posId: string) {
        if (!activeSessionId) return;
        const r = await fetch(`${API}/paper-copy-sessions/${activeSessionId}/positions/${posId}/force-close`, { method: 'POST' });
        if (!r.ok) { showToast('Force-close failed. Did you add the route?', false); return; }
        const res = await r.json() as { closed: boolean; realizedPnl: number };
        if (res.closed) { showToast(`Closed. PnL: ${fmtPnl(res.realizedPnl)}`); } else { showToast('Position already closed.'); }
        await reload();
    }

    async function killAll() { setKillAllConfirm(false); const r = await fetch(`${API}/paper-copy-sessions/kill-all`, { method: 'POST' }); if (!r.ok) { showToast('Failed.', false); return; } const { stopped } = await r.json() as { stopped: number }; showToast(`Killed ${stopped}.`); await loadSessions(); }
    async function deleteSession(id: string) { setDeleteConfirmId(null); const r = await fetch(`${API}/paper-copy-sessions/${id}`, { method: 'DELETE' }); if (!r.ok) { showToast('Failed.', false); return; } showToast('Deleted.'); if (id === activeSessionId) setActiveSessionId(''); await loadSessions(); }

    const isPositive = (detail?.totalPnl ?? 0) >= 0;
    const totalFees = trades.reduce((s, t) => s + t.feeApplied, 0);
    const totalRealPnl = closedPositions.reduce((s, p) => s + p.realizedPnl, 0) + openPositions.reduce((s, p) => s + p.realizedPnl, 0);
    const totalUnrealPnl = openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const resolvedCount = openPositions.filter(p => isResolved(p.currentMarkPrice)).length;

    return <LayoutShell>
        {toast && <div className={`fixed right-5 top-5 z-50 max-w-sm rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl ${toast.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/30 bg-rose-500/10 text-rose-200'}`}>{toast.msg}</div>}
        <div className="flex gap-5">
            <div className="hidden w-64 shrink-0 lg:block"><div className="sticky top-4 space-y-4"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-300">Sessions</h2><div className="flex gap-1.5"><button onClick={() => setShowCreate(!showCreate)} className="rounded-lg border border-slate-700/50 px-2.5 py-1 text-[10px] font-semibold text-blue-400 hover:bg-blue-500/10">+ New</button>{sessions.some(s => s.status === 'RUNNING') && <button onClick={() => setKillAllConfirm(true)} className="rounded-lg border border-slate-700/50 px-2.5 py-1 text-[10px] font-semibold text-rose-400 hover:bg-rose-500/10">Kill all</button>}</div></div>{showCreate && <CreateSessionForm wallets={wallets} onCreated={() => { setShowCreate(false); loadSessions(); }} showToast={showToast} />}<SessionSidebar sessions={sessions} activeId={activeSessionId} onSelect={setActiveSessionId} /></div></div>

            <div className="min-w-0 flex-1 space-y-4">
                <div className="flex gap-2 lg:hidden"><select className="input flex-1" value={activeSessionId} onChange={e => setActiveSessionId(e.target.value)}>{sessions.map(s => <option key={s.id} value={s.id}>{s.trackedWalletLabel}—{s.status}</option>)}</select><button onClick={() => setShowCreate(!showCreate)} className="btn-primary text-xs px-3">+</button></div>
                {!detail ? <div className="flex h-64 flex-col items-center justify-center text-slate-500">{sessions.length === 0 ? <><p className="text-lg font-medium text-slate-300">No sessions</p><p className="mt-1 text-sm">Create one to start.</p></> : <p className="text-sm">Select a session.</p>}</div> : <>
                    <div className="panel p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><div className="flex items-center gap-3"><h2 className="text-lg font-bold text-slate-100">Copying {detail.trackedWalletLabel}</h2><StatusPill status={detail.status} isStale={health?.isStale ?? false} /></div><p className="text-xs text-slate-500">{detail.startedAt && `Started ${new Date(detail.startedAt).toLocaleString()}`}{detail.copyRatio != null && ` · Ratio: ${(detail.copyRatio * 100).toFixed(0)}%`} · {trades.length} trades · {openPositions.length} open · {closedPositions.length} closed</p></div><ActionButtons detail={detail} actionLoading={actionLoading} act={act} repairSession={repairSession} reconcilePositions={reconcilePositions} closeResolved={closeResolved} repairLoading={repairLoading} onDelete={() => setDeleteConfirmId(detail.id)} resolvedCount={resolvedCount} /></div><div className={`mt-4 rounded-xl border p-4 ${pnlBg(detail.totalPnl)}`}><p className={`text-base font-semibold ${pnlColor(detail.totalPnl)}`}>{detail.summarySentence}</p></div></div>
                    <HealthBar health={health} walletAddress={detail.trackedWalletAddress} />
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                        <div className="panel p-3"><KPI label="Portfolio" value={fmt$(detail.netLiquidationValue, 0)} /></div>
                        <div className="panel p-3"><KPI label="Total PnL" value={fmtPnl(detail.totalPnl)} sub={fmtPct(detail.returnPct)} accent={pnlColor(detail.totalPnl)} /></div>
                        <div className="panel p-3"><KPI label="Realized" value={fmtPnl(totalRealPnl)} sub={closedPositions.length > 0 ? `${closedPositions.length} closed` : `fees: ${fmt$(totalFees)}`} accent={pnlColor(totalRealPnl)} /></div>
                        <div className="panel p-3"><KPI label="Unrealized" value={fmtPnl(totalUnrealPnl)} accent={pnlColor(totalUnrealPnl)} /></div>
                        <div className="panel p-3"><KPI label="Cash" value={fmt$(detail.currentCash, 0)} sub={`of ${fmt$(detail.startingCash, 0)}`} /></div>
                        <div className="panel p-3"><KPI label="Open" value={String(openPositions.length)} sub={resolvedCount > 0 ? `${resolvedCount} resolved` : 'positions'} /></div>
                        <div className="panel p-3"><KPI label="Closed" value={String(closedPositions.length)} sub={closedPositions.length === 0 ? 'try Close Resolved' : 'positions'} /></div>
                    </div>
                    <EquityChart points={chartPoints} mode={chartMode} setMode={setChartMode} isPositive={isPositive} />
                    <div className="panel overflow-hidden"><div className="flex border-b border-slate-800/50 overflow-x-auto">{([{ key: 'timeline' as const, label: '📋 Activity' }, { key: 'open' as const, label: `Open (${openPositions.length})${resolvedCount > 0 ? ` ⚡${resolvedCount}` : ''}` }, { key: 'closed' as const, label: `Closed (${closedPositions.length})` }, { key: 'log' as const, label: `Trades (${trades.length})` }]).map(t => <button key={t.key} onClick={() => setActiveTab(t.key)} className={`whitespace-nowrap px-5 py-3 text-xs font-semibold transition-all ${activeTab === t.key ? 'border-b-2 border-blue-400 text-blue-300' : 'text-slate-500 hover:text-slate-300'}`}>{t.label}</button>)}</div><div className="p-4">
                        {activeTab === 'timeline' && <ActivityTimeline trades={trades} />}
                        {activeTab === 'open' && <OpenPositionsTable positions={openPositions} trades={trades} sessionId={activeSessionId} onForceClose={forceClosePos} />}
                        {activeTab === 'closed' && <ClosedPositionsTable positions={closedPositions} trades={trades} />}
                        {activeTab === 'log' && <TradeLog trades={trades} />}
                    </div></div>
                </>}
            </div>
        </div>
        {killAllConfirm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"><div className="w-full max-w-sm rounded-2xl border border-rose-500/30 bg-[#0c1524] p-6 shadow-2xl"><h3 className="text-base font-semibold text-rose-300">Kill all?</h3><p className="mt-2 text-sm text-slate-400">All running sessions stop.</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => setKillAllConfirm(false)} className="btn-muted text-xs">Cancel</button><button onClick={killAll} className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500">Kill All</button></div></div></div>}
        {deleteConfirmId && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"><div className="w-full max-w-sm rounded-2xl border border-rose-500/30 bg-[#0c1524] p-6 shadow-2xl"><h3 className="text-base font-semibold text-rose-300">Delete?</h3><p className="mt-2 text-sm text-slate-400">All data gone.</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => setDeleteConfirmId(null)} className="btn-muted text-xs">Cancel</button><button onClick={() => deleteSession(deleteConfirmId)} className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500">Delete</button></div></div></div>}
    </LayoutShell>;
}