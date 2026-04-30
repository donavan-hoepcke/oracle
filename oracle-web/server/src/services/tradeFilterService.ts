import { config } from '../config.js';
import { TradeCandidate as BaseTradeCandidate } from './ruleEngineService.js';
import { floatMapService } from './floatMapService.js';
import type { RegimeSnapshot } from './regimeService.js';

type TradeCandidate = BaseTradeCandidate & {
  suggestedEntry: number;
  suggestedStop: number;
  suggestedTarget: number;
};

export interface AccountState {
  cash: number;
  portfolioValue: number;
  startOfDayEquity: number;
  openPositionCount: number;
  deployedCapital: number;
  dailyRealizedPnl: number;
  dailyUnrealizedPnl: number;
}

export interface FilterResult {
  passed: boolean;
  reason: string | null;
}

export interface PositionSize {
  shares: number;
  costBasis: number;
}

class TradeFilterService {
  filterCandidate(
    candidate: TradeCandidate,
    account: AccountState,
    regime?: RegimeSnapshot,
  ): FilterResult {
    const exec = config.execution;

    const dailyLoss = account.dailyRealizedPnl + account.dailyUnrealizedPnl;
    const drawdownPct = account.startOfDayEquity > 0
      ? Math.abs(Math.min(0, dailyLoss)) / account.startOfDayEquity
      : 0;
    if (drawdownPct >= exec.max_daily_drawdown_pct) {
      return { passed: false, reason: `drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds max ${(exec.max_daily_drawdown_pct * 100).toFixed(1)}%` };
    }

    if (account.openPositionCount >= exec.max_positions) {
      return { passed: false, reason: `max_positions ${exec.max_positions} reached` };
    }

    const capitalPct = account.cash > 0 ? account.deployedCapital / account.cash : 1;
    if (capitalPct >= exec.max_capital_pct) {
      return { passed: false, reason: `capital deployed ${(capitalPct * 100).toFixed(1)}% exceeds max ${(exec.max_capital_pct * 100).toFixed(1)}%` };
    }

    const entry = candidate.suggestedEntry;
    const stop = candidate.suggestedStop;
    if (entry > 0 && stop > 0) {
      const riskPct = (entry - stop) / entry;
      if (riskPct > exec.max_risk_pct) {
        return { passed: false, reason: `risk_pct ${(riskPct * 100).toFixed(1)}% exceeds max ${(exec.max_risk_pct * 100).toFixed(1)}%` };
      }
    }

    if (regime && exec.regime?.enabled) {
      const vetoResult = this.runRegimeVetos(candidate, regime);
      if (!vetoResult.passed) return vetoResult;
    }

    if (exec.float_rotation?.enabled) {
      const cfg = exec.float_rotation;
      const entry = floatMapService.getEntryForSymbol(candidate.symbol, cfg.max_age_seconds);
      if (entry && entry.rotation !== null && entry.rotation > cfg.veto_rotation_max) {
        return {
          passed: false,
          reason: `float blow-off (rotation ${entry.rotation.toFixed(1)}x exceeds cap ${cfg.veto_rotation_max}x)`,
        };
      }
    }

    return { passed: true, reason: null };
  }

  private runRegimeVetos(candidate: TradeCandidate, regime: RegimeSnapshot): FilterResult {
    const cfg = config.execution.regime;

    const m = regime.market;
    if (
      m.spyTrendPct !== null &&
      m.vxxRocPct !== null &&
      m.spyTrendPct <= cfg.veto_market_spy_trend_pct &&
      m.vxxRocPct >= cfg.veto_market_vxx_roc_pct
    ) {
      return {
        passed: false,
        reason: `market panic (SPY ${(m.spyTrendPct * 100).toFixed(2)}% / VXX ${(m.vxxRocPct * 100).toFixed(2)}%)`,
      };
    }

    const tr = regime.tickers[candidate.symbol];
    if (tr) {
      if (tr.sampleSize >= cfg.veto_graveyard_min_sample && tr.winRate === 0) {
        return {
          passed: false,
          reason: `ticker+setup graveyard (0/${tr.sampleSize} on ${candidate.setup})`,
        };
      }
      if (tr.atrRatio !== null && tr.atrRatio >= cfg.veto_exhaustion_atr_ratio) {
        return {
          passed: false,
          reason: `exhaustion (ATR ratio ${tr.atrRatio.toFixed(2)})`,
        };
      }
    }

    return { passed: true, reason: null };
  }

  calculatePositionSize(candidate: TradeCandidate, account: AccountState): PositionSize {
    const exec = config.execution;
    const entry = candidate.suggestedEntry;
    const stop = candidate.suggestedStop;
    const riskPerShare = Math.round((entry - stop) * 1e8) / 1e8;

    if (riskPerShare <= 0 || entry <= 0) {
      return { shares: 0, costBasis: 0 };
    }

    const riskSizedShares = Math.floor(exec.risk_per_trade / riskPerShare);
    const maxDeployable = Math.max(0, account.cash * exec.max_capital_pct - account.deployedCapital);
    const capitalCapShares = Math.floor(maxDeployable / entry);
    const tradeCostCapShares = exec.max_trade_cost > 0
      ? Math.floor(exec.max_trade_cost / entry)
      : Number.POSITIVE_INFINITY;

    const shares = Math.min(riskSizedShares, capitalCapShares, tradeCostCapShares);
    if (shares < 1) {
      return { shares: 0, costBasis: 0 };
    }
    return { shares, costBasis: shares * entry };
  }
}

export const tradeFilterService = new TradeFilterService();
