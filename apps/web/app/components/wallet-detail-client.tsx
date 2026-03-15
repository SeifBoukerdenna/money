'use client';

import { useEffect, useMemo, useState } from 'react';

type WalletDetail = {
    id: string;
    address: string;
    label: string;
    syncStatus: string;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    lastActivitySyncAt: string | null;
    lastPositionsSyncAt: string | null;
    lastPolledAt: string | null;
    nextPollAt: string | null;
    staleSeconds: number | null;
    isStale: boolean;
    mismatchCount: number;
    unresolvedGapCount: number;
    latestIngestion: {
        outcome: string;
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
    syncCursor: {
        sourceName: string;
        sourceType: string;
        highWatermarkTimestamp: string | null;
        highWatermarkCursor: string | null;
        overlapWindowSec: number;
        lastSuccessAt: string | null;
        lastFailureAt: string | null;
        lastErrorClass: string | null;
        lagSec: number | null;
        status: string;
        lastFetchedCount: number;
        lastInsertedCount: number;
        lastDuplicateCount: number;
        lastParseErrorCount: number;
        lastInsertErrorCount: number;
    } | null;
    totalTrades: number;
    recentMarkets: Array<{ marketId: string; marketQuestion: string | null; trades: number }>;
};

type ActivityItem = {
    id: string;
    sourceName: string;
    sourceType: string;
    sourceEventId: string | null;
    sourceCursor: string | null;
    sourceTxHash: string | null;
    blockNumber: number | null;
    logIndex: number | null;
    eventType: string;
    eventTimestamp: string;
    marketId: string;
    conditionId: string | null;
    marketQuestion: string | null;
    outcome: string | null;
    side: 'BUY' | 'SELL' | null;
    effectiveSide: 'BUY' | 'SELL' | null;
    price: number | null;
    shares: number | null;
    notional: number | null;
    txHash: string | null;
    orderId: string | null;
    observedAt: string | null;
    provenanceNote: string | null;
};

type PositionItem = {
    id: string;
    conditionId: string;
    title: string;
    slug: string;
    outcome: string;
    size: number;
    avgPrice: number;
    currentPrice: number;
    totalTraded: number;
    amountWon: number;
    pnl: number;
    pnlPercent: number;
    side: 'BUY' | 'SELL' | 'UNKNOWN';
    status: 'OPEN' | 'CLOSED';
    icon: string | null;
    eventSlug: string | null;
    updatedAt: string;
};

export function WalletDetailClient({ walletId }: { walletId: string }) {
    const [detail, setDetail] = useState<WalletDetail | null>(null);
    const [items, setItems] = useState<ActivityItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize] = useState(25);
    const [side, setSide] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
    const [eventType, setEventType] = useState('ALL');
    const [market, setMarket] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [positionStatus, setPositionStatus] = useState<'OPEN' | 'CLOSED'>('OPEN');
    const [positions, setPositions] = useState<PositionItem[]>([]);
    const [positionsLoading, setPositionsLoading] = useState(false);
    const [positionsError, setPositionsError] = useState<string | null>(null);

    async function loadDetail() {
        const response = await fetch(`${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets/${walletId}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(await response.text());
        }
        setDetail((await response.json()) as WalletDetail);
    }

    const query = useMemo(() => {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('pageSize', String(pageSize));
        if (eventType !== 'ALL') params.set('eventType', eventType);
        if (side !== 'ALL') params.set('side', side);
        if (market.trim()) params.set('market', market.trim());
        if (from) params.set('from', new Date(from).toISOString());
        if (to) params.set('to', new Date(to).toISOString());
        return params.toString();
    }, [page, pageSize, side, eventType, market, from, to]);

    async function loadTrades() {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets/${walletId}/activity?${query}`, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(await response.text());
            }
            const payload = (await response.json()) as { items: ActivityItem[]; total: number };
            setItems(payload.items);
            setTotal(payload.total);
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Failed to load activity';
            setError(message);
        } finally {
            setLoading(false);
        }
    }

    async function loadPositions() {
        setPositionsLoading(true);
        setPositionsError(null);
        try {
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000'}/wallets/${walletId}/positions?status=${positionStatus}&limit=50`,
                { cache: 'no-store' },
            );
            if (!response.ok) {
                throw new Error(await response.text());
            }
            const payload = (await response.json()) as { items: PositionItem[] };
            setPositions(payload.items ?? []);
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Failed to load positions';
            setPositionsError(message);
        } finally {
            setPositionsLoading(false);
        }
    }

    useEffect(() => {
        loadDetail().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load wallet'));
    }, [walletId]);

    useEffect(() => {
        loadTrades();
    }, [query]);

    useEffect(() => {
        loadPositions();
    }, [walletId, positionStatus]);

    async function copyAddress() {
        if (!detail?.address) return;
        await navigator.clipboard.writeText(detail.address);
    }

    return (
        <div className="space-y-4">
            {detail && (
                <div className="panel p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <h2 className="text-xl font-semibold">{detail.label || detail.address}</h2>
                            <p className="mt-1 text-xs text-slate-400">{detail.address}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <span className="rounded-md border border-slate-700 px-2 py-1 text-xs">{detail.syncStatus}</span>
                            <button className="btn-muted" onClick={copyAddress}>Copy address</button>
                            <a className="btn-muted" target="_blank" rel="noreferrer" href={`https://polymarket.com/profile/${detail.address}`}>Open on Polymarket</a>
                        </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                        <Info label="Total Trades" value={String(detail.totalTrades)} />
                        <Info label="Last Sync" value={detail.lastSyncAt ? new Date(detail.lastSyncAt).toLocaleString() : '—'} />
                        <Info label="Recent Markets" value={String(detail.recentMarkets.length)} />
                        <Info label="Status" value={detail.syncStatus} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                        <Info label="Last Activity Sync" value={detail.lastActivitySyncAt ? new Date(detail.lastActivitySyncAt).toLocaleString() : '—'} />
                        <Info label="Last Position Sync" value={detail.lastPositionsSyncAt ? new Date(detail.lastPositionsSyncAt).toLocaleString() : '—'} />
                        <Info label="Last Poll" value={detail.lastPolledAt ? new Date(detail.lastPolledAt).toLocaleString() : '—'} />
                        <Info label="Next Poll" value={detail.nextPollAt ? new Date(detail.nextPollAt).toLocaleString() : '—'} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                        <Info label="Stale" value={detail.staleSeconds !== null ? `${detail.staleSeconds}s${detail.isStale ? ' (yes)' : ''}` : '—'} />
                        <Info label="Mismatch Count" value={String(detail.mismatchCount)} />
                        <Info label="Gap Issues" value={String(detail.unresolvedGapCount)} />
                        <Info label="Latest Ingestion" value={detail.latestIngestion?.outcome ?? '—'} />
                        <Info label="Ingestion Error Class" value={detail.latestIngestion?.errorClass ?? '—'} />
                    </div>
                    {detail.syncCursor && (
                        <p className="mt-1 text-xs text-slate-500">
                            source={detail.syncCursor.sourceName} • status={detail.syncCursor.status} • overlap={detail.syncCursor.overlapWindowSec}s • watermark={detail.syncCursor.highWatermarkTimestamp ? new Date(detail.syncCursor.highWatermarkTimestamp).toLocaleString() : '—'} • lag={detail.syncCursor.lagSec ?? '—'}s
                        </p>
                    )}
                    {detail.latestIngestion?.message && (
                        <p className="mt-2 text-xs text-slate-400">{detail.latestIngestion.message}</p>
                    )}
                    {detail.latestIngestion?.summary && (
                        <p className="mt-1 text-xs text-slate-500">
                            fetched={detail.latestIngestion.summary.fetchedEvents} • activity={detail.latestIngestion.summary.insertedActivityEvents} • trades={detail.latestIngestion.summary.insertedTradeEvents} • dup={detail.latestIngestion.summary.duplicateEvents} • parseErr={detail.latestIngestion.summary.parseErrors} • dbErr={detail.latestIngestion.summary.dbInsertErrors}
                        </p>
                    )}
                    {detail.lastSyncError && <p className="mt-2 text-xs text-rose-300">{detail.lastSyncError}</p>}
                </div>
            )}

            <div className="panel p-4">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
                    <select className="input" value={eventType} onChange={(event) => { setPage(1); setEventType(event.target.value); }}>
                        <option value="ALL">All events</option>
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                        <option value="CLOSE">CLOSE</option>
                        <option value="REDEEM">REDEEM</option>
                    </select>
                    <select className="input" value={side} onChange={(event) => { setPage(1); setSide(event.target.value as 'ALL' | 'BUY' | 'SELL'); }}>
                        <option value="ALL">All sides</option>
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                    </select>
                    <input className="input" placeholder="Filter market" value={market} onChange={(event) => { setPage(1); setMarket(event.target.value); }} />
                    <input className="input" type="date" value={from} onChange={(event) => { setPage(1); setFrom(event.target.value); }} />
                    <input className="input" type="date" value={to} onChange={(event) => { setPage(1); setTo(event.target.value); }} />
                    <button className="btn-muted" onClick={() => { setPage(1); loadTrades(); }}>Apply</button>
                </div>
                <p className="mt-3 text-xs text-slate-500">Canonical source-wallet timeline only: this table shows ingested wallet activity events, not copy decisions or simulated ledger executions.</p>
            </div>

            <div className="panel overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-800/70 px-4 py-3">
                    <h3 className="text-sm font-semibold tracking-wide text-slate-300">Positions</h3>
                    <div className="inline-flex rounded-lg border border-slate-700/80 bg-slate-950/50 p-1">
                        <button
                            className={`rounded-md px-3 py-1.5 text-xs ${positionStatus === 'OPEN' ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800'}`}
                            onClick={() => setPositionStatus('OPEN')}
                        >
                            Open
                        </button>
                        <button
                            className={`rounded-md px-3 py-1.5 text-xs ${positionStatus === 'CLOSED' ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800'}`}
                            onClick={() => setPositionStatus('CLOSED')}
                        >
                            Closed
                        </button>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-slate-900/95 text-xs uppercase tracking-wide text-slate-400">
                            <tr>
                                <th className="px-3 py-2">Market</th>
                                <th className="px-3 py-2">Outcome</th>
                                <th className="px-3 py-2">Total Traded</th>
                                <th className="px-3 py-2">Amount Won</th>
                                {positionStatus === 'OPEN' && <th className="px-3 py-2">Current</th>}
                                {positionStatus === 'OPEN' && <th className="px-3 py-2">Size</th>}
                                <th className="px-3 py-2">PnL</th>
                                <th className="px-3 py-2">Updated</th>
                            </tr>
                        </thead>
                        <tbody>
                            {positions.map((position) => (
                                <tr key={position.id} className="border-t border-slate-800/70">
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-2">
                                            {position.icon && <img src={position.icon} alt="" className="h-5 w-5 rounded-full" />}
                                            <div>
                                                <div className="font-medium">{position.title}</div>
                                                <div className="text-xs text-slate-500">{position.conditionId}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2">{position.outcome}</td>
                                    <td className="px-3 py-2">${position.totalTraded.toFixed(2)}</td>
                                    <td className="px-3 py-2">${position.amountWon.toFixed(2)}</td>
                                    {positionStatus === 'OPEN' && <td className="px-3 py-2">{position.currentPrice.toFixed(3)}</td>}
                                    {positionStatus === 'OPEN' && <td className="px-3 py-2">{position.size.toFixed(2)}</td>}
                                    <td className={`px-3 py-2 ${position.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                                        ${position.pnl.toFixed(2)} ({position.pnlPercent.toFixed(2)}%)
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-400">{new Date(position.updatedAt).toLocaleString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {positionsLoading && <p className="p-3 text-sm text-slate-400">Loading positions…</p>}
                {positionsError && <p className="p-3 text-sm text-rose-300">{positionsError}</p>}
                {!positionsLoading && !positionsError && positions.length === 0 && (
                    <p className="p-3 text-sm text-slate-400">No {positionStatus.toLowerCase()} positions found.</p>
                )}
            </div>

            <div className="panel overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="sticky top-0 z-10 bg-slate-900/95 text-xs uppercase tracking-wide text-slate-400 backdrop-blur">
                            <tr>
                                <th className="px-3 py-2">Timestamp</th>
                                <th className="px-3 py-2">Event Type</th>
                                <th className="px-3 py-2">Market</th>
                                <th className="px-3 py-2">Outcome</th>
                                <th className="px-3 py-2">Side</th>
                                <th className="px-3 py-2">Price</th>
                                <th className="px-3 py-2">Shares</th>
                                <th className="px-3 py-2">Notional</th>
                                <th className="px-3 py-2">Tx Hash</th>
                                <th className="px-3 py-2">Provenance</th>
                                <th className="px-3 py-2">Trace</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((trade) => (
                                <tr key={trade.id} className="border-t border-slate-800/70">
                                    <td className="px-3 py-2">{new Date(trade.eventTimestamp).toLocaleString()}</td>
                                    <td className="px-3 py-2">{trade.eventType}</td>
                                    <td className="px-3 py-2">
                                        <div className="font-medium">{trade.marketQuestion || trade.marketId}</div>
                                        <div className="text-xs text-slate-500">{trade.marketId}</div>
                                    </td>
                                    <td className="px-3 py-2">{trade.outcome ?? '—'}</td>
                                    <td className="px-3 py-2">{trade.side ?? '—'}</td>
                                    <td className="px-3 py-2">{trade.price !== null ? trade.price.toFixed(4) : '—'}</td>
                                    <td className="px-3 py-2">{trade.shares !== null ? trade.shares.toFixed(2) : '—'}</td>
                                    <td className="px-3 py-2">{trade.notional !== null ? trade.notional.toFixed(2) : '—'}</td>
                                    <td className="px-3 py-2 text-xs text-slate-400">
                                        {trade.txHash ? (
                                            <a
                                                className="text-sky-300 hover:text-sky-200"
                                                target="_blank"
                                                rel="noreferrer"
                                                href={`https://polygonscan.com/tx/${trade.txHash}`}
                                                title={trade.txHash}
                                            >
                                                {shortId(trade.txHash)}
                                            </a>
                                        ) : (
                                            '—'
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-400">
                                        <div className="flex flex-col gap-1">
                                            <span>{trade.sourceName}</span>
                                            <span>{trade.sourceType}</span>
                                            {trade.provenanceNote && <span className="text-slate-500">{trade.provenanceNote}</span>}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-400">
                                        <div className="flex flex-col gap-1">
                                            {trade.orderId && (
                                                <a
                                                    className="text-sky-300 hover:text-sky-200"
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    href={`https://polygonscan.com/search?f=0&q=${encodeURIComponent(trade.orderId)}`}
                                                    title={trade.orderId}
                                                >
                                                    order: {shortId(trade.orderId)}
                                                </a>
                                            )}
                                            {trade.sourceEventId && <span>src: {shortId(trade.sourceEventId)}</span>}
                                            {trade.sourceCursor && <span>cursor: {shortId(trade.sourceCursor)}</span>}
                                            {!trade.orderId && !trade.sourceEventId && !trade.sourceCursor && <span>—</span>}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {loading && <p className="p-3 text-sm text-slate-400">Loading trades…</p>}
                {error && <p className="p-3 text-sm text-rose-300">{error}</p>}
                {!loading && !error && items.length === 0 && <p className="p-3 text-sm text-slate-400">No source wallet events tracked yet.</p>}

                <div className="flex items-center justify-between border-t border-slate-800/70 px-3 py-2 text-xs text-slate-400">
                    <p>Total {total}</p>
                    <div className="flex gap-2">
                        <button className="btn-muted px-2 py-1" disabled={page <= 1} onClick={() => setPage((v) => Math.max(1, v - 1))}>Prev</button>
                        <span className="px-2 py-1">Page {page}</span>
                        <button className="btn-muted px-2 py-1" disabled={page * pageSize >= total} onClick={() => setPage((v) => v + 1)}>Next</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function Info({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-sm">{value}</p>
        </div>
    );
}

function shortId(value: string) {
    if (value.length <= 16) return value;
    return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
