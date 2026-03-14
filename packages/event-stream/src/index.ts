import { z } from 'zod';

export const streamEventTypeSchema = z.enum([
  'WALLET_TRADE_DETECTED',
  'COPY_TRADE_EXECUTED',
  'WHALE_TRADE_ALERT',
  'CLUSTER_SIGNAL',
  'MARKET_SENTIMENT_UPDATE',
]);

export type StreamEventType = z.infer<typeof streamEventTypeSchema>;

export type StreamEventEnvelope = {
  id: string;
  type: StreamEventType;
  entityId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type Listener = (event: StreamEventEnvelope) => void;

export class EventStreamBus {
  private readonly listeners = new Set<Listener>();

  publish(event: StreamEventEnvelope) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
