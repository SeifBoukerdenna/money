export type ClosedPositionLike = {
  realizedPnl: unknown;
};

export type SessionSourceComparisonInput = {
  sourceWinRate: number;
  sourceNetPnl: number;
  closedPositions: ClosedPositionLike[];
  startedAt: string | null;
  createdAtIso: string;
};

export function buildSessionSourceComparison(input: SessionSourceComparisonInput): {
  sourceWinRate: number;
  sourceWinRatePct: number;
  paperWinRate: number;
  paperWinRatePct: number;
  sourceNetPnl: number;
  paperRealizedPnl: number;
  trackingEfficiencyPct: number;
  sessionStartDate: string;
  periodLabel: string;
} {
  const paperWins = input.closedPositions.filter((p) => Number(p.realizedPnl ?? 0) > 0).length;
  const paperLosses = input.closedPositions.filter((p) => Number(p.realizedPnl ?? 0) < 0).length;
  const paperDecisiveTrades = paperWins + paperLosses;
  const paperWinRate = paperDecisiveTrades > 0 ? paperWins / paperDecisiveTrades : 0;
  const paperRealizedPnl = input.closedPositions.reduce(
    (sum, p) => sum + Number(p.realizedPnl ?? 0),
    0,
  );
  const trackingEfficiencyPct =
    input.sourceNetPnl !== 0 ? (paperRealizedPnl / input.sourceNetPnl) * 100 : 0;

  const sessionStartDate = input.startedAt ?? input.createdAtIso;
  const sessionStartDateObj = new Date(sessionStartDate);

  return {
    sourceWinRate: input.sourceWinRate,
    sourceWinRatePct: input.sourceWinRate * 100,
    paperWinRate,
    paperWinRatePct: paperWinRate * 100,
    sourceNetPnl: input.sourceNetPnl,
    paperRealizedPnl,
    trackingEfficiencyPct,
    sessionStartDate,
    periodLabel: `Since ${sessionStartDateObj.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`,
  };
}
