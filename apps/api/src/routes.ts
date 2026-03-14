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
  deletePaperCopySession,
  getSessionHealth,
  killAllPaperSessions,
  pausePaperCopySession,
  reconcilePaperSessionPositions,
  repairPaperCopySession,
  resumePaperCopySession,
  startPaperCopySession,
  stopPaperCopySession,
} from './modules/paper-copy.js';
import { reconcileWalletExposure } from './modules/reconciliation.js';
import { resolveWalletAddress, shortenAddress } from './modules/wallet-input.js';
import { getWalletLeaderboard } from './modules/wallet-analytics.js';
import { registerForceCloseRoutes } from './modules/force-close-routes.js';

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

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ready' };
  });

  app.get('/metrics', async (_: any, reply: any) => {
    reply.header('content-type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  app.get('/dashboard/overview', async () => {
    const [walletCount, activeWallets, totalTrades, tradesToday, latestTrades] = await Promise.all([
      prisma.watchedWallet.count(),
      prisma.watchedWallet.count({
        where: { enabled: true, copyEnabled: true, syncStatus: 'ACTIVE' },
      }),
      prisma.tradeEvent.count(),
      prisma.tradeEvent.count({
        where: { tradedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
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
      getWalletLeaderboard('pnl').then((rows: any[]) => rows.slice(0, 10)),
      prisma.whaleAlert.findMany({
        include: { wallet: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.clusterSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      getLatestMarketIntelligence(20),
      prisma.tradeEvent.groupBy({
        by: ['marketId'],
        _count: { marketId: true },
        where: { tradedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        orderBy: { _count: { marketId: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      leaderboard,
      whaleAlerts: whaleTrades,
      clusterSignals,
      sentiment,
      activeMarkets,
    };
  });

  // ---------------------------------------------------------------------------
  // Wallets
  // ---------------------------------------------------------------------------

  app.get('/wallets', async () => {
    const wallets = await prisma.watchedWallet.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tradeEvents: true } } },
    });
    return wallets.map((w: any) => ({
      id: w.id,
      address: w.address,
      shortAddress: w.address.slice(0, 6) + '…' + w.address.slice(-4),
      label: w.label,
      enabled: w.enabled,
      copyEnabled: w.copyEnabled,
      syncStatus: w.syncStatus,
      lastSyncAt: w.lastSyncAt,
      lastSyncError: w.lastSyncError,
      totalTrades: w._count.tradeEvents,
      lastPolledAt: w.lastPolledAt,
      nextPollAt: w.nextPollAt,
    }));
  });

  app.post('/wallets', async (req: any) => {
    const body = walletCreateSchema.parse(req.body ?? {});
    const address = await resolveWalletAddress(body.input);

    const existing = await prisma.watchedWallet.findUnique({ where: { address } });
    if (existing) {
      if (!existing.enabled) {
        await prisma.watchedWallet.update({
          where: { id: existing.id },
          data: { enabled: true, copyEnabled: true, syncStatus: 'SYNCING', lastSyncError: null },
        });
        await processWalletPoll(existing.id, existing.address);
        return {
          walletId: existing.id,
          created: false,
          address: existing.address,
          message: 'Wallet re-enabled and sync restarted.',
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
    return { walletId: wallet.id, created: true, address: wallet.address, label: wallet.label };
  });

  app.get('/wallets/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({
      where: { id: params.id },
      include: { _count: { select: { tradeEvents: true } } },
    });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

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
    if (query.side) where.side = query.side;
    if (query.eventType) where.eventType = query.eventType;
    if (query.market) where.marketId = { contains: query.market, mode: 'insensitive' };
    if (query.from || query.to) {
      const ts: Record<string, Date> = {};
      if (query.from) ts.gte = new Date(query.from);
      if (query.to) ts.lte = new Date(query.to);
      where.eventTimestamp = ts;
    }

    const [total, rows] = await Promise.all([
      prisma.walletActivityEvent.count({ where }),
      prisma.walletActivityEvent.findMany({
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
        detectedAt: row.detectedAt,
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
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');

    try {
      const items = await dataAdapter.getWalletPositions(wallet.address, query.status, query.limit);
      return { walletId: wallet.id, status: query.status, total: items.length, items };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load wallet positions';
      throw app.httpErrors.badRequest(message);
    }
  });

  app.post('/wallets/:id/sync', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');
    await processWalletPoll(wallet.id, wallet.address);
    return { synced: true };
  });

  app.post('/wallets/:id/reconcile', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const wallet = await prisma.watchedWallet.findUnique({ where: { id: params.id } });
    if (!wallet) throw app.httpErrors.notFound('Wallet not found');
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
    return prisma.watchedWallet.update({
      where: { id: params.id },
      data: {
        enabled: body.enabled,
        copyEnabled: body.enabled,
        syncStatus: body.enabled ? 'ACTIVE' : 'PAUSED',
      },
    });
  });

  app.get('/wallets/:id/analytics', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const snapshot = await prisma.walletAnalyticsSnapshot.findFirst({
      where: { walletId: params.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!snapshot) throw app.httpErrors.notFound('No analytics snapshot yet');
    return snapshot;
  });

  // ---------------------------------------------------------------------------
  // Trades
  // ---------------------------------------------------------------------------

  app.get('/trades', async (req: any) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        side: z.enum(['BUY', 'SELL']).optional(),
        market: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(req.query ?? {});

    const where: Record<string, unknown> = {};
    if (query.side) where.side = query.side;
    if (query.market) where.marketId = { contains: query.market, mode: 'insensitive' };
    if (query.from || query.to) {
      const tradedAt: Record<string, Date> = {};
      if (query.from) tradedAt.gte = new Date(query.from);
      if (query.to) tradedAt.lte = new Date(query.to);
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

  // ---------------------------------------------------------------------------
  // Markets
  // ---------------------------------------------------------------------------

  app.get('/markets', async (req: any) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    const markets = await prisma.tradeEvent.groupBy({
      by: ['marketId', 'marketQuestion'],
      _count: { marketId: true },
      _max: { tradedAt: true },
      orderBy: { _count: { marketId: 'desc' } },
      take: query.limit,
    });
    return markets.map((row: any) => ({
      marketId: row.marketId,
      marketQuestion: row.marketQuestion,
      tradeCount: row._count.marketId,
      lastTradeAt: row._max.tradedAt,
    }));
  });

  // ---------------------------------------------------------------------------
  // Intelligence
  // ---------------------------------------------------------------------------

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
    return query.minTrades === undefined
      ? rows
      : rows.filter((r: any) => r.totalTrades >= query.minTrades!);
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
      .sort((a: any, b: any) => Math.abs(b.sentiment) - Math.abs(a.sentiment));
  });

  app.get('/whale-alerts', async () => {
    return prisma.whaleAlert.findMany({
      include: { wallet: true, tradeEvent: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.get('/alerts/whales', async () => {
    return prisma.whaleAlert.findMany({
      include: { wallet: true, tradeEvent: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.get('/cluster-signals', async () => {
    return prisma.clusterSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  });

  app.get('/signals/clusters', async () => {
    return prisma.clusterSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  });

  // ---------------------------------------------------------------------------
  // Events / websocket
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Strategies
  // ---------------------------------------------------------------------------

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
    return prisma.strategy.update({ where: { id: body.strategyId }, data: { mode: body.mode } });
  });

  app.post('/execution/preview', async (req: any) => {
    const body = previewSchema.parse(req.body);
    const strategy = await prisma.strategy.findUnique({
      where: { id: body.strategyId },
      include: { riskConfig: true, wallet: { select: { address: true } } },
    });
    if (!strategy?.riskConfig) throw app.httpErrors.notFound('Strategy or risk config not found');

    const marketEvents = await prisma.tradeEvent.findMany({
      where: { marketId: body.event.marketId },
      orderBy: { tradedAt: 'desc' },
      take: 1,
    });
    const marketPrice = marketEvents[0] ? Number(marketEvents[0].price) : body.event.price;
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
          | 'MIDPOINT_FALLBACK'
          | 'AGGRESSIVE_LIMIT'
          | 'PASSIVE_LIMIT',
      },
      market: {
        id: body.event.marketId,
        slug: body.event.marketId,
        question: body.event.marketId,
        active: true,
        bestBid: marketPrice * 0.99,
        bestAsk: marketPrice * 1.01,
        midpoint: marketPrice,
        liquidity: 100_000,
        spreadBps: 200,
      },
      event: {
        id: body.event.sourceEventId,
        sourceEventId: body.event.sourceEventId,
        sourceWalletAddress: strategy.wallet?.address ?? '',
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
      dailyPnl: Number(strategy.dailyPnl ?? 0),
    });
    return decision;
  });

  app.get('/strategies/:id/smart-config', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const config = await prisma.smartCopyStrategyConfig.findUnique({
      where: { strategyId: params.id },
    });
    if (!config) throw app.httpErrors.notFound('Smart config not found');
    return config;
  });

  app.post('/strategies/smart-config', async (req: any) => {
    const body = smartConfigSchema.parse(req.body ?? {});
    return prisma.smartCopyStrategyConfig.upsert({
      where: { strategyId: body.strategyId },
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
      update: {
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

  app.post('/backtest', async (req: any) => {
    const body = z
      .object({
        strategyId: z.string().uuid(),
        name: z.string().min(1),
        startDate: z.string().datetime(),
        endDate: z.string().datetime(),
      })
      .parse(req.body);

    const strategy = await prisma.strategy.findUnique({
      where: { id: body.strategyId },
      include: { riskConfig: true },
    });
    if (!strategy?.riskConfig) throw app.httpErrors.notFound('Strategy or risk config not found');

    const events = await prisma.tradeEvent.findMany({
      where: {
        walletId: strategy.walletId,
        tradedAt: { gte: new Date(body.startDate), lte: new Date(body.endDate) },
      },
      orderBy: { tradedAt: 'asc' },
    });

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
        minLiquidity: Number(strategy.riskConfig.minLiquidity ?? 0),
        maxSpreadBps: strategy.riskConfig.maxSpreadBps,
        inverseMode: strategy.riskConfig.inverseMode,
        copyBuys: strategy.riskConfig.copyBuys,
        copySells: strategy.riskConfig.copySells,
        cooldownSeconds: strategy.riskConfig.cooldownSeconds,
        fillStrategy: strategy.riskConfig.fillStrategy as
          | 'MIDPOINT_FALLBACK'
          | 'AGGRESSIVE_LIMIT'
          | 'PASSIVE_LIMIT',
      },
      // Build a marketById map from the events so the backtest engine can look up market data.
      // We use the event price as a proxy for midpoint since we don't have live CLOB data.
      marketById: Object.fromEntries(
        events.map((e: any) => [
          e.marketId,
          {
            bestBid: Number(e.price) * 0.99,
            bestAsk: Number(e.price) * 1.01,
            midpoint: Number(e.price),
            spreadBps: 200,
            liquidity: 100_000,
            active: true,
            question: e.marketQuestion ?? e.marketId,
            slug: e.marketId,
          },
        ]),
      ),
      events: events.map((e: any) => ({
        id: e.id,
        sourceEventId: e.sourceEventId ?? e.id,
        sourceWalletAddress: e.sourceWalletAddress ?? '',
        marketId: e.marketId,
        outcome: e.outcome,
        side: e.side,
        size: Number(e.size),
        price: Number(e.price),
        tradedAt: e.tradedAt instanceof Date ? e.tradedAt.toISOString() : String(e.tradedAt),
        observedAt:
          e.observedAt instanceof Date ? e.observedAt.toISOString() : new Date().toISOString(),
      })),
    });

    await prisma.backtestRun.create({
      data: {
        strategyId: strategy.id,
        name: body.name,
        configJson: { start: body.startDate, end: body.endDate },
        resultJson: result as any,
      },
    });

    return result;
  });

  // ---------------------------------------------------------------------------
  // Paper copy sessions
  // ---------------------------------------------------------------------------

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

    return createPaperCopySession({
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
    });
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

  // Kill all RUNNING sessions at once (marks them COMPLETED, keeps data)
  app.post('/paper-copy-sessions/kill-all', async () => {
    const result = await killAllPaperSessions();
    return result;
  });

  // Permanently delete a session and all its data (trades, positions, snapshots)
  app.delete('/paper-copy-sessions/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await deletePaperCopySession(params.id);
    return { deleted: true };
  });

  // Repair a corrupted session: recalculates cash + positions from trade history,
  // forces status → PAUSED, writes fresh snapshot
  app.post('/paper-copy-sessions/:id/repair', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await repairPaperCopySession(params.id);
    return result;
  });

  // NEW — health/freshness endpoint for the session dashboard
  app.get('/paper-copy-sessions/:id/health', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const health = await getSessionHealth(params.id);
    if (!health) throw app.httpErrors.notFound('Session not found');
    return health;
  });

  // DEBUG — shows raw WalletActivityEvent records for the session's wallet.
  // Use this to diagnose why SELL/CLOSE events are or aren't being processed.
  app.get('/paper-copy-sessions/:id/debug', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(req.query ?? {});

    const session = await db.paperCopySession.findUnique({ where: { id: params.id } });
    if (!session) throw app.httpErrors.notFound('Session not found');

    const events = await db.walletActivityEvent.findMany({
      where: {
        trackedWalletId: session.trackedWalletId,
        eventTimestamp: { gte: session.startedAt ?? session.createdAt },
      },
      orderBy: { eventTimestamp: 'desc' },
      take: query.limit,
      select: {
        id: true,
        eventType: true,
        side: true,
        marketId: true,
        marketQuestion: true,
        outcome: true,
        price: true,
        shares: true,
        eventTimestamp: true,
      },
    });

    // Group by side/eventType so you can see immediately what's in the DB
    const summary = events.reduce((acc: Record<string, number>, e: any) => {
      const key = `${e.eventType ?? 'NULL'}|side=${e.side ?? 'NULL'}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    const processedIds = new Set(
      (
        await db.paperCopyTrade.findMany({
          where: { sessionId: params.id, sourceActivityEventId: { not: null } },
          select: { sourceActivityEventId: true },
        })
      ).map((t: any) => t.sourceActivityEventId),
    );

    return {
      sessionId: params.id,
      walletId: session.trackedWalletId,
      totalEvents: events.length,
      processedCount: events.filter((e: any) => processedIds.has(e.id)).length,
      skippedCount: events.filter((e: any) => !processedIds.has(e.id)).length,
      byTypeAndSide: summary,
      recentEvents: events.slice(0, 30).map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        side: e.side,
        outcome: e.outcome,
        price: e.price ? Number(e.price) : null,
        shares: e.shares ? Number(e.shares) : null,
        market: e.marketQuestion ?? e.marketId,
        ts: e.eventTimestamp,
        processed: processedIds.has(e.id),
      })),
    };
  });

  // RECONCILE POSITIONS — closes any simulated position whose market no longer
  // exists in the source wallet's current open positions on Polymarket.
  // This handles market resolution (REDEEM) events that the polling may have missed.
  app.post('/paper-copy-sessions/:id/reconcile-positions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await reconcilePaperSessionPositions(params.id);
    return result;
  });

  app.get('/paper-copy-sessions', async () => {
    const rows = await db.paperCopySession.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        trackedWallet: true,
        _count: { select: { trades: true, positions: true } },
      },
    });

    // Attach latest PnL from snapshot to the list view
    return Promise.all(
      rows.map(async (row: any) => {
        const latestSnapshot = await db.paperPortfolioSnapshot.findFirst({
          where: { sessionId: row.id },
          orderBy: { timestamp: 'desc' },
          select: { totalPnl: true, returnPct: true, netLiquidationValue: true },
        });
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
          createdAt: row.createdAt,
          lastProcessedEventAt: row.lastProcessedEventAt,
          totalPnl: latestSnapshot ? Number(latestSnapshot.totalPnl) : 0,
          returnPct: latestSnapshot ? Number(latestSnapshot.returnPct) : 0,
          netLiquidationValue: latestSnapshot
            ? Number(latestSnapshot.netLiquidationValue)
            : Number(row.currentCash),
          tradesCount: row._count.trades,
          positionsCount: row._count.positions,
        };
      }),
    );
  });

  app.get('/paper-copy-sessions/:id', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db.paperCopySession.findUnique({
      where: { id: params.id },
      include: { trackedWallet: true },
    });
    if (!row) throw app.httpErrors.notFound('Session not found');

    const [latestSnapshot, openCount] = await Promise.all([
      db.paperPortfolioSnapshot.findFirst({
        where: { sessionId: row.id },
        orderBy: { timestamp: 'desc' },
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
      lastProcessedEventAt: row.lastProcessedEventAt,
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
      stats: { openPositionsCount: openCount },
    };
  });

  app.get('/paper-copy-sessions/:id/metrics', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(2000).default(200) })
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

  app.get('/paper-copy-sessions/:id/positions', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({
        status: z.enum(['OPEN', 'CLOSED', 'ALL']).default('ALL'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query ?? {});
    const rows = await db.paperCopyPosition.findMany({
      where: { sessionId: params.id, ...(query.status === 'ALL' ? {} : { status: query.status }) },
      orderBy: { openedAt: 'desc' },
      take: query.limit,
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

  app.get('/paper-copy-sessions/:id/trades', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(50) })
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
      return slug
        ? `https://polymarket.com/event/${encodeURIComponent(slug)}`
        : `https://polymarket.com/market/${encodeURIComponent(marketId)}`;
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
  registerForceCloseRoutes(app);
}
