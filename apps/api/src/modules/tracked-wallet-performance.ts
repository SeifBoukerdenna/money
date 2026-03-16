import { normalizeMoney } from '../lib/money-utils.js';

const EPSILON = 1e-9;

type TradeSide = 'BUY' | 'SELL';

type TradeLikeEventType = 'BUY' | 'SELL' | 'TRADE' | 'INCREASE' | 'REDUCE' | 'CLOSE' | 'REDEEM';

const TRADE_LIKE_EVENT_TYPES = new Set<TradeLikeEventType>([
  'BUY',
  'SELL',
  'TRADE',
  'INCREASE',
  'REDUCE',
  'CLOSE',
  'REDEEM',
]);

const SELL_LIKE_EVENT_TYPES = new Set(['SELL', 'REDUCE', 'CLOSE', 'REDEEM']);

export type TrackedWalletEvent = {
  id: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  side: TradeSide | null;
  effectiveSide: TradeSide | null;
  eventType: string;
  price: number | null;
  shares: number | null;
  notional: number | null;
  fee: number | null;
  eventTimestamp: Date;
  createdAt: Date;
};

export type TrackedWalletPosition = {
  key: string;
  marketKey: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string;
  netShares: number;
  avgEntryPrice: number;
  currentMarkPrice: number;
  realizedPnlGross: number;
  unrealizedPnl: number;
  status: 'OPEN' | 'CLOSED';
  openedAt: Date;
  closedAt: Date | null;
  lastEventAt: Date;
};

export type TrackedWalletTimelinePoint = {
  index: number;
  eventId: string;
  eventTimestamp: string;
  eventType: string;
  marketId: string;
  outcome: string | null;
  side: TradeSide | null;
  realizedPnlGross: number;
  unrealizedPnl: number;
  fees: number;
  netPnl: number;
  cashDelta: number;
  openMarketValue: number;
  reconstructedAccountValue: number;
};

export type TrackedWalletReductionWarning = {
  code:
    | 'DUPLICATE_EVENT_SKIPPED'
    | 'NON_TRADE_EVENT_SKIPPED'
    | 'UNSUPPORTED_EVENT_RECORDED'
    | 'BUY_WITHOUT_PRICE_OR_SIZE'
    | 'INFERRED_BUY_SHARES'
    | 'SELL_WITHOUT_OPEN_POSITION'
    | 'SELL_EXCEEDS_HELD_SHARES'
    | 'INFERRED_SELL_SHARES'
    | 'INFERRED_SELL_PRICE'
    | 'UNKNOWN_OUTCOME_CLOSE_ALLOCATION'
    | 'INFERENCE_DISABLED_EVENT_SKIPPED'
    | 'ESTIMATED_MARK_USED'
    | 'MISSING_MARK_PRICE'
    | 'MISSING_FEE_DETECTED'
    | 'NO_AUTHORITATIVE_NET'
    | 'UNKNOWN_COST_BASIS_OPEN_POSITION'
    | 'IMPOSSIBLE_STATE_TRANSITION'
    | 'INVALID_NUMERIC_STATE';
  eventId: string;
  message: string;
};

export type SourceLedgerEventType =
  | 'BUY_FILL'
  | 'SELL_FILL'
  | 'FEE'
  | 'RESOLUTION_PAYOUT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'UNSUPPORTED';

export type SourceLedgerEvent = {
  eventId: string;
  eventTimestamp: string;
  type: SourceLedgerEventType;
  marketId: string | null;
  conditionId: string | null;
  outcome: string | null;
  qty: number | null;
  price: number | null;
  amount: number | null;
  note: string | null;
};

export type TrackedWalletConfidence = 'HIGH' | 'PARTIAL' | 'LOW';

export type TrackedWalletConfidenceModel = {
  confidence: TrackedWalletConfidence;
  hasTruncatedHistory: boolean;
  hasUnsupportedEvents: boolean;
  hasUnknownCostBasis: boolean;
  hasEstimatedMarks: boolean;
  hasMissingFees: boolean;
  warnings: string[];
};

export type TrackedWalletCanonicalMetrics = {
  canonicalKnownNetPnl: number | null;
  canonicalRealizedPnl: number;
  canonicalUnrealizedPnl: number;
  canonicalFees: number;
  estimatedNetPnl: number | null;
};

export type TrackedWalletDebugReport = {
  eventCountsByType: Record<SourceLedgerEventType, number>;
  ingestedEventCount: number;
  duplicateCount: number;
  normalizationFailures: number;
  unsupportedIgnoredEvents: number;
  incompleteHistoryReconstructedPositions: number;
  realizedContribution: {
    known: number;
    estimated: number;
  };
  unrealizedContribution: {
    known: number;
    estimated: number;
  };
  knownVsEstimatedContribution: {
    knownNetPnl: number | null;
    estimatedNetPnl: number | null;
  };
  impossibleStateTransitions: number;
  firstEventTimestamp: string | null;
  lastEventTimestamp: string | null;
  unknownCostBasisPositions: string[];
};

export type TrackedWalletMarkMeta = {
  source: 'LIVE' | 'FALLBACK';
  stale: boolean;
};

export type TrackedWalletReductionSummary = {
  eventCount: number;
  tradeLikeEventCount: number;
  buyEventCount: number;
  sellEventCount: number;
  inferredShareEvents: number;
  inferredPriceEvents: number;
  missingFeeEvents: number;
  feeCoveragePct: number;
  duplicateSkipped: number;
  inferenceDisabledSkips: number;
  unsupportedEventCount: number;
  normalizationFailureCount: number;
  impossibleStateTransitions: number;
  missingMarkCount: number;
  estimatedMarkCount: number;
  unknownCostBasisPositions: number;
  eventCountsByType: Record<SourceLedgerEventType, number>;
};

export type TrackedWalletReductionResult = {
  realizedPnlGross: number;
  unrealizedPnl: number;
  fees: number;
  netPnl: number;
  cashDelta: number;
  openMarketValue: number;
  reconstructedAccountValue: number;
  positions: TrackedWalletPosition[];
  timeline: TrackedWalletTimelinePoint[];
  warnings: TrackedWalletReductionWarning[];
  summary: TrackedWalletReductionSummary;
  ledger: SourceLedgerEvent[];
  canonical: TrackedWalletCanonicalMetrics;
  confidenceModel: TrackedWalletConfidenceModel;
  debugReport: TrackedWalletDebugReport;
};

export type SessionTimelinePoint = {
  timestamp: string;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
};

export type SourceVsSessionComparison = {
  source: {
    realizedPnlGross: number;
    unrealizedPnl: number;
    fees: number;
    netPnl: number;
  };
  session: {
    realizedPnlGross: number;
    unrealizedPnl: number;
    fees: number;
    netPnl: number;
  };
  gaps: {
    netPnlGap: number;
    realizedGap: number;
    unrealizedGap: number;
    feeGap: number;
    frictionDrag: number;
    executionDrag: number;
    percentGap: number | null;
  };
  curves: {
    sourceNetPnl: Array<{ timestamp: string; value: number }>;
    sessionNetPnl: Array<{ timestamp: string; value: number }>;
    gap: Array<{ timestamp: string; value: number }>;
  };
  diagnosis: {
    dominantDriver:
      | 'COPY_FRICTION'
      | 'SESSION_UNREALIZED_DRAG'
      | 'SOURCE_DETERIORATION'
      | 'MIXED'
      | 'NEUTRAL';
    summary: string;
  };
};

type PositionAccumulator = {
  key: string;
  marketKey: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string;
  netShares: number;
  avgEntryPrice: number;
  currentMarkPrice: number;
  realizedPnlGross: number;
  status: 'OPEN' | 'CLOSED';
  openedAt: Date;
  closedAt: Date | null;
  lastEventAt: Date;
};

type ReductionMutableState = {
  positionsByKey: Map<string, PositionAccumulator>;
  realizedPnlGross: number;
  fees: number;
  cashDelta: number;
  warnings: TrackedWalletReductionWarning[];
  seenEventIds: Set<string>;
  summary: TrackedWalletReductionSummary;
  inferMissingFields: boolean;
  ledger: SourceLedgerEvent[];
  knownRealizedContribution: number;
  estimatedRealizedContribution: number;
  canonicalFees: number;
  markMetaByKey: Map<string, TrackedWalletMarkMeta>;
  missingMarkCount: number;
  estimatedMarkCount: number;
  hasTruncatedHistory: boolean;
  unknownCostBasisPositions: Set<string>;
  impossibleStateTransitions: number;
  normalizationFailureCount: number;
};

export type TimelineBucket = 'RAW' | '5M' | '15M' | '1H';

function normalizeOutcome(outcome: string | null | undefined): string {
  const normalized = String(outcome ?? '')
    .trim()
    .toUpperCase();
  return normalized.length > 0 ? normalized : 'UNKNOWN';
}

function normalizeMarketKey(input: { conditionId: string | null; marketId: string }): string {
  const conditionId = String(input.conditionId ?? '').trim();
  if (conditionId.length > 0) return conditionId;
  return String(input.marketId).trim();
}

function toPositionKey(marketKey: string, outcome: string): string {
  return `${marketKey}:${outcome}`;
}

function normalizePrice(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function normalizeSize(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num <= 0) return null;
  return num;
}

function ensureFinite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value;
}

function pushLedgerEvent(
  state: ReductionMutableState,
  event: TrackedWalletEvent,
  type: SourceLedgerEventType,
  fields?: Partial<
    Pick<
      SourceLedgerEvent,
      'marketId' | 'conditionId' | 'outcome' | 'qty' | 'price' | 'amount' | 'note'
    >
  >,
) {
  state.ledger.push({
    eventId: event.id,
    eventTimestamp: event.eventTimestamp.toISOString(),
    type,
    marketId: fields?.marketId ?? event.marketId ?? null,
    conditionId: fields?.conditionId ?? event.conditionId ?? null,
    outcome: fields?.outcome ?? event.outcome ?? null,
    qty: fields?.qty ?? null,
    price: fields?.price ?? null,
    amount: fields?.amount ?? null,
    note: fields?.note ?? null,
  });
  state.summary.eventCountsByType[type] += 1;
}

function buildConfidenceModel(input: {
  hasTruncatedHistory: boolean;
  hasUnsupportedEvents: boolean;
  hasUnknownCostBasis: boolean;
  hasEstimatedMarks: boolean;
  hasMissingFees: boolean;
  warnings: string[];
}): TrackedWalletConfidenceModel {
  const severe =
    input.hasUnknownCostBasis ||
    input.hasMissingFees ||
    input.hasTruncatedHistory ||
    input.hasUnsupportedEvents;
  const moderate = input.hasEstimatedMarks;

  const confidence: TrackedWalletConfidence = severe ? 'LOW' : moderate ? 'PARTIAL' : 'HIGH';
  return {
    confidence,
    hasTruncatedHistory: input.hasTruncatedHistory,
    hasUnsupportedEvents: input.hasUnsupportedEvents,
    hasUnknownCostBasis: input.hasUnknownCostBasis,
    hasEstimatedMarks: input.hasEstimatedMarks,
    hasMissingFees: input.hasMissingFees,
    warnings: input.warnings,
  };
}

function resolveEventSide(event: TrackedWalletEvent): TradeSide | null {
  const direct = event.effectiveSide ?? event.side;
  if (direct === 'BUY' || direct === 'SELL') return direct;

  const eventType = String(event.eventType).toUpperCase();
  if (!TRADE_LIKE_EVENT_TYPES.has(eventType as TradeLikeEventType)) return null;
  return SELL_LIKE_EVENT_TYPES.has(eventType) ? 'SELL' : 'BUY';
}

function computeUnrealizedAndOpenValue(input: {
  positionsByKey: Map<string, PositionAccumulator>;
  markPriceByKey: Map<string, number>;
  markMetaByKey: Map<string, TrackedWalletMarkMeta>;
  hasTruncatedHistory: boolean;
  unknownCostBasisPositions: Set<string>;
  warnings?: TrackedWalletReductionWarning[];
  estimatedMarkCounter?: { value: number };
  missingMarkCounter?: { value: number };
}): {
  unrealizedPnl: number;
  openMarketValue: number;
  knownUnrealizedPnl: number;
  estimatedUnrealizedPnl: number;
} {
  let unrealizedPnl = 0;
  let openMarketValue = 0;
  let knownUnrealizedPnl = 0;
  let estimatedUnrealizedPnl = 0;

  for (const position of input.positionsByKey.values()) {
    if (position.netShares <= EPSILON) {
      position.netShares = 0;
      position.status = 'CLOSED';
      continue;
    }

    const marketMark = input.markPriceByKey.get(position.key);
    const fallbackMark =
      position.currentMarkPrice > EPSILON ? position.currentMarkPrice : position.avgEntryPrice;
    const mark = normalizePrice(marketMark ?? fallbackMark) ?? 0;
    const markMeta = input.markMetaByKey.get(position.key);
    const hasMark = input.markPriceByKey.has(position.key);
    position.currentMarkPrice = mark;
    position.status = 'OPEN';

    const positionUnrealized = normalizeMoney(position.netShares * (mark - position.avgEntryPrice));
    unrealizedPnl += positionUnrealized;
    openMarketValue += position.netShares * mark;

    const unknownCostBasis = input.hasTruncatedHistory;
    if (unknownCostBasis) {
      input.unknownCostBasisPositions.add(position.key);
    }

    const markEstimated = !hasMark || !markMeta || markMeta.source !== 'LIVE' || markMeta.stale;
    if (!hasMark) {
      input.missingMarkCounter && (input.missingMarkCounter.value += 1);
      if (input.warnings) {
        input.warnings.push({
          code: 'MISSING_MARK_PRICE',
          eventId: 'SYSTEM',
          message: `Missing live mark for ${position.key}; unrealized is excluded from canonical known net.`,
        });
      }
    } else if (markEstimated) {
      input.estimatedMarkCounter && (input.estimatedMarkCounter.value += 1);
      if (input.warnings) {
        input.warnings.push({
          code: 'ESTIMATED_MARK_USED',
          eventId: 'SYSTEM',
          message: `Estimated or fallback mark used for ${position.key}; canonical known net excludes this unrealized component.`,
        });
      }
    }

    if (!markEstimated && !unknownCostBasis) {
      knownUnrealizedPnl = normalizeMoney(knownUnrealizedPnl + positionUnrealized);
    } else {
      estimatedUnrealizedPnl = normalizeMoney(estimatedUnrealizedPnl + positionUnrealized);
    }
  }

  return {
    unrealizedPnl: normalizeMoney(unrealizedPnl),
    openMarketValue: normalizeMoney(openMarketValue),
    knownUnrealizedPnl: normalizeMoney(knownUnrealizedPnl),
    estimatedUnrealizedPnl: normalizeMoney(estimatedUnrealizedPnl),
  };
}

function pickTargetPositions(
  state: ReductionMutableState,
  event: TrackedWalletEvent,
  marketKey: string,
  outcome: string,
): PositionAccumulator[] {
  const eventType = String(event.eventType).toUpperCase();
  if (outcome !== 'UNKNOWN') {
    const exact = state.positionsByKey.get(toPositionKey(marketKey, outcome));
    if (!exact || exact.netShares <= EPSILON) return [];
    return [exact];
  }

  const candidates = Array.from(state.positionsByKey.values()).filter((row) => {
    if (row.marketKey !== marketKey) return false;
    return row.netShares > EPSILON;
  });

  if (candidates.length > 1 && (eventType === 'REDEEM' || eventType === 'CLOSE')) {
    state.summary.inferredShareEvents += 1;
    state.warnings.push({
      code: 'UNKNOWN_OUTCOME_CLOSE_ALLOCATION',
      eventId: event.id,
      message:
        'Outcome was missing for a close event, so shares were allocated across open outcomes by largest inventory first.',
    });
  }

  candidates.sort((a, b) => b.netShares - a.netShares || a.key.localeCompare(b.key));
  return candidates;
}

function applyBuy(
  state: ReductionMutableState,
  event: TrackedWalletEvent,
  marketKey: string,
  outcome: string,
): boolean {
  const price = normalizePrice(event.price);
  let shares = normalizeSize(event.shares);
  const notional = normalizeSize(event.notional);

  if (
    (shares === null || shares <= EPSILON) &&
    notional !== null &&
    price !== null &&
    price > EPSILON
  ) {
    if (!state.inferMissingFields) {
      state.summary.inferenceDisabledSkips += 1;
      state.warnings.push({
        code: 'INFERENCE_DISABLED_EVENT_SKIPPED',
        eventId: event.id,
        message: 'BUY event required inferred shares but inference is disabled in strict mode.',
      });
      return false;
    }
    shares = normalizeSize(notional / price);
    if (shares !== null) {
      state.summary.inferredShareEvents += 1;
      state.warnings.push({
        code: 'INFERRED_BUY_SHARES',
        eventId: event.id,
        message: 'BUY shares were inferred from notional/price.',
      });
    }
  }

  if (shares === null || price === null) {
    state.summary.normalizationFailureCount += 1;
    state.warnings.push({
      code: 'BUY_WITHOUT_PRICE_OR_SIZE',
      eventId: event.id,
      message: 'BUY event lacked sufficient size/price and was skipped.',
    });
    return false;
  }

  const key = toPositionKey(marketKey, outcome);
  const fee = normalizeSize(event.fee) ?? 0;
  const impliedNotional = normalizeMoney(shares * price);
  const spend = notional ?? impliedNotional;

  if (!Number.isFinite(spend) || !Number.isFinite(fee)) {
    state.summary.normalizationFailureCount += 1;
    state.warnings.push({
      code: 'INVALID_NUMERIC_STATE',
      eventId: event.id,
      message: 'BUY event produced non-finite spend/fee and was skipped.',
    });
    return false;
  }

  let position = state.positionsByKey.get(key);
  if (!position) {
    position = {
      key,
      marketKey,
      marketId: event.marketId,
      conditionId: event.conditionId,
      marketQuestion: event.marketQuestion,
      outcome,
      netShares: 0,
      avgEntryPrice: 0,
      currentMarkPrice: price,
      realizedPnlGross: 0,
      status: 'CLOSED',
      openedAt: event.eventTimestamp,
      closedAt: event.eventTimestamp,
      lastEventAt: event.eventTimestamp,
    };
    state.positionsByKey.set(key, position);
  }

  const previousShares = position.netShares;
  const nextShares = normalizeMoney(previousShares + shares);
  const previousCost = previousShares * position.avgEntryPrice;
  const nextCost = previousCost + shares * price;

  position.netShares = nextShares;
  position.avgEntryPrice = nextShares > EPSILON ? nextCost / nextShares : position.avgEntryPrice;
  position.currentMarkPrice = price;
  position.marketQuestion = event.marketQuestion ?? position.marketQuestion;
  position.lastEventAt = event.eventTimestamp;

  if (previousShares <= EPSILON) {
    position.openedAt = event.eventTimestamp;
    position.closedAt = null;
    position.status = 'OPEN';
  }

  state.cashDelta = normalizeMoney(state.cashDelta - spend - fee);
  state.fees = normalizeMoney(state.fees + fee);
  state.canonicalFees = normalizeMoney(state.canonicalFees + fee);

  pushLedgerEvent(state, event, 'BUY_FILL', {
    qty: shares,
    price,
    amount: spend,
  });
  if (fee > EPSILON) {
    pushLedgerEvent(state, event, 'FEE', {
      amount: fee,
      note: 'fee attached to buy fill',
    });
  }

  return true;
}

function applySell(
  state: ReductionMutableState,
  event: TrackedWalletEvent,
  marketKey: string,
  outcome: string,
): boolean {
  const rawFee = normalizeSize(event.fee) ?? 0;
  const rawShares = normalizeSize(event.shares);
  const rawPrice = normalizePrice(event.price);
  const rawNotional = normalizeSize(event.notional);

  const targets = pickTargetPositions(state, event, marketKey, outcome);
  if (targets.length === 0) {
    state.summary.impossibleStateTransitions += 1;
    state.impossibleStateTransitions += 1;
    state.warnings.push({
      code: 'SELL_WITHOUT_OPEN_POSITION',
      eventId: event.id,
      message: 'Sell-like event had no matching open inventory and was skipped.',
    });
    return false;
  }

  const totalOpenShares = targets.reduce((sum, row) => sum + row.netShares, 0);
  let targetShares = rawShares;
  let usedInferredShares = false;
  let usedInferredPrice = false;

  if (targetShares === null && rawNotional !== null && rawPrice !== null && rawPrice > EPSILON) {
    if (!state.inferMissingFields) {
      state.summary.inferenceDisabledSkips += 1;
      state.warnings.push({
        code: 'INFERENCE_DISABLED_EVENT_SKIPPED',
        eventId: event.id,
        message:
          'SELL event required inferred shares from notional/price but inference is disabled in strict mode.',
      });
      return false;
    }
    targetShares = normalizeSize(rawNotional / rawPrice);
    if (targetShares !== null) {
      usedInferredShares = true;
      state.summary.inferredShareEvents += 1;
      state.warnings.push({
        code: 'INFERRED_SELL_SHARES',
        eventId: event.id,
        message: 'Sell-like shares were inferred from notional/price.',
      });
    }
  }

  if (targetShares === null) {
    if (!state.inferMissingFields) {
      state.summary.inferenceDisabledSkips += 1;
      state.warnings.push({
        code: 'INFERENCE_DISABLED_EVENT_SKIPPED',
        eventId: event.id,
        message:
          'SELL event required inferred shares from open inventory but inference is disabled in strict mode.',
      });
      return false;
    }
    targetShares = totalOpenShares;
    usedInferredShares = true;
    state.summary.inferredShareEvents += 1;
    state.warnings.push({
      code: 'INFERRED_SELL_SHARES',
      eventId: event.id,
      message: 'Sell-like shares were inferred by closing all currently open inventory.',
    });
  }

  const closeRequested = Math.max(0, targetShares);
  const closePossible = Math.min(totalOpenShares, closeRequested);
  if (closeRequested > totalOpenShares + EPSILON) {
    state.summary.impossibleStateTransitions += 1;
    state.impossibleStateTransitions += 1;
    state.warnings.push({
      code: 'SELL_EXCEEDS_HELD_SHARES',
      eventId: event.id,
      message: 'Sell-like shares exceeded inventory and were clamped.',
    });
  }

  if (closePossible <= EPSILON) {
    return false;
  }

  let exitPrice = rawPrice;
  if (exitPrice === null && rawNotional !== null && closePossible > EPSILON) {
    if (!state.inferMissingFields) {
      state.summary.inferenceDisabledSkips += 1;
      state.warnings.push({
        code: 'INFERENCE_DISABLED_EVENT_SKIPPED',
        eventId: event.id,
        message:
          'SELL event required inferred price from notional/shares but inference is disabled in strict mode.',
      });
      return false;
    }
    exitPrice = normalizePrice(rawNotional / closePossible);
    usedInferredPrice = true;
    state.summary.inferredPriceEvents += 1;
    state.warnings.push({
      code: 'INFERRED_SELL_PRICE',
      eventId: event.id,
      message: 'Sell-like price was inferred from notional/shares.',
    });
  }

  if (exitPrice === null) {
    if (!state.inferMissingFields) {
      state.summary.inferenceDisabledSkips += 1;
      state.warnings.push({
        code: 'INFERENCE_DISABLED_EVENT_SKIPPED',
        eventId: event.id,
        message:
          'SELL event required inferred fallback price but inference is disabled in strict mode.',
      });
      return false;
    }
    exitPrice = 0;
    usedInferredPrice = true;
    state.summary.inferredPriceEvents += 1;
    state.warnings.push({
      code: 'INFERRED_SELL_PRICE',
      eventId: event.id,
      message: 'Sell-like price was inferred as zero due to missing settlement price.',
    });
  }

  let sharesRemaining = closePossible;
  let closedShares = 0;
  let realizedGross = 0;

  for (const position of targets) {
    if (sharesRemaining <= EPSILON) break;
    if (position.netShares <= EPSILON) continue;

    const closeShares = Math.min(position.netShares, sharesRemaining);
    if (closeShares <= EPSILON) continue;

    const eventRealized = normalizeMoney(closeShares * (exitPrice - position.avgEntryPrice));
    realizedGross = normalizeMoney(realizedGross + eventRealized);
    position.realizedPnlGross = normalizeMoney(position.realizedPnlGross + eventRealized);
    closedShares += closeShares;

    position.netShares = normalizeMoney(position.netShares - closeShares);
    position.lastEventAt = event.eventTimestamp;
    position.currentMarkPrice = exitPrice;

    if (position.netShares <= EPSILON) {
      position.netShares = 0;
      position.status = 'CLOSED';
      position.closedAt = event.eventTimestamp;
    } else {
      position.status = 'OPEN';
      position.closedAt = null;
    }

    sharesRemaining = normalizeMoney(sharesRemaining - closeShares);
  }

  if (closedShares <= EPSILON) {
    return false;
  }

  const proceeds = rawNotional ?? normalizeMoney(closedShares * exitPrice);
  if (!Number.isFinite(proceeds) || !Number.isFinite(rawFee)) {
    state.summary.normalizationFailureCount += 1;
    state.warnings.push({
      code: 'INVALID_NUMERIC_STATE',
      eventId: event.id,
      message: 'SELL event produced non-finite proceeds/fee and was skipped.',
    });
    return false;
  }

  state.realizedPnlGross = normalizeMoney(state.realizedPnlGross + realizedGross);
  if (usedInferredShares || usedInferredPrice) {
    state.estimatedRealizedContribution = normalizeMoney(
      state.estimatedRealizedContribution + realizedGross,
    );
  } else {
    state.knownRealizedContribution = normalizeMoney(
      state.knownRealizedContribution + realizedGross,
    );
  }
  state.cashDelta = normalizeMoney(state.cashDelta + proceeds - rawFee);
  state.fees = normalizeMoney(state.fees + rawFee);
  state.canonicalFees = normalizeMoney(state.canonicalFees + rawFee);

  const normalizedType = String(event.eventType).toUpperCase();
  const sellLedgerType: SourceLedgerEventType =
    normalizedType === 'REDEEM' || normalizedType === 'CLOSE' ? 'RESOLUTION_PAYOUT' : 'SELL_FILL';
  pushLedgerEvent(state, event, sellLedgerType, {
    qty: closedShares,
    price: exitPrice,
    amount: proceeds,
  });
  if (rawFee > EPSILON) {
    pushLedgerEvent(state, event, 'FEE', {
      amount: rawFee,
      note: 'fee attached to sell-like fill',
    });
  }

  return true;
}

function samplePointAtOrBefore<T extends { timestamp: string }>(
  points: T[],
  timestamp: string,
  valueAccessor: (point: T) => number,
): number {
  if (points.length === 0) return 0;
  const targetMs = new Date(timestamp).getTime();
  if (!Number.isFinite(targetMs)) return valueAccessor(points[points.length - 1]!);

  let lo = 0;
  let hi = points.length - 1;
  let best = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const pointMs = new Date(points[mid]!.timestamp).getTime();
    if (pointMs <= targetMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === -1) return 0;
  return valueAccessor(points[best]!);
}

function normalizeCurve(
  points: Array<{ timestamp: string; value: number }>,
  baseline: number,
): Array<{ timestamp: string; value: number }> {
  return points.map((point) => ({
    timestamp: point.timestamp,
    value: normalizeMoney(point.value - baseline),
  }));
}

function createGapCurve(
  sourceCurve: Array<{ timestamp: string; value: number }>,
  sessionCurve: Array<{ timestamp: string; value: number }>,
): Array<{ timestamp: string; value: number }> {
  const allTimestamps = Array.from(
    new Set([...sourceCurve.map((p) => p.timestamp), ...sessionCurve.map((p) => p.timestamp)]),
  ).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  return allTimestamps.map((timestamp) => {
    const sourceVal = samplePointAtOrBefore(sourceCurve, timestamp, (p) => p.value);
    const sessionVal = samplePointAtOrBefore(sessionCurve, timestamp, (p) => p.value);
    return {
      timestamp,
      value: normalizeMoney(sourceVal - sessionVal),
    };
  });
}

function buildZeroBasedWindowCurve(
  points: Array<{ timestamp: string; value: number }>,
  startAt: string,
  endAt: string,
): Array<{ timestamp: string; value: number }> {
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  const baselineTimestamp = Number.isFinite(startMs)
    ? new Date(startMs - 1).toISOString()
    : startAt;

  const baseline = samplePointAtOrBefore(points, baselineTimestamp, (p) => p.value);
  const endValue = samplePointAtOrBefore(points, endAt, (p) => p.value);

  const inRange = (timestamp: string): boolean => {
    const ts = new Date(timestamp).getTime();
    if (!Number.isFinite(ts)) return false;
    return ts >= startMs && ts <= endMs;
  };

  const rowsInRange = points.filter((row) => inRange(row.timestamp));
  const withAnchors = [
    { timestamp: startAt, value: baseline },
    ...rowsInRange,
    { timestamp: endAt, value: endValue },
  ];

  const dedupByTimestamp = new Map<string, { timestamp: string; value: number }>();
  for (const row of withAnchors) {
    dedupByTimestamp.set(row.timestamp, row);
  }

  const ordered = Array.from(dedupByTimestamp.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return normalizeCurve(ordered, baseline);
}

export function reduceTrackedWalletEvents(input: {
  events: TrackedWalletEvent[];
  markPriceByKey?: Map<string, number>;
  markMetaByKey?: Map<string, TrackedWalletMarkMeta>;
  inferMissingFields?: boolean;
  hasTruncatedHistory?: boolean;
}): TrackedWalletReductionResult {
  const sortedEvents = [...input.events].sort((a, b) => {
    const byEventTs = a.eventTimestamp.getTime() - b.eventTimestamp.getTime();
    if (byEventTs !== 0) return byEventTs;
    const byCreatedTs = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedTs !== 0) return byCreatedTs;
    return a.id.localeCompare(b.id);
  });

  const state: ReductionMutableState = {
    positionsByKey: new Map(),
    realizedPnlGross: 0,
    fees: 0,
    cashDelta: 0,
    warnings: [],
    seenEventIds: new Set(),
    summary: {
      eventCount: sortedEvents.length,
      tradeLikeEventCount: 0,
      buyEventCount: 0,
      sellEventCount: 0,
      inferredShareEvents: 0,
      inferredPriceEvents: 0,
      missingFeeEvents: 0,
      feeCoveragePct: 100,
      duplicateSkipped: 0,
      inferenceDisabledSkips: 0,
      unsupportedEventCount: 0,
      normalizationFailureCount: 0,
      impossibleStateTransitions: 0,
      missingMarkCount: 0,
      estimatedMarkCount: 0,
      unknownCostBasisPositions: 0,
      eventCountsByType: {
        BUY_FILL: 0,
        SELL_FILL: 0,
        FEE: 0,
        RESOLUTION_PAYOUT: 0,
        TRANSFER_IN: 0,
        TRANSFER_OUT: 0,
        UNSUPPORTED: 0,
      },
    },
    inferMissingFields: input.inferMissingFields ?? true,
    ledger: [],
    knownRealizedContribution: 0,
    estimatedRealizedContribution: 0,
    canonicalFees: 0,
    markMetaByKey: input.markMetaByKey ?? new Map<string, TrackedWalletMarkMeta>(),
    missingMarkCount: 0,
    estimatedMarkCount: 0,
    hasTruncatedHistory: input.hasTruncatedHistory ?? false,
    unknownCostBasisPositions: new Set<string>(),
    impossibleStateTransitions: 0,
    normalizationFailureCount: 0,
  };

  const markPriceByKey = input.markPriceByKey ?? new Map<string, number>();
  const timeline: TrackedWalletTimelinePoint[] = [];
  const estimatedMarkCounter = { value: 0 };
  const missingMarkCounter = { value: 0 };

  for (const event of sortedEvents) {
    if (state.seenEventIds.has(event.id)) {
      state.summary.duplicateSkipped += 1;
      pushLedgerEvent(state, event, 'UNSUPPORTED', {
        note: 'duplicate event skipped',
      });
      state.warnings.push({
        code: 'DUPLICATE_EVENT_SKIPPED',
        eventId: event.id,
        message: 'Duplicate event id encountered and ignored.',
      });
      continue;
    }
    state.seenEventIds.add(event.id);

    const eventType = String(event.eventType).toUpperCase();
    if (!TRADE_LIKE_EVENT_TYPES.has(eventType as TradeLikeEventType)) {
      state.summary.unsupportedEventCount += 1;
      pushLedgerEvent(state, event, 'UNSUPPORTED', {
        note: `unsupported event type ${eventType}`,
      });
      state.warnings.push({
        code: 'UNSUPPORTED_EVENT_RECORDED',
        eventId: event.id,
        message: 'Event is not trade-like and was ignored by the ledger reducer.',
      });
      continue;
    }

    const side = resolveEventSide(event);
    if (side === null) {
      state.summary.unsupportedEventCount += 1;
      pushLedgerEvent(state, event, 'UNSUPPORTED', {
        note: 'event side unresolved',
      });
      state.warnings.push({
        code: 'UNSUPPORTED_EVENT_RECORDED',
        eventId: event.id,
        message: 'Event side could not be resolved and was ignored.',
      });
      continue;
    }

    state.summary.tradeLikeEventCount += 1;
    const feeMissing = event.fee === null || event.fee === undefined;
    if (feeMissing) {
      state.summary.missingFeeEvents += 1;
      state.warnings.push({
        code: 'MISSING_FEE_DETECTED',
        eventId: event.id,
        message: 'Event had no explicit fee; canonical known net is not fully authoritative.',
      });
    }

    const marketKey = normalizeMarketKey({
      conditionId: event.conditionId,
      marketId: event.marketId,
    });
    const outcome = normalizeOutcome(event.outcome);

    let processed = false;
    if (side === 'BUY') {
      state.summary.buyEventCount += 1;
      processed = applyBuy(state, event, marketKey, outcome);
    } else {
      state.summary.sellEventCount += 1;
      processed = applySell(state, event, marketKey, outcome);
    }

    if (!processed) continue;

    const { unrealizedPnl, openMarketValue, knownUnrealizedPnl } = computeUnrealizedAndOpenValue({
      positionsByKey: state.positionsByKey,
      markPriceByKey,
      markMetaByKey: state.markMetaByKey,
      hasTruncatedHistory: state.hasTruncatedHistory,
      unknownCostBasisPositions: state.unknownCostBasisPositions,
      estimatedMarkCounter,
      missingMarkCounter,
    });

    const netPnl = normalizeMoney(state.realizedPnlGross + unrealizedPnl - state.fees);
    const canonicalKnownNetPnl = normalizeMoney(
      state.knownRealizedContribution + knownUnrealizedPnl - state.canonicalFees,
    );
    const reconstructedAccountValue = normalizeMoney(state.cashDelta + openMarketValue);

    timeline.push({
      index: timeline.length,
      eventId: event.id,
      eventTimestamp: event.eventTimestamp.toISOString(),
      eventType,
      marketId: event.marketId,
      outcome: event.outcome,
      side,
      realizedPnlGross: normalizeMoney(state.realizedPnlGross),
      unrealizedPnl,
      fees: normalizeMoney(state.fees),
      netPnl: ensureFinite(netPnl),
      cashDelta: normalizeMoney(state.cashDelta),
      openMarketValue,
      reconstructedAccountValue: ensureFinite(reconstructedAccountValue),
    });

    if (!Number.isFinite(canonicalKnownNetPnl) || !Number.isFinite(netPnl)) {
      state.summary.normalizationFailureCount += 1;
      state.warnings.push({
        code: 'INVALID_NUMERIC_STATE',
        eventId: event.id,
        message: 'Non-finite numeric value detected while materializing timeline.',
      });
    }
  }

  const { unrealizedPnl, openMarketValue, knownUnrealizedPnl, estimatedUnrealizedPnl } =
    computeUnrealizedAndOpenValue({
      positionsByKey: state.positionsByKey,
      markPriceByKey,
      markMetaByKey: state.markMetaByKey,
      hasTruncatedHistory: state.hasTruncatedHistory,
      unknownCostBasisPositions: state.unknownCostBasisPositions,
      estimatedMarkCounter,
      missingMarkCounter,
    });

  state.missingMarkCount = missingMarkCounter.value;
  state.estimatedMarkCount = estimatedMarkCounter.value;

  const feeCoveragePct =
    state.summary.tradeLikeEventCount > 0
      ? ((state.summary.tradeLikeEventCount - state.summary.missingFeeEvents) /
          state.summary.tradeLikeEventCount) *
        100
      : 100;

  const positions = Array.from(state.positionsByKey.values())
    .map(
      (row): TrackedWalletPosition => ({
        key: row.key,
        marketKey: row.marketKey,
        marketId: row.marketId,
        conditionId: row.conditionId,
        marketQuestion: row.marketQuestion,
        outcome: row.outcome,
        netShares: normalizeMoney(row.netShares),
        avgEntryPrice: normalizeMoney(row.avgEntryPrice),
        currentMarkPrice: normalizeMoney(row.currentMarkPrice),
        realizedPnlGross: normalizeMoney(row.realizedPnlGross),
        unrealizedPnl:
          row.netShares > EPSILON
            ? normalizeMoney(row.netShares * (row.currentMarkPrice - row.avgEntryPrice))
            : 0,
        status: row.netShares > EPSILON ? 'OPEN' : 'CLOSED',
        openedAt: row.openedAt,
        closedAt: row.netShares > EPSILON ? null : row.closedAt,
        lastEventAt: row.lastEventAt,
      }),
    )
    .sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime());

  const unknownCostBasisPositions = Array.from(state.unknownCostBasisPositions.values());
  state.summary.unknownCostBasisPositions = unknownCostBasisPositions.length;
  state.summary.estimatedMarkCount = state.estimatedMarkCount;
  state.summary.missingMarkCount = state.missingMarkCount;

  const realizedPnlGross = normalizeMoney(state.realizedPnlGross);
  const fees = normalizeMoney(state.fees);
  const netPnl = normalizeMoney(realizedPnlGross + unrealizedPnl - fees);

  const canonicalRealizedPnl = normalizeMoney(state.knownRealizedContribution);
  const canonicalUnrealizedPnl = normalizeMoney(knownUnrealizedPnl);
  const canonicalFees = normalizeMoney(state.canonicalFees);
  const hasMissingFees = state.summary.missingFeeEvents > 0;
  const hasUnknownCostBasis = unknownCostBasisPositions.length > 0;
  const hasUnsupportedEvents = state.summary.unsupportedEventCount > 0;
  const hasEstimatedMarks = state.estimatedMarkCount > 0 || state.missingMarkCount > 0;

  let canonicalKnownNetPnl: number | null = null;
  if (!hasMissingFees && !hasUnknownCostBasis) {
    canonicalKnownNetPnl = normalizeMoney(
      canonicalRealizedPnl + canonicalUnrealizedPnl - canonicalFees,
    );
  }

  const estimatedNetPnl = normalizeMoney(
    netPnl -
      (canonicalKnownNetPnl ??
        normalizeMoney(canonicalRealizedPnl + canonicalUnrealizedPnl - canonicalFees)),
  );

  if (canonicalKnownNetPnl === null) {
    state.warnings.push({
      code: 'NO_AUTHORITATIVE_NET',
      eventId: 'SYSTEM',
      message:
        'Canonical known net PnL is withheld because fees or cost basis are not fully known for the requested reduction window.',
    });
  }

  if (unknownCostBasisPositions.length > 0) {
    for (const key of unknownCostBasisPositions) {
      state.warnings.push({
        code: 'UNKNOWN_COST_BASIS_OPEN_POSITION',
        eventId: 'SYSTEM',
        message: `Open position ${key} has unknown cost basis due to truncated history.`,
      });
    }
  }

  const confidenceWarnings: string[] = [];
  if (state.hasTruncatedHistory) confidenceWarnings.push('history-truncated');
  if (hasUnsupportedEvents) confidenceWarnings.push('unsupported-events');
  if (hasUnknownCostBasis) confidenceWarnings.push('unknown-cost-basis');
  if (hasEstimatedMarks) confidenceWarnings.push('estimated-or-missing-marks');
  if (hasMissingFees) confidenceWarnings.push('missing-fees');

  const confidenceModel = buildConfidenceModel({
    hasTruncatedHistory: state.hasTruncatedHistory,
    hasUnsupportedEvents,
    hasUnknownCostBasis,
    hasEstimatedMarks,
    hasMissingFees,
    warnings: confidenceWarnings,
  });

  const debugReport: TrackedWalletDebugReport = {
    eventCountsByType: { ...state.summary.eventCountsByType },
    ingestedEventCount: state.summary.eventCount,
    duplicateCount: state.summary.duplicateSkipped,
    normalizationFailures: state.summary.normalizationFailureCount,
    unsupportedIgnoredEvents: state.summary.unsupportedEventCount,
    incompleteHistoryReconstructedPositions: unknownCostBasisPositions.length,
    realizedContribution: {
      known: normalizeMoney(state.knownRealizedContribution),
      estimated: normalizeMoney(state.estimatedRealizedContribution),
    },
    unrealizedContribution: {
      known: normalizeMoney(knownUnrealizedPnl),
      estimated: normalizeMoney(estimatedUnrealizedPnl),
    },
    knownVsEstimatedContribution: {
      knownNetPnl: canonicalKnownNetPnl,
      estimatedNetPnl,
    },
    impossibleStateTransitions: state.impossibleStateTransitions,
    firstEventTimestamp: sortedEvents[0]?.eventTimestamp.toISOString() ?? null,
    lastEventTimestamp: sortedEvents.at(-1)?.eventTimestamp.toISOString() ?? null,
    unknownCostBasisPositions,
  };

  return {
    realizedPnlGross,
    unrealizedPnl,
    fees,
    netPnl,
    cashDelta: normalizeMoney(state.cashDelta),
    openMarketValue,
    reconstructedAccountValue: normalizeMoney(state.cashDelta + openMarketValue),
    positions,
    timeline,
    warnings: state.warnings,
    summary: {
      ...state.summary,
      feeCoveragePct: normalizeMoney(feeCoveragePct),
    },
    ledger: state.ledger,
    canonical: {
      canonicalKnownNetPnl,
      canonicalRealizedPnl,
      canonicalUnrealizedPnl,
      canonicalFees,
      estimatedNetPnl,
    },
    confidenceModel,
    debugReport,
  };
}

function bucketSizeMs(bucket: TimelineBucket): number {
  if (bucket === '5M') return 5 * 60_000;
  if (bucket === '15M') return 15 * 60_000;
  if (bucket === '1H') return 60 * 60_000;
  return 0;
}

export function bucketTrackedWalletTimeline(
  timeline: TrackedWalletTimelinePoint[],
  bucket: TimelineBucket,
): TrackedWalletTimelinePoint[] {
  if (bucket === 'RAW') return timeline;
  const sizeMs = bucketSizeMs(bucket);
  if (sizeMs <= 0 || timeline.length === 0) return timeline;

  const byBucket = new Map<number, TrackedWalletTimelinePoint>();
  for (const point of timeline) {
    const ts = new Date(point.eventTimestamp).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucketStart = Math.floor(ts / sizeMs) * sizeMs;
    const existing = byBucket.get(bucketStart);
    if (
      !existing ||
      new Date(point.eventTimestamp).getTime() >= new Date(existing.eventTimestamp).getTime()
    ) {
      byBucket.set(bucketStart, point);
    }
  }

  return Array.from(byBucket.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, point]) => point);
}

export function compareSourceVsSession(input: {
  sourceTimeline: TrackedWalletTimelinePoint[];
  sessionTimeline: SessionTimelinePoint[];
  windowStart: string;
  windowEnd: string;
}): SourceVsSessionComparison {
  const startMs = new Date(input.windowStart).getTime();
  const baselineTimestamp = Number.isFinite(startMs)
    ? new Date(startMs - 1).toISOString()
    : input.windowStart;

  const sourceCurveRaw = input.sourceTimeline.map((point) => ({
    timestamp: point.eventTimestamp,
    value: point.netPnl,
  }));
  const sessionCurveRaw = input.sessionTimeline.map((point) => ({
    timestamp: point.timestamp,
    value: point.totalPnl,
  }));

  const sourceCurve = buildZeroBasedWindowCurve(sourceCurveRaw, input.windowStart, input.windowEnd);
  const sessionCurve = buildZeroBasedWindowCurve(
    sessionCurveRaw,
    input.windowStart,
    input.windowEnd,
  );

  const sourceNetPnl = samplePointAtOrBefore(sourceCurve, input.windowEnd, (p) => p.value);
  const sessionNetPnl = samplePointAtOrBefore(sessionCurve, input.windowEnd, (p) => p.value);

  const sourceRealizedStart = samplePointAtOrBefore(
    input.sourceTimeline.map((p) => ({ timestamp: p.eventTimestamp, value: p.realizedPnlGross })),
    baselineTimestamp,
    (p) => p.value,
  );
  const sourceRealizedEnd = samplePointAtOrBefore(
    input.sourceTimeline.map((p) => ({ timestamp: p.eventTimestamp, value: p.realizedPnlGross })),
    input.windowEnd,
    (p) => p.value,
  );

  const sourceFeesStart = samplePointAtOrBefore(
    input.sourceTimeline.map((p) => ({ timestamp: p.eventTimestamp, value: p.fees })),
    baselineTimestamp,
    (p) => p.value,
  );
  const sourceFeesEnd = samplePointAtOrBefore(
    input.sourceTimeline.map((p) => ({ timestamp: p.eventTimestamp, value: p.fees })),
    input.windowEnd,
    (p) => p.value,
  );

  const sourceUnrealizedStart = samplePointAtOrBefore(
    input.sourceTimeline.map((p) => ({ timestamp: p.eventTimestamp, value: p.unrealizedPnl })),
    baselineTimestamp,
    (p) => p.value,
  );
  const sourceUnrealizedEnd = samplePointAtOrBefore(
    input.sourceTimeline.map((p) => ({ timestamp: p.eventTimestamp, value: p.unrealizedPnl })),
    input.windowEnd,
    (p) => p.value,
  );

  const sessionRealizedStart = samplePointAtOrBefore(
    input.sessionTimeline.map((p) => ({ timestamp: p.timestamp, value: p.realizedPnl })),
    baselineTimestamp,
    (p) => p.value,
  );
  const sessionRealizedEnd = samplePointAtOrBefore(
    input.sessionTimeline.map((p) => ({ timestamp: p.timestamp, value: p.realizedPnl })),
    input.windowEnd,
    (p) => p.value,
  );

  const sessionFeesStart = samplePointAtOrBefore(
    input.sessionTimeline.map((p) => ({ timestamp: p.timestamp, value: p.fees })),
    baselineTimestamp,
    (p) => p.value,
  );
  const sessionFeesEnd = samplePointAtOrBefore(
    input.sessionTimeline.map((p) => ({ timestamp: p.timestamp, value: p.fees })),
    input.windowEnd,
    (p) => p.value,
  );

  const sessionUnrealizedStart = samplePointAtOrBefore(
    input.sessionTimeline.map((p) => ({ timestamp: p.timestamp, value: p.unrealizedPnl })),
    baselineTimestamp,
    (p) => p.value,
  );
  const sessionUnrealizedEnd = samplePointAtOrBefore(
    input.sessionTimeline.map((p) => ({ timestamp: p.timestamp, value: p.unrealizedPnl })),
    input.windowEnd,
    (p) => p.value,
  );

  const sourceRealized = normalizeMoney(sourceRealizedEnd - sourceRealizedStart);
  const sourceFees = normalizeMoney(sourceFeesEnd - sourceFeesStart);
  const sourceUnrealized = normalizeMoney(sourceUnrealizedEnd - sourceUnrealizedStart);

  const sessionRealized = normalizeMoney(sessionRealizedEnd - sessionRealizedStart);
  const sessionFees = normalizeMoney(sessionFeesEnd - sessionFeesStart);
  const sessionUnrealized = normalizeMoney(sessionUnrealizedEnd - sessionUnrealizedStart);

  const feeGap = normalizeMoney(sessionFees - sourceFees);
  const realizedGap = normalizeMoney(sourceRealized - sessionRealized);
  const unrealizedGap = normalizeMoney(sourceUnrealized - sessionUnrealized);
  const netPnlGap = normalizeMoney(sourceNetPnl - sessionNetPnl);

  const frictionDrag = normalizeMoney(Math.max(0, netPnlGap));
  const executionDrag = normalizeMoney(Math.max(0, feeGap));
  const percentGap =
    Math.abs(sourceNetPnl) > EPSILON ? normalizeMoney((netPnlGap / sourceNetPnl) * 100) : null;

  let dominantDriver: SourceVsSessionComparison['diagnosis']['dominantDriver'] = 'NEUTRAL';
  if (
    frictionDrag > Math.abs(sourceNetPnl) * 0.25 &&
    executionDrag >= Math.abs(realizedGap) * 0.5
  ) {
    dominantDriver = 'COPY_FRICTION';
  } else if (sessionUnrealized < sourceUnrealized - 1) {
    dominantDriver = 'SESSION_UNREALIZED_DRAG';
  } else if (sourceNetPnl <= 0 && sessionNetPnl <= 0) {
    dominantDriver = 'SOURCE_DETERIORATION';
  } else if (Math.abs(netPnlGap) > EPSILON) {
    dominantDriver = 'MIXED';
  }

  const summary =
    dominantDriver === 'COPY_FRICTION'
      ? 'Session underperformance is primarily explained by execution friction and fee drag.'
      : dominantDriver === 'SESSION_UNREALIZED_DRAG'
        ? 'Session is lagging due to weaker open inventory mark-to-market relative to source.'
        : dominantDriver === 'SOURCE_DETERIORATION'
          ? 'Both source and copy are deteriorating over this window; edge decay dominates.'
          : dominantDriver === 'MIXED'
            ? 'Source and session divergence is mixed between source edge shifts and copy friction.'
            : 'Source and session are broadly aligned over this window.';

  return {
    source: {
      realizedPnlGross: sourceRealized,
      unrealizedPnl: sourceUnrealized,
      fees: sourceFees,
      netPnl: sourceNetPnl,
    },
    session: {
      realizedPnlGross: sessionRealized,
      unrealizedPnl: sessionUnrealized,
      fees: sessionFees,
      netPnl: sessionNetPnl,
    },
    gaps: {
      netPnlGap,
      realizedGap,
      unrealizedGap,
      feeGap,
      frictionDrag,
      executionDrag,
      percentGap,
    },
    curves: {
      sourceNetPnl: sourceCurve,
      sessionNetPnl: sessionCurve,
      gap: createGapCurve(sourceCurve, sessionCurve),
    },
    diagnosis: {
      dominantDriver,
      summary,
    },
  };
}
