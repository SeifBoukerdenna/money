# Setup

## Prerequisites

- Node.js 20+
- pnpm 9+
- Docker and Docker Compose

## Local setup

1. `pnpm install`
2. `cp .env.example .env`
3. `docker compose up -d postgres redis`
4. `pnpm db:generate`
5. `pnpm db:migrate`
6. `pnpm db:seed`
7. `pnpm dev`

## Live mode enablement checklist

1. Set `LIVE_TRADING_ENABLED=true`
2. Provide Polymarket credentials env vars
3. Set `APP_MODE=LIVE`
4. Confirm in UI with the exact backend confirmation token
