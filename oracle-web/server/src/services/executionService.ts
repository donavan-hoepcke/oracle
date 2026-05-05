import { config } from '../config.js';
import { brokerService } from './brokers/index.js';
import type { BrokerPosition } from '../types/broker.js';
import { tradeFilterService, AccountState } from './tradeFilterService.js';
import { TradeCandidate, CandidateSetup } from './ruleEngineService.js';
import { StockState } from '../websocket/priceSocket.js';
import type { RegimeSnapshot } from './regimeService.js';

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
  trailingState: 'initial' | 'mfe_lock' | 'breakeven' | 'trailing';
  // Max favorable R-multiple observed since entry. Drives the give-back stop
  // so peaks below the 1R breakeven threshold still ratchet the stop up.
  maxFavorableR: number;
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
  riskPerShare: number;
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

export interface FlattenResult {
  /** Total number of trades the flatten was asked to close. */
  requested: number;
  /** Symbols whose closes the broker accepted. Local activeTrades cleared, ledger appended. */
  succeeded: string[];
  /** Symbols whose closes the broker rejected. Local activeTrades unchanged. */
  failed: Array<{ symbol: string; error: string }>;
}

export class ExecutionService {
  private activeTrades: ActiveTrade[] = [];
  private ledger: TradeLedgerEntry[] = [];
  private rejections: Map<string, FilterRejection> = new Map();
  // Symbol -> unix ms when cooldown expires. Populated on bad exits (stop,
  // trailing_stop, circuit_breaker) to prevent same-session re-entries.
  private cooldown: Map<string, number> = new Map();
  // Symbols we have filled an order for in the last N days (per the broker).
  // Used to require a higher bar for re-entry (wash-sale awareness).
  private washSaleSymbols: Set<string> = new Set();
  private washSaleRefreshedAt = 0;
  private startOfDayEquity: number | null = null;
  private enabled = config.execution.enabled;

  getRejections(): FilterRejection[] {
    return Array.from(this.rejections.values());
  }

  getRejectionForSymbol(symbol: string): FilterRejection | undefined {
    return this.rejections.get(symbol);
  }

  getCooldownSymbols(): Array<{ symbol: string; expiresAt: string }> {
    const now = Date.now();
    const out: Array<{ symbol: string; expiresAt: string }> = [];
    for (const [symbol, ms] of this.cooldown.entries()) {
      if (ms > now) out.push({ symbol, expiresAt: new Date(ms).toISOString() });
    }
    return out;
  }

  isOnCooldown(symbol: string): boolean {
    const expires = this.cooldown.get(symbol);
    if (!expires) return false;
    if (expires <= Date.now()) {
      this.cooldown.delete(symbol);
      return false;
    }
    return true;
  }

  getWashSaleSymbols(): string[] {
    return Array.from(this.washSaleSymbols);
  }

  isWashSaleRisk(symbol: string): boolean {
    return this.washSaleSymbols.has(symbol);
  }

  /**
   * Refresh the wash-sale watchlist from broker order history. Cached for
   * WASH_SALE_REFRESH_MS to avoid pounding the API on every cycle.
   */
  private async refreshWashSaleSymbols(): Promise<void> {
    const now = Date.now();
    const WASH_SALE_REFRESH_MS = 60 * 1000; // 1 minute cache
    if (now - this.washSaleRefreshedAt < WASH_SALE_REFRESH_MS) return;

    const days = config.execution.wash_sale_lookback_days;
    if (days <= 0) {
      this.washSaleSymbols.clear();
      this.washSaleRefreshedAt = now;
      return;
    }

    const sinceIso = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    try {
      const orders = await brokerService.getOrdersSince(sinceIso, 'closed');
      const next = new Set<string>();
      for (const o of orders) {
        if (o.filledAvgPrice !== null && o.filledQty !== null && o.symbol) {
          next.add(o.symbol);
        }
      }
      this.washSaleSymbols = next;
      this.washSaleRefreshedAt = now;
    } catch (err) {
      console.error('Failed to refresh wash-sale symbols:', err);
    }
  }

  getActiveTrades(): ActiveTrade[] {
    return [...this.activeTrades];
  }

  getLedger(): TradeLedgerEntry[] {
    return [...this.ledger];
  }

  /**
   * Seed the in-memory ledger from persisted entries (e.g. today's JSONL
   * recording after a server restart). Skips duplicates keyed on
   * symbol + entryTime so it's safe to call before or after live trading.
   */
  hydrateLedger(entries: TradeLedgerEntry[]): number {
    const seen = new Set(
      this.ledger.map((e) => `${e.symbol}|${new Date(e.entryTime).toISOString()}`),
    );
    let added = 0;
    for (const raw of entries) {
      const entryTime = new Date(raw.entryTime);
      const key = `${raw.symbol}|${entryTime.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.ledger.push({
        ...raw,
        entryTime,
        exitTime: new Date(raw.exitTime),
      });
      added++;
    }
    return added;
  }

  getDailyPnl(): number {
    return this.ledger.reduce((sum, t) => sum + t.pnl, 0);
  }

  /**
   * Rewrite ledger entries in place against the broker's actual sell fills since
   * startIso. Corrects EOD/flatten exits that were recorded at entryPrice
   * (pnl = 0) and any other trade whose recorded exit diverged from the
   * real fill. Best effort: on fetch failure the ledger is left unchanged.
   */
  async reconcileLedgerFromBroker(startIso: string): Promise<number> {
    if (this.ledger.length === 0) return 0;
    const { applyFillsToLedger } = await import('./tradeReconciliationService.js');
    let orders;
    try {
      orders = await brokerService.getOrdersSince(startIso, 'closed');
    } catch (err) {
      console.warn('reconcileLedgerFromBroker fetch failed:', err instanceof Error ? err.message : err);
      return 0;
    }
    const { reconciled, changed } = applyFillsToLedger(this.ledger, orders, brokerService.name);
    if (changed > 0) this.ledger = reconciled;
    return changed;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Public hook that mirrors the broker's open positions into activeTrades.
   * Called by the price-socket loop before the market-closed early return so
   * the dashboard and the EOD-flatten retry path see the right state even
   * after a backend restart that lands outside regular hours.
   */
  async reconcileBrokerPositions(stocks: StockState[]): Promise<void> {
    await this.reconcileWithBroker(stocks);
  }

  /** Build a price map from Oracle stocks, falling back to broker positions
   *  for symbols Oracle isn't currently scraping. Adopted positions can fall
   *  off the Oracle watchlist; without this fallback their trailing stops
   *  would never advance.
   */
  private buildPriceMap(
    stocks: StockState[],
    positions: BrokerPosition[] | null,
  ): Map<string, number> {
    const priceMap = new Map<string, number>();
    for (const s of stocks) {
      if (s.currentPrice !== null && s.currentPrice !== undefined) {
        priceMap.set(s.symbol, s.currentPrice);
      }
    }
    if (positions) {
      for (const p of positions) {
        if (priceMap.has(p.symbol)) continue;
        if (Number.isFinite(p.currentPrice) && p.currentPrice > 0) {
          priceMap.set(p.symbol, p.currentPrice);
        }
      }
    }
    return priceMap;
  }

  async onPriceCycle(candidates: TradeCandidate[], stocks: StockState[], regime?: RegimeSnapshot): Promise<void> {
    await this.refreshWashSaleSymbols();
    const positions = await this.reconcileWithBroker(stocks);

    const account = await this.buildAccountState();
    const reservedSymbols = await this.getReservedSymbols();

    await this.checkPendingOrders();
    await this.cancelStaleOrders();
    await this.manageFilled(stocks, positions);
    if (!this.enabled) return;
    await this.evaluateNewEntries(candidates, account, reservedSymbols, regime);
  }

  /**
   * Adopt any broker positions that are not already tracked in activeTrades.
   * Protects against server restarts clearing the in-memory ledger while
   * positions remain at the broker. Uses the live Oracle watchlist for stop
   * and target where available; falls back to max_risk_pct-derived defaults.
   */
  private async reconcileWithBroker(stocks: StockState[]): Promise<BrokerPosition[] | null> {
    let positions;
    let openOrders;
    try {
      [positions, openOrders] = await Promise.all([
        brokerService.getPositions(),
        brokerService.getOpenOrders(),
      ]);
    } catch (err) {
      console.error('Reconcile failed:', err);
      return null;
    }
    // A position with an open sell order means a close is already in flight
    // (either submitted by us this cycle, or queued by the broker for the next
    // session). Adopting it here would clobber the in-flight exit and double-
    // book the symbol on the next entry cycle.
    const symbolsWithOpenSell = new Set(
      openOrders.filter((o) => o.side === 'sell').map((o) => o.symbol),
    );
    const stockMap = new Map(stocks.map((s) => [s.symbol, s]));
    const exec = config.execution;

    for (const pos of positions) {
      if (this.activeTrades.some((t) => t.symbol === pos.symbol)) continue;
      if (symbolsWithOpenSell.has(pos.symbol)) continue;

      const stock = stockMap.get(pos.symbol);
      const entry = pos.avgEntryPrice;
      // Cap the stop at max_risk_pct to protect against adopting positions with
      // absurdly wide Oracle stops (Oracle stops are designed for buy-zone entry,
      // not wherever-we-actually-filled entry).
      const maxRiskStop = entry * (1 - exec.max_risk_pct);
      const oracleStop =
        stock?.stopPrice && stock.stopPrice > 0 && stock.stopPrice < entry
          ? stock.stopPrice
          : null;
      // Use the tighter (higher) of the two stops.
      const initialStop = oracleStop !== null ? Math.max(oracleStop, maxRiskStop) : maxRiskStop;
      const target =
        stock?.sellZonePrice && stock.sellZonePrice > entry
          ? stock.sellZonePrice
          : entry * (1 + exec.max_risk_pct * 3);

      // Seed MFE from the current unrealized gain so positions adopted above
      // break-even immediately get the give-back lock applied on the next tick
      // (instead of resetting the peak to 0 and waiting for another run-up).
      const riskPerShare = entry - initialStop;
      const currentR =
        riskPerShare > 0 && pos.currentPrice > entry
          ? (pos.currentPrice - entry) / riskPerShare
          : 0;

      this.activeTrades.push({
        symbol: pos.symbol,
        strategy: 'momentum_continuation',
        entryPrice: entry,
        entryTime: new Date(),
        shares: pos.qty,
        initialStop,
        currentStop: initialStop,
        target,
        riskPerShare,
        orderId: '',
        status: 'filled',
        trailingState: 'initial',
        maxFavorableR: currentR,
        pendingSince: new Date(),
        rationale: [
          `Adopted orphaned broker position (original strategy unknown)`,
          oracleStop !== null && oracleStop > maxRiskStop
            ? `Stop = Oracle watchlist stopPrice ${oracleStop.toFixed(3)} (tighter than ${(exec.max_risk_pct * 100).toFixed(0)}% max-risk stop ${maxRiskStop.toFixed(3)})`
            : `Stop = ${(exec.max_risk_pct * 100).toFixed(0)}% max-risk cap ${maxRiskStop.toFixed(3)} (Oracle stop ${oracleStop?.toFixed(3) ?? 'n/a'} was too wide)`,
          `Target derived from ${stock?.sellZonePrice && stock.sellZonePrice > entry ? 'Oracle watchlist sellZonePrice' : '3R default'}`,
        ],
      });

      console.log(
        `Adopted orphaned position: ${pos.symbol} qty=${pos.qty} entry=${entry.toFixed(3)} ` +
          `stop=${initialStop.toFixed(3)} target=${target.toFixed(3)}`,
      );
    }
    return positions;
  }

  /**
   * Symbols that already have a position or open order at the broker.
   * Used to avoid placing duplicate orders after a bot restart or when
   * the in-process ledger has drifted from the broker's state.
   */
  private async getReservedSymbols(): Promise<Set<string>> {
    const reserved = new Set<string>();
    try {
      const [positions, openOrders] = await Promise.all([
        brokerService.getPositions(),
        brokerService.getOpenOrders(),
      ]);
      for (const p of positions) reserved.add(p.symbol);
      for (const o of openOrders) reserved.add(o.symbol);
    } catch (err) {
      console.error('Failed to fetch broker state for dup check:', err);
    }
    return reserved;
  }

  async flattenAll(): Promise<FlattenResult> {
    // Snapshot first — exitTrade mutates this.activeTrades on success, so
    // iterating the live array would skip elements as it shrinks.
    const targets = [...this.activeTrades];
    const succeeded: string[] = [];
    const failed: Array<{ symbol: string; error: string }> = [];
    for (const trade of targets) {
      const result = await this.exitTrade(trade, trade.entryPrice, 'eod', 'Manual flatten or EOD close');
      if (result.ok) {
        succeeded.push(trade.symbol);
      } else {
        failed.push({ symbol: trade.symbol, error: result.error ?? 'unknown error' });
      }
    }
    try {
      await brokerService.closeAllPositions();
    } catch {
      // best effort
    }
    // NOTE: do NOT unconditionally clear activeTrades here. exitTrade already
    // removes successfully-closed trades; trades whose closePosition was
    // rejected by the broker (e.g. PDT cap) MUST stay in activeTrades so the
    // next cycle retries. Wiping the list here would re-create the loop where
    // reconcileWithBroker then re-adopts the still-open positions.

    // The exitTrade calls above stamped placeholder exit prices equal to
    // entryPrice. The broker needs a moment to fill the closing market orders;
    // then we rewrite the ledger rows with the real fill prices.
    if (succeeded.length > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      try {
        const changed = await this.reconcileLedgerFromBroker(start);
        if (changed > 0) console.log(`Reconciled ${changed} flatten exit(s) from broker fills`);
      } catch (err) {
        console.warn('Post-flatten reconciliation failed:', err instanceof Error ? err.message : err);
      }
    }

    return { requested: targets.length, succeeded, failed };
  }

  private async buildAccountState(): Promise<AccountState> {
    const account = await brokerService.getAccount();
    const positions = await brokerService.getPositions();

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
      // Phase 3: surface settled-cash and cash-account flag so tradeFilterService
      // can avoid free-riding violations on cash accounts. Margin adapters set
      // settledCash === cash and isCashAccount === false, preserving prior sizing.
      settledCash: account.settledCash,
      isCashAccount: brokerService.isCashAccount,
    };
  }

  private async evaluateNewEntries(
    candidates: TradeCandidate[],
    account: AccountState,
    reservedSymbols: Set<string>,
    regime?: RegimeSnapshot,
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
      if (this.isOnCooldown(candidate.symbol)) {
        const expires = this.cooldown.get(candidate.symbol) ?? 0;
        const mins = Math.round((expires - Date.now()) / 60000);
        this.recordRejection(candidate, `cooldown: re-entry blocked for ~${mins}m after prior stop exit`);
        continue;
      }
      if (candidate.suggestedEntry <= 0 || candidate.suggestedStop <= 0) {
        this.recordRejection(candidate, 'missing suggested entry/stop');
        continue;
      }

      // Higher bar for symbols traded in the last N days (wash-sale awareness).
      // These trades get entered only if the setup is high-conviction.
      if (this.isWashSaleRisk(candidate.symbol)) {
        const wsFail = this.checkWashSaleBar(candidate);
        if (wsFail) {
          this.recordRejection(candidate, wsFail);
          continue;
        }
      }

      const filterResult = tradeFilterService.filterCandidate(candidate, account, regime);
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

      const useLimit =
        candidate.setup === 'red_candle_theory' || candidate.setup === 'momentum_continuation';
      // SubmitOrderParams is a discriminated union — limitPrice is required
      // for limit orders and not allowed on market orders, so we branch.
      const orderParams = useLimit
        ? {
            symbol: candidate.symbol,
            qty: size.shares,
            side: 'buy' as const,
            type: 'limit' as const,
            limitPrice: candidate.suggestedEntry,
          }
        : {
            symbol: candidate.symbol,
            qty: size.shares,
            side: 'buy' as const,
            type: 'market' as const,
          };

      try {
        const order = await brokerService.submitOrder(orderParams);

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
          maxFavorableR: 0,
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
        const order = await brokerService.getOrder(trade.orderId);
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
          await brokerService.cancelOrder(trade.orderId);
        } catch {
          // best effort
        }
        this.activeTrades = this.activeTrades.filter(t => t !== trade);
      }
    }
  }

  private async manageFilled(
    stocks: StockState[],
    positions: BrokerPosition[] | null,
  ): Promise<void> {
    const priceMap = this.buildPriceMap(stocks, positions);
    const exec = config.execution;

    for (const trade of [...this.activeTrades]) {
      if (trade.status !== 'filled') continue;

      // Self-correct: clamp currentStop upward to the max-risk cap. This fixes
      // trades that were adopted or entered before the cap was enforced.
      const maxRiskStop = trade.entryPrice * (1 - exec.max_risk_pct);
      if (trade.currentStop < maxRiskStop && trade.entryPrice > 0) {
        const oldStop = trade.currentStop;
        trade.currentStop = maxRiskStop;
        trade.initialStop = Math.max(trade.initialStop, maxRiskStop);
        trade.riskPerShare = trade.entryPrice - trade.initialStop;
        console.log(
          `Tightened stop on ${trade.symbol}: ${oldStop.toFixed(3)} -> ${maxRiskStop.toFixed(3)} (max-risk cap)`,
        );
      }

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

      // Track max favorable excursion so the give-back stop is ratcheted by
      // the peak, not the current price.
      if (rMultiple > trade.maxFavorableR) trade.maxFavorableR = rMultiple;

      // MFE give-back lock: once the trade has printed at least
      // trailing_mfe_activate_r of unrealized gain, pull the stop up so we
      // give back at most trailing_mfe_giveback_pct of the peak. This fires
      // well below the 1R breakeven tier and captures fades from <1R peaks.
      if (trade.maxFavorableR >= exec.trailing_mfe_activate_r && trade.riskPerShare > 0) {
        const lockedR = trade.maxFavorableR * (1 - exec.trailing_mfe_giveback_pct);
        const mfeStop = trade.entryPrice + lockedR * trade.riskPerShare;
        if (mfeStop > trade.currentStop) {
          trade.currentStop = mfeStop;
          if (trade.trailingState !== 'trailing') trade.trailingState = 'mfe_lock';
        }
      }

      if (rMultiple >= exec.trailing_start_r) {
        const newStop = currentPrice - exec.trailing_distance_r * trade.riskPerShare;
        trade.currentStop = Math.max(trade.currentStop, newStop);
        trade.trailingState = 'trailing';
      } else if (rMultiple >= exec.trailing_breakeven_r) {
        trade.currentStop = Math.max(trade.currentStop, trade.entryPrice);
        // Only adopt the 'breakeven' label if the entry-price stop is actually
        // the binding level. If MFE has already pulled the stop above entry,
        // keep the 'mfe_lock' marker so the UI accurately reflects the locked
        // gain rather than implying the trade is back to flat.
        if (trade.trailingState !== 'trailing' && trade.currentStop <= trade.entryPrice) {
          trade.trailingState = 'breakeven';
        }
      }
    }
  }

  private async exitTrade(
    trade: ActiveTrade,
    exitPrice: number,
    reason: TradeLedgerEntry['exitReason'],
    detail: string = ''
  ): Promise<{ ok: boolean; error?: string }> {
    const previousStatus = trade.status;
    trade.status = 'exiting';
    try {
      await brokerService.closePosition(trade.symbol);
    } catch (err) {
      // The broker rejected the close (e.g. PDT cap, position locked, market closed
      // for an OTC name). Do NOT push a ledger entry or remove from activeTrades
      // — the position is still open at the broker. Revert status so the next
      // cycle retries via the same trigger (price still below stop, EOD flatten,
      // etc.). Without this, `flattenAll` would pile up phantom ledger entries
      // every 30 s while reconcileWithBroker re-adopts the unsold position.
      trade.status = previousStatus;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to close ${trade.symbol} (reason=${reason}): ${msg}. ` +
          `Position remains open; will retry next cycle.`,
      );
      return { ok: false, error: msg };
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
      riskPerShare: trade.riskPerShare,
      pnl,
      pnlPct,
      rMultiple,
      exitReason: reason,
      exitDetail: detail || this.defaultExitDetail(reason),
      rationale: trade.rationale,
    });

    // Block same-session re-entries after bad exits to prevent churn.
    if (reason === 'stop' || reason === 'trailing_stop' || reason === 'circuit_breaker') {
      const cooldownMs = config.execution.cooldown_after_stop_ms;
      if (cooldownMs > 0) {
        this.cooldown.set(trade.symbol, Date.now() + cooldownMs);
      }
    }

    this.activeTrades = this.activeTrades.filter(t => t !== trade);
    return { ok: true };
  }

  /**
   * Returns null if the wash-sale-aware tighter bar is met, otherwise a
   * human-readable reason string.
   */
  private checkWashSaleBar(candidate: TradeCandidate): string | null {
    const exec = config.execution;
    const entry = candidate.suggestedEntry;
    const stop = candidate.suggestedStop;
    const target = candidate.suggestedTarget;
    const buyZone = candidate.snapshot.buyZonePrice;

    if (candidate.score < exec.wash_sale_min_score) {
      return `wash-sale risk: score ${candidate.score.toFixed(0)} < required ${exec.wash_sale_min_score}`;
    }

    const risk = entry - stop;
    const reward = target - entry;
    if (risk <= 0) return 'wash-sale risk: risk <= 0';
    const rr = reward / risk;
    if (rr < exec.wash_sale_min_rr) {
      return `wash-sale risk: R:R ${rr.toFixed(1)} < required ${exec.wash_sale_min_rr.toFixed(1)}`;
    }

    if (exec.wash_sale_require_no_chase && buyZone && entry > buyZone) {
      const chase = ((entry - buyZone) / buyZone) * 100;
      return `wash-sale risk: chasing ${chase.toFixed(1)}% above buy zone (must be at or below)`;
    }

    return null;
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
