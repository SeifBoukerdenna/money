import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { publishEvent } from './event-stream.js';

function detectWhaleAlert(input: {
  wallet: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  liquidity: number;
  tradedAt: string;
  recentEntriesInWindow: number;
}) {
  const reasons: string[] = [];
  const notional = input.size * input.price;
  if (notional >= config.WHALE_LARGE_TRADE_USD) {
    reasons.push('LARGE_TRADE_USD');
  }
  if (input.size >= config.WHALE_LARGE_POSITION_SIZE) {
    reasons.push('LARGE_POSITION_SIZE');
  }
  if (input.recentEntriesInWindow >= config.WHALE_RAPID_MARKET_ENTRY) {
    reasons.push('RAPID_MARKET_ENTRY');
  }
  return {
    triggered: reasons.length > 0,
    reasons,
    notional,
    message: `${input.wallet} ${input.side} ${input.marketId} size=${input.size.toFixed(2)} price=${input.price.toFixed(4)} notional=${notional.toFixed(2)} liquidity=${input.liquidity.toFixed(2)} @ ${input.tradedAt}`,
  };
}

async function notifyDiscord(message: string) {
  if (!config.NOTIFY_DISCORD_WEBHOOK) {
    return;
  }
  await fetch(config.NOTIFY_DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message }),
  });
}

async function notifyTelegram(message: string) {
  if (!config.NOTIFY_TELEGRAM_BOT_TOKEN || !config.NOTIFY_TELEGRAM_CHAT_ID) {
    return;
  }
  await fetch(`https://api.telegram.org/bot${config.NOTIFY_TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.NOTIFY_TELEGRAM_CHAT_ID,
      text: message,
    }),
  });
}

async function notifyEmail(_message: string) {
  if (!config.SMTP_HOST || !config.NOTIFY_EMAIL_TO || !config.NOTIFY_EMAIL_FROM) {
    return;
  }
  logger.warn('Email notifier configured in env but SMTP sender is not implemented in MVP runtime');
}

export async function handleWhaleAlert(input: {
  walletId: string;
  tradeEventId: string;
  walletAddress: string;
  marketId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  liquidity: number;
  tradedAt: Date;
  recentEntriesInWindow: number;
}) {
  const alert = detectWhaleAlert({
    wallet: input.walletAddress,
    marketId: input.marketId,
    side: input.side,
    size: input.size,
    price: input.price,
    liquidity: input.liquidity,
    tradedAt: input.tradedAt.toISOString(),
    recentEntriesInWindow: input.recentEntriesInWindow,
  });

  if (!alert.triggered) {
    return null;
  }

  const row = await prisma.whaleAlert.create({
    data: {
      walletId: input.walletId,
      tradeEventId: input.tradeEventId,
      marketId: input.marketId,
      side: input.side,
      price: input.price,
      size: input.size,
      notionalUsd: alert.notional,
      liquidity: input.liquidity,
      reasonsJson: alert.reasons,
      message: alert.message,
    },
  });

  await publishEvent(
    'WHALE_TRADE_ALERT',
    {
      wallet: input.walletAddress,
      market: input.marketId,
      side: input.side,
      price: input.price,
      size: input.size,
      timestamp: input.tradedAt.toISOString(),
      liquidity: input.liquidity,
      reasons: alert.reasons,
    },
    row.id,
  );

  await Promise.allSettled([
    notifyDiscord(alert.message),
    notifyTelegram(alert.message),
    notifyEmail(alert.message),
  ]);

  return row;
}
