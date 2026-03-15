/*
  Warnings:

  - You are about to alter the column `minWalletWinRate` on the `PaperCopySession` table. The data in that column could be lost. The data in that column will be cast from `Decimal` to `Decimal(65,30)`.
  - You are about to alter the column `minWalletSharpeLike` on the `PaperCopySession` table. The data in that column could be lost. The data in that column will be cast from `Decimal` to `Decimal(65,30)`.
  - You are about to alter the column `dailyDrawdownLimitPct` on the `PaperCopySession` table. The data in that column could be lost. The data in that column will be cast from `Decimal` to `Decimal(65,30)`.

*/
-- AlterTable
ALTER TABLE "PaperCopySession" ALTER COLUMN "minWalletWinRate" SET DATA TYPE DECIMAL(65,30),
ALTER COLUMN "minWalletSharpeLike" SET DATA TYPE DECIMAL(65,30),
ALTER COLUMN "dailyDrawdownLimitPct" SET DATA TYPE DECIMAL(65,30);

-- AlterTable
ALTER TABLE "SystemAlert" ALTER COLUMN "updatedAt" DROP DEFAULT;
