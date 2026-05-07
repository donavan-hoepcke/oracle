import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.05,
      max_risk_pct: 0.10,
      risk_per_trade: 100,
      max_trade_cost: 0,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      regime: {
        enabled: true,
        veto_market_spy_trend_pct: -0.01,
        veto_market_vxx_roc_pct: 0.05,
        veto_graveyard_min_sample: 5,
        veto_exhaustion_atr_ratio: 3.0,
      },
      float_rotation: {
        enabled: true,
        score_bump_base: 10,
        score_bump_prime: 5,
        prime_band_min: 1.0,
        prime_band_max: 3.0,
        veto_rotation_max: 7.0,
        max_age_seconds: 600,
      },
      extended_hours: {
        enabled: true,
        no_entry_buffer_minutes_before_close: 15,
        size_cap_pct: 0.5,
        stop_buffer_pct: 0.25,
      },
    },
    market_hours: { timezone: 'America/New_York', open: '09:30', close: '16:00' },
  },
}));

vi.mock('../services/floatMapService.js', () => ({
  floatMapService: {
    getEntryForSymbol: vi.fn().mockReturnValue(null),
  },
}));

import { tradeFilterService, AccountState } from '../services/tradeFilterService.js';
import { floatMapService } from '../services/floatMapService.js';
import { TradeCandidate } from '../services/ruleEngineService.js';

function makeCandidate(overrides: Partial<TradeCandidate> & { suggestedEntry: number; suggestedStop: number }): TradeCandidate {
  const { suggestedEntry, suggestedStop, suggestedTarget: overrideTarget, ...rest } = overrides;
  const suggestedTarget = overrideTarget ?? suggestedEntry * 1.5;
  return {
    symbol: 'TEST',
    score: 70,
    setup: 'momentum_continuation',
    rationale: [],
    oracleScore: 50,
    messageScore: 50,
    executionScore: 50,
    messageContext: { symbol: 'TEST', mentionCount: 0, convictionScore: 0, tagCounts: {}, latestMessages: [] },
    snapshot: {
      currentPrice: suggestedEntry,
      buyZonePrice: suggestedEntry,
      stopPrice: suggestedStop,
      sellZonePrice: suggestedTarget,
      profitDeltaPct: null,
      trend30m: 'up',
    },
    suggestedEntry,
    suggestedStop,
    suggestedTarget,
    ...rest,
  } as TradeCandidate;
}

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    cash: 10000,
    portfolioValue: 10000,
    startOfDayEquity: 10000,
    openPositionCount: 0,
    deployedCapital: 0,
    dailyRealizedPnl: 0,
    dailyUnrealizedPnl: 0,
    // Default to a margin-style account so existing tests behave as before:
    // settledCash equals cash and isCashAccount is false → sizing falls back
    // to cash. Cash-account-specific tests override these explicitly.
    settledCash: 10000,
    isCashAccount: false,
    ...overrides,
  };
}

describe('TradeFilterService', () => {
  describe('daily drawdown breaker', () => {
    it('rejects when daily loss exceeds 5% of starting equity', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ dailyRealizedPnl: -400, dailyUnrealizedPnl: -150 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('drawdown');
    });

    it('passes when daily loss is within limit', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ dailyRealizedPnl: -100, dailyUnrealizedPnl: -50 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(true);
    });
  });

  describe('max positions', () => {
    it('rejects when at max positions', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ openPositionCount: 8 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('max_positions');
    });
  });

  describe('capital deployment cap', () => {
    it('rejects when deployed capital exceeds 50%', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const account = makeAccount({ deployedCapital: 5100 });
      const result = tradeFilterService.filterCandidate(candidate, account);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('capital');
    });
  });

  describe('max risk percentage', () => {
    it('rejects when stop is >10% from entry (HUBC-like)', () => {
      const candidate = makeCandidate({ suggestedEntry: 0.226, suggestedStop: 0.11 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('risk_pct');
    });

    it('passes when stop is within 10%', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(true);
    });
  });

  describe('position sizing', () => {
    it('calculates shares from risk budget', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 0.95 });
      const size = tradeFilterService.calculatePositionSize(candidate, makeAccount());
      // risk_per_trade=100, riskPerShare=0.05, shares=floor(100/0.05)=2000
      expect(size.shares).toBe(2000);
      expect(size.costBasis).toBe(2000);
    });

    it('clips shares to remaining capital cap instead of rejecting', () => {
      const candidate = makeCandidate({ suggestedEntry: 100.00, suggestedStop: 95.00 });
      // risk_per_trade=100, riskPerShare=5, riskSizedShares=20, riskCost=2000.
      // Account has 10000 cash, 50% cap = 5000, already deployed 4500 → maxDeployable 500.
      // Clip to floor(500/100)=5 shares.
      const account = makeAccount({ deployedCapital: 4500 });
      const size = tradeFilterService.calculatePositionSize(candidate, account);
      expect(size.shares).toBe(5);
      expect(size.costBasis).toBe(500);
    });

    it('returns 0 shares if capital cap leaves no room for even one share', () => {
      const candidate = makeCandidate({ suggestedEntry: 100.00, suggestedStop: 95.00 });
      const account = makeAccount({ deployedCapital: 4950 });
      const size = tradeFilterService.calculatePositionSize(candidate, account);
      expect(size.shares).toBe(0);
    });

    it('returns 0 shares if risk per share is zero', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 1.00 });
      const size = tradeFilterService.calculatePositionSize(candidate, makeAccount());
      expect(size.shares).toBe(0);
    });

    it('surfaces a diagnostic zeroReason when entry <= stop (negative risk geometry)', () => {
      // Regression: 2026-05-07 RXT/SMX/SABR were rejected with the
      // catch-all "rounded to 0 shares" because RCT's suggestedEntry was
      // sourced from a stale Oracle feed below the Alpaca trigger bar's
      // low. The geometric impossibility itself should be loudly visible
      // in the rejection log so the next instance is obvious to triage.
      const candidate = makeCandidate({ suggestedEntry: 1.83, suggestedStop: 2.22 });
      const size = tradeFilterService.calculatePositionSize(candidate, makeAccount());
      expect(size.shares).toBe(0);
      expect(size.zeroReason).toBeDefined();
      expect(size.zeroReason).toMatch(/invalid entry\/stop/i);
      expect(size.zeroReason).toContain('1.830');
      expect(size.zeroReason).toContain('2.220');
    });

    it('zeroReason on capital-cap exhaustion names the deployed-capital ratio', () => {
      // Capital cap binds: account already deployed at the cap, so
      // maxDeployable rounds to 0 and capitalCapShares < 1.
      const candidate = makeCandidate({ suggestedEntry: 100.0, suggestedStop: 95.0 });
      const account = makeAccount({ deployedCapital: 5000 });
      const size = tradeFilterService.calculatePositionSize(candidate, account);
      expect(size.shares).toBe(0);
      expect(size.zeroReason).toMatch(/capital cap/);
    });

    describe('cash account settled-cash sizing (Phase 3)', () => {
      it('sizes against settledCash when isCashAccount=true (risk-bound)', () => {
        // Cash=10000 but only 5000 settled (rest is unsettled proceeds from
        // a recent sell). With 50% capital cap on settled cash: maxDeployable
        // = 5000*0.5 - 0 = 2500 → settled-cash cap is floor(2500/100)=25
        // shares. Risk-sized = floor(100/(100-95))=20 shares. 20 < 25, so
        // risk is the binding constraint → 20 shares. Test confirms cash-account
        // mode falls back to the risk cap when settled cash isn't tight.
        const candidate = makeCandidate({ suggestedEntry: 100, suggestedStop: 95 });
        const account = makeAccount({
          cash: 10000,
          settledCash: 5000,
          isCashAccount: true,
        });
        const size = tradeFilterService.calculatePositionSize(candidate, account);
        expect(size.shares).toBe(20);
      });

      it('clips at settled-cash cap when settledCash is the binding constraint', () => {
        // Cash=10000, settledCash=1000, isCashAccount=true. 50% of settled =
        // 500 maxDeployable, floor(500/100)=5 shares. Risk would have allowed
        // 20 — settled cash is the binding cap.
        const candidate = makeCandidate({ suggestedEntry: 100, suggestedStop: 95 });
        const account = makeAccount({
          cash: 10000,
          settledCash: 1000,
          isCashAccount: true,
        });
        const size = tradeFilterService.calculatePositionSize(candidate, account);
        expect(size.shares).toBe(5);
      });

      it('returns 0 shares when settled cash is fully unsettled', () => {
        // Realistic free-riding scenario: just sold a position, all proceeds
        // unsettled, settledCash=0. The bot must NOT enter a new position
        // funded by unsettled cash.
        const candidate = makeCandidate({ suggestedEntry: 100, suggestedStop: 95 });
        const account = makeAccount({
          cash: 10000,
          settledCash: 0,
          isCashAccount: true,
        });
        const size = tradeFilterService.calculatePositionSize(candidate, account);
        expect(size.shares).toBe(0);
      });

      it('uses cash (not settledCash) when isCashAccount=false (margin)', () => {
        // Margin account: settledCash field is irrelevant, the broker adapter
        // typically sets it equal to cash. If for some reason it's lower,
        // sizing should still use cash on a margin account.
        const candidate = makeCandidate({ suggestedEntry: 100, suggestedStop: 95 });
        const account = makeAccount({
          cash: 10000,
          settledCash: 1000, // pathological — should be ignored on margin
          isCashAccount: false,
        });
        const size = tradeFilterService.calculatePositionSize(candidate, account);
        // 50% of 10000 cash = 5000, floor(5000/100)=50, but risk-sized=20 wins.
        expect(size.shares).toBe(20);
      });
    });
  });

  describe('max trade cost', () => {
    it('clips shares to max_trade_cost when set', async () => {
      vi.resetModules();
      vi.doMock('../config.js', () => ({
        config: {
          execution: {
            max_positions: 8,
            max_capital_pct: 0.5,
            max_daily_drawdown_pct: 0.05,
            max_risk_pct: 0.10,
            risk_per_trade: 100,
            max_trade_cost: 100,
            red_candle_vol_mult: 1.5,
            regime: {
              enabled: true,
              veto_market_spy_trend_pct: -0.01,
              veto_market_vxx_roc_pct: 0.05,
              veto_graveyard_min_sample: 5,
              veto_exhaustion_atr_ratio: 3.0,
            },
          },
        },
      }));
      const { tradeFilterService: isolatedService } = await import('../services/tradeFilterService.js');
      const candidate = makeCandidate({ suggestedEntry: 2.00, suggestedStop: 1.95 });
      // riskSizedShares=2000, costWithout=4000. max_trade_cost=100 → floor(100/2)=50 shares.
      const size = isolatedService.calculatePositionSize(candidate, makeAccount());
      expect(size.shares).toBe(50);
      expect(size.costBasis).toBe(100);
      vi.doUnmock('../config.js');
    });
  });

  describe('regime vetos', () => {
    function makeRegime(overrides: {
      spyTrendPct?: number | null;
      vxxRocPct?: number | null;
      tickerAtrRatio?: number | null;
      winRate?: number | null;
      sampleSize?: number;
    } = {}): import('../services/regimeService.js').RegimeSnapshot {
      return {
        ts: new Date().toISOString(),
        market: {
          score: 0,
          spyTrendPct: overrides.spyTrendPct ?? 0,
          vxxRocPct: overrides.vxxRocPct ?? 0,
          status: 'ok',
        },
        sectors: {},
        tickers: {
          TEST: {
            score: 0,
            sector: 'energy',
            atrRatio: overrides.tickerAtrRatio ?? 1.0,
            winRate: overrides.winRate ?? 0.5,
            sampleSize: overrides.sampleSize ?? 4,
            status: 'ok',
          },
        },
      };
    }

    it('vetos on market panic (SPY ≤ -1% AND VXX ≥ +5%)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ spyTrendPct: -0.015, vxxRocPct: 0.06 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('market panic');
    });

    it('passes when only one panic condition is met', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ spyTrendPct: -0.015, vxxRocPct: 0.02 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(true);
    });

    it('vetos on graveyard (0/5 prior trades on (symbol, setup))', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ winRate: 0, sampleSize: 5 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('graveyard');
    });

    it('passes when sample size below min_sample', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ winRate: 0, sampleSize: 3 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(true);
    });

    it('vetos on exhaustion (ATR ratio ≥ 3.0)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ tickerAtrRatio: 3.5 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('exhaustion');
    });

    it('passes at ATR ratio 2.8 (soft penalty zone, no veto)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ tickerAtrRatio: 2.8 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(true);
    });

    it('no-ops when regime undefined (preserves legacy behavior)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(true);
    });
  });

  describe('float-rotation veto', () => {
    it('rejects when rotation exceeds blow-off cap', () => {
      vi.mocked(floatMapService.getEntryForSymbol).mockReturnValue({
        symbol: 'TEST', rotation: 8.5, last: 1.0, floatMillions: 5, nextOracleSupport: null, nextOracleResistance: null,
      });
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('float blow-off');
      expect(result.reason).toContain('8.5x');
    });

    it('passes at rotation just under the cap', () => {
      vi.mocked(floatMapService.getEntryForSymbol).mockReturnValue({
        symbol: 'TEST', rotation: 6.9, last: 1.0, floatMillions: 5, nextOracleSupport: null, nextOracleResistance: null,
      });
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(true);
    });

    it('passes when symbol is absent from FloatMAP (no signal)', () => {
      vi.mocked(floatMapService.getEntryForSymbol).mockReturnValue(null);
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(true);
    });
  });

  describe('extended-hours guards', () => {
    it('rejects non-RCT setups during pre-market', () => {
      const candidate = makeCandidate({
        suggestedEntry: 1.0,
        suggestedStop: 0.95,
        setup: 'momentum_continuation',
      });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), undefined, 'pre');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not eligible in ext-hours');
    });

    it('rejects non-RCT setups during post-market', () => {
      const candidate = makeCandidate({
        suggestedEntry: 1.0,
        suggestedStop: 0.95,
        setup: 'orb_breakout',
      });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), undefined, 'post');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not eligible in ext-hours');
    });

    it('passes RCT setups during pre-market', () => {
      const candidate = makeCandidate({
        suggestedEntry: 1.0,
        suggestedStop: 0.95,
        setup: 'red_candle_theory',
      });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), undefined, 'pre');
      expect(result.passed).toBe(true);
    });

    it('does NOT apply ext-hours rules during RTH', () => {
      const candidate = makeCandidate({
        suggestedEntry: 1.0,
        suggestedStop: 0.95,
        setup: 'momentum_continuation',
      });
      // RTH session — momentum_continuation should NOT be rejected by
      // the ext-hours gate. (Other RTH gates may still apply but are
      // not exercised by this test fixture.)
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), undefined, 'rth');
      expect(result.passed).toBe(true);
    });
  });
});
