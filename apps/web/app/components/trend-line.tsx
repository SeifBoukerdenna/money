import { useMemo, useState } from 'react';

type TrendPoint = { t: string; v: number };

function fmtUsd(v: number): string {
    const sign = v > 0 ? '+' : '';
    return `${sign}$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTime(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    return d.toLocaleString();
}

export function TrendLine({ points, isPositive }: { points: TrendPoint[]; isPositive: boolean }) {
    const [hoverIdx, setHoverIdx] = useState<number | null>(null);

    const series = useMemo(() => {
        if (points.length < 2) return null;
        const W = 640;
        const H = 140;
        const PX = 10;
        const PY = 14;
        const vals = points.map((p) => p.v);
        const minV = Math.min(...vals);
        const maxV = Math.max(...vals);
        const rng = maxV === minV ? 1 : maxV - minV;
        const toX = (i: number) => PX + (i / (points.length - 1)) * (W - 2 * PX);
        const toY = (v: number) => H - PY - ((v - minV) / rng) * (H - 2 * PY);
        const xs = points.map((_, i) => toX(i));
        const ys = points.map((p) => toY(p.v));
        const line = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
        const fillPath =
            `M${xs[0]},${H - PY} ` +
            xs.map((x, i) => `L${x},${ys[i]}`).join(' ') +
            ` L${xs[xs.length - 1]},${H - PY} Z`;

        return { W, H, PX, PY, minV, maxV, xs, ys, line, fillPath };
    }, [points]);

    if (!series) return <div className="text-xs text-slate-600">No data for this range.</div>;

    const color = isPositive ? '#22c55e' : '#f43f5e';
    const gradientId = isPositive ? 'pnl-fill-pos' : 'pnl-fill-neg';
    const activeIdx = hoverIdx ?? points.length - 1;
    const activePoint = points[activeIdx]!;
    const activeX = series.xs[activeIdx]!;
    const activeY = series.ys[activeIdx]!;

    return (
        <div className="relative">
            <svg
                viewBox={`0 0 ${series.W} ${series.H}`}
                preserveAspectRatio="none"
                className="h-28 w-full cursor-crosshair"
                onMouseLeave={() => setHoverIdx(null)}
                onMouseMove={(e) => {
                    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
                    const localX = Math.min(Math.max(0, e.clientX - rect.left), rect.width);
                    const ratio = rect.width > 0 ? localX / rect.width : 0;
                    const idx = Math.round(ratio * (points.length - 1));
                    setHoverIdx(Math.min(points.length - 1, Math.max(0, idx)));
                }}
            >
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.35" />
                        <stop offset="100%" stopColor={color} stopOpacity="0.03" />
                    </linearGradient>
                </defs>

                <line x1={series.PX} y1={series.PY} x2={series.W - series.PX} y2={series.PY} stroke="rgba(148,163,184,0.16)" strokeWidth="1" />
                <line x1={series.PX} y1={series.H / 2} x2={series.W - series.PX} y2={series.H / 2} stroke="rgba(148,163,184,0.12)" strokeWidth="1" />
                <line x1={series.PX} y1={series.H - series.PY} x2={series.W - series.PX} y2={series.H - series.PY} stroke="rgba(148,163,184,0.16)" strokeWidth="1" />

                <path d={series.fillPath} fill={`url(#${gradientId})`} />
                <polyline
                    points={series.line}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />

                <line x1={activeX} y1={series.PY} x2={activeX} y2={series.H - series.PY} stroke="rgba(148,163,184,0.32)" strokeWidth="1" strokeDasharray="3 3" />
                <circle cx={activeX} cy={activeY} r="4" fill="#0f172a" stroke={color} strokeWidth="2" />
            </svg>

            <div className="pointer-events-none absolute right-2 top-2 rounded border border-slate-700/60 bg-slate-950/85 px-2 py-1 text-[11px] text-slate-200 shadow">
                <p className="font-semibold" style={{ color }}>{fmtUsd(activePoint.v)}</p>
                <p className="text-[10px] text-slate-400">{fmtTime(activePoint.t)}</p>
            </div>

            <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                <span>min {fmtUsd(series.minV)}</span>
                <span>max {fmtUsd(series.maxV)}</span>
            </div>
        </div>
    );
}
