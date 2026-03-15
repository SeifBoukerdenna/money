-- Phase 6: session guardrails + persistent system alerts

ALTER TABLE "PaperCopySession"
ADD COLUMN "minWalletTrades" INTEGER,
ADD COLUMN "minWalletWinRate" DECIMAL,
ADD COLUMN "minWalletSharpeLike" DECIMAL,
ADD COLUMN "dailyDrawdownLimitPct" DECIMAL,
ADD COLUMN "autoPauseOnHealthDegradation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "consecutiveDecisionFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastAutoPausedAt" TIMESTAMP(3);

CREATE TABLE "SystemAlert" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "alertType" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "walletId" TEXT,
  "sessionId" TEXT,
  "payloadJson" JSONB,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "count" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SystemAlert_dedupeKey_key" ON "SystemAlert"("dedupeKey");
CREATE INDEX "SystemAlert_status_severity_lastSeenAt_idx" ON "SystemAlert"("status", "severity", "lastSeenAt");
CREATE INDEX "SystemAlert_alertType_lastSeenAt_idx" ON "SystemAlert"("alertType", "lastSeenAt");
CREATE INDEX "SystemAlert_walletId_lastSeenAt_idx" ON "SystemAlert"("walletId", "lastSeenAt");
CREATE INDEX "SystemAlert_sessionId_lastSeenAt_idx" ON "SystemAlert"("sessionId", "lastSeenAt");

ALTER TABLE "SystemAlert"
ADD CONSTRAINT "SystemAlert_walletId_fkey"
FOREIGN KEY ("walletId") REFERENCES "WatchedWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SystemAlert"
ADD CONSTRAINT "SystemAlert_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "PaperCopySession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
