-- AlterTable
ALTER TABLE "WatchedWallet"
ADD COLUMN     "lastActivitySyncedAt" TIMESTAMP(3),
ADD COLUMN     "lastPositionsSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WalletActivityEvent" (
    "id" TEXT NOT NULL,
    "trackedWalletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "externalEventId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "marketQuestion" TEXT,
    "outcome" TEXT,
    "side" "Side",
    "price" DECIMAL(65,30),
    "shares" DECIMAL(65,30),
    "notional" DECIMAL(65,30),
    "fee" DECIMAL(65,30),
    "txHash" TEXT,
    "orderId" TEXT,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "rawPayloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperCopySession" (
    "id" TEXT NOT NULL,
    "trackedWalletId" TEXT NOT NULL,
    "trackedWalletAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startingCash" DECIMAL(65,30) NOT NULL,
    "currentCash" DECIMAL(65,30) NOT NULL,
    "estimatedSourceExposure" DECIMAL(65,30),
    "copyRatio" DECIMAL(65,30),
    "maxAllocationPerMarket" DECIMAL(65,30) NOT NULL DEFAULT 2500,
    "maxTotalExposure" DECIMAL(65,30) NOT NULL DEFAULT 10000,
    "minNotionalThreshold" DECIMAL(65,30) NOT NULL DEFAULT 2,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "slippageBps" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastProcessedEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperCopySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperCopyTrade" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sourceActivityEventId" TEXT,
    "marketId" TEXT NOT NULL,
    "marketQuestion" TEXT,
    "outcome" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "action" TEXT NOT NULL,
    "sourcePrice" DECIMAL(65,30),
    "simulatedPrice" DECIMAL(65,30) NOT NULL,
    "sourceShares" DECIMAL(65,30),
    "simulatedShares" DECIMAL(65,30) NOT NULL,
    "notional" DECIMAL(65,30) NOT NULL,
    "feeApplied" DECIMAL(65,30) NOT NULL,
    "slippageApplied" DECIMAL(65,30) NOT NULL,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "reasoning" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperCopyTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperCopyPosition" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "marketQuestion" TEXT,
    "outcome" TEXT NOT NULL,
    "netShares" DECIMAL(65,30) NOT NULL,
    "avgEntryPrice" DECIMAL(65,30) NOT NULL,
    "currentMarkPrice" DECIMAL(65,30) NOT NULL,
    "realizedPnl" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperCopyPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperPortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "cash" DECIMAL(65,30) NOT NULL,
    "grossExposure" DECIMAL(65,30) NOT NULL,
    "netLiquidationValue" DECIMAL(65,30) NOT NULL,
    "realizedPnl" DECIMAL(65,30) NOT NULL,
    "unrealizedPnl" DECIMAL(65,30) NOT NULL,
    "totalPnl" DECIMAL(65,30) NOT NULL,
    "returnPct" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperPortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperSessionMetricPoint" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "totalPnl" DECIMAL(65,30) NOT NULL,
    "realizedPnl" DECIMAL(65,30) NOT NULL,
    "unrealizedPnl" DECIMAL(65,30) NOT NULL,
    "netLiquidationValue" DECIMAL(65,30) NOT NULL,
    "openPositionsCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperSessionMetricPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletActivityEvent_trackedWalletId_dedupeKey_key" ON "WalletActivityEvent"("trackedWalletId", "dedupeKey");
CREATE INDEX "WalletActivityEvent_trackedWalletId_eventTimestamp_idx" ON "WalletActivityEvent"("trackedWalletId", "eventTimestamp");
CREATE INDEX "WalletActivityEvent_marketId_eventTimestamp_idx" ON "WalletActivityEvent"("marketId", "eventTimestamp");

CREATE INDEX "PaperCopySession_trackedWalletId_createdAt_idx" ON "PaperCopySession"("trackedWalletId", "createdAt");
CREATE INDEX "PaperCopySession_status_updatedAt_idx" ON "PaperCopySession"("status", "updatedAt");

CREATE UNIQUE INDEX "PaperCopyTrade_sessionId_sourceActivityEventId_key" ON "PaperCopyTrade"("sessionId", "sourceActivityEventId");
CREATE INDEX "PaperCopyTrade_sessionId_eventTimestamp_idx" ON "PaperCopyTrade"("sessionId", "eventTimestamp");

CREATE UNIQUE INDEX "PaperCopyPosition_sessionId_marketId_outcome_key" ON "PaperCopyPosition"("sessionId", "marketId", "outcome");
CREATE INDEX "PaperCopyPosition_sessionId_status_idx" ON "PaperCopyPosition"("sessionId", "status");

CREATE INDEX "PaperPortfolioSnapshot_sessionId_timestamp_idx" ON "PaperPortfolioSnapshot"("sessionId", "timestamp");
CREATE INDEX "PaperSessionMetricPoint_sessionId_timestamp_idx" ON "PaperSessionMetricPoint"("sessionId", "timestamp");

-- AddForeignKey
ALTER TABLE "WalletActivityEvent" ADD CONSTRAINT "WalletActivityEvent_trackedWalletId_fkey" FOREIGN KEY ("trackedWalletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperCopySession" ADD CONSTRAINT "PaperCopySession_trackedWalletId_fkey" FOREIGN KEY ("trackedWalletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperCopyTrade" ADD CONSTRAINT "PaperCopyTrade_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PaperCopySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaperCopyTrade" ADD CONSTRAINT "PaperCopyTrade_sourceActivityEventId_fkey" FOREIGN KEY ("sourceActivityEventId") REFERENCES "WalletActivityEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaperCopyPosition" ADD CONSTRAINT "PaperCopyPosition_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PaperCopySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperPortfolioSnapshot" ADD CONSTRAINT "PaperPortfolioSnapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PaperCopySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperSessionMetricPoint" ADD CONSTRAINT "PaperSessionMetricPoint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PaperCopySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
