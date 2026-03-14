'use client';

import { useState } from 'react';

type Props = {
    compact?: boolean;
    onSuccess?: () => void;
};

export function AddWalletCard({ compact = false, onSuccess }: Props) {
    const [input, setInput] = useState('');
    const [label, setLabel] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    async function submit() {
        setLoading(true);
        setError(null);
        setSuccess(null);
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input, label: label || undefined }),
            });
            if (!response.ok) {
                throw new Error(await response.text());
            }
            const body = (await response.json()) as { created: boolean; message?: string; address: string };
            setSuccess(body.created ? `Tracking started for ${body.address}` : body.message ?? 'Wallet already tracked');
            setInput('');
            setLabel('');
            onSuccess?.();
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Unable to add wallet';
            setError(message);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className={compact ? 'panel p-4' : 'card'}>
            <div className="mb-3">
                <h3 className="text-lg font-semibold">Track a Polymarket wallet</h3>
                <p className="mt-1 text-sm text-slate-400">Paste a profile URL or wallet address to ingest real trade history and monitor new activity.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px_auto]">
                <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    className="input"
                    placeholder="https://polymarket.com/profile/@0x... or 0x..."
                />
                <input
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    className="input"
                    placeholder="Optional label"
                />
                <button disabled={!input || loading} className="btn-primary" onClick={submit}>
                    {loading ? 'Adding...' : 'Add Wallet'}
                </button>
            </div>
            {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
            {success && <p className="mt-3 text-sm text-emerald-300">{success}</p>}
        </div>
    );
}
