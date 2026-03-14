-- AlterTable
ALTER TABLE "WatchedWallet"
ADD COLUMN     "syncStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncError" TEXT;

-- AlterTable
ALTER TABLE "TradeEvent"
ADD COLUMN     "marketQuestion" TEXT,
ADD COLUMN     "txHash" TEXT,
ADD COLUMN     "orderId" TEXT;
