# Tracked-Wallet PnL Inflation Audit Notes

Date: 2026-03-16
Scope: Source-wallet ingestion/reduction/API semantics for tracked-wallet performance and source-vs-session comparisons.

## Inflation Risks Found

1. Missing fees could silently overstate net PnL.
2. Fallback/stale marks could overstate unrealized PnL and therefore net PnL.
3. Unsupported/non-trade events were ignored without explicit canonical accounting impact.
4. Truncated history could leave open-position cost basis unknown while still showing net figures as if authoritative.
5. Sell events larger than known inventory were clamped with warning, but impossible transitions were not exposed as structured instrumentation.
6. API payloads exposed legacy aggregate fields without clear canonical vs estimated separation.

## Exact Fixes Implemented

1. Canonical append-only source ledger was added in reducer output.
- Event types: BUY_FILL, SELL_FILL, FEE, RESOLUTION_PAYOUT, TRANSFER_IN, TRANSFER_OUT, UNSUPPORTED.
- Ledger is emitted as `ledger` in reducer output.

2. Replay/materialization was hardened with explicit known vs estimated decomposition.
- `canonical` metrics added:
  - `canonicalKnownNetPnl` (nullable fail-closed)
  - `canonicalRealizedPnl`
  - `canonicalUnrealizedPnl`
  - `canonicalFees`
  - `estimatedNetPnl`
- Formula preserved: `net = realized + unrealized - fees`.
- Canonical known net is withheld (`null`) when fee coverage or cost basis certainty is insufficient.

3. Confidence model added.
- `confidenceModel` emitted with:
  - `confidence: HIGH | PARTIAL | LOW`
  - `hasTruncatedHistory`
  - `hasUnsupportedEvents`
  - `hasUnknownCostBasis`
  - `hasEstimatedMarks`
  - `hasMissingFees`
  - explicit warning reasons array

4. Conservative valuation behavior enforced.
- Mark metadata now tracks source (`LIVE` vs `FALLBACK`) and staleness.
- Unrealized components from fallback/missing marks are excluded from canonical unrealized and rolled into estimated contribution.
- Truncated-history open positions are flagged unknown-cost-basis and excluded from authoritative canonical net.

5. Instrumentation and validation/debug report added.
- `debugReport` includes:
  - event counts by canonical type
  - ingested count
  - duplicates
  - normalization failures
  - unsupported ignored count
  - incomplete-history reconstructed positions
  - realized/unrealized known vs estimated contribution
  - impossible state transitions
  - first/last timestamp
  - unknown cost-basis positions
- `validationReport` added to tracked-performance API payload with reconciliation notes and confidence flags.

6. API semantics cleanup completed while preserving compatibility.
- New top-level `canonical`, `confidence`, and `confidenceModel` fields in tracked-performance response.
- Deprecated compatibility fields are still emitted under `totals` so existing UI consumers do not break.
- Source-vs-sessions now carries conservative source canonical fields and confidence metadata.

## Remaining Assumptions

1. Transfers and redemptions from the upstream feed are still constrained by source data completeness and event labeling quality.
2. Fallback prices are treated as estimated/stale by default unless live marks are available.
3. No new infrastructure was added; behavior remains DB-backed and in-process cache-backed.

## When Metrics Are Safe To Trust

1. `confidenceModel.confidence === HIGH`.
2. `canonical.canonicalKnownNetPnl` is non-null.
3. No `hasMissingFees`, `hasUnknownCostBasis`, or `hasUnsupportedEvents` flags.
4. Mark coverage comes from live marks (not fallback estimated marks).

## Current Limitations

1. Full transfer/cashflow semantics are still bounded by available event attributes in source activity feed.
2. Canonical known net is intentionally conservative and may understate true net when unknown components exist.
3. Truncation by event cap can still occur; now explicitly flagged and confidence-downgraded.

## 2026 Engineering Fixes

1. Issue 1 — live-book anchored fill pricing and book-gap visibility.
- Files: apps/api/src/modules/slippage.ts, apps/api/src/modules/paper-decisioning.ts, apps/api/src/modules/paper-copy.ts, apps/api/tests/slippage.test.ts, apps/api/tests/paper-decisioning.test.ts.

2. Issue 2 — half-spread friction layered before slippage/drift and exposed in telemetry.
- Files: apps/api/src/modules/slippage.ts, apps/api/src/modules/paper-decisioning.ts, apps/api/tests/slippage.test.ts.

3. Issue 3 — pagination truncation detection, summary flags, and operator warning.
- Files: apps/api/src/modules/ingestion.ts, apps/api/tests/ingestion-watermark.test.ts.

4. Issue 4 — skipped max-adverse-move accounting surfaced as parallel conservative lower bound.
- Files: apps/api/src/modules/paper-copy.ts, apps/api/tests/paper-copy.test.ts.

5. Issue 5 — invariant tolerance moved to max(0.01, startingCapital*0.0001), drift materiality context added, cumulative drift tracked.
- Files: apps/api/src/modules/paper-accounting.ts, apps/api/src/modules/paper-copy.ts, apps/api/src/routes.ts, apps/api/tests/paper-accounting.test.ts.

6. Issue 6 — realized/unrealized/fees/net breakout promoted to top-level session and analytics payloads with unrealized quality warnings.
- Files: apps/api/src/modules/paper-copy.ts, apps/api/src/routes.ts, apps/api/tests/paper-copy.test.ts.

7. Issue 7 — explicit win-rate definition declared and gross-vs-net split exposed.
- Files: packages/wallet-analytics/src/index.ts, packages/wallet-analytics/tests/wallet-analytics.test.ts, apps/api/src/routes.ts.

8. Issue 8 — insert-failure gap risk tracking with reconciliation issue persistence.
- Files: apps/api/src/modules/ingestion.ts, apps/api/tests/ingestion-watermark.test.ts.

9. Issue 9 — source-vs-session mark contamination metadata and warning path.
- Files: apps/api/src/modules/tracked-wallet-performance.ts, apps/api/src/routes.ts, apps/api/tests/tracked-wallet-performance.test.ts.

10. Issue 10 — queue/processing/total latency transparency added to sizing inputs and analytics friction summary.
- Files: apps/api/src/modules/paper-copy.ts, apps/api/tests/paper-copy.test.ts.

11. Cross-cutting — simulation bias report added to session detail payload.
- Files: apps/api/src/routes.ts.
