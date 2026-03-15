/**
 * force-close-routes.ts — Register the force-close API routes.
 *
 * INTEGRATION: Add these 2 lines to your routes.ts:
 *
 *   import { registerForceCloseRoutes } from './modules/force-close-routes.js';
 *
 *   // Inside your registerRoutes function, after other paper-copy routes:
 *   registerForceCloseRoutes(app);
 */

import { z } from 'zod';
import { closeResolvedPositions, forceCloseLot, forceClosePosition } from './force-close.js';

export function registerForceCloseRoutes(app: any) {
  // Force-close a single position at its current mark price
  app.post('/paper-copy-sessions/:id/positions/:positionId/force-close', async (req: any) => {
    const params = z
      .object({
        id: z.string().uuid(),
        positionId: z.string().uuid(),
      })
      .parse(req.params);

    const result = await forceClosePosition(params.id, params.positionId);
    return result;
  });

  // Force-close a specific lot (BUY trade) without flattening all lots in market
  app.post('/paper-copy-sessions/:id/lots/:lotTradeId/force-close', async (req: any) => {
    const params = z
      .object({
        id: z.string().uuid(),
        lotTradeId: z.string().uuid(),
      })
      .parse(req.params);

    const result = await forceCloseLot(params.id, params.lotTradeId);
    return result;
  });

  // Close all positions whose mark price indicates market resolution (≈0 or ≈1)
  app.post('/paper-copy-sessions/:id/close-resolved', async (req: any) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await closeResolvedPositions(params.id);
    return result;
  });
}
