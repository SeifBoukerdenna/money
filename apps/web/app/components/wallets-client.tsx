'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { AddWalletCard } from './add-wallet-card';

type WalletRow = {
    id: string;
    address: string;
    shortAddress: string;
    label: string;
    enabled: boolean;
    copyEnabled: boolean;
    syncStatus: 'SYNCING' | 'ACTIVE' | 'ERROR' | 'PAUSED' | string;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    totalTrades: number;
    lastPolledAt: string | null;
    nextPollAt: string | null;
    lastActivitySyncAt?: string | null;
    lastPositionsSyncAt?: string | null;
    staleSeconds?: number | null;
    isStale?: boolean;
    mismatchCount?: number;
    latestIngestion?: {
        outcome: 'SUCCESS' | 'PARTIAL' | 'FAILED' | string;
        createdAt: string;
        errorClass: string | null;
        message: string | null;
        summary: {
            fetchedEvents: number;
            insertedActivityEvents: number;
            insertedTradeEvents: number;
            duplicateEvents: number;
            parseErrors: number;
            dbInsertErrors: number;
            decisionEnqueueErrors: number;
        } | null;
    } | null;
};

export function WalletsClient({ initialWallets }: { initialWallets: WalletRow[] }) {
    const [wallets, setWallets] = useState(initialWallets);
    const [query, setQuery] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);

    const filtered = useMemo(() => {
        if (!query.trim()) {
            return wallets;
        }
        const q = query.toLowerCase();
        return wallets.filter((wallet) => wallet.address.toLowerCase().includes(q) || wallet.label.toLowerCase().includes(q));
    }, [wallets, query]);

    async function refresh() {
        const response = await fetch(`${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets`, { cache: 'no-store' });
        const rows = (await response.json()) as WalletRow[];
        setWallets(rows);
    }

    async function toggle(wallet: WalletRow, enabled: boolean) {
        setBusyId(wallet.id);
        try {
            await fetch(`${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets/${wallet.id}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            await refresh();
        } finally {
            setBusyId(null);
        }
    }

    async function remove(wallet: WalletRow) {
        setBusyId(wallet.id);
        try {
            await fetch(`${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets/${wallet.id}`, { method: 'DELETE' });
            await refresh();
        } finally {
            setBusyId(null);
        }
    }

    async function sync(wallet: WalletRow) {
        setBusyId(wallet.id);
        try {
            await fetch(`${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets/${wallet.id}/sync`, { method: 'POST' });
            await refresh();
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="space-y-4">
            <AddWalletCard compact onSuccess={refresh} />

            <div className="panel p-3">
                <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search label or address" />
            </div>

            {filtered.length === 0 && (
                <div className="panel p-8 text-center">
                    <p className="text-base font-medium">No tracked wallets</p>
                    <p className="mt-1 text-sm text-slate-400">Add a Polymarket profile URL above to begin real-time tracking.</p>
                </div>
            )}

            <div className="grid grid-cols-1 gap-3">
                {filtered.map((wallet) => (
                    <div key={wallet.id} className="panel p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold">{wallet.label || wallet.shortAddress}</p>
                                <p className="text-xs text-slate-400">{wallet.address}</p>
                            </div>
                            <StatusBadge status={wallet.syncStatus} />
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-300 md:grid-cols-4">
                            <Info label="Total Trades" value={String(wallet.totalTrades)} />
                            <Info label="Last Sync" value={wallet.lastSyncAt ? new Date(wallet.lastSyncAt).toLocaleString() : '—'} />
                            <Info label="Next Poll" value={wallet.nextPollAt ? new Date(wallet.nextPollAt).toLocaleTimeString() : '—'} />
                            <Info label="Tracking" value={wallet.enabled ? 'Enabled' : 'Paused'} />
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-slate-300 md:grid-cols-4">
                            <Info label="Last Activity Sync" value={wallet.lastActivitySyncAt ? new Date(wallet.lastActivitySyncAt).toLocaleString() : '—'} />
                            <Info label="Last Position Sync" value={wallet.lastPositionsSyncAt ? new Date(wallet.lastPositionsSyncAt).toLocaleString() : '—'} />
                            <Info label="Stale" value={wallet.staleSeconds !== null && wallet.staleSeconds !== undefined ? `${wallet.staleSeconds}s${wallet.isStale ? ' (yes)' : ''}` : '—'} />
                            <Info label="Reconcile Mismatches" value={wallet.mismatchCount !== undefined ? String(wallet.mismatchCount) : '—'} />
                        </div>
                        {wallet.latestIngestion && (
                            <p className="mt-2 text-xs text-slate-400">
                                Ingestion: {wallet.latestIngestion.outcome}
                                {wallet.latestIngestion.errorClass ? ` • ${wallet.latestIngestion.errorClass}` : ''}
                                {wallet.latestIngestion.message ? ` • ${wallet.latestIngestion.message}` : ''}
                            </p>
                        )}
                        {wallet.isStale && (
                            <p className="mt-2 text-xs text-amber-300">Wallet sync appears stale. Last update: {wallet.staleSeconds ?? 'unknown'}s ago.</p>
                        )}
                        {wallet.lastSyncError && <p className="mt-2 text-xs text-rose-300">{wallet.lastSyncError}</p>}

                        <div className="mt-4 flex flex-wrap gap-2">
                            <Link href={`/wallets/${wallet.id}`} className="btn-primary">Open</Link>
                            <button className="btn-muted" disabled={busyId === wallet.id} onClick={() => sync(wallet)}>Sync now</button>
                            <button className="btn-muted" disabled={busyId === wallet.id} onClick={() => toggle(wallet, !wallet.enabled)}>
                                {wallet.enabled ? 'Pause' : 'Enable'}
                            </button>
                            <button className="btn-muted border-rose-700 text-rose-200" disabled={busyId === wallet.id} onClick={() => remove(wallet)}>
                                Remove
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const tone = status === 'ACTIVE' ? 'border-emerald-700 text-emerald-200' : status === 'SYNCING' ? 'border-amber-700 text-amber-200' : status === 'ERROR' ? 'border-rose-700 text-rose-200' : 'border-slate-700 text-slate-200';
    return <span className={`rounded-md border px-2 py-1 text-[11px] font-medium ${tone}`}>{status}</span>;
}

function Info({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-sm">{value}</p>
        </div>
    );
}
