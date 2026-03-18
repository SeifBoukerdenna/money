'use client';

/**
 * windowed-pnl-client.tsx
 *
 * Windowed Wallet PnL Tracker panel.
 * Renders inside the wallet detail page as the "PnL Tracker" tab.
 *
 * Fetches: GET /wallets/:id/windowed-pnl?window=...&feeMode=...&useLiveMarks=...
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Types (mirrors API response shape) ──────────────────────────────────────

type FeeMode = 'ACTUAL' | 'REALISTIC' | 'NONE';
type WindowPreset = '5M' | '15M' | '1H' | '4H' | '24H' | '7D' | '30D' | 'ALL';

type SnapshotPublic = {
  timestamp: string;
  openPositionCount: number;
  openMarketValue: number;
  unrealizedPnl: number;
  cumulativeRealizedGross: number;
  cumulativeFees: number;
};

type PositionDelta = {
  key: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string;
  startShares: number;
  startAvgEntry: number;
  startUnrealizedPnl: number;
  startMarkPrice: number | null;
  endShares: number;
  endAvgEntry: number;
  endUnrealizedPnl: number;
  endMarkPrice: number | null;
  sharesDelta: number;
  realizedInWindow: number;
  unrealizedDelta: number;
  feesInWindow: number;
  netDelta: number;
  buysInWindow: number;
  sellsInWindow: number;
  volumeInWindow: number;
  openedInWindow: boolean;
  closedInWindow: boolean;
};

type WindowedPnlConfidence = {
  level: 'HIGH' | 'PARTIAL' | 'LOW';
  totalEventsInWindow: number;
  totalEventsBeforeWindow: number;
  hasFullHistory: boolean;
  missingFeeCount: number;
  inferredFeeCount: number;
  missingMarkCount: number;
  staleMarkCount: number;
  warnings: string[];
};

type WindowedPnlResponse = {
  walletId: string;
  walletAddress: string;
  walletLabel: string;
  window: {
    label: string;
    from: string;
    to: string;
    durationMs: number;
  };
  feeMode: FeeMode;
  pnl: {
    realizedGross: number;
    unrealizedDelta: number;
    fees: number;
    netPnl: number;
  };
  snapshotStart: SnapshotPublic;
  snapshotEnd: SnapshotPublic;
  positionDeltas: PositionDelta[];
  confidence: WindowedPnlConfidence;
  computeMetrics: {
    totalEventsReplayed: number;
    computeTimeMs: number;
  };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:4000';
  return process.env.NEXT_PUBLIC_WEB_API_URL ?? 'http://localhost:4000';
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const prefix = v < 0 ? '-$' : v > 0 ? '+$' : '$';
  return prefix + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtUsdPlain(v: number): string {
  const abs = Math.abs(v);
  return (v < 0 ? '-$' : '$') + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShares(v: number): string {
  if (Math.abs(v) < 0.0001) return '0';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return parseFloat(v.toFixed(4)).toString();
}

function fmtPrice(v: number): string {
  return `${Math.round(v * 100)}¢`;
}

function pnlColor(v: number): string {
  if (v > 0.0001) return '#22c55e';
  if (v < -0.0001) return '#ef4444';
  return '#94a3b8';
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div style={{
      background: '#16181e',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12,
      padding: '16px 20px',
    }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: '#5c6370', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 6px' }}>{label}</p>
      <p style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', margin: 0, color: accent ?? '#e6e8ed', lineHeight: 1 }}>{value}</p>
      {sub && <p style={{ fontSize: 12, color: '#5c6370', margin: '4px 0 0' }}>{sub}</p>}
    </div>
  );
}

function SnapshotCard({ label, snap }: { label: string; snap: SnapshotPublic }) {
  return (
    <div style={{
      background: '#16181e',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12,
      padding: '16px 20px',
      flex: 1,
      minWidth: 0,
    }}>
      <p style={{ fontSize: 11, fontWeight: 600, color: '#5c6370', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>{label}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SnapRow k="Timestamp" v={new Date(snap.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} />
        <SnapRow k="Open Positions" v={String(snap.openPositionCount)} />
        <SnapRow k="Open Mkt Value" v={fmtUsdPlain(snap.openMarketValue)} />
        <SnapRow k="Unrealized PnL" v={fmtUsd(snap.unrealizedPnl)} accent={pnlColor(snap.unrealizedPnl)} />
        <SnapRow k="Cumul. Realized" v={fmtUsd(snap.cumulativeRealizedGross)} accent={pnlColor(snap.cumulativeRealizedGross)} />
        <SnapRow k="Cumul. Fees" v={fmtUsdPlain(snap.cumulativeFees)} />
      </div>
    </div>
  );
}

function SnapRow({ k, v, accent }: { k: string; v: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: '#5c6370' }}>{k}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: accent ?? '#e6e8ed' }}>{v}</span>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: WindowedPnlConfidence }) {
  const colors: Record<string, { bg: string; border: string; text: string }> = {
    HIGH: { bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.30)', text: '#86efac' },
    PARTIAL: { bg: 'rgba(234,179,8,0.10)', border: 'rgba(234,179,8,0.30)', text: '#fde047' },
    LOW: { bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.25)', text: '#fca5a5' },
  };
  const c = colors[confidence.level] ?? colors.PARTIAL!;
  return (
    <div style={{
      background: '#16181e',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12,
      padding: '14px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{
          background: c.bg, border: `1px solid ${c.border}`, color: c.text,
          borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700,
        }}>
          {confidence.level} CONFIDENCE
        </span>
        <span style={{ fontSize: 12, color: '#5c6370' }}>
          {confidence.totalEventsInWindow} events in window · {confidence.totalEventsBeforeWindow} before
        </span>
        {!confidence.hasFullHistory && (
          <span style={{ fontSize: 11, color: '#fca5a5' }}>⚠ Truncated history</span>
        )}
        {confidence.missingFeeCount > 0 && (
          <span style={{ fontSize: 11, color: '#fde047' }}>⚠ {confidence.missingFeeCount} missing fee{confidence.missingFeeCount !== 1 ? 's' : ''}</span>
        )}
        {confidence.inferredFeeCount > 0 && (
          <span style={{ fontSize: 11, color: '#93c5fd' }}>ℹ {confidence.inferredFeeCount} inferred fee{confidence.inferredFeeCount !== 1 ? 's' : ''}</span>
        )}
        {confidence.missingMarkCount > 0 && (
          <span style={{ fontSize: 11, color: '#fca5a5' }}>⚠ {confidence.missingMarkCount} missing mark{confidence.missingMarkCount !== 1 ? 's' : ''}</span>
        )}
        {confidence.staleMarkCount > 0 && (
          <span style={{ fontSize: 11, color: '#fde047' }}>⚠ {confidence.staleMarkCount} stale mark{confidence.staleMarkCount !== 1 ? 's' : ''}</span>
        )}
      </div>
    </div>
  );
}

function PositionDeltaRow({ delta }: { delta: PositionDelta }) {
  const hasActivity = delta.buysInWindow > 0 || delta.sellsInWindow > 0;
  return (
    <tr>
      <td style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', maxWidth: 260 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#e6e8ed', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={delta.marketQuestion ?? delta.key}>
          {delta.marketQuestion ?? delta.key}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 4,
            background: delta.outcome === 'YES' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            color: delta.outcome === 'YES' ? '#86efac' : '#fca5a5',
          }}>{delta.outcome}</span>
          {delta.openedInWindow && <span style={{ fontSize: 11, color: '#93c5fd', background: 'rgba(99,102,241,0.12)', padding: '1px 7px', borderRadius: 4 }}>NEW</span>}
          {delta.closedInWindow && <span style={{ fontSize: 11, color: '#fde047', background: 'rgba(234,179,8,0.12)', padding: '1px 7px', borderRadius: 4 }}>CLOSED</span>}
          {hasActivity && (
            <span style={{ fontSize: 11, color: '#5c6370' }}>
              {delta.buysInWindow > 0 && `${delta.buysInWindow}B`}{delta.buysInWindow > 0 && delta.sellsInWindow > 0 && ' '}{delta.sellsInWindow > 0 && `${delta.sellsInWindow}S`}
            </span>
          )}
        </div>
      </td>

      <td style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 12, color: '#e6e8ed' }}>{fmtShares(delta.endShares)}</div>
        {Math.abs(delta.sharesDelta) > 0.0001 && (
          <div style={{ fontSize: 11, color: delta.sharesDelta > 0 ? '#22c55e' : '#ef4444' }}>
            {delta.sharesDelta > 0 ? '+' : ''}{fmtShares(delta.sharesDelta)}
          </div>
        )}
      </td>

      <td style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 12, color: '#5c6370' }}>{delta.endMarkPrice != null ? fmtPrice(delta.endMarkPrice) : '—'}</div>
        <div style={{ fontSize: 11, color: '#5c6370' }}>avg {fmtPrice(delta.endAvgEntry)}</div>
      </td>

      <td style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: pnlColor(delta.realizedInWindow) }}>
          {delta.realizedInWindow !== 0 ? fmtUsd(delta.realizedInWindow) : <span style={{ color: '#5c6370' }}>—</span>}
        </div>
      </td>

      <td style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: pnlColor(delta.unrealizedDelta) }}>
          {delta.unrealizedDelta !== 0 ? fmtUsd(delta.unrealizedDelta) : <span style={{ color: '#5c6370' }}>—</span>}
        </div>
      </td>

      <td style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: pnlColor(delta.netDelta) }}>
          {fmtUsd(delta.netDelta)}
        </div>
      </td>
    </tr>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

const WINDOW_PRESETS: WindowPreset[] = ['5M', '15M', '1H', '4H', '24H', '7D', '30D', 'ALL'];
const FEE_MODES: FeeMode[] = ['REALISTIC', 'ACTUAL', 'NONE'];

export function WindowedPnlClient({ walletId }: { walletId: string }) {
  const [selectedWindow, setSelectedWindow] = useState<WindowPreset>('24H');
  const [feeMode, setFeeMode] = useState<FeeMode>('REALISTIC');
  const [useLiveMarks, setUseLiveMarks] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<WindowedPnlResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (win: WindowPreset, fee: FeeMode, live: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        window: win,
        feeMode: fee,
        useLiveMarks: String(live),
      });
      const res = await fetch(
        `${getApiBase()}/wallets/${walletId}/windowed-pnl?${params.toString()}`,
        { cache: 'no-store', signal: ctrl.signal },
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => `HTTP ${res.status}`);
        setError(txt);
        setLoading(false);
        return;
      }
      const json = (await res.json()) as WindowedPnlResponse;
      setData(json);
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message ?? 'Unknown error');
      }
    } finally {
      setLoading(false);
    }
  }, [walletId]);

  // Initial load + re-fetch on param change
  useEffect(() => {
    void fetchData(selectedWindow, feeMode, useLiveMarks);
  }, [fetchData, selectedWindow, feeMode, useLiveMarks]);

  const netPnl = data?.pnl.netPnl ?? 0;
  const netColor = pnlColor(netPnl);

  return (
    <>
      <style>{CSS}</style>
      <div className="wpnl-root">
        {/* ── Controls ─────────────────────────────────────────────────── */}
        <div className="wpnl-controls">
          <div className="wpnl-control-group">
            <span className="wpnl-control-label">Window</span>
            <div className="wpnl-pills">
              {WINDOW_PRESETS.map(w => (
                <button
                  key={w}
                  type="button"
                  className={`wpnl-pill${selectedWindow === w ? ' wpnl-pill-on' : ''}`}
                  onClick={() => setSelectedWindow(w)}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          <div className="wpnl-control-group">
            <span className="wpnl-control-label">Fees</span>
            <div className="wpnl-pills">
              {FEE_MODES.map(f => (
                <button
                  key={f}
                  type="button"
                  className={`wpnl-pill${feeMode === f ? ' wpnl-pill-on' : ''}`}
                  onClick={() => setFeeMode(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="wpnl-control-group">
            <span className="wpnl-control-label">Marks</span>
            <button
              type="button"
              className={`wpnl-pill${useLiveMarks ? ' wpnl-pill-on' : ''}`}
              onClick={() => setUseLiveMarks(v => !v)}
            >
              {useLiveMarks ? 'Live' : 'Last known'}
            </button>
          </div>

          <button
            type="button"
            className="wpnl-refresh-btn"
            disabled={loading}
            onClick={() => void fetchData(selectedWindow, feeMode, useLiveMarks)}
          >
            {loading ? '…' : '↺ Refresh'}
          </button>
        </div>

        {/* ── Error ───────────────────────────────────────────────────── */}
        {error && (
          <div className="wpnl-error">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* ── Loading skeleton ─────────────────────────────────────────── */}
        {loading && !data && (
          <div className="wpnl-loading">
            <div className="wpnl-spinner" />
            <span>Computing PnL…</span>
          </div>
        )}

        {/* ── Main content ─────────────────────────────────────────────── */}
        {data && (
          <>
            {/* Window info bar */}
            <div className="wpnl-info-bar">
              <span className="wpnl-window-badge">{data.window.label}</span>
              <span className="wpnl-info-meta">
                {new Date(data.window.from).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {' → '}
                {new Date(data.window.to).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {' · '}
                {fmtDuration(data.window.durationMs)}
              </span>
              <span className="wpnl-info-meta">
                {data.computeMetrics.totalEventsReplayed} events · {data.computeMetrics.computeTimeMs}ms
              </span>
              {loading && <span className="wpnl-refreshing">Refreshing…</span>}
            </div>

            {/* PnL summary metrics */}
            <div className="wpnl-metrics-grid">
              <MetricCard
                label="Net PnL"
                value={fmtUsd(data.pnl.netPnl)}
                sub={`realized + unrealized − fees`}
                accent={netColor}
              />
              <MetricCard
                label="Realized Gross"
                value={fmtUsd(data.pnl.realizedGross)}
                sub="trades closed in window"
                accent={pnlColor(data.pnl.realizedGross)}
              />
              <MetricCard
                label="Unrealized Δ"
                value={fmtUsd(data.pnl.unrealizedDelta)}
                sub="mark-to-market change"
                accent={pnlColor(data.pnl.unrealizedDelta)}
              />
              <MetricCard
                label="Fees"
                value={'−' + fmtUsdPlain(data.pnl.fees)}
                sub={`mode: ${data.feeMode.toLowerCase()}`}
              />
            </div>

            {/* Snapshot comparison */}
            <div className="wpnl-snapshots">
              <SnapshotCard label="📍 Snapshot Start" snap={data.snapshotStart} />
              <div className="wpnl-snapshot-arrow">→</div>
              <SnapshotCard label="📍 Snapshot End" snap={data.snapshotEnd} />
            </div>

            {/* Position deltas */}
            {data.positionDeltas.length > 0 && (
              <div className="wpnl-panel">
                <div className="wpnl-panel-hdr">
                  <span className="wpnl-panel-title">Position Deltas</span>
                  <span className="wpnl-muted">{data.positionDeltas.length} position{data.positionDeltas.length !== 1 ? 's' : ''}</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="wpnl-table">
                    <thead>
                      <tr>
                        <th className="wpnl-th" style={{ minWidth: 200 }}>Market</th>
                        <th className="wpnl-th wpnl-th-r">Shares</th>
                        <th className="wpnl-th wpnl-th-r">Price</th>
                        <th className="wpnl-th wpnl-th-r">Realized</th>
                        <th className="wpnl-th wpnl-th-r">Unrealized Δ</th>
                        <th className="wpnl-th wpnl-th-r">Net Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.positionDeltas.map(d => (
                        <PositionDeltaRow key={d.key} delta={d} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.positionDeltas.length === 0 && (
              <div className="wpnl-empty">No open positions or activity in this window.</div>
            )}

            {/* Confidence */}
            <ConfidenceBadge confidence={data.confidence} />
          </>
        )}
      </div>
    </>
  );
}

// ─── Scoped CSS ───────────────────────────────────────────────────────────────

const CSS = `
.wpnl-root {
  --bg:     #0e0f13;
  --surf:   #16181e;
  --surf2:  #1c1f27;
  --border: rgba(255,255,255,0.07);
  --text:   #e6e8ed;
  --muted:  #5c6370;
  --acc:    #6366f1;
  --acc-dim:rgba(99,102,241,0.14);
  --pos:    #22c55e;
  --neg:    #ef4444;
  --r:      12px;
  --rsm:    6px;
  display: flex; flex-direction: column; gap: 12px;
  font-family: -apple-system,'Inter','Segoe UI',Helvetica,sans-serif;
  font-size: 14px; color: var(--text);
}
.wpnl-root *, .wpnl-root *::before, .wpnl-root *::after { box-sizing: border-box; }

/* Controls */
.wpnl-controls {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  background: var(--surf); border: 1px solid var(--border);
  border-radius: var(--r); padding: 12px 16px;
}
.wpnl-control-group {
  display: flex; align-items: center; gap: 8px;
}
.wpnl-control-label {
  font-size: 11px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  white-space: nowrap;
}
.wpnl-pills { display: flex; gap: 3px; }
.wpnl-pill {
  background: none; border: 1px solid var(--border); border-radius: 6px;
  color: var(--muted); font-size: 12px; font-weight: 600;
  padding: 4px 11px; cursor: pointer; transition: all .15s;
  white-space: nowrap;
}
.wpnl-pill:hover { background: var(--surf2); color: var(--text); border-color: rgba(255,255,255,0.15); }
.wpnl-pill-on { background: var(--acc) !important; border-color: var(--acc) !important; color: #fff !important; }
.wpnl-refresh-btn {
  margin-left: auto; background: var(--surf2); border: 1px solid var(--border);
  border-radius: var(--rsm); color: var(--muted); font-size: 12px; font-weight: 600;
  padding: 5px 14px; cursor: pointer; transition: all .15s;
  white-space: nowrap;
}
.wpnl-refresh-btn:hover:not(:disabled) { color: var(--text); background: rgba(255,255,255,0.06); }
.wpnl-refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Error */
.wpnl-error {
  background: rgba(239,68,68,0.09); border: 1px solid rgba(239,68,68,0.25);
  border-radius: var(--rsm); color: #fca5a5; padding: 10px 14px; font-size: 13px;
}

/* Loading */
.wpnl-loading {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 48px; color: var(--muted); font-size: 14px;
}
.wpnl-spinner {
  width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.1);
  border-top-color: var(--acc); border-radius: 50%;
  animation: wpnl-spin .7s linear infinite; flex-shrink: 0;
}
@keyframes wpnl-spin { to { transform: rotate(360deg); } }
.wpnl-refreshing { font-size: 11px; color: var(--muted); animation: wpnl-fade .8s ease-in-out infinite alternate; }
@keyframes wpnl-fade { from { opacity: 0.4; } to { opacity: 1; } }

/* Info bar */
.wpnl-info-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 0;
}
.wpnl-window-badge {
  background: var(--acc-dim); border: 1px solid rgba(99,102,241,0.25);
  color: #a5b4fc; border-radius: 6px; font-size: 12px; font-weight: 700;
  padding: 3px 10px; letter-spacing: 0.03em;
}
.wpnl-info-meta {
  font-size: 12px; color: var(--muted);
}
.wpnl-info-sep { color: var(--muted); opacity: 0.4; }

/* Metrics grid */
.wpnl-metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
@media(max-width: 800px) {
  .wpnl-metrics-grid { grid-template-columns: repeat(2, 1fr); }
}
@media(max-width: 480px) {
  .wpnl-metrics-grid { grid-template-columns: 1fr; }
}

/* Snapshots */
.wpnl-snapshots {
  display: flex; align-items: flex-start; gap: 12px;
}
.wpnl-snapshot-arrow {
  flex-shrink: 0; color: var(--muted); font-size: 18px;
  padding-top: 48px;
}
@media(max-width: 700px) {
  .wpnl-snapshots { flex-direction: column; }
  .wpnl-snapshot-arrow { display: none; }
}

/* Position deltas panel */
.wpnl-panel {
  background: var(--surf); border: 1px solid var(--border);
  border-radius: var(--r); overflow: hidden;
}
.wpnl-panel-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 16px; border-bottom: 1px solid var(--border);
  gap: 8px;
}
.wpnl-panel-title {
  font-size: 13px; font-weight: 700; color: var(--text);
}
.wpnl-muted { font-size: 12px; color: var(--muted); }
.wpnl-table {
  width: 100%; border-collapse: collapse;
}
.wpnl-th {
  padding: 8px 12px; text-align: left;
  font-size: 10px; font-weight: 700; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid var(--border);
  white-space: nowrap; background: var(--surf);
}
.wpnl-th-r { text-align: right; }

/* Empty */
.wpnl-empty {
  text-align: center; color: var(--muted); font-size: 13px;
  padding: 36px; background: var(--surf); border: 1px solid var(--border);
  border-radius: var(--r);
}
`;
