import type { PaperCopySession } from '@prisma/client';
import { calculateSlippage, type SlippageConfig, type SlippageInput } from './slippage.js';

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
  SKIP_GUARDRAIL_HEALTH_DEGRADED: 'SKIP_GUARDRAIL_HEALTH_DEGRADED',
  SKIP_MAX_ADVERSE_MOVE: 'SKIP_MAX_ADVERSE_MOVE',
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

function pickFirstPositiveNumber(...values: unknown[]): number | null {
  for (const v of values) {
    const n = asNumber(v);
    if (n !== null && n > 0) return n;
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

// ──────────────────────────────────────────────────────────────────────────────
// POSITION MATCHING FOR CLOSE/REDEEM EVENTS
//
// Polymarket REDEEM events are unreliable for position matching:
//   - outcome is almost always null
//   - marketId on the REDEEM may be a DIFFERENT conditionId than the one
//     used on the BUY (Polymarket uses per-outcome-token IDs)
//
// This function tries every available signal to find the matching open position:
//   1. Exact key match (marketId:outcome) — fast path for normal SELLs
//   2. marketId prefix scan — for null-outcome REDEEMs where marketId matches
//   3. conditionId from event fields — different field might match
//   4. conditionId from rawPayloadJson — Polymarket raw data often has it
//   5. All candidate IDs from rawPayloadJson (market, asset_id, token_id, etc.)
//
// Returns the first open position found with netShares > 0.
// ──────────────────────────────────────────────────────────────────────────────
function findOpenPositionForCloseEvent(
  event: Record<string, unknown>,
  marketId: string | null,
  outcome: string,
  positionStateByKey: Map<string, ProjectedPositionState>,
): { position: ProjectedPositionState; resolvedOutcome: string; matchMethod: string } | null {
  // 1. Exact key match (marketId:outcome)
  if (marketId) {
    const exactKey = `${marketId}:${outcome}`;
    const exact = positionStateByKey.get(exactKey);
    if (exact && exact.netShares > 0) {
      return { position: exact, resolvedOutcome: outcome, matchMethod: 'exact_key' };
    }
  }

  // Helper: scan all positions for any key starting with a given ID prefix
  const scanById = (
    id: string,
  ): { position: ProjectedPositionState; resolvedOutcome: string } | null => {
    const prefix = `${id}:`;
    for (const [k, p] of positionStateByKey) {
      if (k.startsWith(prefix) && p.netShares > 0) {
        return { position: p, resolvedOutcome: p.outcome };
      }
    }
    return null;
  };

  // 2. marketId prefix scan (for null outcome → "UNKNOWN")
  if (marketId) {
    const found = scanById(marketId);
    if (found) return { ...found, matchMethod: 'marketId_scan' };
  }

  // Collect ALL candidate IDs from every available source on the event
  const candidateIds = new Set<string>();

  // 3. conditionId from event fields
  const conditionId = typeof event.conditionId === 'string' ? event.conditionId.trim() : null;
  if (conditionId && conditionId.length > 0) candidateIds.add(conditionId);

  // Also try marketSlug, slug etc as potential ID carriers
  for (const field of [
    'conditionId',
    'condition_id',
    'slug',
    'marketSlug',
    'market_slug',
    'questionId',
  ]) {
    const val = event[field];
    if (typeof val === 'string' && val.trim().length > 0) {
      candidateIds.add(val.trim());
    }
  }

  // 4. Dig into rawPayloadJson for any IDs
  const raw =
    event.rawPayloadJson && typeof event.rawPayloadJson === 'object'
      ? (event.rawPayloadJson as Record<string, unknown>)
      : null;

  if (raw) {
    for (const field of [
      'conditionId',
      'condition_id',
      'marketId',
      'market_id',
      'market',
      'asset_id',
      'assetId',
      'token_id',
      'tokenId',
      'questionId',
      'question_id',
      'slug',
      'marketSlug',
      'fpmmAddress',
      'fpmm',
    ]) {
      const val = raw[field];
      if (typeof val === 'string' && val.trim().length > 0) {
        candidateIds.add(val.trim());
      }
    }
  }

  // Remove the marketId we already tried
  if (marketId) candidateIds.delete(marketId);

  // 5. Try each candidate ID
  for (const id of candidateIds) {
    const found = scanById(id);
    if (found) return { ...found, matchMethod: `candidate_id:${id.slice(0, 16)}` };
  }

  // 6. Last resort: match by marketQuestion (title)
  // This is safe because Polymarket 5-min markets have unique time-range names.
  // Multiple positions for the same market (UP + DOWN) are fine — we close
  // whichever has shares > 0. The next REDEEM closes the other side.
  const eventQuestion =
    typeof event.marketQuestion === 'string' ? event.marketQuestion.trim() : null;
  if (eventQuestion && eventQuestion.length > 5) {
    for (const [, p] of positionStateByKey) {
      if (p.netShares > 0 && p.marketQuestion && p.marketQuestion.trim() === eventQuestion) {
        return { position: p, resolvedOutcome: p.outcome, matchMethod: 'market_question' };
      }
    }
  }

  return null;
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
  > & { slippageConfig?: any };
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
    // Use comprehensive matching — tries marketId, conditionId, rawPayload IDs,
    // and marketQuestion to find ANY open position this REDEEM belongs to.
    const match = findOpenPositionForCloseEvent(event, marketId, outcome, positionStateByKey);

    if (!match) {
      return skipDecision({
        marketId,
        marketQuestion,
        outcome,
        side: 'SELL',
        copyRatio,
        reasonCode: PAPER_REASON_CODES.SKIP_NO_OPEN_POSITION,
        humanReason:
          eventType === 'REDEEM'
            ? 'Ignored REDEEM: Copied position is already closed or was never opened.'
            : 'Source exit event arrived but no open copied position exists to close.',
        sizingInputsJson: {
          eventType,
          triedMarketId: marketId,
          triedConditionId: typeof event.conditionId === 'string' ? event.conditionId : null,
          eventOutcome: outcome,
          openPositionKeys: [...positionStateByKey.keys()].slice(0, 20),
        },
      });
    }

    const resolvedPosition = match.position;
    const resolvedOutcome = match.resolvedOutcome;
    const sourcePrice = asNumber(event.price) ?? 0;
    const closePrice = Math.max(0, sourcePrice);
    const closeShares = resolvedPosition.netShares;

    return {
      decisionType: 'CLOSE',
      status: 'PENDING',
      executorType: 'PAPER',
      marketId: resolvedPosition.marketId,
      marketQuestion: marketQuestion ?? resolvedPosition.marketQuestion,
      outcome: resolvedOutcome,
      side: 'SELL',
      sourceShares: asNumber(event.shares),
      simulatedShares: closeShares,
      sourcePrice,
      intendedFillPrice: closePrice,
      copyRatio,
      sizingInputsJson: {
        eventType,
        heldShares: resolvedPosition.netShares,
        originalOutcome: outcome,
        resolvedOutcome,
        matchMethod: match.matchMethod,
        eventMarketId: marketId,
        positionMarketId: resolvedPosition.marketId,
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

  const raw =
    event.rawPayloadJson && typeof event.rawPayloadJson === 'object'
      ? (event.rawPayloadJson as Record<string, unknown>)
      : null;

  const sourceNotional = pickFirstPositiveNumber(
    event.notional,
    raw?.notional,
    raw?.amount,
    raw?.amountUsd,
    raw?.totalTraded,
    raw?.usdValue,
  );

  let sourceShares = pickFirstPositiveNumber(event.shares, raw?.shares, raw?.size, raw?.quantity);
  let sourcePrice = pickFirstPositiveNumber(
    event.price,
    raw?.price,
    raw?.avgPrice,
    raw?.executionPrice,
    raw?.fillPrice,
  );

  if ((!sourceShares || sourceShares <= 0) && sourceNotional && sourcePrice && sourcePrice > 0) {
    sourceShares = sourceNotional / sourcePrice;
  }

  if ((!sourcePrice || sourcePrice <= 0) && sourceNotional && sourceShares && sourceShares > 0) {
    sourcePrice = sourceNotional / sourceShares;
  }

  if (effectiveSide === 'SELL' && position && position.netShares > 0) {
    if (!sourceShares || sourceShares <= 0) {
      sourceShares = position.netShares;
    }
    if (!sourcePrice || sourcePrice <= 0) {
      sourcePrice = pickFirstPositiveNumber(event.price, raw?.price, position.avgEntryPrice, 0.5);
    }
  }

  if (effectiveSide === 'BUY' && sourceNotional && sourceNotional > 0) {
    if (!sourcePrice || sourcePrice <= 0) sourcePrice = 0.5;
    if (!sourceShares || sourceShares <= 0) sourceShares = sourceNotional / sourcePrice;
  }

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
      humanReason:
        'Source event is missing a valid positive price/shares payload after normalization.',
      sizingInputsJson: {
        eventType,
        sourceNotional,
        rawPrice: raw?.price ?? null,
        rawShares: raw?.shares ?? raw?.size ?? null,
      },
    });
  }

  const maxPerMarket = Number(session.maxAllocationPerMarket);
  const minNotional = Number(session.minNotionalThreshold);
  const maxTotalExposure = Number(session.maxTotalExposure);

  const explicitSlippageConfig = (session.slippageConfig ?? null) as SlippageConfig | null;
  const legacySlippageBps = Number(session.slippageBps ?? 0);
  const slippageConfig: SlippageConfig | null = explicitSlippageConfig
    ? explicitSlippageConfig
    : legacySlippageBps > 0
      ? {
          enabled: true,
          mode: 'FIXED_BPS',
          fixedBps: legacySlippageBps,
        }
      : null;

  let simulatedShares = sourceShares * copyRatio;
  let latencyMs: number | undefined = undefined;
  if (event.detectedAt instanceof Date && event.eventTimestamp instanceof Date) {
    latencyMs = Math.max(0, event.detectedAt.getTime() - event.eventTimestamp.getTime());
  }

  const slippageInput: any = {
    side: effectiveSide,
    sourcePrice,
    simulatedShares,
  };
  if (latencyMs !== undefined) slippageInput.latencyMs = latencyMs;

  const slippageResult = calculateSlippage(slippageInput as SlippageInput, slippageConfig);

  const intendedFillPrice = slippageResult.fillPrice;
  let notional = simulatedShares * intendedFillPrice;

  if (slippageResult.isSkipped) {
    return skipDecision({
      marketId,
      marketQuestion,
      outcome,
      side: effectiveSide,
      sourceShares,
      sourcePrice,
      copyRatio,
      reasonCode: PAPER_REASON_CODES.SKIP_MAX_ADVERSE_MOVE,
      humanReason: slippageResult.skipReason ?? 'Trade skipped due to slippage policy.',
      sizingInputsJson: {
        eventType,
        slippageResult,
        sourceNotional,
      },
      riskChecksJson: {
        latencyMs,
        maxAdverseMovePercent: slippageConfig?.maxAdverseMovePercent,
      },
    });
  }

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
        riskChecksJson: { projectedCash, perMarketCap: maxPerMarket },
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
        riskChecksJson: { projectedGrossExposure, requestedNotional: notional, maxTotalExposure },
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
      riskChecksJson: { minNotional, computedNotional: notional },
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
      sizingInputsJson: { eventType, projectedCash, maxPerMarket, slippageResult },
      reasonCode: PAPER_REASON_CODES.COPY_APPROVED,
      humanReason: 'Source buy approved for copy execution under current session guardrails.',
      riskChecksJson: { projectedCash, maxTotalExposure },
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
    sizingInputsJson: { eventType, heldShares: position?.netShares ?? 0, remainingShares },
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
