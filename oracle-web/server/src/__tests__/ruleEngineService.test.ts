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
      momentum_max_chase_pct: 0.10,
      momentum_enabled: true,
      momentum_min_move_pct: 0.03,
      momentum_min_pullback_pct: 0.015,
      momentum_volume_mult: 1.3,
      orb_enabled: true,
      orb_range_minutes: 15,
      orb_volume_mult: 1.3,
      orb_max_chase_pct: 0.03,
      orb_min_range_pct: 0.01,
    },
    market_hours: { timezone: 'America/New_York' },
  },
}));

import {
  ruleEngineService,
  emptyMessageContext,
  emptyRedCandleSignal,
  emptyOrbSignal,
  emptyMomentumSignal,
  computeMomentumSignal,
} from '../services/ruleEngineService.js';
import type { Bar } from '../services/indicatorService.js';
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
  // Routes through pullback_reclaim (tag-driven) which shares the Oracle-stop
  // clamp branch that non-ORB/non-momentum setups use.
  const pullbackTags = { ...emptyMessageContext('TEST'), tagCounts: { first_pullback: 1 } };

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
      pullbackTags,
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
      pullbackTags,
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

  it('empty signal defaults keep legacy callers working and do not invent setups', () => {
    const stock = makeStock({
      currentPrice: 2.0,
      buyZonePrice: 1.95,
      stopPrice: 1.9,
      sellZonePrice: 2.6,
    });

    // Purposely omit orbSignal + momentumSignal — defaults must not create a
    // candidate on their own (no more tag-free structure fallback).
    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
    );

    expect(candidate).toBeNull();
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

function makeBar(isoTs: string, o: number, h: number, l: number, c: number, v: number): Bar {
  return { timestamp: new Date(isoTs), open: o, high: h, low: l, close: c, volume: v };
}

// Build a session-day bar series anchored at 9:30 ET. Each bar is 1 minute;
// the ET->UTC offset shifts across DST, so the tests pass a base hour matching
// the target day's offset (13 = EDT, 14 = EST).
function etMinute(day: string, utcHour: number, minute: number): string {
  const hh = String(utcHour + Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${day}T${hh}:${mm}:00.000Z`;
}

describe('computeMomentumSignal', () => {
  const DAY = '2026-04-21';
  const UTC_BASE_HOUR = 13; // 13:30Z = 9:30 ET during EDT

  function sessionBars(count = 30): Bar[] {
    // Clean structure we're asserting against:
    //   i=0: session open at 1.00
    //   i=5: HOD spike to 1.10 (close 1.095)
    //   i=6..count-2: pullback + consolidation with highs capped at 1.07
    //   i=count-1: reclaim bar closing 1.08 (above pullback ceiling) w/ 2.4x vol
    const bars: Bar[] = [];
    for (let i = 0; i < count; i++) {
      const ts = etMinute(DAY, UTC_BASE_HOUR, 30 + i);
      if (i === 0) {
        bars.push(makeBar(ts, 1.00, 1.005, 0.998, 1.002, 5_000));
      } else if (i <= 5) {
        const closes = [null, 1.02, 1.04, 1.06, 1.08, 1.095];
        const close = closes[i]!;
        const high = i === 5 ? 1.10 : close + 0.003;
        bars.push(makeBar(ts, close - 0.015, high, close - 0.02, close, 5_000));
      } else if (i < count - 1) {
        // Sideways pullback: lows 1.05, highs 1.07 (pullback ceiling).
        bars.push(makeBar(ts, 1.06, 1.07, 1.05, 1.06, 5_000));
      } else {
        // Reclaim: close 1.08 > pullback high 1.07, 12000 volume = 2.4x the
        // 5000 avg so momentum_volume_mult (1.3) passes comfortably.
        bars.push(makeBar(ts, 1.07, 1.082, 1.068, 1.08, 12_000));
      }
    }
    return bars;
  }

  function makeStockForMomentum(price: number): StockState {
    return makeStock({ currentPrice: price, sellZonePrice: 1.2 });
  }

  it('matches a clean HOD → higher-low pullback → volume reclaim', () => {
    const bars = sessionBars(30);
    const now = new Date(etMinute(DAY, UTC_BASE_HOUR, 30 + 29));
    const stock = makeStockForMomentum(1.075);

    const signal = computeMomentumSignal(stock, bars, now);

    expect(signal.matched).toBe(true);
    expect(signal.entry).toBeCloseTo(1.07, 3); // pullback high
    expect(signal.stop).toBeCloseTo(1.05, 3); // pullback low
    expect(signal.stop).toBeGreaterThan(1.0); // higher-low above session open
  });

  it('returns empty when the stock has not moved up enough from the open', () => {
    // Flat series: HOD = 1.003, only 0.3% above open — fails min_move_pct 3%.
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = etMinute(DAY, UTC_BASE_HOUR, 30 + i);
      bars.push(makeBar(ts, 1.0, 1.003, 0.998, 1.001, 5_000));
    }
    const now = new Date(etMinute(DAY, UTC_BASE_HOUR, 30 + 29));
    const signal = computeMomentumSignal(makeStockForMomentum(1.001), bars, now);
    expect(signal.matched).toBe(false);
  });

  it('returns empty when pullback dips below the session open (no higher low)', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = etMinute(DAY, UTC_BASE_HOUR, 30 + i);
      if (i < 10) {
        const price = 1.0 + (i * 0.01);
        bars.push(makeBar(ts, price, price + 0.005, price - 0.001, price + 0.004, 5_000));
      } else if (i < 28) {
        // Pullback that blows through the session open low at 0.95.
        const price = 1.10 - ((i - 10) * 0.01);
        bars.push(makeBar(ts, price, price + 0.002, price - 0.002, price, 5_000));
      } else {
        bars.push(makeBar(ts, 1.0, 1.02, 0.99, 1.01, 12_000));
      }
    }
    const now = new Date(etMinute(DAY, UTC_BASE_HOUR, 30 + 29));
    const signal = computeMomentumSignal(makeStockForMomentum(1.01), bars, now);
    expect(signal.matched).toBe(false);
  });

  it('leaves matched=false (but keeps levels populated) when reclaim volume is weak', () => {
    const bars = sessionBars(30);
    // Tiny volume on the reclaim — kills the volumeConfirm gate.
    bars[bars.length - 1] = { ...bars[bars.length - 1], volume: 100 };
    const now = new Date(etMinute(DAY, UTC_BASE_HOUR, 30 + 29));
    const signal = computeMomentumSignal(makeStockForMomentum(1.09), bars, now);
    expect(signal.matched).toBe(false);
    expect(signal.pullbackHigh).not.toBeNull();
    expect(signal.pullbackLow).not.toBeNull();
  });

  it('routes scoreFromInputs to momentum_continuation and uses pullback low as stop', () => {
    const stock = makeStock({
      currentPrice: 1.09,
      buyZonePrice: 1.05,
      stopPrice: 0.85, // intentionally wide Oracle stop
      sellZonePrice: 1.3,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      emptyOrbSignal(),
      {
        matched: true,
        pullbackHigh: 1.08,
        pullbackLow: 1.04,
        hod: 1.10,
        sessionOpen: 1.00,
        entry: 1.08,
        stop: 1.04,
        rrToSellZone: 5,
        details: ['Momentum reclaim above 1.080'],
      },
    );

    expect(candidate).not.toBeNull();
    expect(candidate!.setup).toBe('momentum_continuation');
    expect(candidate!.suggestedStop).toBe(1.04);
    expect(candidate!.suggestedEntry).toBe(1.09);
    expect(candidate!.suggestedTarget).toBe(1.3);
  });

  it('suppresses momentum_continuation when 30m trend is down', () => {
    const stock = makeStock({
      currentPrice: 1.09,
      buyZonePrice: 1.05,
      stopPrice: 1.0,
      sellZonePrice: 1.3,
      trend30m: 'down',
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      emptyOrbSignal(),
      {
        matched: true,
        pullbackHigh: 1.08,
        pullbackLow: 1.04,
        hod: 1.10,
        sessionOpen: 1.00,
        entry: 1.08,
        stop: 1.04,
        rrToSellZone: 5,
        details: [],
      },
    );

    expect(candidate?.setup).not.toBe('momentum_continuation');
  });

  it('emptyMomentumSignal helper returns an unmatched signal', () => {
    expect(emptyMomentumSignal().matched).toBe(false);
  });
});
