import { EventEmitter } from 'node:events';
import type { Bar } from './indicatorService.js';
import type { TradeLedgerEntry } from './executionService.js';
import type { CandidateSetup } from './ruleEngineService.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketRegime {
  score: number;               // [-1, +1]
  spyTrendPct: number | null;
  vxxRocPct: number | null;
  status: 'ok' | 'unavailable';
}

export interface SectorRegime {
  score: number;
  etfSymbol: string;
  trendPct: number | null;
  status: 'ok' | 'unavailable';
}

export interface TickerRegime {
  score: number;
  sector: string;
  atrRatio: number | null;
  winRate: number | null;
  sampleSize: number;
  status: 'ok' | 'unavailable';
}

export interface RegimeSnapshot {
  ts: string;
  market: MarketRegime;
  sectors: Record<string, SectorRegime>;    // keyed by ETF symbol (e.g. "XBI")
  tickers: Record<string, TickerRegime>;    // keyed by watchlist symbol
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Linear regression slope over the last `windowSize` bar closes.
 * Returns slope × (n−1) expressed as a fraction of the window's first close,
 * i.e. the approximate total price change over the window as a decimal.
 * Returns null when fewer than 2 bars are available after slicing.
 */
function slopeTrendPct(bars: Bar[], windowSize = 30): number | null {
  if (bars.length < 2) return null;
  const window = bars.slice(-windowSize);
  if (window.length < 2) return null;
  const n = window.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += window[i].close;
    sumXY += i * window[i].close;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const first = window[0].close;
  if (first <= 0) return null;
  return (slope * (n - 1)) / first;
}

// ---------------------------------------------------------------------------
// Pure computers
// ---------------------------------------------------------------------------

/**
 * Wilder ATR(14).
 * Requires at least 15 daily bars (14 TRs). Returns null otherwise.
 * Seed value is the simple average of the first 14 TRs (standard Wilder seed).
 * With exactly 15 bars the seed IS the ATR — no further smoothing needed.
 */
export function atr14(dailyBars: Bar[]): number | null {
  if (dailyBars.length < 15) return null;
  const bars = dailyBars.slice(-15);   // use the most recent 15 bars
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }
  // 14 TRs → seed is their simple mean (Wilder initialisation)
  const seed = trs.reduce((s, v) => s + v, 0) / trs.length;
  return seed;
}

/**
 * Compute market-level regime from SPY 1m bars and VXX bars.
 *
 * - spyTrendPct: linear-regression slope of last 30 closes × (n−1) / first close
 * - vxxRocPct:  (latest − first) / first across all passed vxxBars (needs ≥ 2)
 * - score: average of clamped SPY and VXX signals; falls back to whichever
 *   is available when only one is present; 'unavailable' + score=0 when both missing
 */
export function computeMarketRegime(spyBars: Bar[], vxxBars: Bar[], _now: Date): MarketRegime {
  const cfg = config.execution.regime;

  const spyTrendPct = slopeTrendPct(spyBars, 30);

  let vxxRocPct: number | null = null;
  if (vxxBars.length >= 2) {
    const first = vxxBars[0].close;
    const latest = vxxBars[vxxBars.length - 1].close;
    if (first > 0) vxxRocPct = (latest - first) / first;
  }

  if (spyTrendPct === null && vxxRocPct === null) {
    return { score: 0, spyTrendPct: null, vxxRocPct: null, status: 'unavailable' };
  }

  const spySignal = spyTrendPct !== null
    ? clamp(spyTrendPct / cfg.spy_trend_normalize_pct, -1, 1)
    : null;

  // VXX rises → bad for market → negate
  const vxxSignal = vxxRocPct !== null
    ? clamp(-vxxRocPct / cfg.vxx_roc_normalize_pct, -1, 1)
    : null;

  let score: number;
  if (spySignal !== null && vxxSignal !== null) {
    score = 0.5 * spySignal + 0.5 * vxxSignal;
  } else if (spySignal !== null) {
    score = spySignal;
  } else {
    score = vxxSignal!;
  }

  return { score, spyTrendPct, vxxRocPct, status: 'ok' };
}

/**
 * Compute sector-level regime from ETF 1m bars.
 *
 * - trendPct: same slope method as SPY (last 30 closes)
 * - score: clamp(trendPct / sector_trend_normalize_pct, -1, 1)
 * - empty / <2 bars → 'unavailable', score 0
 */
export function computeSectorRegime(bars: Bar[], etfSymbol: string, _now: Date): SectorRegime {
  const cfg = config.execution.regime;
  const trendPct = slopeTrendPct(bars, 30);
  if (trendPct === null) {
    return { score: 0, etfSymbol, trendPct: null, status: 'unavailable' };
  }
  const score = clamp(trendPct / cfg.sector_trend_normalize_pct, -1, 1);
  return { score, etfSymbol, trendPct, status: 'ok' };
}

/** Return max(high) − min(low) across all todayBars, or null if empty. */
function todayRangeFromBars(bars: Bar[]): number | null {
  if (bars.length === 0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (!isFinite(hi) || !isFinite(lo)) return null;
  return hi - lo;
}

/**
 * Compute ticker-level regime.
 *
 * - atrRatio: todayRange / atr14(dailyBars); null if either component missing
 * - pastTrades filtered to terminal exit reasons ('target'|'stop'|'trailing_stop'|'eod')
 * - winRate: wins/total when total ≥ winrate_min_sample, else null
 * - atrPenalty: -1 if atrRatio ≥ atr_penalty_ratio, else 0
 * - winRateScore: (wins − losses)/total when total ≥ winrate_min_sample, else 0
 * - score: 0.5 × atrPenalty + 0.5 × winRateScore
 * - status: 'unavailable' when atrRatio is null; else 'ok'
 */
export function computeTickerRegime(
  _symbol: string,
  _setup: CandidateSetup | string,
  dailyBars: Bar[],
  todayBars: Bar[],
  pastTrades: TradeLedgerEntry[],
  sector: string,
  _now: Date,
): TickerRegime {
  const cfg = config.execution.regime;

  const atr = atr14(dailyBars);
  const range = todayRangeFromBars(todayBars);
  const atrRatio = atr !== null && atr > 0 && range !== null ? range / atr : null;

  const terminalReasons = new Set<string>(['target', 'stop', 'trailing_stop', 'eod']);
  const closed = pastTrades.filter((t) => terminalReasons.has(t.exitReason));
  const total = closed.length;
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = total - wins;

  const winRate = total >= cfg.winrate_min_sample ? wins / total : null;
  const atrPenalty = atrRatio !== null && atrRatio >= cfg.atr_penalty_ratio ? -1 : 0;
  const winRateScore = total >= cfg.winrate_min_sample ? (wins - losses) / total : 0;
  const score = 0.5 * atrPenalty + 0.5 * winRateScore;

  const status: 'ok' | 'unavailable' = atrRatio === null ? 'unavailable' : 'ok';
  return { score, sector, atrRatio, winRate, sampleSize: total, status };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

import type { SectorMapService } from './sectorMapService.js';
import type { TradeHistoryService } from './tradeHistoryService.js';
import { fetchAlpacaBars } from './alpacaBarService.js';
import { sectorMapService } from './sectorMapService.js';
import { tradeHistoryService } from './tradeHistoryService.js';

export interface RegimeDeps {
  fetchBars: (symbol: string, timeframe: string, lookbackMinutes: number) => Promise<Bar[]>;
  fetchTodayBars: (symbol: string) => Promise<Bar[]>;
  sectorMap: Pick<SectorMapService, 'getSectorFor' | 'getEtfFor'>;
  tradeHistory: Pick<TradeHistoryService, 'getRecentTrades'>;
}

export class RegimeService {
  private emitter = new EventEmitter();
  private lastSnapshot: RegimeSnapshot | null = null;

  constructor(private readonly deps: RegimeDeps) {
    this.emitter.setMaxListeners(0);
  }

  recordSnapshot(snapshot: RegimeSnapshot): void {
    this.lastSnapshot = snapshot;
    this.emitter.emit('snapshot', snapshot);
  }

  getLastSnapshot(): RegimeSnapshot | null {
    return this.lastSnapshot;
  }

  onSnapshot(listener: (snapshot: RegimeSnapshot) => void): () => void {
    this.emitter.on('snapshot', listener);
    return () => this.emitter.off('snapshot', listener);
  }

  async buildRegimeSnapshot(
    symbols: string[],
    setup: CandidateSetup | string,
    now: Date,
  ): Promise<RegimeSnapshot> {
    const cfg = config.execution.regime;

    const spyPromise = this.deps.fetchBars('SPY', '1Min', cfg.sector_etf_bars_lookback_min).catch(() => [] as Bar[]);
    // VXX: 2 daily bars (yesterday + today) to compute rate-of-change
    const vxxPromise = this.deps.fetchBars('VXX', '1Day', 2 * 24 * 60).catch(() => [] as Bar[]);

    const sectorBySymbol = new Map<string, string>();
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          sectorBySymbol.set(sym, await this.deps.sectorMap.getSectorFor(sym));
        } catch {
          sectorBySymbol.set(sym, 'unknown');
        }
      }),
    );

    const distinctEtfs = Array.from(
      new Set(Array.from(sectorBySymbol.values()).map((s) => this.deps.sectorMap.getEtfFor(s))),
    );
    const etfBarsPromise = Promise.all(
      distinctEtfs.map(async (etf) => {
        const bars = await this.deps.fetchBars(etf, '1Min', cfg.sector_etf_bars_lookback_min).catch(() => [] as Bar[]);
        return [etf, bars] as const;
      }),
    );

    const [spyBars, vxxBars, etfBarsList] = await Promise.all([spyPromise, vxxPromise, etfBarsPromise]);
    const market = computeMarketRegime(spyBars, vxxBars, now);

    const sectors: Record<string, SectorRegime> = {};
    for (const [etf, bars] of etfBarsList) {
      sectors[etf] = computeSectorRegime(bars, etf, now);
    }

    const tickers: Record<string, TickerRegime> = {};
    await Promise.all(
      symbols.map(async (sym) => {
        const sector = sectorBySymbol.get(sym) ?? 'unknown';
        const [dailyBars, todayBars, pastTrades] = await Promise.all([
          this.deps.fetchBars(sym, '1Day', 30 * 24 * 60).catch(() => [] as Bar[]),
          this.deps.fetchTodayBars(sym).catch(() => [] as Bar[]),
          this.deps.tradeHistory.getRecentTrades(sym, String(setup), now).catch(() => []),
        ]);
        tickers[sym] = computeTickerRegime(sym, setup, dailyBars, todayBars, pastTrades, sector, now);
      }),
    );

    const snapshot = { ts: now.toISOString(), market, sectors, tickers };
    this.recordSnapshot(snapshot);
    return snapshot;
  }
}

/** Singleton RegimeService wired to Alpaca + Finnhub real dependencies. */
export const regimeService = new RegimeService({
  fetchBars: fetchAlpacaBars,
  fetchTodayBars: (symbol) => fetchAlpacaBars(symbol, '1Min', 390),
  sectorMap: sectorMapService,
  tradeHistory: tradeHistoryService,
});
