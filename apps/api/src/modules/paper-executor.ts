import type { PaperCopySession } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { PAPER_REASON_CODES } from './paper-decisioning.js';

export type PaperExecutionResult = {
  status: 'EXECUTED' | 'FAILED' | 'SKIPPED';
  reasonCode: string;
  humanReason: string;
  cashDelta: number;
  fillShares: number;
  fillPrice: number;
  tradeId: string | null;
  errorMessage: string | null;
};

export type PaperExecutorPort = {
  readonly executorType: 'PAPER' | 'DRY_RUN' | 'LIVE';
  execute(input: {
    session: Pick<
      PaperCopySession,
      'id' | 'trackedWalletId' | 'trackedWalletAddress' | 'feeBps' | 'slippageBps'
    >;
    decision: Record<string, any>;
  }): Promise<PaperExecutionResult>;
};

export class PaperLedgerExecutor implements PaperExecutorPort {
  public readonly executorType = 'PAPER' as const;

  async execute(input: {
    session: Pick<
      PaperCopySession,
      'id' | 'trackedWalletId' | 'trackedWalletAddress' | 'feeBps' | 'slippageBps'
    >;
    decision: Record<string, any>;
  }): Promise<PaperExecutionResult> {
    const { session, decision } = input;

    if (decision.status === 'SKIPPED') {
      return {
        status: 'SKIPPED',
        reasonCode: decision.reasonCode,
        humanReason: decision.humanReason,
        cashDelta: 0,
        fillShares: 0,
        fillPrice: 0,
        tradeId: null,
        errorMessage: null,
      };
    }

    const side = decision.side;
    const fillPrice = decision.intendedFillPrice ? Number(decision.intendedFillPrice) : 0;
    const fillShares = decision.simulatedShares ? Number(decision.simulatedShares) : 0;

    if (!side || fillPrice <= 0 || fillShares <= 0 || !decision.marketId || !decision.outcome) {
      return {
        status: 'FAILED',
        reasonCode: PAPER_REASON_CODES.EXECUTION_FAILED_RUNTIME,
        humanReason: 'Decision payload is incomplete for canonical ledger execution.',
        cashDelta: 0,
        fillShares: 0,
        fillPrice: 0,
        tradeId: null,
        errorMessage: 'Decision payload incomplete',
      };
    }

    const notional = fillShares * fillPrice;
    const feeApplied = notional * (Number(session.feeBps) / 10_000);
    const now = new Date();

    try {
      const trade = await prisma.paperCopyTrade.create({
        data: {
          sessionId: session.id,
          trackedWalletId: session.trackedWalletId,
          walletAddress: session.trackedWalletAddress,
          sourceType: decision.decisionType === 'BOOTSTRAP' ? 'BOOTSTRAP' : 'WALLET_ACTIVITY',
          sourceEventTimestamp: decision.sourceEventTimestamp,
          sourceTxHash: decision.sourceTxHash,
          executorType: 'PAPER_EXECUTOR',
          isBootstrap: decision.decisionType === 'BOOTSTRAP',
          sourceActivityEventId: decision.sourceActivityEventId,
          decisionId: decision.id,
          marketId: decision.marketId,
          marketQuestion: decision.marketQuestion,
          outcome: decision.outcome,
          side,
          action: decision.decisionType,
          sourcePrice: decision.sourcePrice,
          simulatedPrice: fillPrice,
          sourceShares: decision.sourceShares,
          simulatedShares: fillShares,
          notional,
          feeApplied,
          slippageApplied:
            decision.sourcePrice !== null
              ? fillPrice - Number(decision.sourcePrice)
              : Number(session.slippageBps) / 10_000,
          eventTimestamp: decision.sourceEventTimestamp ?? now,
          processedAt: now,
          reasoning: {
            decisionId: decision.id,
            decisionType: decision.decisionType,
            reasonCode: decision.reasonCode,
            humanReason: decision.humanReason,
            sizingInputs: decision.sizingInputsJson,
            riskChecks: decision.riskChecksJson,
          },
        },
      });

      const cashDelta = side === 'BUY' ? -(notional + feeApplied) : notional - feeApplied;

      return {
        status: 'EXECUTED',
        reasonCode: decision.reasonCode,
        humanReason: decision.humanReason,
        cashDelta,
        fillShares,
        fillPrice,
        tradeId: trade.id,
        errorMessage: null,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown insert failure';
      return {
        status: 'FAILED',
        reasonCode: PAPER_REASON_CODES.EXECUTION_FAILED_INSERT,
        humanReason: 'Failed to append canonical ledger entry for approved decision.',
        cashDelta: 0,
        fillShares: 0,
        fillPrice: 0,
        tradeId: null,
        errorMessage,
      };
    }
  }
}

export class DryRunExecutor implements PaperExecutorPort {
  public readonly executorType = 'DRY_RUN' as const;

  async execute(input: {
    session: Pick<
      PaperCopySession,
      'id' | 'trackedWalletId' | 'trackedWalletAddress' | 'feeBps' | 'slippageBps'
    >;
    decision: Record<string, any>;
  }): Promise<PaperExecutionResult> {
    return {
      status: 'SKIPPED',
      reasonCode: input.decision.reasonCode,
      humanReason: `Dry-run executor did not place a ledger entry: ${input.decision.humanReason}`,
      cashDelta: 0,
      fillShares: 0,
      fillPrice: 0,
      tradeId: null,
      errorMessage: null,
    };
  }
}

export function resolvePaperExecutor(
  executorType: 'PAPER' | 'DRY_RUN' | 'LIVE',
): PaperExecutorPort {
  if (executorType === 'DRY_RUN') {
    return new DryRunExecutor();
  }
  return new PaperLedgerExecutor();
}
