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
}

const PENDING_TIMEOUT_MS = 30 * 60 * 1000;

export class ExecutionService {
  private activeTrades: ActiveTrade[] = [];
  private ledger: TradeLedgerEntry[] = [];
  private startOfDayEquity: number | null = null;
  private enabled = config.execution.enabled;

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

    const account = await this.buildAccountState();
    const reservedSymbols = await this.getReservedSymbols();

    await this.checkPendingOrders();
    await this.cancelStaleOrders();
    await this.manageFilled(stocks);
    await this.evaluateNewEntries(candidates, account, reservedSymbols);
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
      await this.exitTrade(trade, trade.entryPrice, 'eod');
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
    for (const candidate of candidates) {
      if (this.activeTrades.some(t => t.symbol === candidate.symbol)) continue;
      if (reservedSymbols.has(candidate.symbol)) continue;
      if (candidate.suggestedEntry <= 0 || candidate.suggestedStop <= 0) continue;

      const filterResult = tradeFilterService.filterCandidate(candidate, account);
      if (!filterResult.passed) continue;

      const size = tradeFilterService.calculatePositionSize(candidate, account);
      if (size.shares <= 0) continue;

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
        await this.exitTrade(trade, currentPrice, trade.trailingState !== 'initial' ? 'trailing_stop' : 'stop');
        continue;
      }

      // Check target
      if (currentPrice >= trade.target) {
        await this.exitTrade(trade, currentPrice, 'target');
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
    reason: TradeLedgerEntry['exitReason']
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
    });

    this.activeTrades = this.activeTrades.filter(t => t !== trade);
  }
}

export const executionService = new ExecutionService();
