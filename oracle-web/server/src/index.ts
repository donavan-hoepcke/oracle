import express from 'express';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { z } from 'zod';
import { config } from './config.js';
import { priceSocketServer, StockState } from './websocket/priceSocket.js';
import { getMarketStatus } from './services/marketHoursService.js';
import { messageService } from './services/messageService.js';
import { ruleEngineService } from './services/ruleEngineService.js';

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

// Start server
server.listen(config.port, () => {
  console.log(`Oracle server running on http://localhost:${config.port}`);
  console.log(`WebSocket available at ws://localhost:${config.port}/ws`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  priceSocketServer.shutdown();
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
