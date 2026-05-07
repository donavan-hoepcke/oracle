import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { config } from '../config.js';
import { getPrices, PriceData } from '../services/priceService.js';
import { getMarketStatus, MarketStatus } from '../services/marketHoursService.js';
import { alertService } from '../services/alertService.js';
import { stairStepService, SignalType } from '../services/stairStepService.js';
import { tickerBotService, WatchlistItem, BotStatus, PlaywrightDebugReport } from '../services/tickerBotService.js';

export interface StockState {
  symbol: string;
  targetPrice: number;
  resistance: number | null;
  oracleFields?: Record<string, string>;
  scannerPrice?: number | null;
  stockDataValue?: number | null;
  stopLossPct?: number | null;
  stopPrice?: number | null;
  longPrice?: number | null;
  buyZonePrice?: number | null;
  sellZonePrice?: number | null;
  profitDeltaPct?: number | null;
  maxVolume?: number | null;
  lastVolume?: number | null;
  premarketVolume?: number | null;
  relativeVolume?: number | null;
  floatMillions?: number | null;
  gapPercent?: number | null;
  lastPrice?: number | null;
  currentPrice: number | null;
  change: number | null;
  changePercent: number | null;
  trend30m: 'up' | 'down' | 'flat' | null;
  inTargetRange: boolean;
  alerted: boolean;
  source: string;
  lastUpdate: string | null;
  signal: SignalType;
  boxTop: number | null;
  boxBottom: number | null;
  signalTimestamp: string | null;
}

interface PriceHistoryEntry {
  price: number;
  timestamp: Date;
}

type WebSocketMessage =
  | { type: 'initial'; data: { stocks: StockState[]; marketStatus: MarketStatus; botStatus: BotStatus } }
  | { type: 'watchlist_reload'; data: { stocks: StockState[]; marketStatus: MarketStatus; botStatus: BotStatus } }
  | { type: 'price_update'; data: { stocks: StockState[] } }
  | { type: 'status'; data: { marketStatus: MarketStatus; botStatus: BotStatus } }
  | { type: 'alert'; data: StockState }
  | { type: 'setup_alert'; data: { symbol: string; setup: string; score: number; rationale: string[] } }
  | { type: 'trade_update'; data: { active: ActiveTrade[]; dailyPnl: number; circuitBreakerActive: boolean } };
import { ruleEngineService } from '../services/ruleEngineService.js';
import { executionService, ActiveTrade } from '../services/executionService.js';
import { recordingService } from '../services/recordingService.js';
import { regimeService } from '../services/regimeService.js';
import type { RegimeSnapshot } from '../services/regimeService.js';

class PriceSocketServer {
  private wss: WebSocketServer | null = null;
  private priceInterval: NodeJS.Timeout | null = null;
  private stockStates: Map<string, StockState> = new Map();
  private priceHistory: Map<string, PriceHistoryEntry[]> = new Map();
  private readonly TREND_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
  private fetchInFlight = false;

  initialize(): void {
    // `noServer: true` so multiple WS endpoints can coexist on one HTTP server.
    // Path routing happens in the single `server.on('upgrade', ...)` listener
    // in index.ts, which calls handleUpgrade() below.
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('Client connected');

      // Send initial state
      this.sendToClient(ws, {
        type: 'initial',
        data: {
          stocks: Array.from(this.stockStates.values()),
          marketStatus: getMarketStatus(),
          botStatus: tickerBotService.getStatus(),
        },
      });

      ws.on('close', () => {
        console.log('Client disconnected');
      });
    });

    // Listen for watchlist changes from bot source
    tickerBotService.onWatchlistChange((items) => {
      this.handleWatchlistChange(items);
    });

    // Start price polling
    this.startPricePolling().catch((err) => {
      console.error('Failed to start price polling:', err);
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss!.emit('connection', ws, req);
    });
  }

  private sendToClient(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private broadcast(message: WebSocketMessage): void {
    if (!this.wss) return;

    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  private handleWatchlistChange(items: WatchlistItem[]): void {
    // Reset states for new watchlist
    this.stockStates.clear();
    this.priceHistory.clear();
    stairStepService.clearAll();

    for (const item of items) {
      this.stockStates.set(item.symbol, this.createStockState(item));
    }

    this.broadcast({
      type: 'watchlist_reload',
      data: {
        stocks: Array.from(this.stockStates.values()),
        marketStatus: getMarketStatus(),
        botStatus: tickerBotService.getStatus(),
      },
    });

    // Fetch prices immediately
    this.fetchPrices();
  }

  private isInTargetRange(currentPrice: number, targetPrice: number): boolean {
    if (!targetPrice || targetPrice <= 0) {
      return false;
    }

    const threshold = config.alert_threshold;
    const lowerBound = targetPrice * (1 - threshold);
    const upperBound = targetPrice * (1 + threshold);
    return currentPrice >= lowerBound && currentPrice <= upperBound;
  }

  private createStockState(item: WatchlistItem): StockState {
    return {
      symbol: item.symbol,
      targetPrice: item.targetPrice,
      resistance: item.resistance,
      oracleFields: item.oracleFields,
      scannerPrice: item.scannerPrice ?? null,
      stockDataValue: item.stockDataValue ?? null,
      stopLossPct: item.stopLossPct ?? null,
      stopPrice: item.stopPrice ?? null,
      longPrice: item.longPrice ?? null,
      buyZonePrice: item.buyZonePrice ?? null,
      sellZonePrice: item.sellZonePrice ?? null,
      profitDeltaPct: item.profitDeltaPct ?? null,
      maxVolume: item.maxVolume ?? null,
      lastVolume: item.lastVolume ?? null,
      premarketVolume: item.premarketVolume ?? null,
      relativeVolume: item.relativeVolume ?? null,
      floatMillions: item.floatMillions ?? null,
      gapPercent: item.gapPercent ?? null,
      lastPrice: item.lastPrice ?? null,
      currentPrice: null,
      change: null,
      changePercent: null,
      trend30m: null,
      inTargetRange: false,
      alerted: false,
      source: '',
      lastUpdate: null,
      signal: null,
      boxTop: null,
      boxBottom: null,
      signalTimestamp: null,
    };
  }

  private broadcastBotStatus(status: BotStatus): void {
    this.broadcast({
      type: 'status',
      data: {
        marketStatus: getMarketStatus(),
        botStatus: status,
      },
    });
  }

  private updatePriceHistory(symbol: string, price: number): void {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.TREND_WINDOW_MS);

    let history = this.priceHistory.get(symbol) || [];

    // Add new price
    history.push({ price, timestamp: now });

    // Remove old entries outside the 30-minute window
    history = history.filter(entry => entry.timestamp >= cutoff);

    this.priceHistory.set(symbol, history);
  }

  private calculate30mTrend(symbol: string): 'up' | 'down' | 'flat' | null {
    const history = this.priceHistory.get(symbol);
    if (!history || history.length < 2) return null;

    const oldest = history[0];
    const newest = history[history.length - 1];

    const priceDiff = newest.price - oldest.price;
    const threshold = oldest.price * 0.001; // 0.1% threshold for "flat"

    if (priceDiff > threshold) return 'up';
    if (priceDiff < -threshold) return 'down';
    return 'flat';
  }

  private async fetchPrices(): Promise<void> {
    if (this.fetchInFlight) {
      console.log('Previous fetch still running, skipping this cycle');
      return;
    }
    this.fetchInFlight = true;
    try {
      await this.runFetchCycle();
    } finally {
      this.fetchInFlight = false;
    }
  }

  private async runFetchCycle(): Promise<void> {
    const symbols = Array.from(this.stockStates.keys());
    if (symbols.length === 0) return;

    const marketStatus = getMarketStatus();

    // Always broadcast status update
    this.broadcast({
      type: 'status',
      data: {
        marketStatus,
        botStatus: tickerBotService.getStatus(),
      },
    });

    // Reconcile activeTrades against the broker BEFORE the market-closed
    // early return, so a backend restart after-hours still surfaces broker
    // positions on the dashboard and gives the EOD flatten retry path
    // something to act on.
    if (config.execution.enabled) {
      try {
        await executionService.reconcileBrokerPositions(Array.from(this.stockStates.values()));
      } catch (err) {
        console.error('After-hours reconcile failed:', err);
      }
    }

    // EOD flatten — must run BEFORE the market-closed early return below so
    // positions can still be flattened during the after-close window when the
    // 15:50 attempts were rejected at the broker (e.g. PDT cap, low-liquidity
    // OTC names that don't fill before 16:00). Bounded to weekday + a window
    // that ends ~30 min after the close so we don't keep hammering the broker
    // overnight or through weekends.
    if (config.execution.enabled && executionService.getActiveTrades().length > 0) {
      const { toZonedTime } = await import('date-fns-tz');
      const nowEt = toZonedTime(new Date(), config.market_hours.timezone);
      const dow = nowEt.getDay(); // 0=Sun, 6=Sat
      const isWeekday = dow >= 1 && dow <= 5;
      const [flatH, flatM] = config.execution.eod_flatten_time.split(':').map(Number);
      const flatMinutes = flatH * 60 + flatM;
      const [closeH, closeM] = config.market_hours.close.split(':').map(Number);
      const closeMinutes = closeH * 60 + closeM;
      const nowMinutes = nowEt.getHours() * 60 + nowEt.getMinutes();
      const inFlattenWindow =
        isWeekday && nowMinutes >= flatMinutes && nowMinutes < closeMinutes + 30;
      if (inFlattenWindow) {
        console.log('EOD flatten triggered');
        await executionService.flattenAll();
      }
    }

    // Session-aware polling: in 'closed' (overnight, weekends) we skip
    // entirely — broker reconcile has already run above. In 'pre'/'post'
    // we keep polling prices so RCT entries can fire, but skip the
    // RTH-only subsystems (stair-step, sector hotness, regime). RTH
    // runs the full pipeline.
    const { getMarketSession } = await import('../services/marketHoursService.js');
    const session = getMarketSession();
    const extEnabled =
      config.execution.enabled && config.execution.extended_hours.enabled;

    if (session === 'closed') {
      console.log('Market closed (outside extended hours), skipping price fetch');
      return;
    }
    if ((session === 'pre' || session === 'post') && !extEnabled) {
      console.log(`Session is ${session} but extended_hours.enabled=false; skipping price fetch`);
      return;
    }

    console.log(`Fetching prices for ${symbols.length} symbols (session=${session})...`);
    const prices = await getPrices(symbols);

    // Stair-step signals are computed from intraday volume that doesn't
    // exist outside RTH — skip them in pre/post to avoid spending Alpaca
    // tokens on bars that won't yield meaningful signals. Empty array
    // outside RTH means the per-symbol loop below treats every symbol
    // as "not updated this cycle" and reads cached signal state.
    const symbolsToUpdate: string[] =
      session === 'rth' ? stairStepService.getNextSymbolsToUpdate(symbols, 2) : [];
    for (const symbol of symbolsToUpdate) {
      try {
        const signalState = await stairStepService.updateSymbol(symbol);
        const state = this.stockStates.get(symbol);
        if (state) {
          state.signal = signalState.signal;
          state.boxTop = signalState.boxTop;
          state.boxBottom = signalState.boxBottom;
          state.signalTimestamp = signalState.signalTimestamp;
        }
      } catch (err) {
        console.error(`Error updating stair-step for ${symbol}:`, err);
      }
    }

    const updates: StockState[] = [];
    const alerts: StockState[] = [];

    for (const [symbol, priceData] of prices) {
      const state = this.stockStates.get(symbol);
      if (!state) continue;

      const wasInRange = state.inTargetRange;

      state.currentPrice = priceData.price;
      state.change = priceData.change;
      state.changePercent = priceData.changePercent;
      state.source = priceData.source;
      state.lastUpdate = priceData.timestamp.toISOString();

      if (priceData.price !== null) {
        // Track price history and calculate 30m trend
        this.updatePriceHistory(symbol, priceData.price);
        state.trend30m = this.calculate30mTrend(symbol);
        state.inTargetRange = this.isInTargetRange(priceData.price, state.targetPrice);

        // Check for new alert
        if (state.inTargetRange && !alertService.hasAlerted(symbol)) {
          alertService.recordAlert(symbol);
          state.alerted = true;
          alerts.push(state);
        }
      }

      // Include cached signal state for symbols not updated this cycle
      if (!symbolsToUpdate.includes(symbol)) {
        const cachedSignal = stairStepService.getSignal(symbol);
        state.signal = cachedSignal.signal;
        state.boxTop = cachedSignal.boxTop;
        state.boxBottom = cachedSignal.boxBottom;
        state.signalTimestamp = cachedSignal.signalTimestamp;
      }

      updates.push(state);
    }

    // Broadcast price updates
    if (updates.length > 0) {
      this.broadcast({
        type: 'price_update',
        data: { stocks: updates },
      });
    }

    // Broadcast price alerts
    for (const alertState of alerts) {
      console.log(`ALERT: ${alertState.symbol} at $${alertState.currentPrice} (target: $${alertState.targetPrice})`);
      this.broadcast({
        type: 'alert',
        data: alertState,
      });
    }

    // Build regime snapshot once per cycle (symbols, setup-agnostic for v1).
    let regimeSnapshot: RegimeSnapshot | null = null;
    if (config.execution.regime.enabled) {
      try {
        const symbols = Array.from(this.stockStates.keys());
        regimeSnapshot = await regimeService.buildRegimeSnapshot(symbols, 'orb_breakout', new Date());
      } catch (err) {
        console.error('Regime snapshot build failed:', err);
        regimeSnapshot = null;
      }
    }

    // Get ranked candidates for alerts and execution. Session is forwarded
    // so the rule engine knows to gate non-RCT setups in pre/post.
    let candidates: Awaited<ReturnType<typeof ruleEngineService.getRankedCandidates>> = [];
    try {
      candidates = await ruleEngineService.getRankedCandidates(
        Array.from(this.stockStates.values()),
        20,
        regimeSnapshot ?? undefined,
        session,
      );
      for (const candidate of candidates) {
        // Only alert for top-scoring setups, score threshold can be tuned
        if (
          ['red_candle_theory', 'momentum_continuation', 'pullback_reclaim', 'crowded_extension_watch'].includes(candidate.setup) &&
          candidate.score >= 60 // Only alert for strong setups
        ) {
          this.broadcast({
            type: 'setup_alert',
            data: {
              symbol: candidate.symbol,
              setup: candidate.setup,
              score: candidate.score,
              rationale: candidate.rationale,
            },
          });
        }
      }
    } catch (err) {
      console.error('Error broadcasting setup alerts:', err);
    }

    // Run execution engine
    if (config.execution.enabled) {
      try {
        await executionService.onPriceCycle(
          candidates,
          Array.from(this.stockStates.values()),
          regimeSnapshot ?? undefined,
          session,
        );
        this.broadcast({
          type: 'trade_update',
          data: {
            active: executionService.getActiveTrades(),
            dailyPnl: executionService.getDailyPnl(),
            circuitBreakerActive: false,
          },
        });
      } catch (err) {
        console.error('Execution cycle error:', err);
      }
    }

    try {
      await recordingService.writeCycle({
        stocks: Array.from(this.stockStates.values()),
        candidates,
        rejections: executionService.getRejections(),
        activeTrades: executionService.getActiveTrades(),
        closedTrades: executionService.getLedger(),
        marketStatus,
        regime: regimeSnapshot,
      });
    } catch (err) {
      console.error('Recording write error:', err);
    }
  }

  private async startPricePolling(): Promise<void> {
    // Initial watchlist source start
    await tickerBotService.start();

    // Regular polling
    this.priceInterval = setInterval(() => {
      this.fetchPrices();
    }, config.check_interval * 1000);

    console.log(`Price polling started (every ${config.check_interval}s)`);
  }

  getBotStatus(): BotStatus {
    return tickerBotService.getStatus();
  }

  async startBot(): Promise<BotStatus> {
    const status = await tickerBotService.start();
    this.broadcastBotStatus(status);
    return status;
  }

  async stopBot(): Promise<BotStatus> {
    const status = await tickerBotService.stop();
    this.broadcastBotStatus(status);
    return status;
  }

  async previewPlaywrightTickers(): Promise<WatchlistItem[]> {
    return tickerBotService.previewPlaywrightTickers();
  }

  async previewPlaywrightDebug(): Promise<PlaywrightDebugReport> {
    return tickerBotService.previewPlaywrightDebug();
  }

  getStockStates(): StockState[] {
    return Array.from(this.stockStates.values());
  }

  shutdown(): void {
    if (this.priceInterval) {
      clearInterval(this.priceInterval);
    }
    tickerBotService.shutdown().catch((err) => {
      console.error('Error during bot shutdown:', err);
    });
    if (this.wss) {
      this.wss.close();
    }
  }
}

export const priceSocketServer = new PriceSocketServer();
