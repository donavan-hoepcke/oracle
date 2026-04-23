import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      orb_enabled: true,
      orb_range_minutes: 15,
      orb_volume_mult: 1.3,
      orb_max_chase_pct: 0.03,
      orb_min_range_pct: 0.01,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      momentum_max_chase_pct: 0.05,
      require_uptrend_for_momentum: true,
      max_risk_pct: 0.1,
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
  finnhubApiKey: '',
  polygonApiKey: '',
  alpacaApiKeyId: '',
  alpacaApiSecretKey: '',
  alpacaDataFeed: 'iex',
}));

import {
  ruleEngineService,
  emptyMessageContext,
  emptyRedCandleSignal,
  emptyOrbSignal,
} from '../services/ruleEngineService.js';
import type { StockState } from '../websocket/priceSocket.js';
import type { RegimeSnapshot } from '../services/regimeService.js';

function makeStock(symbol = 'ABC'): StockState {
  return {
    symbol,
    targetPrice: 1.5,
    resistance: 1.5,
    stopLossPct: null,
    stopPrice: 0.95,
    longPrice: 1.0,
    buyZonePrice: 1.0,
    sellZonePrice: 1.5,
    profitDeltaPct: 5,
    maxVolume: 5_000_000,
    lastVolume: 1000,
    premarketVolume: 2_000_000,
    relativeVolume: 1.5,
    floatMillions: 10,
    gapPercent: 0.05,
    lastPrice: 0.95,
    currentPrice: 1.01,
    change: 0.06,
    changePercent: 0.063,
    trend30m: 'up',
    inTargetRange: false,
    alerted: false,
    source: 'test',
    lastUpdate: new Date().toISOString(),
    signal: null,
    boxTop: null,
    boxBottom: null,
    signalTimestamp: null,
  };
}

function makeRegime(marketScore: number, sectorScore: number, tickerScore: number): RegimeSnapshot {
  return {
    ts: new Date().toISOString(),
    market: { score: marketScore, spyTrendPct: 0, vxxRocPct: 0, status: 'ok' },
    sectors: { XBI: { score: sectorScore, etfSymbol: 'XBI', trendPct: 0, status: 'ok' } },
    tickers: {
      ABC: {
        score: tickerScore, sector: 'biotechnology', atrRatio: 1.0, winRate: 0.5,
        sampleSize: 4, status: 'ok',
      },
    },
  };
}

describe('scoreFromInputs regime contribution', () => {
  it('adds composite × score_weight when regime friendly', () => {
    const stock = makeStock();
    const baseline = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
    );
    const friendly = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
      makeRegime(1, 1, 1),
    );
    expect(baseline).not.toBeNull();
    expect(friendly).not.toBeNull();
    // composite = 0.5×1 + 0.2×1 + 0.3×1 = 1.0 → +10
    expect(friendly!.score - baseline!.score).toBeCloseTo(10, 1);
  });

  it('subtracts up to score_weight when regime hostile', () => {
    const stock = makeStock();
    const baseline = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
    );
    const hostile = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
      makeRegime(-1, -1, -1),
    );
    expect(hostile!.score - baseline!.score).toBeCloseTo(-10, 1);
  });

  it('leaves score unchanged when regime=undefined', () => {
    const stock = makeStock();
    const baseline = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
    );
    const noRegime = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
      undefined,
    );
    expect(noRegime!.score).toBe(baseline!.score);
  });
});
