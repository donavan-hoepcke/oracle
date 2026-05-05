import type { Express } from 'express';
import { priceSocketServer } from './websocket/priceSocket.js';
import { regimeService } from './services/regimeService.js';
import { buildSymbolDetail } from './services/symbolDetailService.js';
import { ruleEngineService } from './services/ruleEngineService.js';
import { executionService } from './services/executionService.js';
import { floatMapService } from './services/floatMapService.js';
import { moderatorAlertService } from './services/moderatorAlertService.js';
import { messageService } from './services/messageService.js';

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

  app.get('/api/raw/regime', (_req, res) => {
    res.json({
      ts: new Date().toISOString(),
      snapshot: regimeService.getLastSnapshot(),
    });
  });

  app.get('/api/raw/symbols/:sym', async (req, res) => {
    const raw = typeof req.params.sym === 'string' ? req.params.sym.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(raw)) {
      res.status(400).json({ error: 'invalid_symbol' });
      return;
    }
    const symbol = raw.toUpperCase();
    try {
      const { brokerService } = await import('./services/brokers/index.js');
      const stocks = priceSocketServer.getStockStates();
      const positions = await brokerService.getPositions().catch(() => []);
      const candidates = await ruleEngineService.getRankedCandidates(stocks, 50).catch(() => []);

      const detail = buildSymbolDetail({
        symbol,
        stocks,
        candidates,
        activeTrades: executionService.getActiveTrades(),
        rejections: executionService.getRejections(),
        cooldowns: executionService.getCooldownSymbols(),
        washSaleSymbols: executionService.getWashSaleSymbols(),
        floatMap: floatMapService.getSnapshot(),
        moderator: moderatorAlertService.getSnapshot(),
        messageContext: messageService.getSymbolContext(symbol),
        recentMessages: messageService
          .getRecent(500)
          .filter((m) => m.symbols.includes(symbol))
          .slice(0, 50),
        ledger: executionService.getLedger(),
        positions,
      });

      res.json({ ts: new Date().toISOString(), symbol, detail });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'symbol_detail_failed',
      });
    }
  });
}
