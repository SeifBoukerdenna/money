-- AlterTable
ALTER TABLE "PaperCopyTrade"
ADD COLUMN     "trackedWalletId" TEXT,
ADD COLUMN     "walletAddress" TEXT,
ADD COLUMN     "sourceType" TEXT NOT NULL DEFAULT 'WALLET_ACTIVITY',
ADD COLUMN     "sourceEventTimestamp" TIMESTAMP(3),
ADD COLUMN     "sourceTxHash" TEXT,
ADD COLUMN     "executorType" TEXT NOT NULL DEFAULT 'PAPER_SESSION_ENGINE',
ADD COLUMN     "isBootstrap" BOOLEAN NOT NULL DEFAULT false;

-- Backfill source linkage where available
UPDATE "PaperCopyTrade" pct
SET
  "sourceEventTimestamp" = wae."eventTimestamp",
  "sourceTxHash" = wae."txHash"
FROM "WalletActivityEvent" wae
WHERE pct."sourceActivityEventId" = wae."id";

-- Backfill tracked wallet metadata from session
UPDATE "PaperCopyTrade" pct
SET
  "trackedWalletId" = pcs."trackedWalletId",
  "walletAddress" = pcs."trackedWalletAddress"
FROM "PaperCopySession" pcs
WHERE pct."sessionId" = pcs."id";

-- Backfill bootstrap flag from action field
UPDATE "PaperCopyTrade"
SET "isBootstrap" = true
WHERE "action" = 'BOOTSTRAP';

-- Optional lookup index for source replay/debug
CREATE INDEX "PaperCopyTrade_sessionId_sourceEventTimestamp_idx"
ON "PaperCopyTrade"("sessionId", "sourceEventTimestamp");
