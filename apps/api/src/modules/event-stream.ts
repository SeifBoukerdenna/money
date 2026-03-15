import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import type { Prisma } from '@prisma/client';

type StreamEventType =
  | 'WALLET_TRADE_DETECTED'
  | 'COPY_TRADE_EXECUTED'
  | 'WHALE_TRADE_ALERT'
  | 'CLUSTER_SIGNAL'
  | 'MARKET_SENTIMENT_UPDATE';

type StreamEventEnvelope = {
  id: string;
  type: StreamEventType;
  entityId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type Listener = (event: StreamEventEnvelope) => void;

class EventStreamBus {
  private readonly listeners = new Set<Listener>();

  publish(event: StreamEventEnvelope) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: Listener) {
    if (this.listeners.size >= config.EVENT_BUS_MAX_LISTENERS) {
      throw new Error('Event stream listener limit reached');
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount() {
    return this.listeners.size;
  }
}

export const eventBus = new EventStreamBus();

let _lastPruneAtMs = 0;

async function pruneStreamEventsIfNeeded() {
  const nowMs = Date.now();
  if (nowMs - _lastPruneAtMs < 60_000) {
    return;
  }
  _lastPruneAtMs = nowMs;

  const cap = Math.max(500, config.STREAM_EVENT_RETENTION_ROWS);
  const total = await prisma.streamEvent.count();
  if (total <= cap + 200) {
    return;
  }

  const rowsToDelete = await prisma.streamEvent.findMany({
    orderBy: { createdAt: 'asc' },
    take: total - cap,
    select: { id: true },
  });
  if (rowsToDelete.length === 0) {
    return;
  }
  await prisma.streamEvent.deleteMany({
    where: { id: { in: rowsToDelete.map((row) => row.id) } },
  });
}

export async function publishEvent(
  type: StreamEventType,
  payload: Record<string, unknown>,
  entityId?: string,
): Promise<StreamEventEnvelope> {
  const event: StreamEventEnvelope = {
    id: crypto.randomUUID(),
    type,
    ...(entityId ? { entityId } : {}),
    payload,
    createdAt: new Date().toISOString(),
  };

  await prisma.streamEvent.create({
    data: {
      id: event.id,
      type: event.type,
      entityId: event.entityId ?? null,
      payload: event.payload as Prisma.InputJsonValue,
      createdAt: new Date(event.createdAt),
    },
  });
  await pruneStreamEventsIfNeeded();
  eventBus.publish(event);
  return event;
}

export async function loadRecentEvents(limit = 200) {
  const rows = await prisma.streamEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    ...(row.entityId ? { entityId: row.entityId } : {}),
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
}
