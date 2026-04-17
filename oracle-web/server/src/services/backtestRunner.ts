import { readFileSync } from 'fs';
import { config } from '../config.js';
import type { CandidateSetup } from './ruleEngineService.js';
import type { CycleRecord, RecordedItem, RecordedDecision } from './recordingService.js';

export interface BacktestTrade {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTs: string;
  shares: number;
  initialStop: number;
  currentStop: number;
  target: number;
  riskPerShare: number;
  trailingState: 'initial' | 'breakeven' | 'trailing';
  exitPrice?: number;
  exitTs?: string;
  exitReason?: 'stop' | 'trailing_stop' | 'target' | 'eod';
  pnl?: number;
  rMultiple?: number;
  rationale: string[];
  washSaleFlagged: boolean;
}

export interface BacktestSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  largestWin: number;
  largestLoss: number;
  avgR: number;
  startingEquity: number;
  endingEquity: number;
}

export interface EquityPoint {
  ts: string;
  cash: number;
  deployed: number;
  unrealizedPnl: number;
  equity: number;
}

export interface BacktestResult {
  tradingDay: string;
  totalCycles: number;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  equityCurve: EquityPoint[];
  skipped: Array<{ symbol: string; ts: string; reason: string }>;
}

export interface BacktestOptions {
  startingCash?: number;
}

function closeTrade(
  trade: BacktestTrade,
  exitPrice: number,
  exitTs: string,
  reason: NonNullable<BacktestTrade['exitReason']>,
): void {
  trade.exitPrice = exitPrice;
  trade.exitTs = exitTs;
  trade.exitReason = reason;
  trade.pnl = (exitPrice - trade.entryPrice) * trade.shares;
  trade.rMultiple = trade.riskPerShare > 0
    ? (exitPrice - trade.entryPrice) / trade.riskPerShare
    : 0;
}

function parseEtMinutes(tsEt: string): number {
  const [hh, mm] = tsEt.split(':').map(Number);
  return hh * 60 + mm;
}

export class BacktestRunner {
  runDay(filePath: string, opts: BacktestOptions = {}): BacktestResult {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const cycles: CycleRecord[] = lines.map((l) => JSON.parse(l));
    return this.runCycles(cycles, opts);
  }

  runCycles(cycles: CycleRecord[], opts: BacktestOptions = {}): BacktestResult {
    const exec = config.execution;
    const startingCash = opts.startingCash ?? 10000;

    let cash = startingCash;
    let realizedPnl = 0;
    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [];
    const skipped: BacktestResult['skipped'] = [];
    const cooldownUntilMs = new Map<string, number>();
    const tradedSymbols = new Set<string>();

    let tradingDay = cycles[0]?.tradingDay ?? '';
    const [flatH, flatM] = exec.eod_flatten_time.split(':').map(Number);
    const flatMinutes = flatH * 60 + flatM;

    for (const cycle of cycles) {
      if (!tradingDay) tradingDay = cycle.tradingDay;
      const cycleMs = new Date(cycle.ts).getTime();
      const priceMap = new Map<string, number | null>(
        cycle.items.map((i) => [i.symbol, i.currentPrice]),
      );
      const itemMap = new Map<string, RecordedItem>(
        cycle.items.map((i) => [i.symbol, i]),
      );

      this.manageOpenTrades(trades, priceMap, cycle.ts, cycleMs, cooldownUntilMs, exec, (pnl) => {
        realizedPnl += pnl;
      }, (proceeds) => {
        cash += proceeds;
      });

      this.evaluateNewEntries(
        cycle,
        itemMap,
        priceMap,
        trades,
        cooldownUntilMs,
        tradedSymbols,
        startingCash,
        realizedPnl,
        cash,
        (cost) => {
          cash -= cost;
        },
        skipped,
      );

      const etMinutes = parseEtMinutes(cycle.tsEt);
      if (etMinutes >= flatMinutes) {
        for (const trade of trades) {
          if (trade.exitReason) continue;
          const price = priceMap.get(trade.symbol) ?? trade.entryPrice;
          closeTrade(trade, price, cycle.ts, 'eod');
          cash += trade.shares * price;
          realizedPnl += trade.pnl ?? 0;
        }
      }

      const unrealized = trades
        .filter((t) => !t.exitReason)
        .reduce((sum, t) => {
          const p = priceMap.get(t.symbol);
          if (p == null) return sum;
          return sum + (p - t.entryPrice) * t.shares;
        }, 0);
      const deployed = trades
        .filter((t) => !t.exitReason)
        .reduce((sum, t) => sum + t.shares * t.entryPrice, 0);

      equityCurve.push({
        ts: cycle.ts,
        cash,
        deployed,
        unrealizedPnl: unrealized,
        equity: cash + deployed + unrealized,
      });
    }

    const closed = trades.filter((t) => t.exitReason);
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closed.length - wins;
    const totalPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const largestWin = closed.reduce((max, t) => Math.max(max, t.pnl ?? 0), 0);
    const largestLoss = closed.reduce((min, t) => Math.min(min, t.pnl ?? 0), 0);
    const avgR = closed.length > 0
      ? closed.reduce((sum, t) => sum + (t.rMultiple ?? 0), 0) / closed.length
      : 0;

    return {
      tradingDay,
      totalCycles: cycles.length,
      trades,
      summary: {
        totalTrades: closed.length,
        wins,
        losses,
        winRate: closed.length > 0 ? wins / closed.length : 0,
        totalPnl,
        largestWin,
        largestLoss,
        avgR,
        startingEquity: startingCash,
        endingEquity: startingCash + totalPnl,
      },
      equityCurve,
      skipped,
    };
  }

  private manageOpenTrades(
    trades: BacktestTrade[],
    priceMap: Map<string, number | null>,
    ts: string,
    cycleMs: number,
    cooldownUntilMs: Map<string, number>,
    exec: typeof config.execution,
    onRealized: (pnl: number) => void,
    onProceeds: (proceeds: number) => void,
  ): void {
    for (const trade of trades) {
      if (trade.exitReason) continue;
      const price = priceMap.get(trade.symbol) ?? null;
      if (price == null) continue;

      if (price <= trade.currentStop) {
        const reason = trade.trailingState === 'initial' ? 'stop' : 'trailing_stop';
        closeTrade(trade, price, ts, reason);
        cooldownUntilMs.set(trade.symbol, cycleMs + exec.cooldown_after_stop_ms);
        onProceeds(trade.shares * price);
        onRealized(trade.pnl ?? 0);
        continue;
      }

      if (price >= trade.target) {
        closeTrade(trade, price, ts, 'target');
        onProceeds(trade.shares * price);
        onRealized(trade.pnl ?? 0);
        continue;
      }

      const rMultiple = trade.riskPerShare > 0
        ? (price - trade.entryPrice) / trade.riskPerShare
        : 0;
      if (rMultiple >= exec.trailing_start_r) {
        const newStop = price - exec.trailing_distance_r * trade.riskPerShare;
        trade.currentStop = Math.max(trade.currentStop, newStop);
        trade.trailingState = 'trailing';
      } else if (rMultiple >= exec.trailing_breakeven_r) {
        trade.currentStop = Math.max(trade.currentStop, trade.entryPrice);
        trade.trailingState = 'breakeven';
      }
    }
  }

  private evaluateNewEntries(
    cycle: CycleRecord,
    itemMap: Map<string, RecordedItem>,
    priceMap: Map<string, number | null>,
    trades: BacktestTrade[],
    cooldownUntilMs: Map<string, number>,
    tradedSymbols: Set<string>,
    startingCash: number,
    realizedPnl: number,
    cash: number,
    onSpend: (cost: number) => void,
    skipped: BacktestResult['skipped'],
  ): void {
    const exec = config.execution;
    const cycleMs = new Date(cycle.ts).getTime();

    const candidates = cycle.decisions.filter((d): d is RecordedDecision & { kind: 'candidate' } => d.kind === 'candidate');
    for (const decision of candidates) {
      if (trades.some((t) => t.symbol === decision.symbol && !t.exitReason)) continue;

      const cooldownUntil = cooldownUntilMs.get(decision.symbol);
      if (cooldownUntil !== undefined && cycleMs < cooldownUntil) {
        skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'cooldown' });
        continue;
      }

      const item = itemMap.get(decision.symbol);
      if (!item) continue;
      const entry = item.currentPrice ?? item.buyZonePrice ?? null;
      const stop = item.stopPrice ?? null;
      const target = item.sellZonePrice ?? null;
      if (entry == null || stop == null || target == null || entry <= stop) {
        skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'missing levels' });
        continue;
      }

      const riskPct = (entry - stop) / entry;
      if (riskPct > exec.max_risk_pct) {
        skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: `risk_pct ${(riskPct * 100).toFixed(1)}%` });
        continue;
      }

      const unrealized = trades
        .filter((t) => !t.exitReason)
        .reduce((sum, t) => {
          const p = priceMap.get(t.symbol);
          if (p == null) return sum;
          return sum + (p - t.entryPrice) * t.shares;
        }, 0);
      const dailyPnl = realizedPnl + unrealized;
      const drawdownPct = startingCash > 0
        ? Math.abs(Math.min(0, dailyPnl)) / startingCash
        : 0;
      if (drawdownPct >= exec.max_daily_drawdown_pct) {
        skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'drawdown breaker' });
        continue;
      }

      const openCount = trades.filter((t) => !t.exitReason).length;
      if (openCount >= exec.max_positions) {
        skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'max_positions' });
        continue;
      }

      const washSaleFlagged = tradedSymbols.has(decision.symbol);
      if (washSaleFlagged) {
        const rr = (target - entry) / (entry - stop);
        if (decision.score < exec.wash_sale_min_score || rr < exec.wash_sale_min_rr) {
          skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'wash-sale bar' });
          continue;
        }
        if (exec.wash_sale_require_no_chase && item.buyZonePrice !== null && entry > item.buyZonePrice) {
          skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'wash-sale chase' });
          continue;
        }
      }

      const deployed = trades
        .filter((t) => !t.exitReason)
        .reduce((sum, t) => sum + t.shares * (priceMap.get(t.symbol) ?? t.entryPrice), 0);
      if (startingCash > 0 && deployed / startingCash >= exec.max_capital_pct) {
        skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'capital cap' });
        continue;
      }

      const riskPerShare = entry - stop;
      const shares = Math.floor(exec.risk_per_trade / riskPerShare);
      if (shares < 1) continue;
      const cost = shares * entry;
      const maxDeploy = startingCash * exec.max_capital_pct - deployed;
      if (cost > maxDeploy || cost > cash) {
        skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'insufficient capital' });
        continue;
      }

      trades.push({
        symbol: decision.symbol,
        strategy: decision.setup,
        entryPrice: entry,
        entryTs: cycle.ts,
        shares,
        initialStop: stop,
        currentStop: stop,
        target,
        riskPerShare,
        trailingState: 'initial',
        rationale: decision.rationale,
        washSaleFlagged,
      });
      tradedSymbols.add(decision.symbol);
      onSpend(cost);
    }
  }
}

export const backtestRunner = new BacktestRunner();
