import { LayoutShell } from '../components/layout-shell';
import { WalletsClient } from '../components/wallets-client';
import { apiFetch } from '../lib/api';

type Wallet = {
    id: string;
    address: string;
    shortAddress: string;
    label: string;
    enabled: boolean;
    copyEnabled: boolean;
    syncStatus: string;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    totalTrades: number;
    lastPolledAt: string | null;
    nextPollAt: string | null;
};

export default async function WalletsPage() {
    const wallets = await apiFetch<Wallet[]>('/wallets').catch(() => [] as Wallet[]);
    return (
        <LayoutShell>
            <div className="space-y-4">
                <div>
                    <h2 className="text-2xl font-semibold tracking-tight">Tracked wallets</h2>
                    <p className="mt-1 text-sm text-slate-400">Monitor real Polymarket trade activity and feed those trades into copy execution.</p>
                </div>
                <WalletsClient initialWallets={wallets} />
            </div>
        </LayoutShell>
    );
}
