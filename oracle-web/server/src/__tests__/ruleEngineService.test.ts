import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.05,
      max_risk_pct: 0.10,
      risk_per_trade: 100,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      momentum_max_chase_pct: 0.10,
      require_uptrend_for_momentum: true,
      orb_enabled: true,
      orb_range_minutes: 15,
      orb_volume_mult: 1.3,
      orb_max_chase_pct: 0.03,
      orb_min_range_pct: 0.01,
    },
  },
}));

import {
  ruleEngineService,
  emptyMessageContext,
  emptyRedCandleSignal,
  emptyOrbSignal,
} from '../services/ruleEngineService.js';
import { StockState } from '../websocket/priceSocket.js';

function makeStock(overrides: Partial<StockState>): StockState {
  return {
    symbol: 'TEST',
    targetPrice: 0,
    resistance: null,
    stopLossPct: null,
    stopPrice: null,
    longPrice: null,
    buyZonePrice: null,
    sellZonePrice: null,
    profitDeltaPct: null,
    maxVolume: 1_000_000,
    lastVolume: 10_000,
    premarketVolume: 2_000_000,
    relativeVolume: null,
    floatMillions: 50,
    gapPercent: 0.05,
    lastPrice: 1,
    currentPrice: null,
    change: null,
    changePercent: 0.05,
    trend30m: 'up',
    inTargetRange: false,
    alerted: false,
    source: 'test',
    lastUpdate: new Date().toISOString(),
    signal: null,
    boxTop: null,
    boxBottom: null,
    signalTimestamp: null,
    ...overrides,
  };
}

describe('RuleEngineService suggestedStop clamp', () => {
  it('clamps a wide Oracle stop to the max-risk cap for non-RCT setups', () => {
    // Oracle gives a stop 30% below entry — way wider than 10% max_risk_pct.
    // Without clamping, the trade filter would reject at entry (risk_pct > cap).
    const stock = makeStock({
      currentPrice: 2.0,
      buyZonePrice: 1.95,
      stopPrice: 1.4,
      sellZonePrice: 2.6,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
    );

    expect(candidate).not.toBeNull();
    const c = candidate!;
    const riskPct = (c.suggestedEntry - c.suggestedStop) / c.suggestedEntry;
    // Below max_risk_pct (0.10) with enough margin that downstream `riskPct >
    // max_risk_pct` filters won't trip on floating-point ties.
    expect(riskPct).toBeLessThan(0.10);
    expect(riskPct).toBeGreaterThan(0.095);
  });

  it('keeps the tighter Oracle stop when it is inside the max-risk cap', () => {
    // Oracle stop is 5% below entry — tighter than our 10% max. Keep Oracle's.
    const stock = makeStock({
      currentPrice: 2.0,
      buyZonePrice: 1.95,
      stopPrice: 1.9,
      sellZonePrice: 2.6,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
    );

    expect(candidate!.suggestedStop).toBe(1.9);
  });

  it('routes to orb_breakout when ORB signal matches and uses range low as stop', () => {
    const stock = makeStock({
      currentPrice: 2.05,
      buyZonePrice: 1.95,
      stopPrice: 1.4,
      sellZonePrice: 2.6,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      {
        matched: true,
        rangeHigh: 2.0,
        rangeLow: 1.9,
        entry: 2.0,
        stop: 1.9,
        rrToSellZone: 6,
        details: ['ORB-15 breakout above 2.000'],
      },
    );

    expect(candidate).not.toBeNull();
    expect(candidate!.setup).toBe('orb_breakout');
    expect(candidate!.suggestedStop).toBe(1.9);
    expect(candidate!.suggestedEntry).toBe(2.05);
    // Sell zone clears 1R so we prefer it as the target.
    expect(candidate!.suggestedTarget).toBe(2.6);
  });

  it('prefers a synthetic 1R target when the sell zone is below 1R on ORB', () => {
    const stock = makeStock({
      currentPrice: 2.05,
      buyZonePrice: 1.95,
      stopPrice: 1.4,
      sellZonePrice: 2.1,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      {
        matched: true,
        rangeHigh: 2.0,
        rangeLow: 1.9,
        entry: 2.0,
        stop: 1.9,
        rrToSellZone: 1,
        details: [],
      },
    );

    const c = candidate!;
    const risk = c.suggestedEntry - c.suggestedStop;
    expect(c.setup).toBe('orb_breakout');
    // 1R above entry = 2.20, which beats the 2.10 sell zone.
    expect(c.suggestedTarget).toBeCloseTo(c.suggestedEntry + risk, 6);
  });

  it('ignores the ORB signal when 30m trend is down', () => {
    const stock = makeStock({
      currentPrice: 2.05,
      buyZonePrice: 1.95,
      stopPrice: 1.4,
      sellZonePrice: 2.6,
      trend30m: 'down',
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      {
        matched: true,
        rangeHigh: 2.0,
        rangeLow: 1.9,
        entry: 2.0,
        stop: 1.9,
        rrToSellZone: 6,
        details: [],
      },
    );

    expect(candidate?.setup).not.toBe('orb_breakout');
  });

  it('red-candle theory outranks ORB when both match', () => {
    const stock = makeStock({
      currentPrice: 2.05,
      buyZonePrice: 1.95,
      stopPrice: 1.4,
      sellZonePrice: 2.6,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      {
        matched: true,
        candleHigh: 2.0,
        candleLow: 1.85,
        entry: 2.0,
        stop: 1.85,
        rrToSellZone: 4,
        details: ['rct matched'],
      },
      {
        matched: true,
        rangeHigh: 2.0,
        rangeLow: 1.9,
        entry: 2.0,
        stop: 1.9,
        rrToSellZone: 6,
        details: ['orb matched'],
      },
    );

    expect(candidate!.setup).toBe('red_candle_theory');
    expect(candidate!.suggestedStop).toBe(1.85);
  });

  it('emptyOrbSignal default keeps legacy two-arg callers working', () => {
    const stock = makeStock({
      currentPrice: 2.0,
      buyZonePrice: 1.95,
      stopPrice: 1.9,
      sellZonePrice: 2.6,
    });

    // Purposely omit the orbSignal argument — default must not affect routing.
    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
    );

    expect(candidate).not.toBeNull();
    expect(candidate!.setup).not.toBe('orb_breakout');
    // Sanity: emptyOrbSignal helper is exported and returns unmatched signal.
    expect(emptyOrbSignal().matched).toBe(false);
  });

  it('uses the red-candle signal stop verbatim when RCT matches', () => {
    const stock = makeStock({
      currentPrice: 2.0,
      buyZonePrice: 1.95,
      stopPrice: 1.4,
      sellZonePrice: 2.6,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      { ...emptyMessageContext(stock.symbol), tagCounts: { red_to_green: 1 } },
      {
        matched: true,
        candleHigh: 2.1,
        candleLow: 1.85,
        entry: 2.0,
        stop: 1.85,
        rrToSellZone: 4,
        details: ['red candle theory matched'],
      },
    );

    expect(candidate!.setup).toBe('red_candle_theory');
    expect(candidate!.suggestedStop).toBe(1.85);
  });
});
