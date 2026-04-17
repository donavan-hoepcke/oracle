import { config } from '../config.js';
import { alpacaOrderService } from './alpacaOrderService.js';
import { tradeFilterService, AccountState } from './tradeFilterService.js';
import { TradeCandidate, CandidateSetup } from './ruleEngineService.js';
import { StockState } from '../websocket/priceSocket.js';

export interface ActiveTrade {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTime: Date;
  shares: number;
  initialStop: number;
  currentStop: number;
  target: number;
  riskPerShare: number;
  orderId: string;
  status: 'pending' | 'filled' | 'exiting';
  trailingState: 'initial' | 'breakeven' | 'trailing';
  pendingSince: Date;
  rationale: string[];
}

export interface TradeLedgerEntry {
  symbol: string;
  strategy: CandidateSetup;
  entryPrice: number;
  entryTime: Date;
  exitPrice: number;
  exitTime: Date;
  shares: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  exitReason: 'stop' | 'trailing_stop' | 'target' | 'eod' | 'circuit_breaker';
  exitDetail: string;
  rationale: string[];
}

const PENDING_TIMEOUT_MS = 30 * 60 * 1000;

export interface FilterRejection {
  symbol: string;
  reason: string;
  score: number;
  setup: CandidateSetup;
  suggestedEntry: number;
  suggestedStop: number;
  suggestedTarget: number;
  timestamp: Date;
}

export class ExecutionService {
  private activeTrades: ActiveTrade[] = [];
  private ledger: TradeLedgerEntry[] = [];
  private rejections: Map<string, FilterRejection> = new Map();
  private startOfDayEquity: number | null = null;
  private enabled = config.execution.enabled;

  getRejections(): FilterRejection[] {
    return Array.from(this.rejections.values());
  }

  getRejectionForSymbol(symbol: string): FilterRejection | undefined {
    return this.rejections.get(symbol);
  }

  getActiveTrades(): ActiveTrade[] {
    return [...this.activeTrades];
  }

  getLedger(): TradeLedgerEntry[] {
    return [...this.ledger];
  }

  getDailyPnl(): number {
    return this.ledger.reduce((sum, t) => sum + t.pnl, 0);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async onPriceCycle(candidates: TradeCandidate[], stocks: StockState[]): Promise<void> {
    if (!this.enabled) return;

    await this.reconcileWithAlpaca(stocks);

    const account = await this.buildAccountState();
    const reservedSymbols = await this.getReservedSymbols();

    await this.checkPendingOrders();
    await this.cancelStaleOrders();
    await this.manageFilled(stocks);
    await this.evaluateNewEntries(candidates, account, reservedSymbols);
  }

  /**
   * Adopt any Alpaca positions that are not already tracked in activeTrades.
   * Protects against server restarts clearing the in-memory ledger while
   * positions remain at the broker. Uses the live Oracle watchlist for stop
   * and target where available; falls back to max_risk_pct-derived defaults.
   */
  private async reconcileWithAlpaca(stocks: StockState[]): Promise<void> {
    let positions;
    try {
      positions = await alpacaOrderService.getPositions();
    } catch (err) {
      console.error('Reconcile failed:', err);
      return;
    }
    const stockMap = new Map(stocks.map((s) => [s.symbol, s]));
    const exec = config.execution;

    for (const pos of positions) {
      if (this.activeTrades.some((t) => t.symbol === pos.symbol)) continue;

      const stock = stockMap.get(pos.symbol);
      const entry = pos.avgEntryPrice;
      const initialStop =
        stock?.stopPrice && stock.stopPrice > 0 && stock.stopPrice < entry
          ? stock.stopPrice
          : entry * (1 - exec.max_risk_pct);
      const target =
        stock?.sellZonePrice && stock.sellZonePrice > entry
          ? stock.sellZonePrice
          : entry * (1 + exec.max_risk_pct * 3);

      this.activeTrades.push({
        symbol: pos.symbol,
        strategy: 'momentum_continuation',
        entryPrice: entry,
        entryTime: new Date(),
        shares: pos.qty,
        initialStop,
        currentStop: initialStop,
        target,
        riskPerShare: entry - initialStop,
        orderId: '',
        status: 'filled',
        trailingState: 'initial',
        pendingSince: new Date(),
        rationale: [
          `Adopted orphaned Alpaca position (original strategy unknown)`,
          `Stop derived from ${stock?.stopPrice ? 'Oracle watchlist stopPrice' : `${(exec.max_risk_pct * 100).toFixed(0)}% max risk default`}`,
          `Target derived from ${stock?.sellZonePrice && stock.sellZonePrice > entry ? 'Oracle watchlist sellZonePrice' : '3R default'}`,
        ],
      });

      console.log(
        `Adopted orphaned position: ${pos.symbol} qty=${pos.qty} entry=${entry.toFixed(3)} ` +
          `stop=${initialStop.toFixed(3)} target=${target.toFixed(3)}`,
      );
    }
  }

  /**
   * Symbols that already have a position or open order at Alpaca.
   * Used to avoid placing duplicate orders after a bot restart or when
   * the in-process ledger has drifted from Alpaca's state.
   */
  private async getReservedSymbols(): Promise<Set<string>> {
    const reserved = new Set<string>();
    try {
      const [positions, openOrders] = await Promise.all([
        alpacaOrderService.getPositions(),
        alpacaOrderService.getOpenOrders(),
      ]);
      for (const p of positions) reserved.add(p.symbol);
      for (const o of openOrders) reserved.add(o.symbol);
    } catch (err) {
      console.error('Failed to fetch Alpaca state for dup check:', err);
    }
    return reserved;
  }

  async flattenAll(): Promise<void> {
    for (const trade of this.activeTrades) {
      await this.exitTrade(trade, trade.entryPrice, 'eod', 'Manual flatten or EOD close');
    }
    try {
      await alpacaOrderService.closeAllPositions();
    } catch {
      // best effort
    }
    this.activeTrades = [];
  }

  private async buildAccountState(): Promise<AccountState> {
    const account = await alpacaOrderService.getAccount();
    const positions = await alpacaOrderService.getPositions();

    if (this.startOfDayEquity === null) {
      this.startOfDayEquity = account.portfolioValue;
    }

    const deployedCapital = positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPl, 0);

    return {
      cash: account.cash,
      portfolioValue: account.portfolioValue,
      startOfDayEquity: this.startOfDayEquity,
      openPositionCount: this.activeTrades.filter(t => t.status === 'filled').length,
      deployedCapital,
      dailyRealizedPnl: this.getDailyPnl(),
      dailyUnrealizedPnl: unrealizedPnl,
    };
  }

  private async evaluateNewEntries(
    candidates: TradeCandidate[],
    account: AccountState,
    reservedSymbols: Set<string>
  ): Promise<void> {
    // Rebuild rejection map each cycle so stale entries clear naturally.
    const currentCandidateSymbols = new Set(candidates.map((c) => c.symbol));
    for (const symbol of Array.from(this.rejections.keys())) {
      if (!currentCandidateSymbols.has(symbol)) this.rejections.delete(symbol);
    }

    for (const candidate of candidates) {
      if (this.activeTrades.some(t => t.symbol === candidate.symbol)) {
        this.rejections.delete(candidate.symbol);
        continue;
      }
      if (reservedSymbols.has(candidate.symbol)) {
        this.rejections.delete(candidate.symbol);
        continue;
      }
      if (candidate.suggestedEntry <= 0 || candidate.suggestedStop <= 0) {
        this.recordRejection(candidate, 'missing suggested entry/stop');
        continue;
      }

      const filterResult = tradeFilterService.filterCandidate(candidate, account);
      if (!filterResult.passed) {
        this.recordRejection(candidate, filterResult.reason ?? 'unknown');
        continue;
      }

      const size = tradeFilterService.calculatePositionSize(candidate, account);
      if (size.shares <= 0) {
        this.recordRejection(candidate, 'position size rounded to 0 shares');
        continue;
      }

      this.rejections.delete(candidate.symbol);

      const orderType = candidate.setup === 'red_candle_theory' || candidate.setup === 'momentum_continuation'
        ? 'limit' as const
        : 'market' as const;

      try {
        const order = await alpacaOrderService.submitOrder({
          symbol: candidate.symbol,
          qty: size.shares,
          side: 'buy',
          type: orderType,
          limitPrice: orderType === 'limit' ? candidate.suggestedEntry : undefined,
        });

        this.activeTrades.push({
          symbol: candidate.symbol,
          strategy: candidate.setup,
          entryPrice: candidate.suggestedEntry,
          entryTime: new Date(),
          shares: size.shares,
          initialStop: candidate.suggestedStop,
          currentStop: candidate.suggestedStop,
          target: candidate.suggestedTarget,
          riskPerShare: candidate.suggestedEntry - candidate.suggestedStop,
          orderId: order.id,
          status: 'pending',
          trailingState: 'initial',
          pendingSince: new Date(),
          rationale: [...candidate.rationale, `Score ${candidate.score.toFixed(0)} | ${candidate.setup}`],
        });

        account.openPositionCount++;
        account.deployedCapital += size.costBasis;
        reservedSymbols.add(candidate.symbol);
      } catch (err) {
        console.error(`Failed to submit order for ${candidate.symbol}:`, err);
      }
    }
  }

  private async checkPendingOrders(): Promise<void> {
    for (const trade of this.activeTrades) {
      if (trade.status !== 'pending') continue;
      try {
        const order = await alpacaOrderService.getOrder(trade.orderId);
        if (order.status === 'filled') {
          trade.status = 'filled';
          if (order.filledAvgPrice) trade.entryPrice = order.filledAvgPrice;
          if (order.filledQty) trade.shares = order.filledQty;
          trade.riskPerShare = trade.entryPrice - trade.initialStop;
        } else if (order.status === 'canceled' || order.status === 'expired' || order.status === 'rejected') {
          this.activeTrades = this.activeTrades.filter(t => t !== trade);
        }
      } catch {
        // will retry next cycle
      }
    }
  }

  private async cancelStaleOrders(): Promise<void> {
    const now = Date.now();
    for (const trade of [...this.activeTrades]) {
      if (trade.status === 'pending' && now - trade.pendingSince.getTime() > PENDING_TIMEOUT_MS) {
        try {
          await alpacaOrderService.cancelOrder(trade.orderId);
        } catch {
          // best effort
        }
        this.activeTrades = this.activeTrades.filter(t => t !== trade);
      }
    }
  }

  private async manageFilled(stocks: StockState[]): Promise<void> {
    const priceMap = new Map(stocks.map(s => [s.symbol, s.currentPrice]));

    for (const trade of [...this.activeTrades]) {
      if (trade.status !== 'filled') continue;

      const currentPrice = priceMap.get(trade.symbol);
      if (currentPrice === null || currentPrice === undefined) continue;

      // Check stop
      if (currentPrice <= trade.currentStop) {
        const reason = trade.trailingState !== 'initial' ? 'trailing_stop' : 'stop';
        const detail = reason === 'trailing_stop'
          ? `Price ${currentPrice.toFixed(3)} crossed trailing stop ${trade.currentStop.toFixed(3)} (state=${trade.trailingState})`
          : `Price ${currentPrice.toFixed(3)} crossed initial stop ${trade.currentStop.toFixed(3)}`;
        await this.exitTrade(trade, currentPrice, reason, detail);
        continue;
      }

      // Check target
      if (currentPrice >= trade.target) {
        const detail = `Price ${currentPrice.toFixed(3)} reached target ${trade.target.toFixed(3)}`;
        await this.exitTrade(trade, currentPrice, 'target', detail);
        continue;
      }

      // Update trailing stop
      const rMultiple = trade.riskPerShare > 0
        ? (currentPrice - trade.entryPrice) / trade.riskPerShare
        : 0;

      const exec = config.execution;
      if (rMultiple >= exec.trailing_start_r) {
        const newStop = currentPrice - exec.trailing_distance_r * trade.riskPerShare;
        trade.currentStop = Math.max(trade.currentStop, newStop);
        trade.trailingState = 'trailing';
      } else if (rMultiple >= exec.trailing_breakeven_r) {
        trade.currentStop = Math.max(trade.currentStop, trade.entryPrice);
        trade.trailingState = 'breakeven';
      }
    }
  }

  private async exitTrade(
    trade: ActiveTrade,
    exitPrice: number,
    reason: TradeLedgerEntry['exitReason'],
    detail: string = ''
  ): Promise<void> {
    trade.status = 'exiting';
    try {
      await alpacaOrderService.closePosition(trade.symbol);
    } catch (err) {
      console.error(`Failed to close position ${trade.symbol}:`, err);
    }

    const pnl = (exitPrice - trade.entryPrice) * trade.shares;
    const pnlPct = trade.entryPrice > 0 ? (exitPrice - trade.entryPrice) / trade.entryPrice * 100 : 0;
    const rMultiple = trade.riskPerShare > 0 ? (exitPrice - trade.entryPrice) / trade.riskPerShare : 0;

    this.ledger.push({
      symbol: trade.symbol,
      strategy: trade.strategy,
      entryPrice: trade.entryPrice,
      entryTime: trade.entryTime,
      exitPrice,
      exitTime: new Date(),
      shares: trade.shares,
      pnl,
      pnlPct,
      rMultiple,
      exitReason: reason,
      exitDetail: detail || this.defaultExitDetail(reason),
      rationale: trade.rationale,
    });

    this.activeTrades = this.activeTrades.filter(t => t !== trade);
  }

  private recordRejection(candidate: TradeCandidate, reason: string): void {
    this.rejections.set(candidate.symbol, {
      symbol: candidate.symbol,
      reason,
      score: candidate.score,
      setup: candidate.setup,
      suggestedEntry: candidate.suggestedEntry,
      suggestedStop: candidate.suggestedStop,
      suggestedTarget: candidate.suggestedTarget,
      timestamp: new Date(),
    });
  }

  private defaultExitDetail(reason: TradeLedgerEntry['exitReason']): string {
    switch (reason) {
      case 'eod': return 'End-of-day flatten (positions do not carry overnight)';
      case 'circuit_breaker': return 'Daily drawdown circuit breaker triggered';
      case 'stop': return 'Initial stop hit';
      case 'trailing_stop': return 'Trailing stop hit';
      case 'target': return 'Target price reached';
    }
  }
}

export const executionService = new ExecutionService();
