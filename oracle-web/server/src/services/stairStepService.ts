import { fetch1MinBars, fetch5MinBars, PolygonBar } from './polygonService.js';
import { fetchAlpaca1MinBars, fetchAlpaca5MinBars, AlpacaBar } from './alpacaBarService.js';
import {
  calculateEMA,
  calculateATR,
  calculateVWAP,
  calculateRelativeVolume,
  isEmaRising,
} from './indicatorService.js';
import { stairStepConfig, alpacaApiKeyId, polygonApiKey } from '../config.js';

// Common bar type (both services return same structure)
type Bar = PolygonBar | AlpacaBar;

export type SignalType = 'BRK' | 'RC' | null;

export interface SignalState {
  signal: SignalType;
  boxTop: number | null;
  boxBottom: number | null;
  signalTimestamp: string | null;
}

interface SymbolData {
  bars1m: Bar[];
  bars5m: Bar[];
  activeBox: { top: number; bottom: number; containmentCount: number } | null;
  lastSignal: SignalState;
  lastUpdate: Date;
  pivotHigh: number | null;
  pullbackLow: number | null;
}

class StairStepService {
  private symbolData: Map<string, SymbolData> = new Map();
  private updateQueue: string[] = [];
  private currentQueueIndex = 0;

  /**
   * Get the next symbols to update (round-robin to stay within rate limits)
   */
  getNextSymbolsToUpdate(symbols: string[], count: number = 2): string[] {
    if (symbols.length === 0) return [];

    // Rebuild queue if symbols changed
    if (
      this.updateQueue.length !== symbols.length ||
      !symbols.every((s) => this.updateQueue.includes(s))
    ) {
      this.updateQueue = [...symbols];
      this.currentQueueIndex = 0;
    }

    const result: string[] = [];
    for (let i = 0; i < count && i < symbols.length; i++) {
      result.push(this.updateQueue[this.currentQueueIndex]);
      this.currentQueueIndex = (this.currentQueueIndex + 1) % this.updateQueue.length;
    }

    return result;
  }

  /**
   * Update bar data and compute signal for a symbol
   */
  async updateSymbol(symbol: string): Promise<SignalState> {
    const config = stairStepConfig;
    if (!config.enabled) {
      return { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null };
    }

    console.log(`Fetching bars for ${symbol}...`);

    // Fetch bar data - try Alpaca first, then Polygon as fallback
    let bars1m: Bar[] = [];
    let bars5m: Bar[] = [];
    let source = '';

    if (alpacaApiKeyId) {
      [bars1m, bars5m] = await Promise.all([
        fetchAlpaca1MinBars(symbol, 60),  // Last 60 minutes
        fetchAlpaca5MinBars(symbol, 120), // Last 2 hours
      ]);
      source = 'Alpaca';
    }

    // Fallback to Polygon if Alpaca returned no data
    if (bars1m.length === 0 && polygonApiKey) {
      [bars1m, bars5m] = await Promise.all([
        fetch1MinBars(symbol, 60),
        fetch5MinBars(symbol, 120),
      ]);
      source = 'Polygon';
    }

    if (bars1m.length > 0) {
      console.log(`Got ${bars1m.length} 1-min bars for ${symbol} from ${source}`);
    }

    if (bars1m.length < config.box_lookback || bars5m.length < 5) {
      console.log(`Insufficient bar data for ${symbol}`);
      return { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null };
    }

    // Get or create symbol data
    let data = this.symbolData.get(symbol);
    if (!data) {
      data = {
        bars1m: [],
        bars5m: [],
        activeBox: null,
        lastSignal: { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null },
        lastUpdate: new Date(),
        pivotHigh: null,
        pullbackLow: null,
      };
      this.symbolData.set(symbol, data);
    }

    data.bars1m = bars1m;
    data.bars5m = bars5m;
    data.lastUpdate = new Date();

    // Compute signal
    const signal = this.computeSignal(symbol);
    data.lastSignal = signal;

    return signal;
  }

  /**
   * Get cached signal for a symbol (doesn't fetch new data)
   */
  getSignal(symbol: string): SignalState {
    const data = this.symbolData.get(symbol);
    return data?.lastSignal ?? { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null };
  }

  private computeSignal(symbol: string): SignalState {
    const data = this.symbolData.get(symbol);
    if (!data) {
      return { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null };
    }

    const { bars1m, bars5m } = data;
    const config = stairStepConfig;

    // Calculate indicators for 1-min bars
    const closes1m = bars1m.map((b) => b.close);
    const ema9 = calculateEMA(closes1m, config.ema_period);
    const atr14 = calculateATR(bars1m, config.atr_period);
    const vwap = calculateVWAP(bars1m);

    // Calculate indicators for 5-min bars (higher timeframe)
    const closes5m = bars5m.map((b) => b.close);
    const ema20_5m = calculateEMA(closes5m, config.htf_ema_period);

    if (ema9.length === 0 || atr14.length === 0 || vwap.length === 0) {
      return { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null };
    }

    const currentBar = bars1m[bars1m.length - 1];
    const currentClose = currentBar.close;
    const currentVwap = vwap[vwap.length - 1];
    const currentEma9 = ema9[ema9.length - 1];
    const currentAtr = atr14[atr14.length - 1];

    // Check trend filters
    const aboveVwap = currentClose > currentVwap;
    const ema9Rising = isEmaRising(ema9, 3);

    // HTF filter: close > EMA20 and EMA20 rising
    const htfClose = bars5m[bars5m.length - 1].close;
    const htfEma20 = ema20_5m[ema20_5m.length - 1];
    const htfAboveEma = htfClose > htfEma20;
    const htfEmaRising = isEmaRising(ema20_5m, 3);

    // Exit signal: close < VWAP (only if require_above_vwap is enabled)
    if (config.require_above_vwap && !aboveVwap) {
      // Clear any active signal
      data.activeBox = null;
      data.pivotHigh = null;
      data.pullbackLow = null;
      return { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null };
    }

    // Detect consolidation box
    const box = this.detectBox(bars1m, config.box_lookback, currentAtr, config);

    if (box) {
      data.activeBox = box;
    }

    // No active box, no signal
    if (!data.activeBox) {
      return { signal: null, boxTop: null, boxBottom: null, signalTimestamp: null };
    }

    const { top: boxTop, bottom: boxBottom } = data.activeBox;

    // Check for BRK (Breakout) signal
    const breakoutThreshold = boxTop + config.breakout_atr_mult * currentAtr;
    const isGreenCandle = currentClose > currentBar.open;
    const volumes = bars1m.map((b) => b.volume);
    const relativeVolume = calculateRelativeVolume(volumes, 20);

    if (
      currentClose > breakoutThreshold &&
      isGreenCandle &&
      relativeVolume >= config.min_relative_volume &&
      ema9Rising &&
      htfAboveEma &&
      htfEmaRising
    ) {
      // Record pivot high for potential RC signal
      data.pivotHigh = currentClose;
      data.pullbackLow = null;
      return {
        signal: 'BRK',
        boxTop,
        boxBottom,
        signalTimestamp: new Date().toISOString(),
      };
    }

    // Check for RC (Reclaim Continuation) signal
    // Requires: prior breakout (pivotHigh set), pullback to EMA9, then reclaim
    if (data.pivotHigh !== null) {
      // Track pullback low
      if (data.pullbackLow === null || currentClose < data.pullbackLow) {
        // Check if we're pulling back to EMA9 area
        const emaProximity = Math.abs(currentClose - currentEma9) / currentAtr;
        if (emaProximity < 0.5) {
          data.pullbackLow = currentClose;
        }
      }

      // Check for reclaim above pivot
      if (
        data.pullbackLow !== null &&
        data.pullbackLow > boxBottom && // Higher low structure
        currentClose > data.pivotHigh &&
        isGreenCandle &&
        relativeVolume >= config.min_relative_volume * 0.8 && // Slightly lower vol requirement
        htfAboveEma
      ) {
        // Update pivot for potential further RCs
        data.pivotHigh = currentClose;
        data.pullbackLow = null;
        return {
          signal: 'RC',
          boxTop,
          boxBottom,
          signalTimestamp: new Date().toISOString(),
        };
      }
    }

    // Return current box state without new signal
    return {
      signal: null,
      boxTop: data.activeBox ? boxTop : null,
      boxBottom: data.activeBox ? boxBottom : null,
      signalTimestamp: null,
    };
  }

  private detectBox(
    bars: Bar[],
    lookback: number,
    currentAtr: number,
    config: typeof stairStepConfig
  ): { top: number; bottom: number; containmentCount: number } | null {
    if (bars.length < lookback) return null;

    const recentBars = bars.slice(-lookback);

    // Find range
    let high = -Infinity;
    let low = Infinity;
    for (const bar of recentBars) {
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
    }

    const boxHeight = high - low;
    const maxHeight = config.box_height_atr_mult * currentAtr;

    // Box height must be <= 0.8 * ATR
    if (boxHeight > maxHeight) return null;

    // Count contained bars
    let containmentCount = 0;
    for (const bar of recentBars) {
      if (bar.high <= high && bar.low >= low) {
        containmentCount++;
      }
    }

    // Need at least 12 bars contained
    if (containmentCount < config.min_containment_bars) return null;

    return { top: high, bottom: low, containmentCount };
  }

  /**
   * Clear data for a symbol
   */
  clearSymbol(symbol: string): void {
    this.symbolData.delete(symbol);
  }

  /**
   * Clear all data
   */
  clearAll(): void {
    this.symbolData.clear();
    this.updateQueue = [];
    this.currentQueueIndex = 0;
  }
}

export const stairStepService = new StairStepService();
