/**
 * paper-session-market-routes.ts — New API endpoints for per-market position detail.
 *
 * These routes fulfill the spec requirements:
 *   - Position history popup (per-market trade sequence)
 *   - History view (per-market performance summary)
 *
 * INTEGRATION: Import and call `registerPaperSessionMarketRoutes(app)` from routes.ts.
 */

import { z } from 'zod';
import { prisma } from './lib/prisma.js';
import { LedgerEntry, computeMarketTradeHistory, computeMarketSummaries } from './lib/paper-ledger';

const db = prisma as any;

/**
 * Convert a DB trade row into a LedgerEntry for the pure accounting functions.
 */
function tradeRowToLedgerEntry(row: Record<string, any>): LedgerEntry {
  const shares = Number(row.simulatedShares ?? 0);
  const price = Number(row.simulatedPrice ?? 0);
  return {
    id: row.id,
    sourceEventId: row.sourceActivityEventId ?? null,
    marketId: row.marketId,
    outcome: (row.outcome ?? 'UNKNOWN').toUpperCase(),
    side: row.side as 'BUY' | 'SELL',
    action: row.action ?? row.side,
    shares,
    price,
    notional: shares * price,
    fee: Number(row.feeApplied ?? 0),
    slippage: Number(row.slippageApplied ?? 0),
    timestamp:
      row.eventTimestamp instanceof Date ? row.eventTimestamp : new Date(row.eventTimestamp),
  };
}

export function registerPaperSessionMarketRoutes(app: any) {
  /**
   * GET /paper-copy-sessions/:id/positions/:marketId/:outcome/trades
   *
   * Returns the full per-trade history for a specific market:outcome position.
   *
   * Each row contains:
   *   - timestamp
   *   - action type (BUY, SELL, REDEEM, CLOSE, etc.)
   *   - shares
   *   - price
   *   - realized PnL for that specific trade
   *   - running netShares and avgEntryPrice after the trade
   *
   * This powers the POSITION HISTORY POPUP in the UI.
   */
  app.get('/paper-copy-sessions/:id/positions/:marketId/:outcome/trades', async (req: any) => {
    const params = z
      .object({
        id: z.string().uuid(),
        marketId: z.string().min(1),
        outcome: z.string().min(1),
      })
      .parse(req.params);

    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      })
      .parse(req.query ?? {});

    const session = await db.paperCopySession.findUnique({
      where: { id: params.id },
      select: { id: true },
    });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const normalizedOutcome = params.outcome.toUpperCase();

    const rows = await db.paperCopyTrade.findMany({
      where: {
        sessionId: params.id,
        marketId: params.marketId,
        outcome: normalizedOutcome,
      },
      orderBy: [{ eventTimestamp: 'asc' }, { createdAt: 'asc' }],
      take: query.limit,
    });

    const entries = rows.map(tradeRowToLedgerEntry);
    const history = computeMarketTradeHistory(params.marketId, normalizedOutcome, entries);

    // Fetch position metadata (market question, current mark price)
    const position = await db.paperCopyPosition.findFirst({
      where: {
        sessionId: params.id,
        marketId: params.marketId,
        outcome: normalizedOutcome,
      },
      select: {
        marketQuestion: true,
        currentMarkPrice: true,
        netShares: true,
        avgEntryPrice: true,
        realizedPnl: true,
        unrealizedPnl: true,
        status: true,
      },
    });

    return {
      marketId: params.marketId,
      outcome: normalizedOutcome,
      marketQuestion: position?.marketQuestion ?? null,
      currentPosition: position
        ? {
            netShares: Number(position.netShares),
            avgEntryPrice: Number(position.avgEntryPrice),
            currentMarkPrice: Number(position.currentMarkPrice),
            realizedPnl: Number(position.realizedPnl),
            unrealizedPnl: Number(position.unrealizedPnl),
            status: position.status,
          }
        : null,
      tradeCount: history.length,
      trades: history.map((t) => ({
        id: t.id,
        timestamp: t.timestamp.toISOString(),
        action: t.action,
        side: t.side,
        shares: t.shares,
        price: t.price,
        fee: t.fee,
        realizedPnl: Math.round(t.realizedPnl * 10000) / 10000,
        netSharesAfter: t.netSharesAfter,
        avgEntryPriceAfter: Math.round(t.avgEntryPriceAfter * 100000000) / 100000000,
      })),
    };
  });

  /**
   * GET /paper-copy-sessions/:id/market-summary
   *
   * Returns per-market performance summaries for all markets in a session.
   *
   * Each row contains:
   *   - market name (question text)
   *   - total invested
   *   - total returned
   *   - net realized PnL
   *   - current position size and status
   *
   * This powers the HISTORY VIEW in the UI.
   */
  app.get('/paper-copy-sessions/:id/market-summary', async (req: any) => {
    const params = z
      .object({
        id: z.string().uuid(),
      })
      .parse(req.params);

    const query = z
      .object({
        status: z.enum(['ALL', 'OPEN', 'CLOSED']).default('ALL'),
        sortBy: z.enum(['pnl', 'invested', 'returned', 'market']).default('pnl'),
        limit: z.coerce.number().int().min(1).max(2500).default(100),
      })
      .parse(req.query ?? {});

    const session = await db.paperCopySession.findUnique({
      where: { id: params.id },
      select: { id: true, startingCash: true },
    });
    if (!session) throw app.httpErrors.notFound('Session not found');

    // Fetch all trades for this session
    const rows = await db.paperCopyTrade.findMany({
      where: { sessionId: params.id },
      orderBy: [{ eventTimestamp: 'asc' }, { createdAt: 'asc' }],
    });

    const entries = rows.map(tradeRowToLedgerEntry);
    let summaries = computeMarketSummaries(entries);

    // Enrich with market question names from positions table
    const positions = await db.paperCopyPosition.findMany({
      where: { sessionId: params.id },
      select: { marketId: true, outcome: true, marketQuestion: true, unrealizedPnl: true },
    });

    const questionMap = new Map<string, string>();
    const unrealizedMap = new Map<string, number>();
    for (const pos of positions) {
      const key = `${pos.marketId}:${(pos.outcome ?? '').toUpperCase()}`;
      if (pos.marketQuestion) questionMap.set(key, pos.marketQuestion);
      unrealizedMap.set(key, Number(pos.unrealizedPnl ?? 0));
    }

    // Filter by status
    if (query.status !== 'ALL') {
      summaries = summaries.filter((s) => s.status === query.status);
    }

    // Sort
    switch (query.sortBy) {
      case 'pnl':
        summaries.sort((a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl));
        break;
      case 'invested':
        summaries.sort((a, b) => b.totalInvested - a.totalInvested);
        break;
      case 'returned':
        summaries.sort((a, b) => b.totalReturned - a.totalReturned);
        break;
      case 'market':
        summaries.sort((a, b) => a.marketId.localeCompare(b.marketId));
        break;
    }

    // Limit
    summaries = summaries.slice(0, query.limit);

    return {
      sessionId: params.id,
      marketCount: summaries.length,
      markets: summaries.map((s) => {
        const key = `${s.marketId}:${s.outcome}`;
        const unrealizedPnl = unrealizedMap.get(key) ?? 0;
        const netPnl = s.realizedPnl + unrealizedPnl - s.fees;
        return {
          marketId: s.marketId,
          outcome: s.outcome,
          marketQuestion: questionMap.get(key) ?? null,
          totalInvested: Math.round(s.totalInvested * 100) / 100,
          totalReturned: Math.round(s.totalReturned * 100) / 100,
          realizedPnl: Math.round(s.realizedPnl * 100) / 100,
          fees: Math.round(s.fees * 100) / 100,
          netPnl: Math.round(netPnl * 100) / 100,
          // Legacy alias kept for backwards compatibility with existing consumers.
          netRealizedPnl: Math.round(s.realizedPnl * 100) / 100,
          unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
          currentNetShares: s.currentNetShares,
          avgEntryPrice: s.avgEntryPrice,
          status: s.status,
          tradeCount: s.tradeCount,
          buyCount: s.buyCount,
          sellCount: s.sellCount,
        };
      }),
    };
  });

  /**
   * GET /paper-copy-sessions/:id/positions-grouped
   *
   * Returns positions grouped by market (combining YES/NO outcomes).
   *
   * This powers the grouped position view in the UI where
   * clicking a market opens the position history popup.
   */
  app.get('/paper-copy-sessions/:id/positions-grouped', async (req: any) => {
    const params = z
      .object({
        id: z.string().uuid(),
      })
      .parse(req.params);

    const query = z
      .object({
        status: z.enum(['ALL', 'OPEN', 'CLOSED']).default('ALL'),
      })
      .parse(req.query ?? {});

    const session = await db.paperCopySession.findUnique({
      where: { id: params.id },
      select: { id: true },
    });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const whereClause: Record<string, any> = { sessionId: params.id };
    if (query.status !== 'ALL') {
      whereClause.status = query.status;
    }

    const positions = await db.paperCopyPosition.findMany({
      where: whereClause,
      orderBy: [{ status: 'asc' }, { realizedPnl: 'desc' }],
    });

    // Group by marketId (may have YES and NO outcomes)
    const grouped = new Map<
      string,
      {
        marketId: string;
        marketQuestion: string | null;
        outcomes: Array<{
          outcome: string;
          netShares: number;
          avgEntryPrice: number;
          currentMarkPrice: number;
          realizedPnl: number;
          unrealizedPnl: number;
          status: string;
        }>;
        totalRealizedPnl: number;
        totalUnrealizedPnl: number;
        hasOpenPositions: boolean;
      }
    >();

    for (const pos of positions) {
      const marketId = pos.marketId;
      let group = grouped.get(marketId);
      if (!group) {
        group = {
          marketId,
          marketQuestion: pos.marketQuestion ?? null,
          outcomes: [],
          totalRealizedPnl: 0,
          totalUnrealizedPnl: 0,
          hasOpenPositions: false,
        };
        grouped.set(marketId, group);
      }

      const realized = Number(pos.realizedPnl ?? 0);
      const unrealized = Number(pos.unrealizedPnl ?? 0);

      group.outcomes.push({
        outcome: pos.outcome,
        netShares: Number(pos.netShares),
        avgEntryPrice: Number(pos.avgEntryPrice),
        currentMarkPrice: Number(pos.currentMarkPrice),
        realizedPnl: realized,
        unrealizedPnl: unrealized,
        status: pos.status,
      });

      group.totalRealizedPnl += realized;
      group.totalUnrealizedPnl += unrealized;
      if (pos.status === 'OPEN') group.hasOpenPositions = true;
      if (pos.marketQuestion) group.marketQuestion = pos.marketQuestion;
    }

    const markets = [...grouped.values()].map((g) => ({
      ...g,
      totalRealizedPnl: Math.round(g.totalRealizedPnl * 100) / 100,
      totalUnrealizedPnl: Math.round(g.totalUnrealizedPnl * 100) / 100,
      totalPnl: Math.round((g.totalRealizedPnl + g.totalUnrealizedPnl) * 100) / 100,
    }));

    return {
      sessionId: params.id,
      marketCount: markets.length,
      markets,
    };
  });
}
