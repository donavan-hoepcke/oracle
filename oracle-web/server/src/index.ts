import express from 'express';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config } from './config.js';
import { priceSocketServer, StockState } from './websocket/priceSocket.js';
import { getMarketStatus } from './services/marketHoursService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// JSON middleware
app.use(express.json());

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

app.post('/api/bot/start', async (_req, res) => {
  try {
    const status = await priceSocketServer.startBot();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to start bot',
    });
  }
});

app.post('/api/bot/stop', async (_req, res) => {
  try {
    const status = await priceSocketServer.stopBot();
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to stop bot',
    });
  }
});

app.post('/api/bot/source', async (req, res) => {
  const source = req.body?.source;
  if (source !== 'excel' && source !== 'playwright') {
    res.status(400).json({ error: 'source must be "excel" or "playwright"' });
    return;
  }

  try {
    const status = await priceSocketServer.setTickerSource(source);
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to set bot source',
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
