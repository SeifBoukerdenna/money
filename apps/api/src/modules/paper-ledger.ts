import { prisma } from '../lib/prisma.js';

export type PaperFillInput = {
  strategyId: string;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  fillPrice: number;
  feeBps: number;
};

export async function applyPaperFill(
  input: PaperFillInput,
): Promise<{ feePaid: number; realizedDelta: number }> {
  const feePaid = input.size * input.fillPrice * (input.feeBps / 10000);
  const existing = await prisma.position.findUnique({
    where: {
      strategyId_marketId_outcome: {
        strategyId: input.strategyId,
        marketId: input.marketId,
        outcome: input.outcome,
      },
    },
  });

  let realizedDelta = 0;
  if (!existing) {
    if (input.side === 'SELL') {
      return { feePaid, realizedDelta: -feePaid };
    }
    await prisma.position.create({
      data: {
        strategyId: input.strategyId,
        marketId: input.marketId,
        outcome: input.outcome,
        size: input.size,
        avgPrice: input.fillPrice,
        realizedPnl: -feePaid,
        unrealizedPnl: 0,
      },
    });
    return { feePaid, realizedDelta: -feePaid };
  }

  const currentSize = Number(existing.size);
  const currentAvg = Number(existing.avgPrice);
  const currentRealized = Number(existing.realizedPnl);

  if (input.side === 'BUY') {
    const newSize = currentSize + input.size;
    const newAvg =
      newSize > 0
        ? (currentSize * currentAvg + input.size * input.fillPrice) / newSize
        : currentAvg;
    await prisma.position.update({
      where: { id: existing.id },
      data: {
        size: newSize,
        avgPrice: newAvg,
        realizedPnl: currentRealized - feePaid,
      },
    });
    realizedDelta = -feePaid;
  } else {
    const closeSize = Math.min(currentSize, input.size);
    const pnl = closeSize * (input.fillPrice - currentAvg) - feePaid;
    const newSize = Math.max(0, currentSize - closeSize);
    await prisma.position.update({
      where: { id: existing.id },
      data: {
        size: newSize,
        realizedPnl: currentRealized + pnl,
      },
    });
    realizedDelta = pnl;
  }

  return { feePaid, realizedDelta };
}
