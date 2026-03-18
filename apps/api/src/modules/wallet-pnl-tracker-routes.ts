/**
 * wallet-pnl-tracker-routes.ts
 *
 * Fastify route registration for the Windowed Wallet PnL Tracker.
 *
 * INTEGRATION: Import and call `registerWalletPnlTrackerRoutes(app)` from routes.ts.
 *
 * Routes:
 *   GET /wallets/:id/windowed-pnl
 */

import { z } from 'zod';

import { calculateWindowedPnl } from './wallet-pnl-tracker.js';

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const querySchema = z.object({
  window: z.enum(['5M', '15M', '1H', '4H', '24H', '7D', '30D', 'ALL']).default('24H'),
  feeMode: z.enum(['ACTUAL', 'REALISTIC', 'NONE']).default('REALISTIC'),
  useLiveMarks: z.coerce.boolean().default(true),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export function registerWalletPnlTrackerRoutes(app: any) {
  app.get('/wallets/:id/windowed-pnl', async (req: any) => {
    const params = paramsSchema.parse(req.params);
    const query = querySchema.parse(req.query ?? {});

    const windowInput =
      query.from && query.to ? { from: query.from, to: query.to } : query.window;

    return calculateWindowedPnl({
      walletId: params.id,
      window: windowInput,
      feeMode: query.feeMode,
      useLiveMarks: query.useLiveMarks,
    });
  });
}
