type TrendPoint = { t: string; v: number };

export function TrendLine({ points, isPositive }: { points: TrendPoint[]; isPositive: boolean }) {
    if (points.length < 2) return <div className="text-xs text-slate-600">No data for this range.</div>;

    const W = 560;
    const H = 80;
    const PX = 4;
    const PY = 8;
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

    const color = isPositive ? '#22c55e' : '#f43f5e';
    const fill = isPositive ? 'rgba(34,197,94,0.12)' : 'rgba(244,63,94,0.12)';

    return (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-20 w-full">
            <path d={fillPath} fill={fill} />
            <polyline
                points={line}
                fill="none"
                stroke={color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
            />
            <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="2.5" fill={color} />
        </svg>
    );
}
