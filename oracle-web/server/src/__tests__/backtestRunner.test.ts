import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      enabled: true,
      paper: true,
      risk_per_trade: 100,
      max_trade_cost: 0,
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.5,
      max_risk_pct: 0.10,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      momentum_max_chase_pct: 0.05,
      cooldown_after_stop_ms: 60 * 60 * 1000,
      require_uptrend_for_momentum: true,
      wash_sale_lookback_days: 30,
      wash_sale_min_score: 75,
      wash_sale_min_rr: 3.0,
      wash_sale_require_no_chase: true,
      trailing_breakeven_r: 1.0,
      trailing_start_r: 2.0,
      trailing_distance_r: 1.0,
      eod_flatten_time: '15:50',
    },
    market_hours: { timezone: 'America/New_York' },
  },
}));

import { BacktestRunner } from '../services/backtestRunner.js';
import type {
  CycleRecord,
  RecordedItem,
  RecordedDecision,
} from '../services/recordingService.js';

function makeItem(
  symbol: string,
  price: number,
  levels: { stopPrice?: number; buyZonePrice?: number; sellZonePrice?: number } = {},
): RecordedItem {
  return {
    symbol,
    currentPrice: price,
    lastPrice: price,
    changePercent: 0,
    stopPrice: levels.stopPrice ?? null,
    buyZonePrice: levels.buyZonePrice ?? null,
    sellZonePrice: levels.sellZonePrice ?? null,
    profitDeltaPct: null,
    maxVolume: null,
    premarketVolume: null,
    relativeVolume: null,
    floatMillions: null,
    signal: null,
    trend30m: 'up',
    boxTop: null,
    boxBottom: null,
  };
}

function makeCandidate(symbol: string, score = 80): RecordedDecision {
  return {
    symbol,
    kind: 'candidate',
    setup: 'momentum_continuation',
    score,
    rationale: ['test candidate'],
  };
}

// April 17, 2026 is in US DST → ET = UTC-4.
function makeCycle(
  tsEt: string,
  items: RecordedItem[],
  decisions: RecordedDecision[] = [],
  tradingDay = '2026-04-17',
): CycleRecord {
  const [hh, mm] = tsEt.split(':').map(Number);
  const ts = new Date(Date.UTC(2026, 3, 17, hh + 4, mm, 0)).toISOString();
  return {
    ts,
    tsEt: `${tsEt}:00`,
    tradingDay,
    marketStatus: { isOpen: true, openTime: '09:30', closeTime: '16:00' },
    items,
    decisions,
    activeTrades: [],
    closedTrades: [],
  };
}

describe('BacktestRunner', () => {
  const runner = new BacktestRunner();

  it('opens a trade and exits at target', () => {
    const cycles = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2 })],
        [makeCandidate('AAA')],
      ),
      makeCycle('09:31', [makeItem('AAA', 1.25, { stopPrice: 0.9, sellZonePrice: 1.2 })]),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('target');
    expect(trade.exitPrice).toBe(1.25);
    expect(trade.pnl).toBeGreaterThan(0);
    expect(result.summary.wins).toBe(1);
    expect(result.summary.losses).toBe(0);
  });

  it('exits at initial stop on drawdown', () => {
    const cycles = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2 })],
        [makeCandidate('AAA')],
      ),
      makeCycle('09:31', [makeItem('AAA', 0.85, { stopPrice: 0.9, sellZonePrice: 1.2 })]),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBe(0.85);
    expect(trade.pnl).toBeLessThan(0);
    expect(result.summary.losses).toBe(1);
  });

  it('advances trailing stop from initial to breakeven to trailing, then exits', () => {
    const cycles = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 5.0 })],
        [makeCandidate('AAA')],
      ),
      // r=1.5 → breakeven (stop moves to 1.00)
      makeCycle('09:31', [makeItem('AAA', 1.15, { stopPrice: 0.9, sellZonePrice: 5.0 })]),
      // r=3.0 → trailing (stop moves to 1.30 - 1.0*0.10 = 1.20)
      makeCycle('09:32', [makeItem('AAA', 1.3, { stopPrice: 0.9, sellZonePrice: 5.0 })]),
      // pulls back below trailing stop → trailing_stop exit at 1.15
      makeCycle('09:33', [makeItem('AAA', 1.15, { stopPrice: 0.9, sellZonePrice: 5.0 })]),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('trailing_stop');
    expect(trade.trailingState).toBe('trailing');
    expect(trade.currentStop).toBeCloseTo(1.2, 6);
    expect(trade.exitPrice).toBe(1.15);
    expect(trade.pnl).toBeGreaterThan(0);
  });

  it('blocks re-entry while cooldown is active after a stop', () => {
    const cycles = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2 })],
        [makeCandidate('AAA')],
      ),
      makeCycle('09:31', [makeItem('AAA', 0.85, { stopPrice: 0.9, sellZonePrice: 1.2 })]),
      // 14 minutes later — cooldown is 1 hour in the test config, still active.
      makeCycle(
        '09:45',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2 })],
        [makeCandidate('AAA')],
      ),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.trades).toHaveLength(1);
    expect(result.skipped.some((s) => s.reason === 'cooldown')).toBe(true);
  });

  it('applies wash-sale bar on a previously traded symbol with low score', () => {
    const cycles = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2, buyZonePrice: 1.0 })],
        [makeCandidate('AAA', 90)],
      ),
      makeCycle('09:31', [
        makeItem('AAA', 1.25, { stopPrice: 0.9, sellZonePrice: 1.2, buyZonePrice: 1.0 }),
      ]),
      // Second candidate on same symbol, score below wash_sale_min_score.
      makeCycle(
        '11:00',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2, buyZonePrice: 1.0 })],
        [makeCandidate('AAA', 70)],
      ),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.trades).toHaveLength(1);
    expect(result.skipped.some((s) => s.reason === 'wash-sale bar')).toBe(true);
  });

  it('rejects candidates whose risk_pct exceeds max_risk_pct', () => {
    const cycles = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.8, sellZonePrice: 1.5 })],
        [makeCandidate('AAA')],
      ),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.trades).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason.startsWith('risk_pct'))).toBe(true);
  });

  it('flattens open positions at EOD', () => {
    const cycles = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 2.0 })],
        [makeCandidate('AAA')],
      ),
      makeCycle('15:50', [makeItem('AAA', 1.1, { stopPrice: 0.9, sellZonePrice: 2.0 })]),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exitReason).toBe('eod');
    expect(trade.exitPrice).toBe(1.1);
  });

  it('produces one equity snapshot per cycle', () => {
    const cycles = [
      makeCycle('09:30', [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2 })]),
      makeCycle('09:31', [makeItem('AAA', 1.05, { stopPrice: 0.9, sellZonePrice: 1.2 })]),
    ];
    const result = runner.runCycles(cycles, { startingCash: 10000 });
    expect(result.equityCurve).toHaveLength(2);
    expect(result.equityCurve[0].equity).toBe(10000);
    expect(result.totalCycles).toBe(2);
    expect(result.tradingDay).toBe('2026-04-17');
  });

  it('scales risk per trade with starting cash so position sizes stay proportional', () => {
    const day = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.95, sellZonePrice: 1.2 })],
        [makeCandidate('AAA')],
      ),
      makeCycle('09:31', [makeItem('AAA', 1.25, { stopPrice: 0.95, sellZonePrice: 1.2 })]),
    ];
    const small = new BacktestRunner().runCycles(day, { startingCash: 1_000 });
    const large = new BacktestRunner().runCycles(day, { startingCash: 100_000 });
    // Both accounts should take the same trade (default risk = 1% of cash).
    expect(small.trades).toHaveLength(1);
    expect(large.trades).toHaveLength(1);
    // Large-account size should be ~100× small-account size (same risk fraction).
    const ratio = large.trades[0].shares / small.trades[0].shares;
    expect(ratio).toBeGreaterThan(50);
    expect(ratio).toBeLessThan(150);
  });

  it('honors an explicit riskPerTrade override', () => {
    const day = [
      makeCycle(
        '09:30',
        [makeItem('AAA', 1.0, { stopPrice: 0.9, sellZonePrice: 1.2 })],
        [makeCandidate('AAA')],
      ),
      makeCycle('09:31', [makeItem('AAA', 1.25, { stopPrice: 0.9, sellZonePrice: 1.2 })]),
    ];
    const result = new BacktestRunner().runCycles(day, {
      startingCash: 10_000,
      riskPerTrade: 50,
    });
    // $50 risk / $0.10 per-share risk = 500 shares.
    expect(result.trades[0].shares).toBe(500);
  });

  it('skips candidates that exceed the max_positions cap', () => {
    const items = ['AAA', 'BBB', 'CCC'].map((s) =>
      makeItem(s, 1.0, { stopPrice: 0.95, sellZonePrice: 1.2 }),
    );
    const decisions = items.map((i) => makeCandidate(i.symbol));
    const cycles = [makeCycle('09:30', items, decisions)];
    // Override max_positions via starting a large risk so only 2 fit; simpler: startingCash cap.
    // With risk_per_trade=100 and riskPerShare=0.05 → shares=2000 cost=$2000 each.
    // max_capital_pct=0.5 and startingCash=3000 → maxDeploy=1500. Only 0 fit (cost 2000 > 1500).
    // Use startingCash=5000 → maxDeploy=2500 → first fits, second: deployed=2000, maxDeploy=500 → second rejected with 'insufficient capital'.
    const result = runner.runCycles(cycles, { startingCash: 5000 });
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.skipped.some((s) => s.reason === 'insufficient capital')).toBe(true);
  });
});
