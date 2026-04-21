import express from 'express';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync } from 'fs';
import { z } from 'zod';
import { config } from './config.js';
import { priceSocketServer, StockState } from './websocket/priceSocket.js';
import { getMarketStatus } from './services/marketHoursService.js';
import { messageService } from './services/messageService.js';
import { ruleEngineService } from './services/ruleEngineService.js';
import { executionService } from './services/executionService.js';
import { backtestRunner } from './services/backtestRunner.js';
import { synthesizeDay } from './services/recordingSynthService.js';
import { floatMapService } from './services/floatMapService.js';
import { moderatorAlertService } from './services/moderatorAlertService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// JSON middleware
app.use(express.json());

// --- Rate limiter (in-memory, per-IP) ---
function createRateLimiter(maxRequests: number, windowMs: number) {
  const requests = new Map<string, number[]>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const timestamps = (requests.get(key) ?? []).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    timestamps.push(now);
    requests.set(key, timestamps);
    next();
  };
}

const botRateLimit = createRateLimiter(10, 60_000);
const messageRateLimit = createRateLimiter(60, 60_000);

// API Routes
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    marketStatus: getMarketStatus(),
  });
});

app.get('/api/watchlist', (_req, res) => {
  const stocks = priceSocketServer.getStockStates();
  res.json({
    stocks,
    marketStatus: getMarketStatus(),
    botStatus: priceSocketServer.getBotStatus(),
  });
});

app.get('/api/bot/status', (_req, res) => {
  res.json(priceSocketServer.getBotStatus());
});

app.post('/api/bot/start', botRateLimit, async (_req, res) => {
  try {
    const status = await priceSocketServer.startBot();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to start bot',
    });
  }
});

app.post('/api/bot/stop', botRateLimit, async (_req, res) => {
  try {
    const status = await priceSocketServer.stopBot();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to stop bot',
    });
  }
});

app.get('/api/bot/playwright-preview', async (req, res) => {
  const limitRaw = req.query.limit;
  const limitNum = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 25;
  const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(limitNum, 200)) : 25;

  try {
    const items = await priceSocketServer.previewPlaywrightTickers();
    res.json({
      count: items.length,
      items: items.slice(0, limit),
      selectorMode: config.bot.playwright.row_selector ? 'row' : 'symbols',
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to preview playwright extraction',
    });
  }
});

app.get('/api/bot/playwright-debug', async (_req, res) => {
  try {
    const report = await priceSocketServer.previewPlaywrightDebug();
    res.json(report);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to inspect playwright page',
    });
  }
});

const messageEventSchema = z.object({
  text: z.string().min(1).max(5000),
  channel: z.string().max(200).optional(),
  author: z.string().max(200).optional(),
  timestamp: z.string().optional(),
});

const messageBatchSchema = z.object({
  events: z.array(messageEventSchema).max(100),
});

const messageBodySchema = z.union([messageEventSchema, messageBatchSchema]);

app.post('/api/messages', messageRateLimit, (req, res) => {
  const parsed = messageBodySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }

  try {
    const body = parsed.data;

    if ('events' in body) {
      const created = messageService.ingestMany(body.events);
      res.json({ count: created.length, events: created });
      return;
    }

    const created = messageService.ingest(body);
    res.json(created);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to ingest message events',
    });
  }
});

app.get('/api/messages', (req, res) => {
  const limitRaw = req.query.limit;
  const limitNum = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 100;
  const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(limitNum, 1000)) : 100;
  res.json({
    count: limit,
    events: messageService.getRecent(limit),
  });
});

app.get('/api/floatmap', (_req, res) => {
  res.json(floatMapService.getSnapshot());
});

app.get('/api/moderator-alerts', (_req, res) => {
  res.json(moderatorAlertService.getSnapshot());
});

app.get('/api/trade-candidates', async (_req, res) => {
  const limitRaw = _req.query.limit;
  const limitNum = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 10;
  const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(limitNum, 100)) : 10;

  try {
    const stocks = priceSocketServer.getStockStates();
    const candidates = await ruleEngineService.getRankedCandidates(stocks, limit);

    res.json({
      count: candidates.length,
      candidates,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to compute trade candidates',
    });
  }
});

app.get('/api/trades', (_req, res) => {
  res.json({
    active: executionService.getActiveTrades(),
    closed: executionService.getLedger(),
    dailyPnl: executionService.getDailyPnl(),
  });
});

app.get('/api/scanner', async (_req, res) => {
  try {
    const { alpacaOrderService } = await import('./services/alpacaOrderService.js');
    const stocks = priceSocketServer.getStockStates();
    const positionsPromise = alpacaOrderService.getPositions().catch(() => []);
    const candidates = await ruleEngineService.getRankedCandidates(stocks, 20);
    const positions = await positionsPromise;

    const activeTrades = executionService.getActiveTrades();
    const rejections = executionService.getRejections();
    const cooldowns = executionService.getCooldownSymbols();
    const cooldownMap = new Map(cooldowns.map((c) => [c.symbol, c]));
    const washSaleSet = new Set(executionService.getWashSaleSymbols());
    const rejectionMap = new Map(rejections.map((r) => [r.symbol, r]));
    const candidateMap = new Map(candidates.map((c) => [c.symbol, c]));
    const activeMap = new Map(activeTrades.map((t) => [t.symbol, t]));
    const positionMap = new Map(positions.map((p) => [p.symbol, p]));

    const rows = stocks.map((stock) => {
      const active = activeMap.get(stock.symbol);
      const rejection = rejectionMap.get(stock.symbol);
      const candidate = candidateMap.get(stock.symbol);
      const position = positionMap.get(stock.symbol);

      const current = stock.currentPrice;
      const stop = stock.stopPrice ?? null;
      const buy = stock.buyZonePrice ?? null;
      const sell = stock.sellZonePrice ?? null;

      let status: 'traded' | 'blown_out' | 'rejected' | 'candidate' | 'setup' | 'watch' | 'dead';
      if (active) {
        status = 'traded';
      } else if (current !== null && sell !== null && current >= sell) {
        status = 'blown_out';
      } else if (current !== null && stop !== null && current <= stop) {
        status = 'dead';
      } else if (rejection) {
        status = 'rejected';
      } else if (candidate) {
        status = 'candidate';
      } else if (current !== null && buy !== null && stop !== null && current >= buy * 0.98 && current <= buy * 1.02) {
        status = 'setup';
      } else {
        status = 'watch';
      }

      const pctTo = (to: number | null) =>
        current !== null && to !== null && current > 0 ? ((to - current) / current) * 100 : null;

      return {
        symbol: stock.symbol,
        status,
        currentPrice: current,
        changePercent: stock.changePercent,
        stopPrice: stop,
        buyZonePrice: buy,
        sellZonePrice: sell,
        lastPrice: stock.lastPrice ?? null,
        premarketVolume: stock.premarketVolume ?? null,
        relativeVolume: stock.relativeVolume ?? null,
        floatMillions: stock.floatMillions ?? null,
        signal: stock.signal,
        trend30m: stock.trend30m,
        pctToStop: pctTo(stop),
        pctToBuyZone: pctTo(buy),
        pctToSellZone: pctTo(sell),
        activeTrade: active
          ? {
              entryPrice: active.entryPrice,
              currentStop: active.currentStop,
              target: active.target,
              shares: active.shares,
              trailingState: active.trailingState,
              status: active.status,
              rationale: active.rationale,
              unrealizedPl: position?.unrealizedPl ?? null,
              rMultiple:
                active.riskPerShare > 0 && current !== null
                  ? (current - active.entryPrice) / active.riskPerShare
                  : null,
            }
          : null,
        candidate: candidate
          ? {
              score: candidate.score,
              setup: candidate.setup,
              rationale: candidate.rationale,
            }
          : null,
        rejection: rejection
          ? {
              reason: rejection.reason,
              score: rejection.score,
              setup: rejection.setup,
            }
          : null,
        cooldownExpiresAt: cooldownMap.get(stock.symbol)?.expiresAt ?? null,
        washSaleRisk: washSaleSet.has(stock.symbol),
      };
    });

    res.json({
      rows,
      asOf: new Date().toISOString(),
      marketStatus: getMarketStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to build scanner' });
  }
});

app.get('/api/execution/journal', async (_req, res) => {
  try {
    const { alpacaOrderService } = await import('./services/alpacaOrderService.js');
    const [account, positions] = await Promise.all([
      alpacaOrderService.getAccount(),
      alpacaOrderService.getPositions(),
    ]);
    const deployedCapital = positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPl, 0);
    const dailyRealizedPnl = executionService.getDailyPnl();
    const dailyTotalPnl = dailyRealizedPnl + unrealizedPnl;

    res.json({
      account: {
        equity: account.portfolioValue,
        cash: account.cash,
        buyingPower: account.buyingPower,
        deployedCapital,
        unrealizedPnl,
        dailyRealizedPnl,
        dailyTotalPnl,
      },
      execution: {
        enabled: executionService.isEnabled(),
        paper: config.execution.paper,
        openPositions: executionService.getActiveTrades().filter((t) => t.status === 'filled').length,
        pendingOrders: executionService.getActiveTrades().filter((t) => t.status === 'pending').length,
        maxPositions: config.execution.max_positions,
      },
      active: executionService.getActiveTrades().map((t) => {
        const pos = positions.find((p) => p.symbol === t.symbol);
        return {
          ...t,
          currentPrice: pos?.currentPrice ?? null,
          unrealizedPl: pos?.unrealizedPl ?? null,
        };
      }),
      closed: executionService.getLedger(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to build journal' });
  }
});

app.get('/api/execution/status', async (_req, res) => {
  try {
    const { alpacaOrderService } = await import('./services/alpacaOrderService.js');
    const account = await alpacaOrderService.getAccount();
    res.json({
      enabled: executionService.isEnabled(),
      paper: config.execution.paper,
      openPositions: executionService.getActiveTrades().length,
      maxPositions: config.execution.max_positions,
      deployedCapital: account.portfolioValue - account.cash,
      availableCash: account.cash,
      dailyPnl: executionService.getDailyPnl(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get execution status' });
  }
});

app.post('/api/execution/toggle', botRateLimit, (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  executionService.setEnabled(enabled);
  res.json({ enabled: executionService.isEnabled() });
});

app.get('/api/backtest/days', (_req, res) => {
  try {
    if (!existsSync(config.recording.dir)) {
      res.json({ days: [] });
      return;
    }
    const files = readdirSync(config.recording.dir);
    const days = files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace(/\.jsonl$/, ''))
      .sort((a, b) => b.localeCompare(a));
    res.json({ days });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list recordings' });
  }
});

const backtestRunSchema = z.object({
  tradingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startingCash: z.number().positive().max(10_000_000).optional(),
  riskPerTrade: z.number().positive().max(1_000_000).optional(),
});

app.post('/api/backtest/run', botRateLimit, (req, res) => {
  const parsed = backtestRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }
  const { tradingDay, startingCash, riskPerTrade } = parsed.data;
  const filePath = resolve(config.recording.dir, `${tradingDay}.jsonl`);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `No recording for ${tradingDay}` });
    return;
  }
  try {
    const result = backtestRunner.runDay(filePath, { startingCash, riskPerTrade });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backtest failed' });
  }
});

const backtestSynthSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tickers: z.array(z.string().min(1).max(10)).max(50).optional(),
  seed: z.number().int().optional(),
});

app.post('/api/backtest/synth', botRateLimit, (req, res) => {
  const parsed = backtestSynthSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    return;
  }
  try {
    const result = synthesizeDay(parsed.data);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Synth failed' });
  }
});

app.post('/api/execution/flatten', botRateLimit, async (_req, res) => {
  try {
    await executionService.flattenAll();
    res.json({ message: 'All positions flattened', trades: executionService.getLedger().length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to flatten' });
  }
});

// Serve static files in production
const distPath = resolve(__dirname, '../../dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(resolve(distPath, 'index.html'));
  });
}

// Initialize WebSocket server
priceSocketServer.initialize(server);

// Start FloatMAP polling (no-op when disabled in config).
floatMapService.start().catch((err) => {
  console.warn('floatMap start failed:', err instanceof Error ? err.message : err);
});

// Start Daily Market Profits moderator-alert polling (no-op when disabled).
moderatorAlertService.start().catch((err) => {
  console.warn('moderatorAlerts start failed:', err instanceof Error ? err.message : err);
});

// Start server
server.listen(config.port, () => {
  console.log(`Oracle server running on http://localhost:${config.port}`);
  console.log(`WebSocket available at ws://localhost:${config.port}/ws`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  priceSocketServer.shutdown();
  floatMapService.stop().catch(() => {});
  moderatorAlertService.stop().catch(() => {});
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  priceSocketServer.shutdown();
  server.close(() => {
    process.exit(0);
  });
});
