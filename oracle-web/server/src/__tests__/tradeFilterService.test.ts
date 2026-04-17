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
    },
  },
}));

import { tradeFilterService, AccountState } from '../services/tradeFilterService.js';
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

    it('returns 0 shares if cost would breach capital cap', () => {
      const candidate = makeCandidate({ suggestedEntry: 100.00, suggestedStop: 95.00 });
      // risk_per_trade=100, riskPerShare=5, shares=floor(100/5)=20, cost=2000
      // account has 10000 cash, 50% cap = 5000, already deployed 4500
      const account = makeAccount({ deployedCapital: 4500 });
      const size = tradeFilterService.calculatePositionSize(candidate, account);
      expect(size.shares).toBe(0);
    });

    it('returns 0 shares if risk per share is zero', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.00, suggestedStop: 1.00 });
      const size = tradeFilterService.calculatePositionSize(candidate, makeAccount());
      expect(size.shares).toBe(0);
    });
  });
});
