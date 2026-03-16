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
    query?: WalletActivityFeedQuery,
  ): Promise<WalletActivityFeedEvent[]>;
  getWalletPositions(
    walletAddress: string,
    status: 'OPEN' | 'CLOSED',
    limit?: number,
  ): Promise<WalletPosition[]>;
  getMarket(marketId: string): Promise<Market | null>;
}

export type WalletActivityFeedQuery = {
  sinceIso?: string;
  untilIso?: string;
  offset?: number;
  limit?: number;
};

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
  sourceCursor?: string | null;
  eventType: string;
  marketId: string;
  conditionId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  side: Side | null;
  effectiveSide: Side | null;
  price: number | null;
  shares: number | null;
  notional: number | null;
  fee: number | null;
  blockNumber: number | null;
  logIndex: number | null;
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
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Polymarket request failed: ${response.status} ${url}`);
    }
    return (await response.json()) as Record<string, unknown> | Array<Record<string, unknown>>;
  }

  async getWalletActivity(walletAddress: string, sinceIso?: string): Promise<TradeEvent[]> {
    const events = await this.getWalletActivityFeed(
      walletAddress,
      sinceIso ? { sinceIso } : undefined,
    );
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
    query?: WalletActivityFeedQuery,
  ): Promise<WalletActivityFeedEvent[]> {
    const sinceIso = query?.sinceIso;
    const untilIso = query?.untilIso;
    const offset = Math.max(0, query?.offset ?? 0);
    const limit = Math.max(1, Math.min(500, query?.limit ?? 500));

    const encoded = encodeURIComponent(walletAddress.toLowerCase());
    const candidates = [
      `${this.dataApiBaseUrl}/activity?user=${encoded}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`,
      `${this.dataApiBaseUrl}/trades?user=${encoded}&limit=${limit}&offset=${offset}`,
    ];

    let payload: Array<Record<string, unknown>> | null = null;
    let offsetExceeded = false;
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
      } catch (err: any) {
        if (err.message && err.message.includes(' 400 ') && err.message.includes('offset=')) {
          offsetExceeded = true;
        }
        continue;
      }
    }

    // When Polymarket hits its max historical offset (e.g., offset=3000), it returns a 400.
    // We should return an empty array to gracefully end pagination rather than throwing an error,
    // which would crash the ingestion and prevent the `walletSyncCursor` from ever being created.
    if (!payload && offsetExceeded) {
      return [];
    }

    if (!payload) {
      throw new Error('Unable to fetch wallet activity from Polymarket endpoints');
    }

    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : null;
    const untilMs = untilIso ? new Date(untilIso).getTime() : null;
    const events: WalletActivityFeedEvent[] = [];

    for (const row of payload) {
      const marketId = String(row.conditionId ?? row.market ?? row.marketId ?? '').trim();
      const conditionIdRaw = String(row.conditionId ?? row.market ?? row.marketId ?? '').trim();
      const conditionId = conditionIdRaw.length > 0 ? conditionIdRaw : null;
      const tradedAtMs = toEpochMs(row.timestamp ?? row.tradedAt ?? row.createdAt ?? row.time);
      const size = Number(row.size ?? row.amount ?? row.shares ?? row.usdcSize ?? 0);
      const price = Number(row.price ?? row.avgPrice ?? 0);
      const notional = Number.isFinite(size) && Number.isFinite(price) ? size * price : null;
      const sourceWalletAddress = String(
        row.proxyWallet ?? row.user ?? row.wallet ?? row.sourceWalletAddress ?? walletAddress,
      ).trim();

      const rawEventType = String(row.type ?? row.eventType ?? 'TRADE').toUpperCase();

      // ---------------------------------------------------------------------------
      // Side + eventType normalization
      //
      // Polymarket's data-api is inconsistent across endpoints. Rules:
      //
      // 1. Explicit eventType takes precedence: SELL, CLOSE, REDUCE, REDEEM → SELL
      // 2. For TRADE events: look at row.side, row.takerSide, row.outcome_side
      //    Any of those being 'SELL' → normalise to SELL
      // 3. REDEEM is a market resolution payout → treat as CLOSE (full SELL)
      // 4. INCREASE is an add-to-position → BUY
      // 5. Default to BUY only when no signal indicates SELL
      // ---------------------------------------------------------------------------
      let normalizedType: string;
      let effectiveSide: Side | null;

      if (rawEventType === 'REDEEM') {
        normalizedType = 'REDEEM';
        effectiveSide = 'SELL';
      } else if (rawEventType === 'CLOSE') {
        normalizedType = 'CLOSE';
        effectiveSide = 'SELL';
      } else if (rawEventType === 'REDUCE') {
        normalizedType = 'REDUCE';
        effectiveSide = 'SELL';
      } else if (rawEventType === 'SELL') {
        normalizedType = 'SELL';
        effectiveSide = 'SELL';
      } else if (rawEventType === 'INCREASE') {
        normalizedType = 'INCREASE';
        effectiveSide = 'BUY';
      } else if (rawEventType === 'BUY') {
        normalizedType = 'BUY';
        effectiveSide = 'BUY';
      } else {
        // TRADE or unknown — resolve from side fields
        const sideHint = String(
          row.side ?? row.takerSide ?? row.outcome_side ?? row.orderSide ?? '',
        ).toUpperCase();
        if (sideHint === 'SELL') {
          normalizedType = 'SELL';
          effectiveSide = 'SELL';
        } else if (sideHint === 'BUY') {
          normalizedType = 'BUY';
          effectiveSide = 'BUY';
        } else {
          // No explicit signal — default to BUY (most common case for TRADE)
          normalizedType = 'BUY';
          effectiveSide = 'BUY';
        }
      }

      if (sinceMs && Number.isFinite(sinceMs) && tradedAtMs <= sinceMs) {
        continue;
      }
      if (untilMs && Number.isFinite(untilMs) && tradedAtMs > untilMs) {
        continue;
      }
      if (!marketId) {
        continue;
      }

      const externalEventId = row.id ? String(row.id) : undefined;

      // Normalize outcome to UPPERCASE — critical for position matching.
      // Polymarket's positions API returns "Up"/"Down" but activity returns "UP"/"DOWN".
      // Inconsistency causes findUnique(sessionId, marketId, outcome) to miss positions.
      const normalizedOutcome = row.outcome ? String(row.outcome).toUpperCase() : null;

      // For REDEEM events: price and shares may be null/zero for worthless positions.
      // We still need to emit these events so the paper engine closes the position.
      // Winning REDEEMs: price=1.0, shares=usdcSize. Losing: price=0, shares=0.
      let eventPrice = Number.isFinite(price) && price > 0 ? price : null;
      let eventShares = Number.isFinite(size) && size > 0 ? size : null;

      if (normalizedType === 'REDEEM' || normalizedType === 'CLOSE') {
        // For winning REDEEM: shares = usdcSize (payout), price = 1.0
        const usdcPayout = Math.abs(Number(row.usdcSize ?? 0));
        if (usdcPayout > 0) {
          eventShares = usdcPayout;
          eventPrice = 1.0;
        } else {
          // Losing position — still emit the event but with null price/shares.
          // _applyEvent handles this case by closing the position at price=0.
          eventShares = null;
          eventPrice = null;
        }
      }

      events.push({
        id: crypto.randomUUID(),
        ...(externalEventId ? { externalEventId } : {}),
        sourceCursor: externalEventId ?? null,
        eventType: normalizedType,
        marketId,
        conditionId,
        marketQuestion: row.title ? String(row.title) : null,
        outcome: normalizedOutcome,
        side: effectiveSide,
        effectiveSide,
        price: eventPrice,
        shares: eventShares,
        notional: eventShares !== null && eventPrice !== null ? eventShares * eventPrice : null,
        fee: null,
        blockNumber: numberOrNull(row.blockNumber ?? row.block_num ?? row.block),
        logIndex: numberOrNull(row.logIndex ?? row.log_index ?? row.index),
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
        // Normalize to UPPERCASE to match activity events
        const outcome = String(row.outcome ?? 'UNKNOWN')
          .trim()
          .toUpperCase();
        const size = Number(row.size ?? 0);
        if (!conditionId || !title || !Number.isFinite(size) || size <= 0) {
          continue;
        }

        const avgPrice = Number(row.avgPrice ?? row.price ?? 0);
        const currentPrice = Number(row.curPrice ?? row.currentPrice ?? row.price ?? avgPrice);
        const totalTraded = Math.abs(
          Number(row.cashBalanceDelta ?? row.totalTraded ?? size * avgPrice),
        );
        const pnl = (currentPrice - avgPrice) * size;
        const pnlPercent = avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;

        items.push({
          id: conditionId,
          conditionId,
          title,
          slug: String(row.slug ?? row.marketSlug ?? conditionId),
          outcome,
          size,
          avgPrice,
          currentPrice,
          totalTraded,
          amountWon: 0,
          pnl,
          pnlPercent,
          side: 'BUY',
          status: 'OPEN',
          icon: row.icon ? String(row.icon) : null,
          eventSlug: row.eventSlug ? String(row.eventSlug) : null,
          updatedAt: new Date().toISOString(),
        } satisfies WalletPosition);
      }
      return items.slice(0, limit);
    }

    // CLOSED positions — inferred from redemptions
    const payload = await this.fetchJson(
      `${this.dataApiBaseUrl}/value?user=${encoded}&limit=${limit}&offset=0`,
    );
    const rows = Array.isArray(payload)
      ? payload
      : payload && Array.isArray((payload as Record<string, unknown>).data)
        ? ((payload as Record<string, unknown>).data as Array<Record<string, unknown>>)
        : [];

    const totalTradedByCondition = new Map<string, number>();
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

    for (const row of rows) {
      const conditionId = String(row.conditionId ?? row.market ?? '').trim();
      if (!conditionId) continue;

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

      if (type !== 'REDEEM') continue;

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
    if (response.status === 404) return null;
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

function numberOrNull(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}

function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return value;
    return value * 1000;
  }
  const parsed = new Date(String(value ?? '')).getTime();
  if (Number.isFinite(parsed)) return parsed;
  return Date.now();
}

export function createPolymarketDataAdapter(): PolymarketDataPort {
  return new LivePolymarketAdapter('https://clob.polymarket.com');
}

export function createPolymarketTradingAdapter(_mode: 'LIVE'): PolymarketTradingPort {
  return new LivePolymarketAdapter('https://clob.polymarket.com');
}
