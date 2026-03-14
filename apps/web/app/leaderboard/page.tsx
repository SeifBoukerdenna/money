import { LayoutShell } from '../components/layout-shell';
import { apiFetch } from '../lib/api';

type LeaderboardRow = {
    walletId: string;
    wallet: string;
    label: string;
    trades: number;
    winRate: number;
    profit: number;
    avgTradeSize: number;
    marketsTraded: number;
    sharpeLike: number;
    tradeAccuracy: number;
};

export default async function LeaderboardPage() {
    const rows = await apiFetch<LeaderboardRow[]>('/leaderboard?sortBy=pnl').catch(() => []);

    return (
        <LayoutShell>
            <div className="card overflow-x-auto">
                <h2 className="mb-4 text-xl font-semibold">Wallet Leaderboard</h2>
                <table className="w-full text-left text-sm">
                    <thead>
                        <tr className="text-slate-400">
                            <th className="py-2">Wallet</th>
                            <th>Trades</th>
                            <th>Win Rate</th>
                            <th>PnL</th>
                            <th>Avg Trade</th>
                            <th>Markets</th>
                            <th>Sharpe-like</th>
                            <th>Accuracy</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.walletId} className="border-t border-slate-800">
                                <td className="py-2">
                                    <div className="font-medium">{row.label}</div>
                                    <div className="text-xs text-slate-500">{row.wallet}</div>
                                </td>
                                <td>{row.trades}</td>
                                <td>{(row.winRate * 100).toFixed(1)}%</td>
                                <td>{row.profit.toFixed(2)}</td>
                                <td>{row.avgTradeSize.toFixed(2)}</td>
                                <td>{row.marketsTraded}</td>
                                <td>{row.sharpeLike.toFixed(2)}</td>
                                <td>{(row.tradeAccuracy * 100).toFixed(1)}%</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </LayoutShell>
    );
}
