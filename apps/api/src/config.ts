import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiEnvPath = path.resolve(__dirname, '../.env');
const rootEnvPath = path.resolve(__dirname, '../../../.env');

if (existsSync(rootEnvPath)) {
  loadEnv({ path: rootEnvPath, override: false });
}
if (existsSync(apiEnvPath)) {
  loadEnv({ path: apiEnvPath, override: false });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().default(4000),
  APP_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),
  LIVE_TRADING_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  LIVE_TRADING_CONFIRMATION_TOKEN: z.string().default('I_UNDERSTAND_LIVE_TRADING_RISK'),
  POLYMARKET_API_BASE: z.string().url().default('https://clob.polymarket.com'),
  INGEST_POLL_INTERVAL_MS: z.coerce.number().default(3000),
  INGEST_POLL_MAX_INTERVAL_MS: z.coerce.number().default(30000),
  RUNTIME_SCHEDULER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  RUNTIME_SCHEDULER_LEASE_KEY: z.string().default('copytrader:scheduler:leader'),
  RUNTIME_SCHEDULER_LEASE_TTL_MS: z.coerce.number().default(15000),
  PORTFOLIO_SNAPSHOT_INTERVAL_MS: z.coerce.number().default(60000),
  WALLET_ANALYTICS_INTERVAL_MS: z.coerce.number().default(300000),
  MARKET_INTELLIGENCE_INTERVAL_MS: z.coerce.number().default(120000),
  PAPER_TICK_INTERVAL_MS: z.coerce.number().default(5000),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().default(600000),
  OPS_MEMORY_SAMPLE_INTERVAL_MS: z.coerce.number().default(30000),
  PORTFOLIO_SNAPSHOT_RETENTION_ROWS: z.coerce.number().default(2000),
  WALLET_ANALYTICS_RETENTION_ROWS: z.coerce.number().default(288),
  MARKET_INTELLIGENCE_RETENTION_ROWS: z.coerce.number().default(720),
  STREAM_EVENT_RETENTION_ROWS: z.coerce.number().default(10000),
  EVENT_BUS_MAX_LISTENERS: z.coerce.number().default(500),
  ACTIVE_WALLET_POLL_MS: z.coerce.number().default(5000),
  INACTIVE_WALLET_POLL_MIN_MS: z.coerce.number().default(30000),
  INACTIVE_WALLET_POLL_MAX_MS: z.coerce.number().default(60000),
  ACTIVE_WALLET_WINDOW_MINUTES: z.coerce.number().default(30),
  INGEST_OVERLAP_WINDOW_SEC: z.coerce.number().default(180),
  INGEST_BACKFILL_LOOKBACK_DAYS: z.coerce.number().default(30),
  INGEST_BACKFILL_PAGE_LIMIT: z.coerce.number().default(20),
  INGEST_ACTIVITY_PAGE_SIZE: z.coerce.number().default(500),
  CLUSTER_THRESHOLD_WALLETS: z.coerce.number().default(3),
  CLUSTER_WINDOW_SECONDS: z.coerce.number().default(120),
  WHALE_LARGE_TRADE_USD: z.coerce.number().default(5000),
  WHALE_LARGE_POSITION_SIZE: z.coerce.number().default(500),
  WHALE_RAPID_MARKET_ENTRY: z.coerce.number().default(3),
  NOTIFY_DISCORD_WEBHOOK: z.string().optional(),
  NOTIFY_TELEGRAM_BOT_TOKEN: z.string().optional(),
  NOTIFY_TELEGRAM_CHAT_ID: z.string().optional(),
  NOTIFY_EMAIL_FROM: z.string().optional(),
  NOTIFY_EMAIL_TO: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;
export const config: AppConfig = envSchema.parse(process.env);
