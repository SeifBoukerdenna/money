-- CreateEnum
CREATE TYPE "PaperDecisionType" AS ENUM ('COPY', 'SKIP', 'REDUCE', 'CLOSE', 'BOOTSTRAP', 'NOOP');

-- CreateEnum
CREATE TYPE "PaperDecisionStatus" AS ENUM ('PENDING', 'EXECUTED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaperExecutorType" AS ENUM ('PAPER', 'DRY_RUN', 'LIVE');

-- AlterTable
ALTER TABLE "PaperCopyTrade"
ADD COLUMN "decisionId" TEXT;

-- CreateTable
CREATE TABLE "PaperCopyDecision" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "trackedWalletId" TEXT,
    "walletAddress" TEXT,
    "sourceActivityEventId" TEXT,
    "sourceEventTimestamp" TIMESTAMP(3),
    "sourceTxHash" TEXT,
    "decisionType" "PaperDecisionType" NOT NULL,
    "status" "PaperDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "executorType" "PaperExecutorType" NOT NULL DEFAULT 'PAPER',
    "marketId" TEXT,
    "marketQuestion" TEXT,
    "outcome" TEXT,
    "side" "Side",
    "sourceShares" DECIMAL(65,30),
    "simulatedShares" DECIMAL(65,30),
    "sourcePrice" DECIMAL(65,30),
    "intendedFillPrice" DECIMAL(65,30),
    "copyRatio" DECIMAL(65,30),
    "sizingInputsJson" JSONB,
    "reasonCode" TEXT NOT NULL,
    "humanReason" TEXT NOT NULL,
    "riskChecksJson" JSONB,
    "notes" TEXT,
    "executionError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperCopyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaperCopyDecision_sessionId_sourceActivityEventId_key"
ON "PaperCopyDecision"("sessionId", "sourceActivityEventId");

-- CreateIndex
CREATE INDEX "PaperCopyDecision_sessionId_createdAt_idx"
ON "PaperCopyDecision"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperCopyDecision_sessionId_status_createdAt_idx"
ON "PaperCopyDecision"("sessionId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PaperCopyDecision_sessionId_sourceEventTimestamp_idx"
ON "PaperCopyDecision"("sessionId", "sourceEventTimestamp");

-- CreateIndex
CREATE INDEX "PaperCopyTrade_decisionId_idx"
ON "PaperCopyTrade"("decisionId");

-- AddForeignKey
ALTER TABLE "PaperCopyDecision"
ADD CONSTRAINT "PaperCopyDecision_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "PaperCopySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperCopyDecision"
ADD CONSTRAINT "PaperCopyDecision_sourceActivityEventId_fkey"
FOREIGN KEY ("sourceActivityEventId") REFERENCES "WalletActivityEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperCopyTrade"
ADD CONSTRAINT "PaperCopyTrade_decisionId_fkey"
FOREIGN KEY ("decisionId") REFERENCES "PaperCopyDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
