import { config } from '../config.js';
import { TradeCandidate as BaseTradeCandidate } from './ruleEngineService.js';

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
  filterCandidate(candidate: TradeCandidate, account: AccountState): FilterResult {
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

    return { passed: true, reason: null };
  }

  calculatePositionSize(candidate: TradeCandidate, account: AccountState): PositionSize {
    const exec = config.execution;
    const entry = candidate.suggestedEntry;
    const stop = candidate.suggestedStop;
    const riskPerShare = Math.round((entry - stop) * 1e8) / 1e8;

    if (riskPerShare <= 0) {
      return { shares: 0, costBasis: 0 };
    }

    const shares = Math.floor(exec.risk_per_trade / riskPerShare);
    const costBasis = shares * entry;

    const maxDeployable = account.cash * exec.max_capital_pct - account.deployedCapital;
    if (costBasis > maxDeployable || shares < 1) {
      return { shares: 0, costBasis: 0 };
    }

    return { shares, costBasis };
  }
}

export const tradeFilterService = new TradeFilterService();
