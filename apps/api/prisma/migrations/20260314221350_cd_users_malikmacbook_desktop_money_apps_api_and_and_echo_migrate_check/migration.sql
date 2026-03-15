-- Reconstructed migration to match previously applied local DB history.
-- This aligns Prisma migration history and index naming with the state already
-- present in the database to avoid forced reset on `migrate dev`.

-- Paper copy trade indexes removed in that local migration
DROP INDEX IF EXISTS "PaperCopyTrade_decisionId_idx";
DROP INDEX IF EXISTS "PaperCopyTrade_sessionId_sourceEventTimestamp_idx";

-- Index renames observed in database
ALTER INDEX IF EXISTS "WalletActivityEvent_trackedWalletId_sourceName_sourceEventId_id"
  RENAME TO "WalletActivityEvent_trackedWalletId_sourceName_sourceEventI_idx";

ALTER INDEX IF EXISTS "WalletReconciliationIssue_trackedWalletId_issueType_resolvedAt_"
  RENAME TO "WalletReconciliationIssue_trackedWalletId_issueType_resolve_idx";
