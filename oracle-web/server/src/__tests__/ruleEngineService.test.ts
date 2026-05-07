import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      float_rotation: {
        enabled: true,
        score_bump_base: 10,
        score_bump_prime: 5,
        prime_band_min: 1.0,
        prime_band_max: 3.0,
        veto_rotation_max: 7.0,
        max_age_seconds: 600,
      },
      sector_hotness: {
        enabled: true,
        top_k_sectors: 3,
        score_bump: 8,
        refresh_interval_seconds: 300,
        max_age_seconds: 900,
        lookback_minutes: 60,
      },
    },
  },
}));

vi.mock('../services/floatMapService.js', () => ({
  floatMapService: {
    getEntryForSymbol: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../services/sectorHotnessService.js', () => ({
  sectorHotnessService: {
    getHotnessForSymbol: vi.fn().mockResolvedValue(null),
  },
}));

const { mockFetchAlpaca1MinBars } = vi.hoisted(() => ({
  mockFetchAlpaca1MinBars: vi.fn(),
}));
vi.mock('../services/alpacaBarService.js', () => ({
  fetchAlpaca1MinBars: mockFetchAlpaca1MinBars,
  fetchAlpacaBars: vi.fn(async () => []),
  getAlpacaRateLimiterStats: () => ({}),
}));

import {
  ruleEngineService,
  emptyMessageContext,
  emptyRedCandleSignal,
  emptyOrbSignal,
} from '../services/ruleEngineService.js';
import { floatMapService } from '../services/floatMapService.js';
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

describe('RuleEngineService.getRankedCandidates concurrency + cache', () => {
  beforeEach(() => {
    ruleEngineService.clearRankingCache();
    mockFetchAlpaca1MinBars.mockReset();
    mockFetchAlpaca1MinBars.mockResolvedValue([]); // no bars → no signals; that's fine
  });

  it('coalesces concurrent callers to one underlying evaluation', async () => {
    // Regression for 2026-05-07 Issue 1: 12 concurrent /api/raw/symbols/:sym
    // requests timed out at 15s because each one re-ran the full 40-symbol
    // evaluation path, queuing ~480 Alpaca bar fetches behind the IEX
    // rate limiter.
    const stocks = ['AAA', 'BBB', 'CCC'].map((sym) =>
      makeStock({ symbol: sym, currentPrice: 1.0, buyZonePrice: 0.95 }),
    );

    // Fire 12 concurrent callers, each "asking for a different limit" the
    // way different /api/raw/symbols/:sym handlers would.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        ruleEngineService.getRankedCandidates(stocks, 10 + i),
      ),
    );

    // All callers got SOMETHING (possibly empty list — depends on whether
    // setups match; what matters is they all completed without timing out).
    expect(results).toHaveLength(12);

    // The fetch path is shared via inflight + cache: 1 evaluation pass per
    // distinct symbol, NOT 12 × 3. Each evaluateStock fires fetchAlpaca1MinBars
    // twice (RCT 90-bar lookback + ORB 390-bar lookback), so the upper
    // bound is 2 × stocks.length = 6 calls when fully coalesced.
    expect(mockFetchAlpaca1MinBars.mock.calls.length).toBeLessThanOrEqual(stocks.length * 2);
  });

  it('serves a second call within 5s from the cache without re-evaluating', async () => {
    const stocks = [makeStock({ symbol: 'AAA' })];
    await ruleEngineService.getRankedCandidates(stocks, 10);
    const fetchesAfterFirst = mockFetchAlpaca1MinBars.mock.calls.length;

    await ruleEngineService.getRankedCandidates(stocks, 10);
    expect(mockFetchAlpaca1MinBars.mock.calls.length).toBe(fetchesAfterFirst);
  });

  it('different `limit` values share the same underlying ranking', async () => {
    const stocks = ['AAA', 'BBB'].map((sym) => makeStock({ symbol: sym }));
    await ruleEngineService.getRankedCandidates(stocks, 1);
    const baseline = mockFetchAlpaca1MinBars.mock.calls.length;
    // limit=50 should NOT re-trigger the fetches — it just slices a
    // longer range from the cached full-list.
    await ruleEngineService.getRankedCandidates(stocks, 50);
    expect(mockFetchAlpaca1MinBars.mock.calls.length).toBe(baseline);
  });
});

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

  it('RCT suggestedEntry tracks the trigger candle high when Oracle currentPrice is stale below it', () => {
    // Regression for the 2026-05-07 RXT/SMX/SABR rejections.
    // detectRedCandleTheory uses Alpaca 1m bars to confirm the reclaim;
    // pre-market thin liquidity meant a reclaim flipped on briefly while
    // Oracle's currentPrice (a different feed) was still below the trigger
    // bar's low. The old path took suggestedEntry = currentPrice verbatim,
    // producing entry < stop and a downstream "rounded to 0 shares"
    // rejection with no diagnostic context. The fix uses
    // max(currentPrice, candleHigh) so geometry stays sane.
    const stock = makeStock({
      currentPrice: 1.83, // stale Oracle feed
      buyZonePrice: null,
      stopPrice: 1.78,
      sellZonePrice: 2.6,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      {
        matched: true,
        candleHigh: 2.24, // Alpaca 1m trigger bar high (reclaim level)
        candleLow: 2.22,
        entry: 2.24,
        stop: 2.22,
        rrToSellZone: 18,
        details: ['rct matched (stale-feed regression)'],
      },
      emptyOrbSignal(),
    );

    expect(candidate).not.toBeNull();
    expect(candidate!.setup).toBe('red_candle_theory');
    expect(candidate!.suggestedEntry).toBe(2.24);
    expect(candidate!.suggestedStop).toBe(2.22);
    // Geometry sanity: long-side entry must be > stop. The bug produced
    // suggestedEntry=1.83 (Oracle) with suggestedStop=2.22 (Alpaca).
    expect(candidate!.suggestedEntry).toBeGreaterThan(candidate!.suggestedStop);
  });

  it('RCT suggestedEntry uses currentPrice when it has already cleared the trigger high', () => {
    // The "happy path" — currentPrice is fresh and above triggerBar.high.
    // We should pay the (higher) currentPrice on a market buy, not silently
    // clip to the stale trigger high.
    const stock = makeStock({
      currentPrice: 2.30,
      buyZonePrice: null,
      stopPrice: 1.78,
      sellZonePrice: 2.6,
    });

    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      {
        matched: true,
        candleHigh: 2.24,
        candleLow: 2.22,
        entry: 2.24,
        stop: 2.22,
        rrToSellZone: 18,
        details: ['rct matched (fresh-feed)'],
      },
      emptyOrbSignal(),
    );

    expect(candidate!.suggestedEntry).toBe(2.30);
    expect(candidate!.suggestedStop).toBe(2.22);
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

  it('does not bump score when symbol is absent from FloatMAP', () => {
    vi.mocked(floatMapService.getEntryForSymbol).mockReturnValue(null);
    const stock = makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6 });
    const c = ruleEngineService.scoreFromInputs(stock, emptyMessageContext(stock.symbol), emptyRedCandleSignal());
    expect(c).not.toBeNull();
    expect(c!.rationale.some((r) => r.includes('FloatMAP'))).toBe(false);
  });

  it('applies base bump for FloatMAP membership outside the prime band', () => {
    // Only the TEST symbol gets a FloatMAP entry; OTHER returns null so the
    // baseline scores without any float bump.
    vi.mocked(floatMapService.getEntryForSymbol).mockImplementation((sym) =>
      sym === 'TEST'
        ? { symbol: 'TEST', rotation: 0.6, last: 2.0, floatMillions: 5, nextOracleSupport: null, nextOracleResistance: null }
        : null,
    );
    const baseline = ruleEngineService.scoreFromInputs(
      makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6, symbol: 'OTHER' }),
      emptyMessageContext('OTHER'),
      emptyRedCandleSignal(),
    );
    const withFloat = ruleEngineService.scoreFromInputs(
      makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6 }),
      emptyMessageContext('TEST'),
      emptyRedCandleSignal(),
    );
    expect(withFloat!.score - baseline!.score).toBeCloseTo(10, 1);
    expect(withFloat!.rationale.some((r) => r.includes('FloatMAP listed (rotation 0.6x) +10'))).toBe(true);
    expect(withFloat!.rationale.some((r) => r.includes('Prime rotation band'))).toBe(false);
  });

  it('stacks the prime-band bonus when rotation falls in [1.0, 3.0]', () => {
    vi.mocked(floatMapService.getEntryForSymbol).mockImplementation((sym) =>
      sym === 'TEST'
        ? { symbol: 'TEST', rotation: 2.4, last: 2.0, floatMillions: 5, nextOracleSupport: null, nextOracleResistance: null }
        : null,
    );
    const baseline = ruleEngineService.scoreFromInputs(
      makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6, symbol: 'OTHER' }),
      emptyMessageContext('OTHER'),
      emptyRedCandleSignal(),
    );
    const withFloat = ruleEngineService.scoreFromInputs(
      makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6 }),
      emptyMessageContext('TEST'),
      emptyRedCandleSignal(),
    );
    expect(withFloat!.score - baseline!.score).toBeCloseTo(15, 1); // base 10 + prime 5
    expect(withFloat!.rationale.some((r) => r.includes('Prime rotation band'))).toBe(true);
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

  it('applies sector hotness bump when the symbol is in a top-K hot sector', () => {
    const stock = makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6 });
    const baseline = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
    );
    const withHotness = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      undefined,
      undefined,
      { sector: 'technology', etf: 'XLK', rank: 1, pctChange: 0.024 },
    );
    expect(withHotness!.score - baseline!.score).toBeCloseTo(8, 1);
    expect(withHotness!.rationale.some((r) => r.includes('Hot sector: technology') && r.includes('#1'))).toBe(true);
  });

  it('does not apply hotness bump when sector ranks outside top-K', () => {
    const stock = makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6 });
    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      undefined,
      undefined,
      { sector: 'utilities', etf: 'XLU', rank: 10, pctChange: -0.005 },
    );
    expect(candidate!.rationale.some((r) => r.includes('Hot sector'))).toBe(false);
  });

  it('does not apply hotness bump when sector hotness is null (stale snapshot)', () => {
    const stock = makeStock({ currentPrice: 2.0, buyZonePrice: 1.95, stopPrice: 1.9, sellZonePrice: 2.6 });
    const candidate = ruleEngineService.scoreFromInputs(
      stock,
      emptyMessageContext(stock.symbol),
      emptyRedCandleSignal(),
      undefined,
      undefined,
      null,
    );
    expect(candidate!.rationale.some((r) => r.includes('Hot sector'))).toBe(false);
  });
});
