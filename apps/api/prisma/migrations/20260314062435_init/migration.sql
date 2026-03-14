-- AlterTable
ALTER TABLE "WatchedWallet" ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "nextPollAt" TIMESTAMP(3),
ADD COLUMN     "priorityTier" TEXT NOT NULL DEFAULT 'INACTIVE';

-- CreateTable
CREATE TABLE "WalletAnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "winRate" DECIMAL(65,30) NOT NULL,
    "averageEntryPrice" DECIMAL(65,30) NOT NULL,
    "averageExitPrice" DECIMAL(65,30) NOT NULL,
    "averageHoldTime" DECIMAL(65,30) NOT NULL,
    "profitFactor" DECIMAL(65,30) NOT NULL,
    "realizedPnl" DECIMAL(65,30) NOT NULL,
    "unrealizedPnl" DECIMAL(65,30) NOT NULL,
    "maxDrawdown" DECIMAL(65,30) NOT NULL,
    "bestTrade" DECIMAL(65,30) NOT NULL,
    "worstTrade" DECIMAL(65,30) NOT NULL,
    "marketDiversification" INTEGER NOT NULL,
    "tradeFrequency" DECIMAL(65,30) NOT NULL,
    "sharpeLike" DECIMAL(65,30) NOT NULL,
    "tradeAccuracy" DECIMAL(65,30) NOT NULL,
    "avgTradeSize" DECIMAL(65,30) NOT NULL,
    "marketsTraded" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletAnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhaleAlert" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tradeEventId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "size" DECIMAL(65,30) NOT NULL,
    "notionalUsd" DECIMAL(65,30) NOT NULL,
    "liquidity" DECIMAL(65,30) NOT NULL,
    "reasonsJson" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhaleAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterSignal" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "walletIdsJson" JSONB NOT NULL,
    "thresholdWallets" INTEGER NOT NULL,
    "windowSeconds" INTEGER NOT NULL,
    "firstTradeAt" TIMESTAMP(3) NOT NULL,
    "lastTradeAt" TIMESTAMP(3) NOT NULL,
    "eventKey" TEXT NOT NULL,
    "triggerTradeEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketIntelligenceSnapshot" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "totalBuyVolume" DECIMAL(65,30) NOT NULL,
    "totalSellVolume" DECIMAL(65,30) NOT NULL,
    "uniqueWallets" INTEGER NOT NULL,
    "netSentimentScore" DECIMAL(65,30) NOT NULL,
    "buyPressure" DECIMAL(65,30) NOT NULL,
    "sellPressure" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketIntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmartCopyStrategyConfig" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "profitableWalletsOnly" BOOLEAN NOT NULL DEFAULT false,
    "minSourceTradeUsd" DECIMAL(65,30),
    "firstEntryOnly" BOOLEAN NOT NULL DEFAULT false,
    "ignoreExitTrades" BOOLEAN NOT NULL DEFAULT false,
    "copyClustersOnly" BOOLEAN NOT NULL DEFAULT false,
    "topRankedWalletsOnly" BOOLEAN NOT NULL DEFAULT false,
    "topRankMinWinRate" DECIMAL(65,30),
    "topRankMinSharpeLike" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmartCopyStrategyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletAnalyticsSnapshot_walletId_createdAt_idx" ON "WalletAnalyticsSnapshot"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "WhaleAlert_marketId_createdAt_idx" ON "WhaleAlert"("marketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterSignal_eventKey_key" ON "ClusterSignal"("eventKey");

-- CreateIndex
CREATE INDEX "ClusterSignal_marketId_createdAt_idx" ON "ClusterSignal"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketIntelligenceSnapshot_marketId_createdAt_idx" ON "MarketIntelligenceSnapshot"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "StreamEvent_type_createdAt_idx" ON "StreamEvent"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SmartCopyStrategyConfig_strategyId_key" ON "SmartCopyStrategyConfig"("strategyId");

-- AddForeignKey
ALTER TABLE "WalletAnalyticsSnapshot" ADD CONSTRAINT "WalletAnalyticsSnapshot_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhaleAlert" ADD CONSTRAINT "WhaleAlert_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhaleAlert" ADD CONSTRAINT "WhaleAlert_tradeEventId_fkey" FOREIGN KEY ("tradeEventId") REFERENCES "TradeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterSignal" ADD CONSTRAINT "ClusterSignal_triggerTradeEventId_fkey" FOREIGN KEY ("triggerTradeEventId") REFERENCES "TradeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartCopyStrategyConfig" ADD CONSTRAINT "SmartCopyStrategyConfig_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
