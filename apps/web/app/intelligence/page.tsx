import { LayoutShell } from '../components/layout-shell';
import { apiFetch } from '../lib/api';

type IntelligencePayload = {
    leaderboard: Array<{
        walletId: string;
        wallet: string;
        label: string;
        trades: number;
        winRate: number;
        profit: number;
        sharpeLike: number;
    }>;
    whaleAlerts: Array<{
        id: string;
        marketId: string;
        side: 'BUY' | 'SELL';
        notionalUsd: string | number;
        wallet: { label: string; address: string };
    }>;
    clusterSignals: Array<{
        id: string;
        marketId: string;
        side: 'BUY' | 'SELL';
        thresholdWallets: number;
        windowSeconds: number;
    }>;
    sentiment: Array<{
        marketId: string;
        netSentimentScore: number;
        uniqueWallets: number;
    }>;
    activeMarkets: Array<{
        marketId: string;
        _count: { marketId: number };
    }>;
};

type ScorecardsPayload = {
    methodology: {
        version: string;
        confidence: string;
        score: string;
    };
    rows: Array<{
        walletId: string;
        label: string;
        wallet: string;
        totalTrades: number;
        winRate: number;
        sharpeLike: number;
        realizedPnl: number;
        maxDrawdown: number;
        confidence: number;
        recencyHours: number;
        compositeScore: number;
        snapshotAt: string;
    }>;
};

type SystemAlert = {
    id: string;
    alertType: string;
    severity: string;
    title: string;
    message: string;
    count: number;
    lastSeenAt: string;
    wallet: { label: string; address: string } | null;
    session: { id: string; status: string } | null;
};

export default async function IntelligencePage() {
    const [data, scorecards, systemAlerts] = await Promise.all([
        apiFetch<IntelligencePayload>('/dashboard/intelligence').catch(
            () =>
                ({
                    leaderboard: [],
                    whaleAlerts: [],
                    clusterSignals: [],
                    sentiment: [],
                    activeMarkets: [],
                }) as IntelligencePayload,
        ),
        apiFetch<ScorecardsPayload>('/intelligence/scorecards?limit=10').catch(
            () =>
                ({
                    methodology: {
                        version: 'unavailable',
                        confidence: 'unavailable',
                        score: 'unavailable',
                    },
                    rows: [],
                }) as ScorecardsPayload,
        ),
        apiFetch<SystemAlert[]>('/alerts/system?status=OPEN&limit=12').catch(() => [] as SystemAlert[]),
    ]);

    return (
        <LayoutShell>
            <section className="card mb-4">
                <h2 className="mb-2 text-lg font-semibold">Wallet Intelligence Scorecards</h2>
                <p className="mb-3 text-xs text-slate-400">
                    Composite score is confidence-weighted to avoid over-trusting tiny samples.
                </p>
                <div className="mb-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-400">
                    <p>Method: {scorecards.methodology.score}</p>
                    <p>Confidence: {scorecards.methodology.confidence}</p>
                </div>
                {scorecards.rows.length === 0 && (
                    <p className="text-sm text-slate-400">No scorecards yet. Wait for wallet analytics snapshots.</p>
                )}
                <div className="space-y-2">
                    {scorecards.rows.map((row, idx) => (
                        <div key={row.walletId} className="rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                                <p className="font-medium text-slate-100">
                                    #{idx + 1} {row.label}
                                </p>
                                <p className="text-slate-300">Score {row.compositeScore.toFixed(3)}</p>
                            </div>
                            <p className="text-slate-500">{row.wallet}</p>
                            <p className="mt-1 text-xs text-slate-400">
                                Confidence {(row.confidence * 100).toFixed(1)}% • Trades {row.totalTrades} • Win {(row.winRate * 100).toFixed(1)}% • Sharpe-like {row.sharpeLike.toFixed(2)} • PnL {row.realizedPnl.toFixed(2)}
                            </p>
                        </div>
                    ))}
                </div>
            </section>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Top Wallets (Latest Snapshot)</h2>
                    {data.leaderboard.length === 0 && (
                        <p className="text-sm text-slate-400">No leaderboard snapshots available yet.</p>
                    )}
                    {data.leaderboard.slice(0, 8).map((row) => (
                        <div key={row.walletId} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.label}</div>
                            <div className="text-slate-400">{row.wallet}</div>
                            <div className="text-slate-300">
                                PnL {row.profit.toFixed(2)} • Win {(row.winRate * 100).toFixed(1)}%
                            </div>
                        </div>
                    ))}
                </section>

                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Recent Whale Alerts</h2>
                    {data.whaleAlerts.length === 0 && (
                        <p className="text-sm text-slate-400">No whale alerts yet.</p>
                    )}
                    {data.whaleAlerts.slice(0, 8).map((row) => (
                        <div key={row.id} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.wallet?.label ?? row.wallet?.address ?? 'Unknown wallet'}</div>
                            <div className="text-slate-300">
                                {row.side} {row.marketId} • ${Number(row.notionalUsd).toFixed(2)}
                            </div>
                        </div>
                    ))}
                </section>

                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Cluster Signals</h2>
                    {data.clusterSignals.length === 0 && (
                        <p className="text-sm text-slate-400">No cluster signals detected yet.</p>
                    )}
                    {data.clusterSignals.slice(0, 8).map((row) => (
                        <div key={row.id} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.marketId}</div>
                            <div className="text-slate-300">
                                {row.side} • {row.thresholdWallets}+ wallets / {row.windowSeconds}s
                            </div>
                        </div>
                    ))}
                </section>

                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Market Sentiment</h2>
                    {data.sentiment.length === 0 && (
                        <p className="text-sm text-slate-400">No market sentiment snapshots yet.</p>
                    )}
                    {data.sentiment.slice(0, 8).map((row) => (
                        <div key={row.marketId} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{row.marketId}</div>
                            <div className="text-slate-300">
                                Sentiment {(row.netSentimentScore * 100).toFixed(1)}% • Wallets {row.uniqueWallets}
                            </div>
                        </div>
                    ))}
                </section>

                <section className="card">
                    <h2 className="mb-3 text-lg font-semibold">Open System Alerts</h2>
                    {systemAlerts.length === 0 && (
                        <p className="text-sm text-slate-400">No open platform/session alerts.</p>
                    )}
                    {systemAlerts.map((row) => (
                        <div key={row.id} className="mb-2 rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="flex items-center justify-between gap-2">
                                <p className={`font-medium ${row.severity === 'CRITICAL' ? 'text-rose-300' : row.severity === 'WARN' ? 'text-amber-300' : 'text-slate-100'}`}>
                                    {row.title}
                                </p>
                                <span className="text-[11px] text-slate-500">x{row.count}</span>
                            </div>
                            <p className="text-slate-400">{row.message}</p>
                            <p className="mt-1 text-[11px] text-slate-600">
                                {row.wallet?.label ?? row.wallet?.address ?? 'platform'}
                                {row.session ? ` • session ${row.session.id.slice(0, 8)}` : ''}
                            </p>
                        </div>
                    ))}
                </section>
            </div>
        </LayoutShell>
    );
}
