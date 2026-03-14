-- CreateEnum
CREATE TYPE "AppMode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "Side" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "DecisionAction" AS ENUM ('EXECUTE', 'SKIP');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('SUBMITTED', 'FILLED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "WatchedWallet" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "copyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchedWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mode" "AppMode" NOT NULL DEFAULT 'PAPER',
    "bankroll" DECIMAL(65,30) NOT NULL DEFAULT 10000,
    "copiedTradesToday" INTEGER NOT NULL DEFAULT 0,
    "skippedTradesToday" INTEGER NOT NULL DEFAULT 0,
    "dailyPnl" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "lastCopiedTradeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskConfig" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "fixedDollar" DECIMAL(65,30),
    "pctSourceSize" DECIMAL(65,30),
    "pctBankroll" DECIMAL(65,30),
    "maxExposure" DECIMAL(65,30) NOT NULL,
    "perMarketMaxAllocation" DECIMAL(65,30) NOT NULL,
    "dailyLossCap" DECIMAL(65,30) NOT NULL,
    "maxSlippageBps" INTEGER NOT NULL,
    "minLiquidity" DECIMAL(65,30) NOT NULL,
    "maxSpreadBps" INTEGER NOT NULL,
    "inverseMode" BOOLEAN NOT NULL DEFAULT false,
    "copyBuys" BOOLEAN NOT NULL DEFAULT true,
    "copySells" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "fillStrategy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeEvent" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "sourceWalletAddress" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "size" DECIMAL(65,30) NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "tradedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyDecision" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "tradeEventId" TEXT NOT NULL,
    "action" "DecisionAction" NOT NULL,
    "side" "Side" NOT NULL,
    "orderSize" DECIMAL(65,30) NOT NULL,
    "limitPrice" DECIMAL(65,30) NOT NULL,
    "reasonsJson" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "mode" "AppMode" NOT NULL,
    "status" "ExecutionStatus" NOT NULL,
    "externalOrderId" TEXT,
    "filledSize" DECIMAL(65,30) NOT NULL,
    "avgFillPrice" DECIMAL(65,30) NOT NULL,
    "feePaid" DECIMAL(65,30) NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "size" DECIMAL(65,30) NOT NULL,
    "avgPrice" DECIMAL(65,30) NOT NULL,
    "realizedPnl" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unrealizedPnl" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "mode" "AppMode" NOT NULL,
    "bankroll" DECIMAL(65,30) NOT NULL,
    "exposure" DECIMAL(65,30) NOT NULL,
    "realizedPnl" DECIMAL(65,30) NOT NULL,
    "unrealizedPnl" DECIMAL(65,30) NOT NULL,
    "openPositions" INTEGER NOT NULL,
    "copiedTradesToday" INTEGER NOT NULL,
    "skippedTradesToday" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configJson" JSONB NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WatchedWallet_address_key" ON "WatchedWallet"("address");

-- CreateIndex
CREATE UNIQUE INDEX "RiskConfig_strategyId_key" ON "RiskConfig"("strategyId");

-- CreateIndex
CREATE INDEX "TradeEvent_marketId_idx" ON "TradeEvent"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeEvent_walletId_sourceEventId_key" ON "TradeEvent"("walletId", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "CopyDecision_idempotencyKey_key" ON "CopyDecision"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_decisionId_key" ON "Execution"("decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_strategyId_marketId_outcome_key" ON "Position"("strategyId", "marketId", "outcome");

-- CreateIndex
CREATE INDEX "AuditLog_category_entityId_idx" ON "AuditLog"("category", "entityId");

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskConfig" ADD CONSTRAINT "RiskConfig_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeEvent" ADD CONSTRAINT "TradeEvent_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WatchedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDecision" ADD CONSTRAINT "CopyDecision_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDecision" ADD CONSTRAINT "CopyDecision_tradeEventId_fkey" FOREIGN KEY ("tradeEventId") REFERENCES "TradeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "CopyDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
