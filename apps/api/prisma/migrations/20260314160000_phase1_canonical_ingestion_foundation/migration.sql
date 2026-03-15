-- AlterTable
ALTER TABLE "WalletActivityEvent"
ADD COLUMN     "sourceName" TEXT NOT NULL DEFAULT 'POLYMARKET_DATA_API',
ADD COLUMN     "sourceType" TEXT NOT NULL DEFAULT 'HTTP_API',
ADD COLUMN     "sourceEventId" TEXT,
ADD COLUMN     "sourceCursor" TEXT,
ADD COLUMN     "conditionId" TEXT,
ADD COLUMN     "effectiveSide" "Side",
ADD COLUMN     "blockNumber" INTEGER,
ADD COLUMN     "logIndex" INTEGER,
ADD COLUMN     "sourceTxHash" TEXT,
ADD COLUMN     "observedAt" TIMESTAMP(3),
ADD COLUMN     "rawPayloadHash" TEXT,
ADD COLUMN     "provenanceNote" TEXT;

UPDATE "WalletActivityEvent"
SET
  "sourceEventId" = COALESCE("externalEventId", "orderId", "txHash", "id"),
  "sourceTxHash" = "txHash",
  "effectiveSide" = "side",
  "observedAt" = "detectedAt"
WHERE "sourceEventId" IS NULL OR "sourceTxHash" IS NULL OR "effectiveSide" IS NULL OR "observedAt" IS NULL;

-- CreateTable
CREATE TABLE "WalletSyncCursor" (
    "id" TEXT NOT NULL,
    "trackedWalletId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'HTTP_API',
    "highWatermarkTimestamp" TIMESTAMP(3),
    "highWatermarkCursor" TEXT,
    "overlapWindowSec" INTEGER NOT NULL DEFAULT 180,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastErrorClass" TEXT,
    "lagSec" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastFetchedCount" INTEGER NOT NULL DEFAULT 0,
    "lastInsertedCount" INTEGER NOT NULL DEFAULT 0,
    "lastDuplicateCount" INTEGER NOT NULL DEFAULT 0,
    "lastParseErrorCount" INTEGER NOT NULL DEFAULT 0,
    "lastInsertErrorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletSyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletReconciliationIssue" (
    "id" TEXT NOT NULL,
    "trackedWalletId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL DEFAULT 'POLYMARKET_DATA_API',
    "issueType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARN',
    "marketId" TEXT,
    "conditionId" TEXT,
    "expectedValue" JSONB,
    "actualValue" JSONB,
    "notes" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletReconciliationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletActivityEvent_trackedWalletId_sourceName_sourceEventId_idx" ON "WalletActivityEvent"("trackedWalletId", "sourceName", "sourceEventId");
CREATE INDEX "WalletActivityEvent_trackedWalletId_sourceTxHash_logIndex_idx" ON "WalletActivityEvent"("trackedWalletId", "sourceTxHash", "logIndex");

CREATE UNIQUE INDEX "WalletSyncCursor_trackedWalletId_sourceName_key" ON "WalletSyncCursor"("trackedWalletId", "sourceName");
CREATE INDEX "WalletSyncCursor_sourceName_status_idx" ON "WalletSyncCursor"("sourceName", "status");

CREATE INDEX "WalletReconciliationIssue_trackedWalletId_detectedAt_idx" ON "WalletReconciliationIssue"("trackedWalletId", "detectedAt");
CREATE INDEX "WalletReconciliationIssue_trackedWalletId_issueType_resolvedAt_idx" ON "WalletReconciliationIssue"("trackedWalletId", "issueType", "resolvedAt");

-- AddForeignKey
ALTER TABLE "WalletSyncCursor" ADD CONSTRAINT "WalletSyncCursor_trackedWalletId_fkey" FOREIGN KEY ("trackedWalletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WalletReconciliationIssue" ADD CONSTRAINT "WalletReconciliationIssue_trackedWalletId_fkey" FOREIGN KEY ("trackedWalletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
