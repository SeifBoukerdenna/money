import {
  apiLatency,
  detectionLatency,
  ingestionRate,
  pollLatency,
  tradeDetectionLatency,
} from '../lib/metrics.js';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { createPolymarketDataAdapter } from './polymarket.js';
import type { Prisma } from '@prisma/client';
import { handleWhaleAlert } from './alerts.js';
import { detectAndPersistClusterSignal } from './cluster-signals.js';
import { publishEvent } from './event-stream.js';
import { decisionQueue, ingestQueue } from './queue.js';
import { buildActivityDedupeKey, isTradeLikeActivity } from './activity.js';

const dataAdapter = createPolymarketDataAdapter();

const MAX_MONITOR_CONCURRENCY = 30;
const hexWalletRegex = /^0x[a-fA-F0-9]{40}$/;
const profileHandleRegex = /^[a-zA-Z0-9._-]{2,64}$/;

function isPollIdentifierValid(addressOrHandle: string): boolean {
  if (hexWalletRegex.test(addressOrHandle)) {
    return true;
  }
  if (addressOrHandle.startsWith('0x')) {
    if (addressOrHandle.length === 42) {
      return false;
    }
    return profileHandleRegex.test(addressOrHandle);
  }
  return profileHandleRegex.test(addressOrHandle);
}

function isRecentlyActive(lastTradeAt: Date | null): boolean {
  if (!lastTradeAt) {
    return false;
  }
  const cutoff = Date.now() - config.ACTIVE_WALLET_WINDOW_MINUTES * 60_000;
  return lastTradeAt.getTime() >= cutoff;
}

function computeNextPollIntervalMs(active: boolean): number {
  if (active) {
    return config.ACTIVE_WALLET_POLL_MS;
  }
  const min = config.INACTIVE_WALLET_POLL_MIN_MS;
  const max = config.INACTIVE_WALLET_POLL_MAX_MS;
  return min + Math.floor(Math.random() * Math.max(1, max - min));
}

async function shouldPollWalletNow(walletId: string): Promise<boolean> {
  const key = `wallet:last-poll:${walletId}`;
  const value = await redis.get(key);
  if (!value) {
    return true;
  }
  const lastMs = Number(value);
  if (!Number.isFinite(lastMs)) {
    return true;
  }
  const latestTrade = await prisma.tradeEvent.findFirst({
    where: { walletId },
    orderBy: { tradedAt: 'desc' },
    select: { tradedAt: true },
  });
  const active = isRecentlyActive(latestTrade?.tradedAt ?? null);
  const waitMs = computeNextPollIntervalMs(active);
  return Date.now() - lastMs >= waitMs;
}

export async function scheduleWalletPolls(): Promise<void> {
  const wallets = await prisma.watchedWallet.findMany({
    where: {
      enabled: true,
      copyEnabled: true,
      syncStatus: { not: 'ERROR' },
    },
  });

  for (let index = 0; index < wallets.length; index += MAX_MONITOR_CONCURRENCY) {
    const batch = wallets.slice(index, index + MAX_MONITOR_CONCURRENCY);
    await Promise.all(
      batch.map(async (wallet) => {
        if (!(await shouldPollWalletNow(wallet.id))) {
          return;
        }
        const latestTrade = await prisma.tradeEvent.findFirst({
          where: { walletId: wallet.id },
          orderBy: { tradedAt: 'desc' },
          select: { tradedAt: true },
        });
        const active = isRecentlyActive(latestTrade?.tradedAt ?? null);
        await ingestQueue.add(
          'poll-wallet',
          { walletId: wallet.id, address: wallet.address, tier: active ? 'ACTIVE' : 'INACTIVE' },
          {
            priority: active ? 1 : 10,
            removeOnComplete: 1000,
            removeOnFail: 1000,
            attempts: 5,
            backoff: { type: 'exponential', delay: 500 },
          },
        );
      }),
    );
  }
}

export async function processWalletPoll(walletId: string, address: string): Promise<void> {
  if (!isPollIdentifierValid(address)) {
    await prisma.watchedWallet.update({
      where: { id: walletId },
      data: {
        enabled: false,
        copyEnabled: false,
        syncStatus: 'ERROR',
        lastSyncError:
          'Invalid wallet identifier. Use a Polymarket profile handle or full 0x address.',
        lastPolledAt: new Date(),
      },
    });
    logger.warn({ walletId, address }, 'wallet disabled due to invalid identifier');
    return;
  }

  const start = Date.now();
  await redis.set(`wallet:last-poll:${walletId}`, String(start));

  await prisma.watchedWallet.update({
    where: { id: walletId },
    data: {
      syncStatus: 'SYNCING',
      lastSyncError: null,
    },
  });

  const latest = await prisma.walletActivityEvent.findFirst({
    where: { trackedWalletId: walletId },
    orderBy: { eventTimestamp: 'desc' },
  });
  const sinceIso = latest?.eventTimestamp.toISOString();

  const apiStart = Date.now();
  let events: Awaited<ReturnType<typeof dataAdapter.getWalletActivityFeed>> = [];
  try {
    events = await dataAdapter.getWalletActivityFeed(address, sinceIso);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown ingestion error';
    await prisma.watchedWallet.update({
      where: { id: walletId },
      data: {
        syncStatus: 'ERROR',
        lastSyncError: message,
        lastPolledAt: new Date(),
      },
    });
    logger.warn({ walletId, address, message }, 'wallet poll failed');
    apiLatency.observe({ adapter: 'polymarket' }, Date.now() - apiStart);
    return;
  }
  apiLatency.observe({ adapter: 'polymarket' }, Date.now() - apiStart);

  const activeTier = isRecentlyActive(latest?.eventTimestamp ?? null) ? 'ACTIVE' : 'INACTIVE';

  let latestSeenActivityAt: Date | null = null;

  for (const event of events) {
    const eventTs = new Date(event.eventTimestamp);
    const dedupeKey = buildActivityDedupeKey(event);
    const detectedMs = Math.max(0, Date.now() - eventTs.getTime());
    detectionLatency.observe(detectedMs);
    tradeDetectionLatency.observe(detectedMs);

    try {
      const activityRow = await prisma.walletActivityEvent.create({
        data: {
          trackedWalletId: walletId,
          walletAddress: event.walletAddress,
          externalEventId: event.externalEventId ?? null,
          dedupeKey,
          eventType: event.eventType,
          marketId: event.marketId,
          marketQuestion: event.marketQuestion ?? null,
          outcome: event.outcome ?? null,
          side: event.side,
          price: event.price,
          shares: event.shares,
          notional: event.notional,
          fee: event.fee,
          txHash: event.txHash,
          orderId: event.orderId,
          eventTimestamp: eventTs,
          detectedAt: new Date(event.detectedAt),
          rawPayloadJson: event.rawPayload as Prisma.InputJsonValue,
        },
      });

      if (!latestSeenActivityAt || eventTs > latestSeenActivityAt) {
        latestSeenActivityAt = eventTs;
      }

      if (!isTradeLikeActivity(event)) {
        continue;
      }

      const row = await prisma.tradeEvent.create({
        data: {
          walletId,
          sourceEventId: event.externalEventId ?? event.orderId ?? event.txHash ?? activityRow.id,
          sourceWalletAddress: event.walletAddress,
          marketId: event.marketId,
          marketQuestion: event.marketQuestion,
          outcome: event.outcome ?? 'UNKNOWN',
          side: event.side!,
          size: event.shares!,
          price: event.price!,
          txHash: event.txHash,
          orderId: event.orderId,
          tradedAt: eventTs,
          observedAt: new Date(event.detectedAt),
        },
      });

      ingestionRate.inc({ wallet_tier: activeTier.toLowerCase() });

      await publishEvent(
        'WALLET_TRADE_DETECTED',
        {
          walletId,
          walletAddress: event.walletAddress,
          activityEventId: activityRow.id,
          eventType: event.eventType,
          marketId: event.marketId,
          side: event.side,
          size: event.shares,
          price: event.price,
          tradedAt: event.eventTimestamp,
          detectionLatencyMs: detectedMs,
        },
        row.id,
      );

      const recentEntriesInWindow = await prisma.tradeEvent.count({
        where: {
          walletId,
          marketId: row.marketId,
          side: row.side,
          tradedAt: {
            gte: new Date(row.tradedAt.getTime() - config.CLUSTER_WINDOW_SECONDS * 1000),
            lte: row.tradedAt,
          },
        },
      });

      const marketLiquidityApprox = Number(row.size) * Number(row.price) * 20;
      await handleWhaleAlert({
        walletId,
        tradeEventId: row.id,
        walletAddress: row.sourceWalletAddress,
        marketId: row.marketId,
        side: row.side,
        price: Number(row.price),
        size: Number(row.size),
        liquidity: marketLiquidityApprox,
        tradedAt: row.tradedAt,
        recentEntriesInWindow,
      });

      await detectAndPersistClusterSignal(row.id);

      const strategies = await prisma.strategy.findMany({
        where: { walletId, enabled: true },
        select: { id: true },
      });
      for (const strategy of strategies) {
        await decisionQueue.add(
          'decision',
          { strategyId: strategy.id, tradeEventId: row.id, activityEventId: activityRow.id },
          {
            removeOnComplete: 1000,
            removeOnFail: 1000,
            attempts: 5,
            backoff: { type: 'exponential', delay: 500 },
          },
        );
      }
    } catch (error) {
      logger.debug(
        { error, dedupeKey, externalEventId: event.externalEventId ?? null },
        'activity event duplicate or insert failed',
      );
    }
  }

  const nextInterval = computeNextPollIntervalMs(activeTier === 'ACTIVE');
  const walletUpdateData: Record<string, unknown> = {
    syncStatus: 'ACTIVE',
    lastSyncAt: new Date(),
    lastPolledAt: new Date(),
    nextPollAt: new Date(Date.now() + nextInterval),
    priorityTier: activeTier,
  };
  if (latestSeenActivityAt) {
    walletUpdateData.lastActivitySyncedAt = latestSeenActivityAt;
  }
  await prisma.watchedWallet.update({
    where: { id: walletId },
    data: walletUpdateData,
  });

  pollLatency.observe(Date.now() - start);
}
