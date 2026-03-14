# Polymarket Wallet Copy Trader

Production-style paper-first copy-trading platform for Polymarket wallets.

## Monorepo layout

- `apps/web` Next.js dashboard
- `apps/api` Fastify API, workers, queue, and execution pipeline
- `packages/shared` domain models and contracts
- `packages/polymarket-adapter` live + mock market/wallet adapters
- `packages/risk-engine` sizing and risk decisions
- `packages/backtest-engine` replay simulator and metrics
- `packages/wallet-analytics` wallet performance metrics engine
- `packages/cluster-detector` coordinated trade cluster detection
- `packages/market-intelligence` market sentiment and pressure aggregation
- `packages/alerts` whale trade alert detection
- `packages/event-stream` typed event envelope/bus model

## Quick start

1. Install dependencies
   - `pnpm install`
2. Copy envs
   - `cp .env.example .env`
3. Start infra
   - `docker compose up -d postgres redis`
4. Generate and migrate DB
   - `pnpm db:generate`
   - `pnpm db:migrate`
5. Seed demo data
   - `pnpm db:seed`
6. Start apps
   - `pnpm dev`

Paper mode is default (`APP_MODE=PAPER`). Live mode requires `LIVE_TRADING_ENABLED=true` and explicit confirmation token.

## Testing

- Unit/integration: `pnpm test`
- E2E dashboard smoke: `pnpm test:e2e`

## Core safeguards

- Idempotency key per source event + strategy
- Append-only `AuditLog` for all decisions and executions
- Live trade hard checks in API and executor
- Risk checks before any order creation
- Fallback to paper mode if live config is invalid

## Trading intelligence (new)

- Adaptive polling with active/inactive wallet priority tiers
- Near-real-time event stream with websocket at `/events/ws`
- Whale alerts with Discord/Telegram/email hooks
- Cluster signals for multi-wallet coordinated entries
- Wallet analytics snapshots and leaderboard metrics
- Market intelligence snapshots and sentiment heatmap API
- Smart copy strategy filters (profitable-only, threshold, cluster-only, top-ranked-only, etc.)

## Key new endpoints

- `GET /dashboard/intelligence`
- `GET /leaderboard?sortBy=pnl|winRate|sharpe|accuracy`
- `GET /heatmap`
- `GET /wallets/:id/analytics`
- `GET /whale-alerts`
- `GET /cluster-signals`
- `GET /market-intelligence`
- `GET /events` and websocket `GET /events/ws`
- `GET /strategies/:id/smart-config`
- `POST /strategies/smart-config`

## Documentation

- [Architecture](docs/architecture.md)
- [Setup](docs/setup.md)
- [Operations Runbook](docs/runbook.md)

## Known limitations

- Live Polymarket auth expects valid SDK-compatible credentials
- Historical market reconstruction quality depends on upstream data completeness
- Notification providers are pluggable but minimally wired in MVP

## Future enhancements

- Wallet discovery and ranking
- Multi-wallet blended follower strategies
- Category/tag selective copy
- CSV exports for trades/positions/backtests
