import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';

const SNAPSHOT_RETENTION_ROWS = Math.max(200, config.PORTFOLIO_SNAPSHOT_RETENTION_ROWS);

async function pruneStrategySnapshots(strategyId: string): Promise<void> {
  const count = await prisma.portfolioSnapshot.count({ where: { strategyId } });
  if (count <= SNAPSHOT_RETENTION_ROWS + 100) {
    return;
  }
  const staleRows = await prisma.portfolioSnapshot.findMany({
    where: { strategyId },
    orderBy: { createdAt: 'asc' },
    take: count - SNAPSHOT_RETENTION_ROWS,
    select: { id: true },
  });
  if (staleRows.length === 0) {
    return;
  }
  await prisma.portfolioSnapshot.deleteMany({
    where: { id: { in: staleRows.map((row) => row.id) } },
  });
}

function hasMeaningfulChange(input: {
  bankroll: number;
  exposure: number;
  realized: number;
  unrealized: number;
  openPositions: number;
  latest: {
    bankroll: number;
    exposure: number;
    realizedPnl: number;
    unrealizedPnl: number;
    openPositions: number;
    createdAt: Date;
  } | null;
}): boolean {
  if (!input.latest) {
    return true;
  }

  const ageMs = Date.now() - input.latest.createdAt.getTime();
  if (ageMs >= config.PORTFOLIO_SNAPSHOT_INTERVAL_MS) {
    return true;
  }

  const nearlyEqual = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  return !(
    nearlyEqual(input.bankroll, input.latest.bankroll) &&
    nearlyEqual(input.exposure, input.latest.exposure) &&
    nearlyEqual(input.realized, input.latest.realizedPnl) &&
    nearlyEqual(input.unrealized, input.latest.unrealizedPnl) &&
    input.openPositions === input.latest.openPositions
  );
}

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

    const latest = await prisma.portfolioSnapshot.findFirst({
      where: { strategyId: strategy.id },
      orderBy: { createdAt: 'desc' },
      select: {
        bankroll: true,
        exposure: true,
        realizedPnl: true,
        unrealizedPnl: true,
        openPositions: true,
        createdAt: true,
      },
    });

    if (
      !hasMeaningfulChange({
        bankroll: Number(strategy.bankroll),
        exposure,
        realized,
        unrealized,
        openPositions: positions.filter((p: (typeof positions)[number]) => Number(p.size) > 0)
          .length,
        latest: latest
          ? {
              bankroll: Number(latest.bankroll),
              exposure: Number(latest.exposure),
              realizedPnl: Number(latest.realizedPnl),
              unrealizedPnl: Number(latest.unrealizedPnl),
              openPositions: latest.openPositions,
              createdAt: latest.createdAt,
            }
          : null,
      })
    ) {
      continue;
    }

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

    await pruneStrategySnapshots(strategy.id);
  }
}
