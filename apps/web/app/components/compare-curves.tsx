import { useMemo, useState } from 'react';

type CurvePoint = { timestamp: string; value: number };

type CurveInput = {
    name: string;
    color: string;
    points: CurvePoint[];
};

function fmtUsd(v: number): string {
    const abs = Math.abs(v);
    const sign = v > 0 ? '+' : v < 0 ? '-' : '';
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTime(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    return d.toLocaleString();
}

export function CompareCurves({ curves }: { curves: CurveInput[] }) {
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);

    const prepared = useMemo(() => {
        const activeCurves = curves.filter((curve) => curve.points.length > 0);
        if (activeCurves.length === 0) return null;

        const allTimestamps = Array.from(
            new Set(activeCurves.flatMap((curve) => curve.points.map((point) => point.timestamp))),
        ).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

        if (allTimestamps.length < 2) return null;

        const sampleAt = (points: CurvePoint[], timestamp: string): number => {
            let value = points[0]?.value ?? 0;
            for (const point of points) {
                if (new Date(point.timestamp).getTime() <= new Date(timestamp).getTime()) {
                    value = point.value;
                } else {
                    break;
                }
            }
            return value;
        };

        const sampledCurves = activeCurves.map((curve) => ({
            name: curve.name,
            color: curve.color,
            points: allTimestamps.map((timestamp) => ({
                timestamp,
                value: sampleAt(curve.points, timestamp),
            })),
        }));

        const allValues = sampledCurves.flatMap((curve) => curve.points.map((point) => point.value));
        const min = Math.min(...allValues);
        const max = Math.max(...allValues);
        const range = max === min ? 1 : max - min;

        const W = 720;
        const H = 220;
        const PX = 18;
        const PY = 18;

        const toX = (index: number) => PX + (index / (allTimestamps.length - 1)) * (W - 2 * PX);
        const toY = (value: number) => H - PY - ((value - min) / range) * (H - 2 * PY);

        const xPoints = allTimestamps.map((_, index) => toX(index));

        const renderedCurves = sampledCurves.map((curve) => {
            const yPoints = curve.points.map((point) => toY(point.value));
            const polyline = xPoints.map((x, index) => `${x},${yPoints[index]}`).join(' ');
            return {
                ...curve,
                yPoints,
                polyline,
            };
        });

        return {
            W,
            H,
            PX,
            PY,
            min,
            max,
            timestamps: allTimestamps,
            xPoints,
            curves: renderedCurves,
        };
    }, [curves]);

    if (!prepared) {
        return <div className="text-xs text-slate-500">No comparison data available.</div>;
    }

    const activeIndex = hoverIndex ?? prepared.timestamps.length - 1;
    const activeTimestamp = prepared.timestamps[activeIndex] ?? prepared.timestamps.at(-1) ?? '';

    return (
        <div className="space-y-2">
            <svg
                viewBox={`0 0 ${prepared.W} ${prepared.H}`}
                preserveAspectRatio="none"
                className="h-56 w-full cursor-crosshair"
                onMouseLeave={() => setHoverIndex(null)}
                onMouseMove={(event) => {
                    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
                    const localX = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
                    const ratio = rect.width > 0 ? localX / rect.width : 0;
                    const index = Math.round(ratio * (prepared.timestamps.length - 1));
                    setHoverIndex(Math.max(0, Math.min(prepared.timestamps.length - 1, index)));
                }}
            >
                <line x1={prepared.PX} y1={prepared.PY} x2={prepared.W - prepared.PX} y2={prepared.PY} stroke="rgba(148,163,184,0.18)" strokeWidth="1" />
                <line x1={prepared.PX} y1={prepared.H / 2} x2={prepared.W - prepared.PX} y2={prepared.H / 2} stroke="rgba(148,163,184,0.14)" strokeWidth="1" />
                <line x1={prepared.PX} y1={prepared.H - prepared.PY} x2={prepared.W - prepared.PX} y2={prepared.H - prepared.PY} stroke="rgba(148,163,184,0.18)" strokeWidth="1" />

                {prepared.curves.map((curve) => (
                    <polyline
                        key={curve.name}
                        points={curve.polyline}
                        fill="none"
                        stroke={curve.color}
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ))}

                <line
                    x1={prepared.xPoints[activeIndex]}
                    y1={prepared.PY}
                    x2={prepared.xPoints[activeIndex]}
                    y2={prepared.H - prepared.PY}
                    stroke="rgba(148,163,184,0.35)"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                />

                {prepared.curves.map((curve) => (
                    <circle
                        key={`${curve.name}-dot`}
                        cx={prepared.xPoints[activeIndex]}
                        cy={curve.yPoints[activeIndex]}
                        r="3.5"
                        fill="#020617"
                        stroke={curve.color}
                        strokeWidth="2"
                    />
                ))}
            </svg>

            <div className="grid gap-2 sm:grid-cols-3">
                {prepared.curves.map((curve) => (
                    <div key={curve.name} className="rounded border border-slate-700/60 bg-slate-950/75 px-2 py-1 text-xs">
                        <p className="font-semibold" style={{ color: curve.color }}>
                            {curve.name}
                        </p>
                        <p className="text-slate-200">{fmtUsd(curve.points[activeIndex]?.value ?? 0)}</p>
                        <p className="text-[10px] text-slate-500">{fmtTime(activeTimestamp)}</p>
                    </div>
                ))}
            </div>

            <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span>min {fmtUsd(prepared.min)}</span>
                <span>max {fmtUsd(prepared.max)}</span>
            </div>
        </div>
    );
}
