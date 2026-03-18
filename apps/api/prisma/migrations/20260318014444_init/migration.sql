-- AlterTable
ALTER TABLE "PaperCopySession" ADD COLUMN     "slippageConfig" JSONB;

-- AlterTable
ALTER TABLE "PaperPortfolioSnapshot" ADD COLUMN     "fees" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PaperSessionMetricPoint" ADD COLUMN     "fees" DECIMAL(65,30) NOT NULL DEFAULT 0;
