import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      regime: {
        enabled: true,
        score_weight: 10,
        market_weight: 0.5,
        sector_weight: 0.2,
        ticker_weight: 0.3,
        spy_trend_normalize_pct: 0.005,
        vxx_roc_normalize_pct: 0.05,
        sector_trend_normalize_pct: 0.01,
        veto_market_spy_trend_pct: -0.01,
        veto_market_vxx_roc_pct: 0.05,
        veto_graveyard_min_sample: 5,
        veto_exhaustion_atr_ratio: 3.0,
        winrate_min_sample: 3,
        atr_penalty_ratio: 2.5,
        sector_etf_bars_lookback_min: 30,
        trade_history_max_trades: 20,
        trade_history_max_calendar_days: 30,
      },
    },
    market_hours: { timezone: 'America/New_York', open: '09:30', close: '16:00' },
  },
}));

import {
  computeMarketRegime,
  computeSectorRegime,
  computeTickerRegime,
  atr14,
} from '../services/regimeService.js';
import type { Bar } from '../services/indicatorService.js';
import type { TradeLedgerEntry } from '../services/executionService.js';

function makeBar(ts: Date, close: number, high = close, low = close, open = close): Bar {
  return { timestamp: ts, open, high, low, close, volume: 1000 };
}

function makeSlope(pct: number, count = 30, start = 100): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const close = start * (1 + (pct * i) / (count - 1));
    bars.push(makeBar(new Date(2026, 3, 22, 13, i), close));
  }
  return bars;
}

describe('atr14', () => {
  it('computes Wilder ATR over 14 daily bars', () => {
    const bars: Bar[] = [];
    let prevClose = 10;
    for (let i = 0; i < 15; i++) {
      const high = prevClose + 1;
      const low = prevClose - 1;
      const close = prevClose + 0.1;
      bars.push(makeBar(new Date(2026, 3, i + 1), close, high, low, prevClose));
      prevClose = close;
    }
    const v = atr14(bars);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(1.5);
    expect(v!).toBeLessThan(2.5);
  });

  it('returns null with fewer than 15 bars', () => {
    expect(atr14([])).toBeNull();
    expect(atr14(Array.from({ length: 14 }, (_, i) => makeBar(new Date(2026, 3, i + 1), 10)))).toBeNull();
  });
});

describe('computeMarketRegime', () => {
  it('returns positive score when SPY up, VXX flat', () => {
    const spyBars = makeSlope(0.005);
    const vxxBars = [makeBar(new Date(2026, 3, 21), 20), makeBar(new Date(2026, 3, 22), 20)];
    const r = computeMarketRegime(spyBars, vxxBars, new Date(2026, 3, 22));
    expect(r.status).toBe('ok');
    expect(r.score).toBeGreaterThan(0.4);
    expect(r.spyTrendPct!).toBeGreaterThan(0);
    expect(r.vxxRocPct).toBe(0);
  });

  it('returns negative score when SPY down and VXX spiking', () => {
    const spyBars = makeSlope(-0.005);
    const vxxBars = [makeBar(new Date(2026, 3, 21), 20), makeBar(new Date(2026, 3, 22), 22)];
    const r = computeMarketRegime(spyBars, vxxBars, new Date(2026, 3, 22));
    expect(r.score).toBeLessThan(-0.4);
  });

  it('clamps extreme values to [-1, +1]', () => {
    const spyBars = makeSlope(0.05);
    const vxxBars = [makeBar(new Date(), 20), makeBar(new Date(), 5)];
    const r = computeMarketRegime(spyBars, vxxBars, new Date());
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(-1);
  });

  it('returns unavailable when both signals missing', () => {
    const r = computeMarketRegime([], [], new Date());
    expect(r.status).toBe('unavailable');
    expect(r.score).toBe(0);
    expect(r.spyTrendPct).toBeNull();
    expect(r.vxxRocPct).toBeNull();
  });

  it('returns partial score when only SPY available', () => {
    const r = computeMarketRegime(makeSlope(0.005), [], new Date());
    expect(r.spyTrendPct).not.toBeNull();
    expect(r.vxxRocPct).toBeNull();
    expect(r.status).toBe('ok');
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('computeSectorRegime', () => {
  it('maps strong uptrend to positive score', () => {
    const r = computeSectorRegime(makeSlope(0.02), 'XBI', new Date());
    expect(r.score).toBeCloseTo(1);
    expect(r.etfSymbol).toBe('XBI');
  });

  it('maps strong downtrend to negative score', () => {
    const r = computeSectorRegime(makeSlope(-0.02), 'XLE', new Date());
    expect(r.score).toBeCloseTo(-1);
  });

  it('returns unavailable with empty bars', () => {
    const r = computeSectorRegime([], 'XBI', new Date());
    expect(r.status).toBe('unavailable');
    expect(r.score).toBe(0);
  });
});

function makePastTrades(wins: number, losses: number): TradeLedgerEntry[] {
  const t: TradeLedgerEntry[] = [];
  for (let i = 0; i < wins; i++) {
    t.push({
      symbol: 'ABC', strategy: 'orb_breakout',
      entryPrice: 1, entryTime: new Date(), exitPrice: 1.1, exitTime: new Date(),
      shares: 100, riskPerShare: 0.05, pnl: 10, pnlPct: 0.1, rMultiple: 2,
      exitReason: 'target', exitDetail: '', rationale: [],
    });
  }
  for (let i = 0; i < losses; i++) {
    t.push({
      symbol: 'ABC', strategy: 'orb_breakout',
      entryPrice: 1, entryTime: new Date(), exitPrice: 0.95, exitTime: new Date(),
      shares: 100, riskPerShare: 0.05, pnl: -5, pnlPct: -0.05, rMultiple: -1,
      exitReason: 'stop', exitDetail: '', rationale: [],
    });
  }
  return t;
}

describe('computeTickerRegime', () => {
  const dailyBars: Bar[] = (() => {
    const bars: Bar[] = [];
    let prev = 10;
    for (let i = 0; i < 15; i++) {
      bars.push(makeBar(new Date(2026, 3, i + 1), prev + 0.05, prev + 1, prev - 1, prev));
      prev = prev + 0.05;
    }
    return bars;
  })();

  it('positive score when low ATR ratio and high win rate', () => {
    const today = [makeBar(new Date(), 10, 10.2, 9.8)];
    const r = computeTickerRegime('ABC', 'orb_breakout', dailyBars, today, makePastTrades(4, 1), 'energy', new Date());
    expect(r.status).toBe('ok');
    expect(r.atrRatio!).toBeLessThan(1);
    expect(r.winRate!).toBeCloseTo(0.8);
    expect(r.sampleSize).toBe(5);
    expect(r.score).toBeGreaterThan(0);
  });

  it('negative score when ATR ratio high and win rate low', () => {
    const today = [makeBar(new Date(), 10, 15, 9)];
    const r = computeTickerRegime('ABC', 'orb_breakout', dailyBars, today, makePastTrades(1, 4), 'energy', new Date());
    expect(r.atrRatio!).toBeGreaterThan(2.5);
    expect(r.winRate!).toBeCloseTo(0.2);
    expect(r.score).toBeLessThan(0);
  });

  it('sample size below threshold → winRate null', () => {
    const today = [makeBar(new Date(), 10, 10.1, 9.9)];
    const r = computeTickerRegime('ABC', 'orb_breakout', dailyBars, today, makePastTrades(1, 1), 'energy', new Date());
    expect(r.winRate).toBeNull();
    expect(r.sampleSize).toBe(2);
  });

  it('returns unavailable when daily bars insufficient for ATR', () => {
    const r = computeTickerRegime('ABC', 'orb_breakout', [], [], [], 'energy', new Date());
    expect(r.atrRatio).toBeNull();
    expect(r.status).toBe('unavailable');
  });
});
