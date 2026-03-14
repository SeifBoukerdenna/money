import Link from 'next/link';
import { ReactNode } from 'react';

export function LayoutShell({ children }: { children: ReactNode }) {
    const links = [
        { href: '/', label: 'Overview' },
        { href: '/wallets', label: 'Wallets' },
        { href: '/trades', label: 'Trades' },
        { href: '/markets', label: 'Markets' },
        { href: '/intelligence', label: 'Intelligence' },
        { href: '/leaderboard', label: 'Leaderboard' },
        { href: '/simulation', label: 'Simulation' },
        { href: '/stream', label: 'Stream' },
    ];
    return (
        <div className="mx-auto min-h-screen max-w-6xl px-5 py-6">
            <header className="mb-5 rounded-2xl border border-slate-800/70 bg-[#08101d]/85 p-3 backdrop-blur">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-[220px]">
                        <h1 className="text-base font-semibold tracking-tight">Polymarket Tracker</h1>
                        <p className="text-xs text-slate-400">Real wallet activity and copy-trade intelligence</p>
                    </div>
                    <div className="flex min-w-[260px] flex-1 items-center justify-end">
                        <input className="input max-w-sm" placeholder="Search wallets, markets, events" />
                    </div>
                </div>
                <nav className="mt-3 flex flex-wrap gap-1.5">
                    {links.map((link) => (
                        <Link
                            key={link.href}
                            href={link.href}
                            className="rounded-lg border border-slate-700/80 bg-[#0b172a]/70 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                        >
                            {link.label}
                        </Link>
                    ))}
                </nav>
            </header>
            {children}
        </div>
    );
}
