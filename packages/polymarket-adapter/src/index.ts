import { type FillStrategy, type Market, type Side, type TradeEvent } from '@copytrader/shared';

export type PolymarketOrderRequest = {
  marketId: string;
  outcome: string;
  side: Side;
  size: number;
  limitPrice: number;
  fillStrategy: FillStrategy;
  idempotencyKey: string;
};

export type PolymarketOrderResponse = {
  orderId: string;
  status: 'SUBMITTED' | 'FILLED' | 'FAILED';
  filledSize: number;
  avgFillPrice: number;
  feePaid: number;
};

export interface PolymarketDataPort {
  getWalletActivity(walletAddress: string, sinceIso?: string): Promise<TradeEvent[]>;
  getWalletActivityFeed(
    walletAddress: string,
    sinceIso?: string,
  ): Promise<WalletActivityFeedEvent[]>;
  getWalletPositions(
    walletAddress: string,
    status: 'OPEN' | 'CLOSED',
    limit?: number,
  ): Promise<WalletPosition[]>;
  getMarket(marketId: string): Promise<Market | null>;
}

export interface PolymarketTradingPort {
  submitOrder(request: PolymarketOrderRequest): Promise<PolymarketOrderResponse>;
}

export type WalletPosition = {
  id: string;
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  totalTraded: number;
  amountWon: number;
  pnl: number;
  pnlPercent: number;
  side: 'BUY' | 'SELL' | 'UNKNOWN';
  status: 'OPEN' | 'CLOSED';
  icon: string | null;
  eventSlug: string | null;
  updatedAt: string;
};

export type WalletActivityFeedEvent = {
  id: string;
  externalEventId?: string;
  eventType: string;
  marketId: string;
  marketQuestion: string | null;
  outcome: string | null;
  side: Side | null;
  price: number | null;
  shares: number | null;
  notional: number | null;
  fee: number | null;
  txHash: string | null;
  orderId: string | null;
  eventTimestamp: string;
  detectedAt: string;
  walletAddress: string;
  rawPayload: Record<string, unknown>;
};

export class LivePolymarketAdapter implements PolymarketDataPort, PolymarketTradingPort {
  constructor(private readonly baseUrl: string) {}

  private readonly dataApiBaseUrl = 'https://data-api.polymarket.com';

  private async fetchJson(
    url: string,
  ): Promise<Record<string, unknown> | Array<Record<string, unknown>> | null> {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
      },
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Polymarket request failed: ${response.status} ${url}`);
    }
    return (await response.json()) as Record<string, unknown> | Array<Record<string, unknown>>;
  }

  async getWalletActivity(walletAddress: string, sinceIso?: string): Promise<TradeEvent[]> {
    const events = await this.getWalletActivityFeed(walletAddress, sinceIso);
    return events
      .filter(
        (event) =>
          event.side !== null &&
          (event.eventType === 'BUY' ||
            event.eventType === 'SELL' ||
            event.eventType === 'TRADE') &&
          event.price !== null &&
          event.shares !== null &&
          event.price > 0 &&
          event.shares > 0,
      )
      .map((event) => ({
        id: event.id,
        sourceEventId: event.externalEventId ?? event.orderId ?? event.txHash ?? event.id,
        sourceWalletAddress: event.walletAddress,
        marketId: event.marketId,
        outcome: event.outcome ?? 'UNKNOWN',
        side: event.side as Side,
        size: event.shares as number,
        price: event.price as number,
        tradedAt: event.eventTimestamp,
        observedAt: event.detectedAt,
      }));
  }

  async getWalletActivityFeed(
    walletAddress: string,
    sinceIso?: string,
  ): Promise<WalletActivityFeedEvent[]> {
    const encoded = encodeURIComponent(walletAddress.toLowerCase());
    const candidates = [
      `${this.dataApiBaseUrl}/activity?user=${encoded}&limit=500&offset=0&sortBy=TIMESTAMP&sortDirection=DESC`,
      `${this.dataApiBaseUrl}/trades?user=${encoded}&limit=500&offset=0`,
    ];

    let payload: Array<Record<string, unknown>> | null = null;
    for (const candidate of candidates) {
      try {
        const body = await this.fetchJson(candidate);
        if (Array.isArray(body)) {
          payload = body;
          break;
        }
        if (body && Array.isArray((body as Record<string, unknown>).data)) {
          payload = (body as { data: Array<Record<string, unknown>> }).data;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!payload) {
      throw new Error('Unable to fetch wallet activity from Polymarket endpoints');
    }

    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : null;
    const events: WalletActivityFeedEvent[] = [];

    for (const row of payload) {
      const marketId = String(row.market ?? row.marketId ?? row.conditionId ?? '').trim();
      const tradedAtMs = toEpochMs(row.timestamp ?? row.tradedAt ?? row.createdAt ?? row.time);
      const size = Number(row.size ?? row.amount ?? row.shares ?? row.usdcSize ?? 0);
      const price = Number(row.price ?? row.avgPrice ?? 0);
      const notional = Number.isFinite(size) && Number.isFinite(price) ? size * price : null;
      const sourceWalletAddress = String(
        row.proxyWallet ?? row.user ?? row.wallet ?? row.sourceWalletAddress ?? walletAddress,
      ).trim();
      const eventType = String(row.type ?? row.eventType ?? 'TRADE').toUpperCase();
      const normalizedType =
        eventType === 'TRADE'
          ? String(row.side ?? row.takerSide ?? 'TRADE').toUpperCase() === 'SELL'
            ? 'SELL'
            : 'BUY'
          : eventType === 'REDEEM'
            ? 'CLOSE'
            : eventType;

      if (sinceMs && Number.isFinite(sinceMs) && tradedAtMs <= sinceMs) {
        continue;
      }
      if (!marketId) {
        continue;
      }

      const externalEventId = row.id ? String(row.id) : undefined;

      events.push({
        id: crypto.randomUUID(),
        ...(externalEventId ? { externalEventId } : {}),
        eventType: normalizedType,
        marketId,
        marketQuestion: row.title ? String(row.title) : null,
        outcome: row.outcome ? String(row.outcome) : null,
        side: normalizedType === 'BUY' ? 'BUY' : normalizedType === 'SELL' ? 'SELL' : null,
        price: Number.isFinite(price) && price > 0 ? price : null,
        shares: Number.isFinite(size) && size > 0 ? size : null,
        notional: notional && Number.isFinite(notional) ? notional : null,
        fee: null,
        txHash: row.transactionHash
          ? String(row.transactionHash)
          : row.txHash
            ? String(row.txHash)
            : null,
        orderId: row.orderId ? String(row.orderId) : null,
        eventTimestamp: new Date(tradedAtMs).toISOString(),
        detectedAt: new Date().toISOString(),
        walletAddress: sourceWalletAddress,
        rawPayload: row,
      });
    }

    return events;
  }

  async getWalletPositions(
    walletAddress: string,
    status: 'OPEN' | 'CLOSED',
    limit = 100,
  ): Promise<WalletPosition[]> {
    const encoded = encodeURIComponent(walletAddress.toLowerCase());

    if (status === 'OPEN') {
      const payload = await this.fetchJson(
        `${this.dataApiBaseUrl}/positions?user=${encoded}&sizeThreshold=.01&limit=${limit}&offset=0`,
      );
      const rows = Array.isArray(payload)
        ? payload
        : payload && Array.isArray((payload as Record<string, unknown>).data)
          ? ((payload as Record<string, unknown>).data as Array<Record<string, unknown>>)
          : [];

      const items: WalletPosition[] = [];
      for (const row of rows) {
        const conditionId = String(row.conditionId ?? '').trim();
        const title = String(row.title ?? '').trim();
        const outcome = String(row.outcome ?? 'UNKNOWN').trim();
        const size = Number(row.size ?? 0);
        if (!conditionId || !title || !Number.isFinite(size) || size <= 0) {
          continue;
        }

        const avgPrice = Number(row.avgPrice ?? 0);
        const currentPrice = Number(row.curPrice ?? row.currentPrice ?? 0);
        const totalTraded = Number(row.initialValue ?? row.totalBought ?? 0);
        const amountWon = Number(row.currentValue ?? 0);
        const pnl = Number(row.cashPnl ?? 0);
        const pnlPercent = Number(row.percentPnl ?? 0);
        const sideGuess =
          Number.isFinite(currentPrice) && Number.isFinite(avgPrice)
            ? currentPrice >= avgPrice
              ? 'BUY'
              : 'SELL'
            : 'UNKNOWN';

        items.push({
          id: String(row.asset ?? `${conditionId}:${outcome}`),
          conditionId,
          title,
          slug: String(row.slug ?? conditionId),
          outcome,
          size,
          avgPrice,
          currentPrice,
          totalTraded,
          amountWon,
          pnl,
          pnlPercent,
          side: sideGuess as 'BUY' | 'SELL' | 'UNKNOWN',
          status: 'OPEN',
          icon: row.icon ? String(row.icon) : null,
          eventSlug: row.eventSlug ? String(row.eventSlug) : null,
          updatedAt: new Date().toISOString(),
        });
      }
      return items.slice(0, limit);
    }

    const payload = await this.fetchJson(
      `${this.dataApiBaseUrl}/activity?user=${encoded}&limit=1000&offset=0&sortBy=TIMESTAMP&sortDirection=DESC`,
    );
    const rows = Array.isArray(payload)
      ? payload
      : payload && Array.isArray((payload as Record<string, unknown>).data)
        ? ((payload as Record<string, unknown>).data as Array<Record<string, unknown>>)
        : [];

    const redeemedByCondition = new Map<
      string,
      {
        conditionId: string;
        outcome: string;
        title: string;
        slug: string;
        icon: string | null;
        eventSlug: string | null;
        amountWon: number;
        updatedAtMs: number;
      }
    >();
    const totalTradedByCondition = new Map<string, number>();

    for (const row of rows) {
      const conditionId = String(row.conditionId ?? '').trim();
      if (!conditionId) {
        continue;
      }
      const outcome = String(row.outcome ?? 'UNKNOWN').trim();
      const type = String(row.type ?? '').toUpperCase();
      const usdcSize = Math.abs(Number(row.usdcSize ?? 0));
      const timestampMs = toEpochMs(row.timestamp ?? row.time ?? row.createdAt);

      if (type === 'TRADE' && Number.isFinite(usdcSize) && usdcSize > 0) {
        totalTradedByCondition.set(
          conditionId,
          (totalTradedByCondition.get(conditionId) ?? 0) + usdcSize,
        );
      }

      if (type !== 'REDEEM') {
        continue;
      }

      const existing = redeemedByCondition.get(conditionId);
      const amountWon = Number(row.usdcSize ?? 0);
      redeemedByCondition.set(conditionId, {
        conditionId,
        outcome: outcome === 'UNKNOWN' ? (existing?.outcome ?? 'UNKNOWN') : outcome,
        title: String(row.title ?? conditionId),
        slug: String(row.slug ?? conditionId),
        icon: row.icon ? String(row.icon) : null,
        eventSlug: row.eventSlug ? String(row.eventSlug) : null,
        amountWon: (existing?.amountWon ?? 0) + (Number.isFinite(amountWon) ? amountWon : 0),
        updatedAtMs: Math.max(existing?.updatedAtMs ?? 0, timestampMs),
      });
    }

    return Array.from(redeemedByCondition.values())
      .map((row) => {
        const totalTraded = totalTradedByCondition.get(row.conditionId) ?? 0;
        const amountWon = row.amountWon;
        const pnl = amountWon - totalTraded;
        const pnlPercent = totalTraded > 0 ? (pnl / totalTraded) * 100 : 0;
        return {
          id: row.conditionId,
          conditionId: row.conditionId,
          title: row.title,
          slug: row.slug,
          outcome: row.outcome,
          size: 0,
          avgPrice: 0,
          currentPrice: 0,
          totalTraded,
          amountWon,
          pnl,
          pnlPercent,
          side: pnl >= 0 ? 'BUY' : 'SELL',
          status: 'CLOSED' as const,
          icon: row.icon,
          eventSlug: row.eventSlug,
          updatedAt: new Date(row.updatedAtMs).toISOString(),
        } satisfies WalletPosition;
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);
  }

  async getMarket(marketId: string): Promise<Market | null> {
    const response = await fetch(`${this.baseUrl}/markets/${marketId}`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Polymarket market fetch failed: ${response.status}`);
    }
    const row = (await response.json()) as Record<string, unknown>;
    const bestBid = Number(row.bestBid ?? 0);
    const bestAsk = Number(row.bestAsk ?? 0);
    const midpoint =
      bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : Number(row.midpoint ?? 0);
    const spreadBps = midpoint > 0 ? ((bestAsk - bestBid) / midpoint) * 10000 : 0;

    return {
      id: marketId,
      slug: String(row.slug ?? marketId),
      question: String(row.question ?? ''),
      active: Boolean(row.active ?? true),
      bestBid,
      bestAsk,
      midpoint,
      liquidity: Number(row.liquidity ?? 0),
      spreadBps,
    };
  }

  async submitOrder(_request: PolymarketOrderRequest): Promise<PolymarketOrderResponse> {
    throw new Error(
      'LivePolymarketAdapter.submitOrder requires official Polymarket CLOB SDK wiring',
    );
  }
}

function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }
    return value * 1000;
  }

  const parsed = new Date(String(value ?? '')).getTime();
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Date.now();
}
