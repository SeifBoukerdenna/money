# Operations Runbook

## Health endpoints

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`

## Common alerts

- High detection latency
- Rising skip-rate due to risk checks
- Live execution failures
- Redis/Postgres connectivity issues

## Incident response

1. Flip to paper mode by setting `APP_MODE=PAPER`
2. Disable live submissions via `LIVE_TRADING_ENABLED=false`
3. Inspect `AuditLog`, `CopyDecision`, and `Execution`
4. Replay missed events with backtest/simulation route

## SLO suggestions

- Event detection p95 < 10s
- Copy decision p95 < 2s
- Execution success ratio > 99% in paper and > 95% in live
