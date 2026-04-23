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
