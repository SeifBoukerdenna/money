import { runBacktest } from '@copytrader/backtest-engine';
import { decideCopyOrder } from '@copytrader/risk-engine';
import { z } from 'zod';

import { config } from './config.js';
import { metricsRegistry } from './lib/metrics.js';
import { prisma } from './lib/prisma.js';
import { eventBus, loadRecentEvents } from './modules/event-stream.js';
import { scheduleWalletPolls } from './modules/ingestion.js';
import { getLatestMarketIntelligence } from './modules/market-intelligence.js';
import { processWalletPoll } from './modules/ingestion.js';
import { createPolymarketDataAdapter } from './modules/polymarket.js';
import {
  createPaperCopySession,
  pausePaperCopySession,
  resumePaperCopySession,
  startPaperCopySession,
  stopPaperCopySession,
} from './modules/paper-copy.js';
import { reconcileWalletExposure } from './modules/reconciliation.js';
import { resolveWalletAddress, shortenAddress } from './modules/wallet-input.js';
import { getWalletLeaderboard } from './modules/wallet-analytics.js';

const walletCreateSchema = z.object({
  input: z.string().min(3),
  label: z.string().optional(),
});

const modeUpdateSchema = z.object({
  strategyId: z.string().uuid(),
  mode: z.enum(['PAPER', 'LIVE']),
  confirmationToken: z.string().optional(),
});

const previewSchema = z.object({
  strategyId: z.string().uuid(),
  event: z.object({
    sourceEventId: z.string(),
    marketId: z.string(),
    outcome: z.string(),
    side: z.enum(['BUY', 'SELL']),
    size: z.number().positive(),
    price: z.number().positive(),
  }),
});

const smartConfigSchema = z.object({
  strategyId: z.string().uuid(),
  profitableWalletsOnly: z.boolean().optional(),
  minSourceTradeUsd: z.number().nullable().optional(),
  firstEntryOnly: z.boolean().optional(),
  ignoreExitTrades: z.boolean().optional(),
  copyClustersOnly: z.boolean().optional(),
  topRankedWalletsOnly: z.boolean().optional(),
  topRankMinWinRate: z.number().nullable().optional(),
  topRankMinSharpeLike: z.number().nullable().optional(),
});

const dataAdapter = createPolymarketDataAdapter();

export async function registerRoutes(app: any): Promise<void> {
  const db = prisma as unknown as Record<string, any>;

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ready' };
  });

  app.get('/metrics', async (_: any, reply: any) => {
    reply.header('content-type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  app.get('/dashboard/overview', async () => {
    const [walletCount, activeWallets, totalTrades, tradesToday, latestTrades] = await Promise.all([
      prisma.watchedWallet.count(),
      prisma.watchedWallet.count({
        where: { enabled: true, copyEnabled: true, syncStatus: 'ACTIVE' },
      }),
      prisma.tradeEvent.count(),
      prisma.tradeEvent.count({
        where: {
          tradedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      prisma.tradeEvent.findMany({
        orderBy: { tradedAt: 'desc' },
        take: 20,
        include: { wallet: true },
      }),
    ]);

    return {
      trackedWallets: walletCount,
      activeWallets,
      totalTrades,
      tradesToday,
      recentWalletActivity: latestTrades.map((row: any) => ({
        walletId: row.walletId,
        label: row.wallet.label,
        address: row.wallet.address,
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        side: row.side,
        price: Number(row.price),
        size: Number(row.size),
        tradedAt: row.tradedAt,
      })),
    };
  });

  app.get('/dashboard/intelligence', async () => {
    const [leaderboard, whaleTrades, clusterSignals, sentiment, activeMarkets] = await Promise.all([
      getWalletLeaderboard('pnl').then((rows) => rows.slice(0, 10)),
      prisma.whaleAlert.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { wallet: true },
      }),
      prisma.clusterSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      getLatestMarketIntelligence(25),
      prisma.tradeEvent.groupBy({
        by: ['marketId'],
        _count: { marketId: true },
        orderBy: { _count: { marketId: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      topWallets: leaderboard,
      recentWhaleTrades: whaleTrades.map((row: any) => ({
        id: row.id,
        wallet: row.wallet.address,
        label: row.wallet.label,
        marketId: row.marketId,
        side: row.side,
        size: Number(row.size),
        price: Number(row.price),
        notionalUsd: Number(row.notionalUsd),
        createdAt: row.createdAt,
      })),
      clusterSignals,
      marketSentiment: sentiment,
      mostActiveMarkets: activeMarkets.map((row: any) => ({
        marketId: row.marketId,
        trades: row._count.marketId,
      })),
    };
  });

  app.patch('/wallets/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        label: z.string().optional(),
        enabled: z.boolean().optional(),
        copyEnabled: z.boolean().optional(),
      })
      .parse(req.body);
    const updateData: Record<string, unknown> = {};
    if (body.label !== undefined) {
      updateData.label = body.label;
    }
    if (body.enabled !== undefined) {
      updateData.enabled = body.enabled;
    }
    if (body.copyEnabled !== undefined) {
      updateData.copyEnabled = body.copyEnabled;
    }
    return prisma.watchedWallet.update({ where: { id: params.id }, data: updateData });
  });

  app.get('/trades', async (req: any) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query ?? {});

    const decisions = await prisma.copyDecision.findMany({
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: {
        tradeEvent: true,
        execution: true,
      },
    });

    return decisions.map((decision: any) => {
      const reasons = Array.isArray(decision.reasonsJson) ? decision.reasonsJson : [];
      return {
        id: decision.id,
        action: decision.action,
        side: decision.side,
        orderSize: Number(decision.orderSize),
        limitPrice: Number(decision.limitPrice),
        createdAt: decision.createdAt,
        reasonsJson: reasons,
        tradeEvent: {
          sourceWalletAddress: decision.tradeEvent.sourceWalletAddress,
          marketId: decision.tradeEvent.marketId,
          outcome: decision.tradeEvent.outcome,
        },
        execution: decision.execution
          ? {
              status: decision.execution.status,
              errorMessage: decision.execution.errorMessage,
            }
          : undefined,
      };
    });
  });

  app.get('/dashboard/onboarding-state', async () => {
    const wallets = await prisma.watchedWallet.count();
    return {
      hasTrackedWallets: wallets > 0,
    };
  });

  app.get('/wallets', async () => {
    const wallets = await prisma.watchedWallet.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { tradeEvents: true },
        },
      },
    });
    return wallets.map((wallet: any) => ({
      id: wallet.id,
      address: wallet.address,
      shortAddress: shortenAddress(wallet.address),
      label: wallet.label,
      enabled: wallet.enabled,
      copyEnabled: wallet.copyEnabled,
      syncStatus: wallet.syncStatus,
      lastSyncAt: wallet.lastSyncAt,
      lastSyncError: wallet.lastSyncError,
      totalTrades: wallet._count.tradeEvents,
      lastPolledAt: wallet.lastPolledAt,
      nextPollAt: wallet.nextPollAt,
    }));
  });

  app.post('/wallets', async (req: any) => {
    const body = walletCreateSchema.parse(req.body);
    let address: string;
    try {
      address = await resolveWalletAddress(body.input);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid wallet input';
      throw app.httpErrors.badRequest(message);
    }
    const existing = await prisma.watchedWallet.findUnique({ where: { address } });
    if (existing) {
      if (!existing.enabled || !existing.copyEnabled || existing.syncStatus === 'ERROR') {
        const reactivated = await prisma.watchedWallet.update({
          where: { id: existing.id },
          data: {
            enabled: true,
            copyEnabled: true,
            syncStatus: 'SYNCING',
            lastSyncError: null,
          },
        });
        await processWalletPoll(reactivated.id, reactivated.address);
        return {
          walletId: reactivated.id,
          created: false,
          address: reactivated.address,
          message: 'Wallet already tracked. Sync restarted.',
        };
      }
      return {
        walletId: existing.id,
        created: false,
        address: existing.address,
        message: 'Wallet already tracked',
      };
    }

    const label = body.label?.trim() || shortenAddress(address);
    const wallet = await prisma.watchedWallet.create({
      data: {
        address,
        label,
        enabled: true,
        copyEnabled: true,
        syncStatus: 'SYNCING',
        strategies: {
          create: {
            name: `${label} Strategy`,
            enabled: true,
            mode: 'PAPER',
            riskConfig: {
              create: {
                fixedDollar: 100,
                pctSourceSize: null,
                pctBankroll: null,
                maxExposure: 5000,
                perMarketMaxAllocation: 1000,
                dailyLossCap: 500,
                maxSlippageBps: 150,
                minLiquidity: 1000,
                maxSpreadBps: 1500,
                inverseMode: false,
                copyBuys: true,
                copySells: true,
                cooldownSeconds: 5,
                fillStrategy: 'MIDPOINT_FALLBACK',
              },
            },
            smartConfig: {
              create: {
                profitableWalletsOnly: false,
                minSourceTradeUsd: null,
                firstEntryOnly: false,
                ignoreExitTrades: false,
                copyClustersOnly: false,
                topRankedWalletsOnly: false,
                topRankMinWinRate: null,
                topRankMinSharpeLike: null,
              },
            },
          },
        },
      },
    });

    await processWalletPoll(wallet.id, wallet.address);

    return {
      walletId: wallet.id,
      created: true,
      address: wallet.address,
      label: wallet.label,
    };
  });

  app.get('/wallets/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({
      where: { id: params.id },
      include: {
        _count: {
          select: { tradeEvents: true },
        },
      },
    });
    if (!wallet) {
      throw app.httpErrors.notFound('Wallet not found');
    }

    const recentMarkets = await prisma.tradeEvent.groupBy({
      by: ['marketId', 'marketQuestion'],
      where: { walletId: wallet.id },
      _count: { marketId: true },
      orderBy: { _count: { marketId: 'desc' } },
      take: 10,
    });

    return {
      id: wallet.id,
      address: wallet.address,
      label: wallet.label,
      syncStatus: wallet.syncStatus,
      lastSyncAt: wallet.lastSyncAt,
      lastSyncError: wallet.lastSyncError,
      totalTrades: wallet._count.tradeEvents,
      recentMarkets: recentMarkets.map((row: any) => ({
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        trades: row._count.marketId,
      })),
    };
  });

  app.get('/wallets/:id/trades', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        side: z.enum(['BUY', 'SELL']).optional(),
        market: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(req.query);

    const where: Record<string, unknown> = { walletId: params.id };
    if (query.side) {
      where.side = query.side;
    }
    if (query.market) {
      where.marketId = { contains: query.market, mode: 'insensitive' as const };
    }
    if (query.from || query.to) {
      const tradedAt: Record<string, Date> = {};
      if (query.from) {
        tradedAt.gte = new Date(query.from);
      }
      if (query.to) {
        tradedAt.lte = new Date(query.to);
      }
      where.tradedAt = tradedAt;
    }

    const [total, rows] = await Promise.all([
      prisma.tradeEvent.count({ where }),
      prisma.tradeEvent.findMany({
        where,
        orderBy: { tradedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map((row: any) => ({
        id: row.id,
        timestamp: row.tradedAt,
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        outcome: row.outcome,
        side: row.side,
        price: Number(row.price),
        size: Number(row.size),
        notional: Number(row.price) * Number(row.size),
        txHash: row.txHash,
        orderId: row.orderId,
      })),
    };
  });

  app.get('/wallets/:id/activity', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        eventType: z.string().optional(),
        side: z.enum(['BUY', 'SELL']).optional(),
        market: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(req.query ?? {});

    const where: Record<string, unknown> = { trackedWalletId: params.id };
    if (query.eventType) {
      where.eventType = query.eventType.toUpperCase();
    }
    if (query.side) {
      where.side = query.side;
    }
    if (query.market) {
      where.OR = [
        { marketId: { contains: query.market, mode: 'insensitive' } },
        { marketQuestion: { contains: query.market, mode: 'insensitive' } },
      ];
    }
    if (query.from || query.to) {
      const ts: Record<string, Date> = {};
      if (query.from) {
        ts.gte = new Date(query.from);
      }
      if (query.to) {
        ts.lte = new Date(query.to);
      }
      where.eventTimestamp = ts;
    }

    const [total, rows] = await Promise.all([
      db.walletActivityEvent.count({ where }),
      db.walletActivityEvent.findMany({
        where,
        orderBy: { eventTimestamp: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map((row: any) => ({
        id: row.id,
        eventType: row.eventType,
        marketId: row.marketId,
        marketQuestion: row.marketQuestion,
        outcome: row.outcome,
        side: row.side,
        price: row.price ? Number(row.price) : null,
        shares: row.shares ? Number(row.shares) : null,
        notional: row.notional ? Number(row.notional) : null,
        txHash: row.txHash,
        orderId: row.orderId,
        eventTimestamp: row.eventTimestamp,
      })),
    };
  });

  app.get('/wallets/:id/positions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        status: z.enum(['OPEN', 'CLOSED']).default('OPEN'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});

    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) {
      throw app.httpErrors.notFound('Wallet not found');
    }

    try {
      const items = await dataAdapter.getWalletPositions(wallet.address, query.status, query.limit);
      return {
        walletId: wallet.id,
        status: query.status,
        total: items.length,
        items,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load wallet positions';
      throw app.httpErrors.badRequest(message);
    }
  });

  app.post('/wallets/:id/sync', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) {
      throw app.httpErrors.notFound('Wallet not found');
    }
    await processWalletPoll(wallet.id, wallet.address);
    return { synced: true };
  });

  app.post('/wallets/:id/reconcile', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) {
      throw app.httpErrors.notFound('Wallet not found');
    }
    await reconcileWalletExposure(wallet.id, wallet.address);
    return { reconciled: true };
  });

  app.delete('/wallets/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await prisma.watchedWallet.delete({ where: { id: params.id } });
    return { deleted: true };
  });

  app.post('/wallets/:id/toggle', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const wallet = await prisma.watchedWallet.update({
      where: { id: params.id },
      data: {
        enabled: body.enabled,
        copyEnabled: body.enabled,
        syncStatus: body.enabled ? 'ACTIVE' : 'PAUSED',
      },
    });
    return wallet;
  });

  app.get('/market-intelligence', async (req: any) => {
    const query = z
      .object({ limit: z.coerce.number().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    return getLatestMarketIntelligence(query.limit);
  });

  app.get('/leaderboard', async (req: any) => {
    const query = z
      .object({
        sortBy: z.enum(['pnl', 'winRate', 'sharpe', 'accuracy']).default('pnl'),
        minTrades: z.coerce.number().optional(),
      })
      .parse(req.query ?? {});
    const rows = await getWalletLeaderboard(query.sortBy);
    const minTrades = query.minTrades;
    return minTrades === undefined ? rows : rows.filter((row: any) => row.trades >= minTrades);
  });

  app.get('/wallets/:id/analytics', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const snapshots = await prisma.walletAnalyticsSnapshot.findMany({
      where: { walletId: params.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return snapshots;
  });

  app.get('/strategies/:id/smart-config', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    return prisma.smartCopyStrategyConfig.findUnique({ where: { strategyId: params.id } });
  });

  app.post('/strategies/smart-config', async (req: any) => {
    const body = smartConfigSchema.parse(req.body);
    const updateData: Record<string, unknown> = {};
    if (body.profitableWalletsOnly !== undefined) {
      updateData.profitableWalletsOnly = body.profitableWalletsOnly;
    }
    if (body.minSourceTradeUsd !== undefined) {
      updateData.minSourceTradeUsd = body.minSourceTradeUsd;
    }
    if (body.firstEntryOnly !== undefined) {
      updateData.firstEntryOnly = body.firstEntryOnly;
    }
    if (body.ignoreExitTrades !== undefined) {
      updateData.ignoreExitTrades = body.ignoreExitTrades;
    }
    if (body.copyClustersOnly !== undefined) {
      updateData.copyClustersOnly = body.copyClustersOnly;
    }
    if (body.topRankedWalletsOnly !== undefined) {
      updateData.topRankedWalletsOnly = body.topRankedWalletsOnly;
    }
    if (body.topRankMinWinRate !== undefined) {
      updateData.topRankMinWinRate = body.topRankMinWinRate;
    }
    if (body.topRankMinSharpeLike !== undefined) {
      updateData.topRankMinSharpeLike = body.topRankMinSharpeLike;
    }
    return prisma.smartCopyStrategyConfig.upsert({
      where: { strategyId: body.strategyId },
      update: updateData,
      create: {
        strategyId: body.strategyId,
        profitableWalletsOnly: body.profitableWalletsOnly ?? false,
        minSourceTradeUsd: body.minSourceTradeUsd ?? null,
        firstEntryOnly: body.firstEntryOnly ?? false,
        ignoreExitTrades: body.ignoreExitTrades ?? false,
        copyClustersOnly: body.copyClustersOnly ?? false,
        topRankedWalletsOnly: body.topRankedWalletsOnly ?? false,
        topRankMinWinRate: body.topRankMinWinRate ?? null,
        topRankMinSharpeLike: body.topRankMinSharpeLike ?? null,
      },
    });
  });

  app.get('/alerts/whales', async () => {
    return prisma.whaleAlert.findMany({
      include: { wallet: true, tradeEvent: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.get('/signals/clusters', async () => {
    return prisma.clusterSignal.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.get('/heatmap', async () => {
    const intel = await getLatestMarketIntelligence(100);
    return intel
      .map((row: any) => ({
        marketId: row.marketId,
        buyPressure: row.buyPressure,
        sellPressure: row.sellPressure,
        activeWallets: row.uniqueWallets,
        sentiment: row.netSentimentScore,
      }))
      .sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment));
  });

  app.get('/events', async (req: any) => {
    const query = z
      .object({ limit: z.coerce.number().min(1).max(500).default(200) })
      .parse(req.query ?? {});
    return loadRecentEvents(query.limit);
  });

  app.get('/events/ws', { websocket: true }, (connection: any) => {
    const unsubscribe = eventBus.subscribe((event) => {
      connection.socket.send(JSON.stringify(event));
    });

    connection.socket.on('close', () => {
      unsubscribe();
    });
  });

  app.post('/paper-copy-sessions', async (req: any) => {
    const body = z
      .object({
        trackedWalletId: z.string().uuid(),
        startingCash: z.number().positive().optional(),
        maxAllocationPerMarket: z.number().positive().optional(),
        maxTotalExposure: z.number().positive().optional(),
        minNotionalThreshold: z.number().positive().optional(),
        feeBps: z.number().nonnegative().max(500).optional(),
        slippageBps: z.number().nonnegative().max(500).optional(),
      })
      .parse(req.body ?? {});
    const payload: {
      trackedWalletId: string;
      startingCash?: number;
      maxAllocationPerMarket?: number;
      maxTotalExposure?: number;
      minNotionalThreshold?: number;
      feeBps?: number;
      slippageBps?: number;
    } = {
      trackedWalletId: body.trackedWalletId,
      ...(body.startingCash !== undefined ? { startingCash: body.startingCash } : {}),
      ...(body.maxAllocationPerMarket !== undefined
        ? { maxAllocationPerMarket: body.maxAllocationPerMarket }
        : {}),
      ...(body.maxTotalExposure !== undefined ? { maxTotalExposure: body.maxTotalExposure } : {}),
      ...(body.minNotionalThreshold !== undefined
        ? { minNotionalThreshold: body.minNotionalThreshold }
        : {}),
      ...(body.feeBps !== undefined ? { feeBps: body.feeBps } : {}),
      ...(body.slippageBps !== undefined ? { slippageBps: body.slippageBps } : {}),
    };
    return createPaperCopySession(payload);
  });

  app.post('/paper-copy-sessions/:id/start', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await startPaperCopySession(params.id);
    return { started: true };
  });

  app.post('/paper-copy-sessions/:id/pause', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await pausePaperCopySession(params.id);
    return { paused: true };
  });

  app.post('/paper-copy-sessions/:id/resume', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await resumePaperCopySession(params.id);
    return { resumed: true };
  });

  app.post('/paper-copy-sessions/:id/stop', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await stopPaperCopySession(params.id);
    return { stopped: true };
  });

  app.get('/paper-copy-sessions', async () => {
    const rows = await db.paperCopySession.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        trackedWallet: true,
        _count: { select: { trades: true, positions: true } },
      },
    });
    return rows.map((row: any) => ({
      id: row.id,
      trackedWalletId: row.trackedWalletId,
      trackedWalletAddress: row.trackedWalletAddress,
      label: row.trackedWallet.label,
      status: row.status,
      startingCash: Number(row.startingCash),
      currentCash: Number(row.currentCash),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      createdAt: row.createdAt,
      tradesCount: row._count.trades,
      positionsCount: row._count.positions,
    }));
  });

  app.get('/paper-copy-sessions/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db.paperCopySession.findUnique({
      where: { id: params.id },
      include: { trackedWallet: true },
    });
    if (!row) {
      throw app.httpErrors.notFound('Session not found');
    }

    const [latestSnapshot, bestTrade, worstTrade, openCount] = await Promise.all([
      db.paperPortfolioSnapshot.findFirst({
        where: { sessionId: row.id },
        orderBy: { timestamp: 'desc' },
      }),
      db.paperCopyTrade.findFirst({
        where: { sessionId: row.id },
        orderBy: { notional: 'desc' },
      }),
      db.paperCopyTrade.findFirst({
        where: { sessionId: row.id },
        orderBy: { notional: 'asc' },
      }),
      db.paperCopyPosition.count({ where: { sessionId: row.id, status: 'OPEN' } }),
    ]);

    const nlv = latestSnapshot
      ? Number(latestSnapshot.netLiquidationValue)
      : Number(row.currentCash);
    const totalPnl = latestSnapshot ? Number(latestSnapshot.totalPnl) : 0;
    const returnPct = latestSnapshot ? Number(latestSnapshot.returnPct) : 0;

    return {
      id: row.id,
      trackedWalletId: row.trackedWalletId,
      trackedWalletAddress: row.trackedWalletAddress,
      trackedWalletLabel: row.trackedWallet.label,
      status: row.status,
      startingCash: Number(row.startingCash),
      currentCash: Number(row.currentCash),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      estimatedSourceExposure: row.estimatedSourceExposure
        ? Number(row.estimatedSourceExposure)
        : null,
      copyRatio: row.copyRatio ? Number(row.copyRatio) : null,
      netLiquidationValue: nlv,
      totalPnl,
      returnPct,
      summarySentence:
        totalPnl >= 0
          ? `Hypothetically, copying this wallet since session start would have made $${totalPnl.toFixed(2)} (+${returnPct.toFixed(2)}%).`
          : `Hypothetically, copying this wallet since session start would have lost $${Math.abs(totalPnl).toFixed(2)} (${returnPct.toFixed(2)}%).`,
      stats: {
        openPositionsCount: openCount,
        bestNotionalTrade: bestTrade ? Number(bestTrade.notional) : null,
        worstNotionalTrade: worstTrade ? Number(worstTrade.notional) : null,
      },
    };
  });

  app.get('/paper-copy-sessions/:id/trades', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query ?? {});
    const rows = await db.paperCopyTrade.findMany({
      where: { sessionId: params.id },
      orderBy: { eventTimestamp: 'desc' },
      take: query.limit,
      include: {
        sourceActivityEvent: {
          select: {
            id: true,
            walletAddress: true,
            eventTimestamp: true,
            txHash: true,
            orderId: true,
            externalEventId: true,
            rawPayloadJson: true,
          },
        },
      },
    });

    const marketUrlFor = (marketId: string, rawPayloadJson?: unknown): string => {
      const raw =
        rawPayloadJson && typeof rawPayloadJson === 'object'
          ? (rawPayloadJson as Record<string, unknown>)
          : null;
      const slug =
        raw && typeof raw.eventSlug === 'string'
          ? raw.eventSlug
          : raw && typeof raw.slug === 'string'
            ? raw.slug
            : raw && typeof raw.marketSlug === 'string'
              ? raw.marketSlug
              : null;
      if (slug) {
        return `https://polymarket.com/event/${encodeURIComponent(slug)}`;
      }
      return `https://polymarket.com/market/${encodeURIComponent(marketId)}`;
    };

    return rows.map((row: any) => ({
      id: row.id,
      marketId: row.marketId,
      marketUrl: marketUrlFor(row.marketId, row.sourceActivityEvent?.rawPayloadJson),
      marketQuestion: row.marketQuestion,
      outcome: row.outcome,
      side: row.side,
      action: row.action,
      sourceActivityEventId: row.sourceActivityEventId,
      sourcePrice: row.sourcePrice ? Number(row.sourcePrice) : null,
      simulatedPrice: Number(row.simulatedPrice),
      sourceShares: row.sourceShares ? Number(row.sourceShares) : null,
      simulatedShares: Number(row.simulatedShares),
      notional: Number(row.notional),
      feeApplied: Number(row.feeApplied),
      slippageApplied: Number(row.slippageApplied),
      sourceWalletAddress: row.sourceActivityEvent?.walletAddress ?? null,
      sourceEventTimestamp: row.sourceActivityEvent?.eventTimestamp ?? null,
      sourceTxHash: row.sourceActivityEvent?.txHash ?? null,
      sourceTxUrl: row.sourceActivityEvent?.txHash
        ? `https://polygonscan.com/tx/${row.sourceActivityEvent.txHash}`
        : null,
      sourceOrderId: row.sourceActivityEvent?.orderId ?? null,
      sourceExternalEventId: row.sourceActivityEvent?.externalEventId ?? null,
      eventTimestamp: row.eventTimestamp,
      processedAt: row.processedAt,
      reasoning: row.reasoning,
    }));
  });

  app.get('/paper-copy-sessions/:id/positions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ status: z.enum(['OPEN', 'CLOSED', 'ALL']).default('ALL') })
      .parse(req.query ?? {});
    const rows = await db.paperCopyPosition.findMany({
      where: { sessionId: params.id, status: query.status === 'ALL' ? undefined : query.status },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row: any) => ({
      id: row.id,
      marketId: row.marketId,
      marketQuestion: row.marketQuestion,
      outcome: row.outcome,
      netShares: Number(row.netShares),
      avgEntryPrice: Number(row.avgEntryPrice),
      currentMarkPrice: Number(row.currentMarkPrice),
      realizedPnl: Number(row.realizedPnl),
      unrealizedPnl: Number(row.unrealizedPnl),
      status: row.status,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      updatedAt: row.updatedAt,
    }));
  });

  app.get('/paper-copy-sessions/:id/snapshots', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(1000).default(500) })
      .parse(req.query ?? {});
    const rows = await db.paperPortfolioSnapshot.findMany({
      where: { sessionId: params.id },
      orderBy: { timestamp: 'asc' },
      take: query.limit,
    });
    return rows.map((row: any) => ({
      timestamp: row.timestamp,
      cash: Number(row.cash),
      grossExposure: Number(row.grossExposure),
      netLiquidationValue: Number(row.netLiquidationValue),
      realizedPnl: Number(row.realizedPnl),
      unrealizedPnl: Number(row.unrealizedPnl),
      totalPnl: Number(row.totalPnl),
      returnPct: Number(row.returnPct),
    }));
  });

  app.get('/paper-copy-sessions/:id/metrics', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(2000).default(1000) })
      .parse(req.query ?? {});
    const rows = await db.paperSessionMetricPoint.findMany({
      where: { sessionId: params.id },
      orderBy: { timestamp: 'asc' },
      take: query.limit,
    });
    return rows.map((row: any) => ({
      timestamp: row.timestamp,
      totalPnl: Number(row.totalPnl),
      realizedPnl: Number(row.realizedPnl),
      unrealizedPnl: Number(row.unrealizedPnl),
      netLiquidationValue: Number(row.netLiquidationValue),
      openPositionsCount: row.openPositionsCount,
    }));
  });

  app.post('/mode', async (req: any) => {
    const body = modeUpdateSchema.parse(req.body);
    if (body.mode === 'LIVE') {
      if (!config.LIVE_TRADING_ENABLED) {
        await prisma.strategy.update({ where: { id: body.strategyId }, data: { mode: 'PAPER' } });
        return { strategyId: body.strategyId, mode: 'PAPER', fallback: 'LIVE_TRADING_DISABLED' };
      }
      if (body.confirmationToken !== config.LIVE_TRADING_CONFIRMATION_TOKEN) {
        await prisma.strategy.update({ where: { id: body.strategyId }, data: { mode: 'PAPER' } });
        return { strategyId: body.strategyId, mode: 'PAPER', fallback: 'INVALID_CONFIRMATION' };
      }
    }
    return prisma.strategy.update({
      where: { id: body.strategyId },
      data: { mode: body.mode },
    });
  });

  app.post('/execution/preview', async (req: any) => {
    const body = previewSchema.parse(req.body);
    const strategy = await prisma.strategy.findUnique({
      where: { id: body.strategyId },
      include: { riskConfig: true },
    });
    if (!strategy?.riskConfig) {
      throw app.httpErrors.notFound('Strategy or risk config not found');
    }
    const marketEvents = await prisma.tradeEvent.findMany({
      where: { marketId: body.event.marketId },
      orderBy: { tradedAt: 'desc' },
      take: 1,
    });
    const event = marketEvents[0];
    const marketPrice = event ? Number(event.price) : body.event.price;
    const decision = decideCopyOrder({
      strategyId: strategy.id,
      riskConfig: {
        id: strategy.riskConfig.id,
        strategyId: strategy.id,
        fixedDollar: strategy.riskConfig.fixedDollar
          ? Number(strategy.riskConfig.fixedDollar)
          : null,
        pctSourceSize: strategy.riskConfig.pctSourceSize
          ? Number(strategy.riskConfig.pctSourceSize)
          : null,
        pctBankroll: strategy.riskConfig.pctBankroll
          ? Number(strategy.riskConfig.pctBankroll)
          : null,
        maxExposure: Number(strategy.riskConfig.maxExposure),
        perMarketMaxAllocation: Number(strategy.riskConfig.perMarketMaxAllocation),
        dailyLossCap: Number(strategy.riskConfig.dailyLossCap),
        maxSlippageBps: strategy.riskConfig.maxSlippageBps,
        minLiquidity: Number(strategy.riskConfig.minLiquidity),
        maxSpreadBps: strategy.riskConfig.maxSpreadBps,
        inverseMode: strategy.riskConfig.inverseMode,
        copyBuys: strategy.riskConfig.copyBuys,
        copySells: strategy.riskConfig.copySells,
        cooldownSeconds: strategy.riskConfig.cooldownSeconds,
        fillStrategy: strategy.riskConfig.fillStrategy as
          | 'AGGRESSIVE_LIMIT'
          | 'PASSIVE_LIMIT'
          | 'MIDPOINT_FALLBACK',
      },
      market: {
        id: body.event.marketId,
        slug: body.event.marketId,
        question: body.event.marketId,
        active: true,
        bestBid: marketPrice * 0.99,
        bestAsk: marketPrice * 1.01,
        midpoint: marketPrice,
        liquidity: 50000,
        spreadBps: 200,
      },
      event: {
        id: crypto.randomUUID(),
        sourceEventId: body.event.sourceEventId,
        sourceWalletAddress: 'preview',
        marketId: body.event.marketId,
        outcome: body.event.outcome,
        side: body.event.side,
        size: body.event.size,
        price: body.event.price,
        tradedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
      },
      bankroll: Number(strategy.bankroll),
      currentExposure: 0,
      perMarketExposure: 0,
      dailyPnl: Number(strategy.dailyPnl),
      lastTradeAtIso: strategy.lastCopiedTradeAt?.toISOString() ?? new Date(0).toISOString(),
    });
    return decision;
  });

  app.post('/ingestion/run', async () => {
    await scheduleWalletPolls();
    return { queued: true };
  });

  app.post('/backtests/run', async (req: any) => {
    const body = z
      .object({
        strategyId: z.string().uuid(),
        name: z.string().min(1),
      })
      .parse(req.body);
    const strategy = await prisma.strategy.findUnique({
      where: { id: body.strategyId },
      include: { riskConfig: true },
    });
    if (!strategy?.riskConfig) {
      throw app.httpErrors.notFound('Strategy or risk config not found');
    }
    const events = await prisma.tradeEvent.findMany({
      where: { walletId: strategy.walletId },
      orderBy: { tradedAt: 'asc' },
      take: 2000,
    });
    const marketById: Record<
      string,
      {
        bestBid: number;
        bestAsk: number;
        midpoint: number;
        spreadBps: number;
        liquidity: number;
        active: boolean;
        question: string;
        slug: string;
      }
    > = {};
    for (const event of events) {
      marketById[event.marketId] = {
        bestBid: Number(event.price) * 0.99,
        bestAsk: Number(event.price) * 1.01,
        midpoint: Number(event.price),
        spreadBps: 200,
        liquidity: 50000,
        active: true,
        question: event.marketId,
        slug: event.marketId,
      };
    }
    const result = runBacktest({
      strategyId: strategy.id,
      bankrollStart: Number(strategy.bankroll),
      riskConfig: {
        id: strategy.riskConfig.id,
        strategyId: strategy.id,
        fixedDollar: strategy.riskConfig.fixedDollar
          ? Number(strategy.riskConfig.fixedDollar)
          : null,
        pctSourceSize: strategy.riskConfig.pctSourceSize
          ? Number(strategy.riskConfig.pctSourceSize)
          : null,
        pctBankroll: strategy.riskConfig.pctBankroll
          ? Number(strategy.riskConfig.pctBankroll)
          : null,
        maxExposure: Number(strategy.riskConfig.maxExposure),
        perMarketMaxAllocation: Number(strategy.riskConfig.perMarketMaxAllocation),
        dailyLossCap: Number(strategy.riskConfig.dailyLossCap),
        maxSlippageBps: strategy.riskConfig.maxSlippageBps,
        minLiquidity: Number(strategy.riskConfig.minLiquidity),
        maxSpreadBps: strategy.riskConfig.maxSpreadBps,
        inverseMode: strategy.riskConfig.inverseMode,
        copyBuys: strategy.riskConfig.copyBuys,
        copySells: strategy.riskConfig.copySells,
        cooldownSeconds: strategy.riskConfig.cooldownSeconds,
        fillStrategy: strategy.riskConfig.fillStrategy as
          | 'AGGRESSIVE_LIMIT'
          | 'PASSIVE_LIMIT'
          | 'MIDPOINT_FALLBACK',
      },
      events: events.map((event: (typeof events)[number]) => ({
        id: event.id,
        sourceEventId: event.sourceEventId,
        sourceWalletAddress: event.sourceWalletAddress,
        marketId: event.marketId,
        outcome: event.outcome,
        side: event.side,
        size: Number(event.size),
        price: Number(event.price),
        tradedAt: event.tradedAt.toISOString(),
        observedAt: event.observedAt.toISOString(),
      })),
      marketById,
    });

    await prisma.backtestRun.create({
      data: {
        strategyId: strategy.id,
        name: body.name,
        configJson: { eventCount: events.length },
        resultJson: result,
      },
    });
    return result;
  });

  app.get('/admin/health', async () => {
    const [wallets, decisions, executions, latestAudit] = await Promise.all([
      prisma.watchedWallet.count(),
      prisma.copyDecision.count(),
      prisma.execution.count(),
      prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      mode: config.APP_MODE,
      liveTradingEnabled: config.LIVE_TRADING_ENABLED,
      wallets,
      decisions,
      executions,
      latestAudit,
    };
  });
}
