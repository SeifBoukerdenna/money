import { prisma } from '../lib/prisma.js';

export async function createPortfolioSnapshots(): Promise<void> {
  const strategies = await prisma.strategy.findMany();
  for (const strategy of strategies) {
    const positions = await prisma.position.findMany({ where: { strategyId: strategy.id } });
    const exposure = positions.reduce(
      (sum: number, p: (typeof positions)[number]) => sum + Number(p.size) * Number(p.avgPrice),
      0,
    );
    const realized = positions.reduce(
      (sum: number, p: (typeof positions)[number]) => sum + Number(p.realizedPnl),
      0,
    );
    const unrealized = positions.reduce(
      (sum: number, p: (typeof positions)[number]) => sum + Number(p.unrealizedPnl),
      0,
    );
    await prisma.portfolioSnapshot.create({
      data: {
        strategyId: strategy.id,
        mode: strategy.mode,
        bankroll: strategy.bankroll,
        exposure,
        realizedPnl: realized,
        unrealizedPnl: unrealized,
        openPositions: positions.filter((p: (typeof positions)[number]) => Number(p.size) > 0)
          .length,
        copiedTradesToday: strategy.copiedTradesToday,
        skippedTradesToday: strategy.skippedTradesToday,
      },
    });
  }
}
