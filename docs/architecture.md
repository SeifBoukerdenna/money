# Architecture

## Core principles

- Hexagonal-ish ports/adapters architecture
- Domain-first modeling in `packages/shared`
- Idempotent event processing with append-only decision audit
- Paper trading as default execution mode

## Event pipeline

1. Ingestion worker pulls wallet activity via adapter
2. New events are normalized into `TradeEvent` and deduplicated by source event id
3. Decision job computes `CopyOrderDecision` with `risk-engine`
4. Execution job routes to paper or live executor
5. Portfolio snapshots and audit rows are persisted
6. Trade intelligence pipeline computes analytics, whale alerts, clusters, and market sentiment
7. Typed events are persisted and pushed via websocket

## Runtime components

- API: Fastify HTTP + scheduler + queue producer
- Worker queues: BullMQ for detection, decision, execution
- Redis: queue backend + caching
- PostgreSQL: source of truth and audit log
- Event stream: persisted `StreamEvent` + realtime websocket fanout
- Intelligence engines: wallet analytics, cluster detector, market sentiment

## Data model highlights

- `TradeEvent`: normalized source activity
- `CopyDecision`: risk/evaluation result per strategy
- `Execution`: submitted/simulated order outcome
- `PortfolioSnapshot`: periodic per-strategy state
- `AuditLog`: append-only critical operation trail
- `WalletAnalyticsSnapshot`: periodic wallet performance metrics
- `WhaleAlert`: large-trade anomaly detection output
- `ClusterSignal`: short-window coordinated market entry signal
- `MarketIntelligenceSnapshot`: buy/sell pressure and sentiment snapshots
- `StreamEvent`: replayable event feed for UI and automation
