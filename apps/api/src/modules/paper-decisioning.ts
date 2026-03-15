import type { PaperCopySession } from '@prisma/client';

export const PAPER_REASON_CODES = {
  COPY_APPROVED: 'COPY_APPROVED',
  SKIP_BELOW_MIN_NOTIONAL: 'SKIP_BELOW_MIN_NOTIONAL',
  SKIP_NO_AVAILABLE_CASH: 'SKIP_NO_AVAILABLE_CASH',
  SKIP_OVER_MARKET_CAP: 'SKIP_OVER_MARKET_CAP',
  SKIP_UNSUPPORTED_EVENT: 'SKIP_UNSUPPORTED_EVENT',
  SKIP_STALE_SOURCE_EVENT: 'SKIP_STALE_SOURCE_EVENT',
  SKIP_NO_OPEN_POSITION: 'SKIP_NO_OPEN_POSITION',
  SKIP_INVALID_SOURCE_SIZE: 'SKIP_INVALID_SOURCE_SIZE',
  SKIP_GUARDRAIL_WALLET_QUALITY: 'SKIP_GUARDRAIL_WALLET_QUALITY',
  SKIP_GUARDRAIL_DRAWDOWN: 'SKIP_GUARDRAIL_DRAWDOWN',
  SKIP_GUARDRAIL_HEALTH_DEGRADED: 'SKIP_GUARDRAIL_HEALTH_DEGRADED',
  REDUCE_ON_SOURCE_REDUCTION: 'REDUCE_ON_SOURCE_REDUCTION',
  CLOSE_ON_SOURCE_EXIT: 'CLOSE_ON_SOURCE_EXIT',
  BOOTSTRAP_EXISTING_POSITION: 'BOOTSTRAP_EXISTING_POSITION',
  EXECUTION_FAILED_INSERT: 'EXECUTION_FAILED_INSERT',
  EXECUTION_FAILED_RUNTIME: 'EXECUTION_FAILED_RUNTIME',
} as const;

export type PaperReasonCode = (typeof PAPER_REASON_CODES)[keyof typeof PAPER_REASON_CODES];

export type PaperDecisionType = 'COPY' | 'SKIP' | 'REDUCE' | 'CLOSE' | 'BOOTSTRAP' | 'NOOP';
export type PaperDecisionStatus = 'PENDING' | 'EXECUTED' | 'SKIPPED' | 'FAILED';
export type PaperExecutorType = 'PAPER' | 'DRY_RUN' | 'LIVE';

export type ProjectedPositionState = {
  marketId: string;
  outcome: string;
  avgEntryPrice: number;
  netShares: number;
  marketQuestion: string | null;
};

export type PaperDecisionDraft = {
  decisionType: PaperDecisionType;
  status: PaperDecisionStatus;
  executorType: PaperExecutorType;
  marketId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  side: 'BUY' | 'SELL' | null;
  sourceShares: number | null;
  simulatedShares: number | null;
  sourcePrice: number | null;
  intendedFillPrice: number | null;
  copyRatio: number | null;
  sizingInputsJson: Record<string, unknown>;
  reasonCode: PaperReasonCode;
  humanReason: string;
  riskChecksJson: Record<string, unknown>;
  notes: string | null;
};

export function resolveEffectiveSide(event: Record<string, unknown>): 'BUY' | 'SELL' {
  if (event.side === 'SELL') return 'SELL';
  if (event.side === 'BUY') return 'BUY';

  const eventType = String(event.eventType ?? '').toUpperCase();
  if (['SELL', 'CLOSE', 'REDUCE', 'REDEEM'].includes(eventType)) {
    return 'SELL';
  }

  const raw =
    event.rawPayloadJson && typeof event.rawPayloadJson === 'object'
      ? (event.rawPayloadJson as Record<string, unknown>)
      : null;
  const takerSide = String(raw?.takerSide ?? raw?.side ?? '').toUpperCase();
  if (takerSide === 'SELL') {
    return 'SELL';
  }

  return 'BUY';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function skipDecision(input: {
  marketId?: string | null;
  marketQuestion?: string | null;
  outcome?: string | null;
  side?: 'BUY' | 'SELL' | null;
  sourceShares?: number | null;
  sourcePrice?: number | null;
  copyRatio?: number | null;
  reasonCode: PaperReasonCode;
  humanReason: string;
  sizingInputsJson?: Record<string, unknown>;
  riskChecksJson?: Record<string, unknown>;
  notes?: string | null;
}): PaperDecisionDraft {
  return {
    decisionType: 'SKIP',
    status: 'SKIPPED',
    executorType: 'PAPER',
    marketId: input.marketId ?? null,
    marketQuestion: input.marketQuestion ?? null,
    outcome: input.outcome ?? null,
    side: input.side ?? null,
    sourceShares: input.sourceShares ?? null,
    simulatedShares: null,
    sourcePrice: input.sourcePrice ?? null,
    intendedFillPrice: null,
    copyRatio: input.copyRatio ?? null,
    sizingInputsJson: input.sizingInputsJson ?? {},
    reasonCode: input.reasonCode,
    humanReason: input.humanReason,
    riskChecksJson: input.riskChecksJson ?? {},
    notes: input.notes ?? null,
  };
}

export function evaluatePaperEventDecision(input: {
  session: Pick<
    PaperCopySession,
    | 'maxAllocationPerMarket'
    | 'maxTotalExposure'
    | 'minNotionalThreshold'
    | 'slippageBps'
    | 'copyRatio'
    | 'startedAt'
  >;
  event: Record<string, unknown>;
  projectedCash: number;
  projectedGrossExposure: number;
  positionStateByKey: Map<string, ProjectedPositionState>;
}): PaperDecisionDraft {
  const { session, event, projectedCash, projectedGrossExposure, positionStateByKey } = input;
  const eventType = String(event.eventType ?? '').toUpperCase();
  const marketId = typeof event.marketId === 'string' ? event.marketId : null;
  const marketQuestion = typeof event.marketQuestion === 'string' ? event.marketQuestion : null;
  const outcome = String(event.outcome ?? 'UNKNOWN').toUpperCase();
  const key = marketId ? `${marketId}:${outcome}` : null;
  const position = key ? positionStateByKey.get(key) : null;
  const effectiveSide = resolveEffectiveSide(event);
  const copyRatio = Number(session.copyRatio ?? 1);

  const eventTs = event.eventTimestamp instanceof Date ? event.eventTimestamp : null;
  if (eventTs && session.startedAt && eventTs.getTime() < session.startedAt.getTime()) {
    return skipDecision({
      marketId,
      marketQuestion,
      outcome,
      side: effectiveSide,
      copyRatio,
      reasonCode: PAPER_REASON_CODES.SKIP_STALE_SOURCE_EVENT,
      humanReason: 'Source event is older than the active session start timestamp.',
      riskChecksJson: {
        sessionStartedAt: session.startedAt.toISOString(),
        sourceEventTimestamp: eventTs.toISOString(),
      },
    });
  }

  if (!marketId) {
    return skipDecision({
      marketQuestion,
      outcome,
      side: effectiveSide,
      copyRatio,
      reasonCode: PAPER_REASON_CODES.SKIP_UNSUPPORTED_EVENT,
      humanReason: 'Source event is missing marketId and cannot be mapped to a copy decision.',
      sizingInputsJson: { eventType },
    });
  }

  if (!['BUY', 'SELL', 'TRADE', 'INCREASE', 'REDUCE', 'CLOSE', 'REDEEM'].includes(eventType)) {
    return skipDecision({
      marketId,
      marketQuestion,
      outcome,
      side: effectiveSide,
      copyRatio,
      reasonCode: PAPER_REASON_CODES.SKIP_UNSUPPORTED_EVENT,
      humanReason: `Unsupported source event type ${eventType || 'UNKNOWN'} for copy execution.`,
      sizingInputsJson: { eventType },
    });
  }

  if (eventType === 'CLOSE' || eventType === 'REDEEM') {
    if (!position || position.netShares <= 0) {
      return skipDecision({
        marketId,
        marketQuestion,
        outcome,
        side: 'SELL',
        copyRatio,
        reasonCode: PAPER_REASON_CODES.SKIP_NO_OPEN_POSITION,
        humanReason: 'Source exit event arrived but no open copied position exists to close.',
      });
    }

    const sourcePrice = asNumber(event.price) ?? 0;
    const closePrice = Math.max(0, sourcePrice);
    const closeShares = position.netShares;

    return {
      decisionType: 'CLOSE',
      status: 'PENDING',
      executorType: 'PAPER',
      marketId,
      marketQuestion,
      outcome,
      side: 'SELL',
      sourceShares: asNumber(event.shares),
      simulatedShares: closeShares,
      sourcePrice,
      intendedFillPrice: closePrice,
      copyRatio,
      sizingInputsJson: {
        eventType,
        heldShares: position.netShares,
      },
      reasonCode: PAPER_REASON_CODES.CLOSE_ON_SOURCE_EXIT,
      humanReason:
        closePrice <= 0
          ? 'Source position exited worthless, closing copied position at 0.'
          : 'Source position exited, closing copied position through canonical ledger.',
      riskChecksJson: {},
      notes: eventType,
    };
  }

  const sourceShares = asNumber(event.shares);
  const sourcePrice = asNumber(event.price);
  if (!sourceShares || !sourcePrice || sourceShares <= 0 || sourcePrice <= 0) {
    return skipDecision({
      marketId,
      marketQuestion,
      outcome,
      side: effectiveSide,
      sourceShares,
      sourcePrice,
      copyRatio,
      reasonCode: PAPER_REASON_CODES.SKIP_INVALID_SOURCE_SIZE,
      humanReason: 'Source event is missing a valid positive price and shares payload.',
      sizingInputsJson: { eventType },
    });
  }

  const slippageSign = effectiveSide === 'BUY' ? 1 : -1;
  const slippageBps = Number(session.slippageBps);
  const intendedFillPrice = Math.max(
    0.0001,
    sourcePrice + sourcePrice * (slippageBps / 10_000) * slippageSign,
  );
  const maxPerMarket = Number(session.maxAllocationPerMarket);
  const minNotional = Number(session.minNotionalThreshold);
  const maxTotalExposure = Number(session.maxTotalExposure);

  let simulatedShares = sourceShares * copyRatio;
  let notional = simulatedShares * intendedFillPrice;

  if (effectiveSide === 'BUY') {
    const availableCashCap = Math.min(projectedCash, maxPerMarket);
    if (availableCashCap <= 0) {
      return skipDecision({
        marketId,
        marketQuestion,
        outcome,
        side: 'BUY',
        sourceShares,
        sourcePrice,
        copyRatio,
        reasonCode: PAPER_REASON_CODES.SKIP_NO_AVAILABLE_CASH,
        humanReason: 'Insufficient available cash for buy-side copy execution.',
        riskChecksJson: {
          projectedCash,
          perMarketCap: maxPerMarket,
        },
      });
    }

    if (notional > availableCashCap) {
      simulatedShares = availableCashCap / intendedFillPrice;
      notional = simulatedShares * intendedFillPrice;
    }

    if (projectedGrossExposure + notional > maxTotalExposure) {
      return skipDecision({
        marketId,
        marketQuestion,
        outcome,
        side: 'BUY',
        sourceShares,
        sourcePrice,
        copyRatio,
        reasonCode: PAPER_REASON_CODES.SKIP_OVER_MARKET_CAP,
        humanReason: 'Proposed buy would exceed maximum total exposure guardrail.',
        riskChecksJson: {
          projectedGrossExposure,
          requestedNotional: notional,
          maxTotalExposure,
        },
      });
    }
  } else {
    if (!position || position.netShares <= 0) {
      return skipDecision({
        marketId,
        marketQuestion,
        outcome,
        side: 'SELL',
        sourceShares,
        sourcePrice,
        copyRatio,
        reasonCode: PAPER_REASON_CODES.SKIP_NO_OPEN_POSITION,
        humanReason: 'Source sell/reduce event has no open copied position to reduce.',
      });
    }

    simulatedShares = Math.min(position.netShares, simulatedShares);
    notional = simulatedShares * intendedFillPrice;
  }

  if (simulatedShares <= 0 || notional < minNotional) {
    return skipDecision({
      marketId,
      marketQuestion,
      outcome,
      side: effectiveSide,
      sourceShares,
      sourcePrice,
      copyRatio,
      reasonCode: PAPER_REASON_CODES.SKIP_BELOW_MIN_NOTIONAL,
      humanReason: 'Copy trade notional is below configured minimum threshold.',
      riskChecksJson: {
        minNotional,
        computedNotional: notional,
      },
    });
  }

  if (effectiveSide === 'BUY') {
    return {
      decisionType: 'COPY',
      status: 'PENDING',
      executorType: 'PAPER',
      marketId,
      marketQuestion,
      outcome,
      side: 'BUY',
      sourceShares,
      simulatedShares,
      sourcePrice,
      intendedFillPrice,
      copyRatio,
      sizingInputsJson: {
        eventType,
        projectedCash,
        maxPerMarket,
      },
      reasonCode: PAPER_REASON_CODES.COPY_APPROVED,
      humanReason: 'Source buy approved for copy execution under current session guardrails.',
      riskChecksJson: {
        projectedCash,
        maxTotalExposure,
      },
      notes: null,
    };
  }

  const remainingShares = Math.max(0, (position?.netShares ?? 0) - simulatedShares);
  const decisionType: PaperDecisionType = remainingShares <= 1e-9 ? 'CLOSE' : 'REDUCE';

  return {
    decisionType,
    status: 'PENDING',
    executorType: 'PAPER',
    marketId,
    marketQuestion,
    outcome,
    side: 'SELL',
    sourceShares,
    simulatedShares,
    sourcePrice,
    intendedFillPrice,
    copyRatio,
    sizingInputsJson: {
      eventType,
      heldShares: position?.netShares ?? 0,
      remainingShares,
    },
    reasonCode:
      decisionType === 'CLOSE'
        ? PAPER_REASON_CODES.CLOSE_ON_SOURCE_EXIT
        : PAPER_REASON_CODES.REDUCE_ON_SOURCE_REDUCTION,
    humanReason:
      decisionType === 'CLOSE'
        ? 'Source fully exited this position; copied position will be fully closed.'
        : 'Source reduced position size; copied position will be proportionally reduced.',
    riskChecksJson: {},
    notes: null,
  };
}

export function applyProjectedExecution(input: {
  positionStateByKey: Map<string, ProjectedPositionState>;
  marketId: string;
  marketQuestion: string | null;
  outcome: string;
  side: 'BUY' | 'SELL';
  fillPrice: number;
  fillShares: number;
}): void {
  const key = `${input.marketId}:${input.outcome.toUpperCase()}`;
  const existing = input.positionStateByKey.get(key);

  if (input.side === 'BUY') {
    if (!existing) {
      input.positionStateByKey.set(key, {
        marketId: input.marketId,
        outcome: input.outcome.toUpperCase(),
        avgEntryPrice: input.fillPrice,
        netShares: input.fillShares,
        marketQuestion: input.marketQuestion,
      });
      return;
    }

    const currShares = existing.netShares;
    const newShares = currShares + input.fillShares;
    existing.avgEntryPrice =
      newShares > 0
        ? (currShares * existing.avgEntryPrice + input.fillShares * input.fillPrice) / newShares
        : existing.avgEntryPrice;
    existing.netShares = newShares;
    existing.marketQuestion = input.marketQuestion ?? existing.marketQuestion;
    return;
  }

  if (!existing) {
    return;
  }
  existing.netShares = Math.max(0, existing.netShares - input.fillShares);
  existing.marketQuestion = input.marketQuestion ?? existing.marketQuestion;
}
