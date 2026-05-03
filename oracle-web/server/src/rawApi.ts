import type { Express } from 'express';
import { priceSocketServer } from './websocket/priceSocket.js';
import { regimeService } from './services/regimeService.js';
import { buildSymbolDetail } from './services/symbolDetailService.js';

/**
 * Bot-consumption surface for stock_o_bot. Localhost-only for v1; no auth.
 * All endpoints under `/api/raw/*` to clearly separate from the UI surface.
 */
export function registerRawApi(app: Express): void {
  app.get('/api/raw/scanner', (_req, res) => {
    res.json({
      ts: new Date().toISOString(),
      stocks: priceSocketServer.getStockStates(),
    });
  });
}
