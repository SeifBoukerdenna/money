'use client';

import { useEffect, useState } from 'react';

import { LayoutShell } from '../components/layout-shell';

type EventRow = {
    id: string;
    type: string;
    entityId?: string;
    payload: Record<string, unknown>;
    createdAt: string;
};

export default function StreamPage() {
    const [events, setEvents] = useState<EventRow[]>([]);

    useEffect(() => {
        const base = process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';
        fetch(`${base}/events?limit=100`)
            .then((res) => res.json())
            .then((rows: EventRow[]) => setEvents(rows))
            .catch(() => undefined);

        const wsBase = base.replace('http://', 'ws://').replace('https://', 'wss://');
        const ws = new WebSocket(`${wsBase}/events/ws`);
        ws.onmessage = (message) => {
            try {
                const event = JSON.parse(message.data as string) as EventRow;
                setEvents((current) => [event, ...current].slice(0, 250));
            } catch {
                // ignore malformed event payloads
            }
        };
        return () => ws.close();
    }, []);

    return (
        <LayoutShell>
            <div className="card">
                <h2 className="mb-4 text-xl font-semibold">Unified Event Stream</h2>
                <div className="space-y-2">
                    {events.map((event) => (
                        <div key={event.id} className="rounded-lg border border-slate-800 p-3 text-sm">
                            <div className="font-medium">{event.type}</div>
                            <div className="text-xs text-slate-400">{new Date(event.createdAt).toLocaleString()}</div>
                            <pre className="mt-2 overflow-x-auto text-xs text-slate-300">{JSON.stringify(event.payload, null, 2)}</pre>
                        </div>
                    ))}
                </div>
            </div>
        </LayoutShell>
    );
}
