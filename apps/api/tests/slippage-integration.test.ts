import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { evaluatePaperEventDecision, PAPER_REASON_CODES, type ProjectedPositionState } from '../src/modules/paper-decisioning.js';
import { resolvePaperExecutor } from '../src/modules/paper-executor.js';

describe('Slippage & Execution Integration tests', () => {
  let walletId: string;
  let sessionId: string;

  beforeAll(async () => {
    await prisma.watchedWallet.deleteMany({ where: { address: '0xTestWalletIntegrationSlippage' } });
    const wallet = await prisma.watchedWallet.create({
      data: {
        address: '0xTestWalletIntegrationSlippage',
        label: 'Test Wallet Slippage',
      },
    });
    walletId = wallet.id;

    const session = await prisma.paperCopySession.create({
      data: {
        trackedWalletId: walletId,
        trackedWalletAddress: wallet.address,
        status: 'RUNNING',
        startingCash: 10000,
        currentCash: 10000,
        slippageConfig: {
          enabled: true,
          mode: 'FIXED_PERCENT',
          fixedPercent: 0.05, // 5% worse
        },
      } as any,
    });
    sessionId = session.id;
  });

  afterAll(async () => {
    if (sessionId) await prisma.paperCopySession.delete({ where: { id: sessionId } });
    if (walletId) await prisma.watchedWallet.delete({ where: { id: walletId } });
  });

  it('evaluates BUY decision with slippage, executes it, and verifies fillPrice in ledger', async () => {
    const session = await prisma.paperCopySession.findUniqueOrThrow({ where: { id: sessionId } });

    const now = new Date();
    const event = {
      id: 'test_event_1',
      trackedWalletId: walletId,
      eventType: 'BUY',
      marketId: 'market_1',
      outcome: 'YES',
      side: 'BUY',
      price: 0.5,
      shares: 100,
      notional: 50,
      eventTimestamp: now,
      detectedAt: now, // 0 latency
    };

    const positionStateByKey = new Map<string, ProjectedPositionState>();

    const decisionDraft = evaluatePaperEventDecision({
      session,
      event,
      projectedCash: 10000,
      projectedGrossExposure: 0,
      positionStateByKey,
    });

    expect(decisionDraft.decisionType).toBe('COPY');
    expect(decisionDraft.intendedFillPrice).toBe(0.525); // 0.5 * 1.05

    // Save decision manually to satisfy FK
    const decisionRow = await prisma.paperCopyDecision.create({
      data: {
        sessionId,
        trackedWalletId: walletId,
        decisionType: decisionDraft.decisionType,
        status: decisionDraft.status,
        executorType: decisionDraft.executorType,
        marketId: decisionDraft.marketId,
        outcome: decisionDraft.outcome,
        side: decisionDraft.side,
        sourceShares: decisionDraft.sourceShares,
        simulatedShares: decisionDraft.simulatedShares,
        sourcePrice: decisionDraft.sourcePrice,
        intendedFillPrice: decisionDraft.intendedFillPrice,
        reasonCode: decisionDraft.reasonCode,
        humanReason: decisionDraft.humanReason,
        sizingInputsJson: decisionDraft.sizingInputsJson as any ?? {},
      },
    });

    // Execute it
    const executor = resolvePaperExecutor('PAPER');
    const execRes = await executor.execute({ session, decision: decisionRow });

    expect(execRes.status).toBe('EXECUTED');
    expect(execRes.fillPrice).toBe(0.525);

    // Verify it is in the ledger preserving source vs fill price
    const trade = await prisma.paperCopyTrade.findUniqueOrThrow({ where: { id: execRes.tradeId! } });
    expect(Number(trade.sourcePrice)).toBeCloseTo(0.5);
    expect(Number(trade.simulatedPrice)).toBeCloseTo(0.525);
    
    // Size check
    expect(Number(trade.simulatedShares)).toBe(100);
    expect(Number(trade.notional)).toBeCloseTo(52.5);
  });

  it('skips trade due to MAX_ADVERSE_MOVE', async () => {
    const session = await prisma.paperCopySession.findUniqueOrThrow({ where: { id: sessionId } });
    
    // Inject extreme latency to simulate skipping
    const nowTs = Date.now();
    const eventTimestamp = new Date(nowTs - 10000); // 10s old
    const detectedAt = new Date(nowTs); // high latency

    const skipSession = {
      ...session,
      slippageConfig: {
        enabled: true,
        mode: 'LATENCY_BUCKETED',
        latencyBuckets: [
          { maxMs: 1000, slippagePercent: 0.01 },
          { maxMs: 5000, slippagePercent: 0.05 },
          { maxMs: null, slippagePercent: 0.1, skipTrade: true }, // Should hit this
        ],
      }
    };

    const event = {
      id: 'test_event_2',
      trackedWalletId: walletId,
      eventType: 'BUY',
      marketId: 'market_2',
      outcome: 'NO',
      side: 'BUY',
      price: 0.5,
      shares: 100,
      notional: 50,
      eventTimestamp,
      detectedAt,
    };

    const positionStateByKey = new Map<string, ProjectedPositionState>();

    const decisionDraft = evaluatePaperEventDecision({
      session: skipSession,
      event,
      projectedCash: 10000,
      projectedGrossExposure: 0,
      positionStateByKey,
    });

    expect(decisionDraft.decisionType).toBe('SKIP');
    expect(decisionDraft.reasonCode).toBe(PAPER_REASON_CODES.SKIP_MAX_ADVERSE_MOVE);
    expect(decisionDraft.status).toBe('SKIPPED');
  });

});
