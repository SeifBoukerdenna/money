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
