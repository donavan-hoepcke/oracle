import { config } from '../config.js';
import { toZonedTime } from 'date-fns-tz';
import { brokerService } from './brokers/index.js';
import type { BrokerOrder, BrokerPosition } from '../types/broker.js';
import { tradeFilterService, AccountState } from './tradeFilterService.js';
import { TradeCandidate, CandidateSetup } from './ruleEngineService.js';
import { StockState } from '../websocket/priceSocket.js';
import type { RegimeSnapshot } from './regimeService.js';
import { appendLedgerEntry } from './ledgerStore.js';

/**
 * Detect Alpaca's pattern-day-trader rejection. Match on either the
 * documented error code (40310100) or the human-readable phrase to be
 * defensive against adapter wrapping or formatting changes. Exported
 * for testability.
 */
export function isPdtError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (msg.includes('40310100')) return true;
  return /pattern day trad(?:er|ing)/i.test(msg);
}

/** ET trading-day key used to scope the PDT circuit breaker. */
function todayInET(): string {
  const z = toZonedTime(new Date(), config.market_hours?.timezone || 'America/New_York');
  const y = z.getFullYear();
  const m = String(z.getMonth() + 1).padStart(2, '0');
  const d = String(z.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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
  /**
   * Broker handles for the bracket exit legs. When the entry is submitted
   * via `submitBracketOrder`, these are populated and the broker manages
   * exits server-side as an OCO pair — when one fills the other auto-
   * cancels. tighten_stop replaces stopOrderId in-place; on legacy
   * non-bracketed entries these are null and the bot manages exits in
   * the polling loop instead.
   */
  targetOrderId: string | null;
  stopOrderId: string | null;
  /**
   * Last stop price we successfully wrote to the broker. Tracked
   * separately from `currentStop` so trailing-stop replacement is
   * monotonic AND idempotent: if a ratchet succeeds in memory but the
   * subsequent broker write fails, the next cycle still tries the
   * replacement. Initialized to `initialStop` for new bracketed trades;
   * unused (-Infinity sentinel) for non-bracketed legacy/adopted
   * positions where the broker doesn't hold an active stop leg.
   */
  lastBrokerStop: number;
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
  // Set to today's ET date when Alpaca returns a PDT (pattern day trader)
  // rejection. While this is set for the current trading day we skip the
  // submit path entirely — every potential day-trade would be rejected
  // the same way and looping just spams the log every cycle. Cleared
  // automatically on the next session day. Cash account vs margin
  // doesn't matter to PDT — the rule applies to any account ≤ $25k that
  // would round-trip a position the same day.
  private pdtBlockedDay: string | null = null;

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
  /**
   * Single chokepoint for adding a closed trade to the in-memory ledger AND
   * persisting it eagerly to disk. Eager persistence closes the 30-second
   * window where a close lives in memory only — `recordingService.writeCycle`
   * runs on the next polling tick, so a process restart between close and
   * write would otherwise lose the entry. Hydration on startup reads the
   * eager log first, so anything written here survives a restart.
   */
  private recordClosedTrade(entry: TradeLedgerEntry): void {
    this.ledger.push(entry);
    try {
      appendLedgerEntry(entry);
    } catch (err) {
      // Eager persistence failures must not break the trade lifecycle:
      // the in-memory ledger is still authoritative for this session, and
      // the next cycle's writeCycle is the backstop. Log loud so an
      // operator can investigate (typically: disk full, permissions).
      console.error(
        `Failed to eagerly persist ledger entry for ${entry.symbol}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

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

  async onPriceCycle(
    candidates: TradeCandidate[],
    stocks: StockState[],
    regime?: RegimeSnapshot,
    session: 'pre' | 'rth' | 'post' | 'closed' = 'rth',
  ): Promise<void> {
    await this.refreshWashSaleSymbols();
    const positions = await this.reconcileWithBroker(stocks);

    const account = await this.buildAccountState();
    const reservedSymbols = await this.getReservedSymbols();

    await this.checkPendingOrders();
    await this.cancelStaleOrders();
    await this.manageFilled(stocks, positions);
    if (!this.enabled) return;
    await this.evaluateNewEntries(candidates, account, reservedSymbols, regime, session);
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

    // Step 1: detect closes the broker performed without us — bracket OCO
    // legs firing server-side, manual liquidations on the broker's web UI,
    // or any other path that bypasses `exitTrade`. Without this, the bot
    // happily ratchets a trailing stop on a position that no longer exists.
    // Runs BEFORE adoption so a closed-then-re-adopted symbol is logged
    // with its real fill price, not as an orphan.
    await this.detectBrokerDrivenCloses(positions, openOrders);

    // Step 1b: detect round-trips that completed entirely outside the bot's
    // visibility — a buy and matching sell that both filled while the bot
    // was restarting (or before this cycle's `detectBrokerDrivenCloses`
    // had the trade in activeTrades). Without this, brackets that fire
    // mid-restart leave no ledger trace at all.
    await this.detectOrphanedRoundTrips();

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
        // Adopted orphans don't have known bracket-leg ids — bot manages
        // exits in the polling loop instead. Future: attempt to find
        // existing target/stop orders for this symbol via getOpenOrders
        // and adopt them too.
        targetOrderId: null,
        stopOrderId: null,
        // Sentinel meaning "no broker leg to track". Trailing-stop
        // replacement is gated on `stopOrderId` truthiness so this
        // value is never read for adopted trades — kept consistent
        // with the type for clarity.
        lastBrokerStop: -Infinity,
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
   * Detect activeTrades that the broker has already exited (bracket OCO
   * firing, manual UI liquidation, or any path that bypassed `exitTrade`)
   * and turn them into real ledger entries. Runs once per cycle.
   *
   * Three outcomes per activeTrade:
   *   - Broker has the position at full size → leave alone (managed normally)
   *   - Broker has fewer shares than we think → downsize the activeTrade
   *     (partial fill on a bracket leg). v1 doesn't write a partial-close
   *     ledger entry; partials are rare and the next full close captures
   *     the residual P&L.
   *   - Broker has no position AND no open buy → close it. We look up the
   *     sell fill via getOrdersSince, build a TradeLedgerEntry from the
   *     real fill price/time, and remove the trade from activeTrades.
   *     If no sell fill is visible yet (close just happened, broker
   *     hasn't surfaced it), skip and retry next cycle.
   */
  /**
   * Find round-trips (buy + matching sell) that completed entirely outside
   * the bot's in-memory state — typically because the bot was restarting
   * while a bracketed trade ran its full course.
   *
   * Strategy: pull today's filled orders, group by symbol, pair each buy
   * with the soonest later sell of equal qty. For each pair the bot has
   * neither an activeTrade nor a ledger entry for (keyed on the buy's
   * filledAt), synthesize a TradeLedgerEntry using the real fill prices
   * and route through recordClosedTrade so it lands in both the in-memory
   * ledger and the eager-write JSONL.
   *
   * Filter: only consider buy orders whose `orderClass === 'bracket'`.
   * The bot only ever submits bracket entries, so this excludes manual
   * trades the operator placed via the broker's UI from being attributed
   * to the bot. (Adapters that don't surface orderClass leave the field
   * undefined; those orders are skipped.)
   */
  private async detectOrphanedRoundTrips(): Promise<void> {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    let orders: BrokerOrder[];
    try {
      orders = await brokerService.getOrdersSince(dayStart.toISOString(), 'closed');
    } catch (err) {
      console.warn(
        `detectOrphanedRoundTrips: getOrdersSince failed: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    const filled = orders.filter(
      (o) => o.status === 'filled' && o.filledAvgPrice !== null && o.filledAt !== null && o.filledQty !== null,
    );

    // Group fills by symbol. Sort each group ascending by fill time so a
    // buy is paired with the earliest subsequent sell.
    const bySymbol = new Map<string, BrokerOrder[]>();
    for (const o of filled) {
      const arr = bySymbol.get(o.symbol) ?? [];
      arr.push(o);
      bySymbol.set(o.symbol, arr);
    }
    for (const arr of bySymbol.values()) {
      arr.sort((a, b) => new Date(a.filledAt as string).getTime() - new Date(b.filledAt as string).getTime());
    }

    // Build the existing-ledger key set so we don't double-attribute. We
    // key on symbol+entryTime since that's what hydrateLedger dedupes on.
    const ledgerKeys = new Set(
      this.ledger.map((e) => `${e.symbol}|${new Date(e.entryTime).toISOString()}`),
    );
    const activeSymbols = new Set(this.activeTrades.map((t) => t.symbol));

    for (const [symbol, fills] of bySymbol) {
      // Active trades for a symbol are tracked elsewhere — leave alone so
      // detectBrokerDrivenCloses doesn't fight us.
      if (activeSymbols.has(symbol)) continue;

      const claimedSellIds = new Set<string>();
      for (const buy of fills) {
        if (buy.side !== 'buy') continue;
        // Only attribute trades the bot would have placed. Bracket entries
        // are the bot's only submission path today; anything else (a manual
        // simple market order from the operator's web UI) gets skipped.
        if (buy.orderClass !== 'bracket') continue;

        const buyTime = new Date(buy.filledAt as string).toISOString();
        const key = `${symbol}|${buyTime}`;
        if (ledgerKeys.has(key)) continue;

        // Find the earliest sell after this buy with matching qty.
        const buyQty = buy.filledQty as number;
        const sell = fills.find(
          (o) =>
            o.side === 'sell' &&
            !claimedSellIds.has(o.id) &&
            (o.filledAt as string) > (buy.filledAt as string) &&
            Math.abs((o.filledQty ?? 0) - buyQty) < 0.01,
        );
        if (!sell || sell.filledAvgPrice === null) {
          // Buy without a matching sell — position is presumably still
          // open at the broker, so leave it for `reconcileWithBroker` to
          // adopt rather than synthesizing a half-trade here.
          continue;
        }

        claimedSellIds.add(sell.id);
        ledgerKeys.add(key);

        const entryPrice = buy.filledAvgPrice as number;
        const exitPrice = sell.filledAvgPrice;
        const shares = buyQty;
        const pnl = (exitPrice - entryPrice) * shares;
        const pnlPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
        // No risk reference for orphans (entry-time stop is unknown), so
        // riskPerShare and rMultiple stay 0 — the journal still has the
        // raw $ P&L for these.
        this.recordClosedTrade({
          symbol,
          strategy: 'momentum_continuation',
          entryPrice,
          entryTime: new Date(buy.filledAt as string),
          exitPrice,
          exitTime: new Date(sell.filledAt as string),
          shares,
          riskPerShare: 0,
          pnl,
          pnlPct,
          rMultiple: 0,
          exitReason: 'eod',
          exitDetail: `Orphaned round-trip reconciled from broker history (buy ${buy.id}, sell ${sell.id})`,
          rationale: ['Round-trip completed outside bot visibility (likely across a process restart)'],
        });

        console.log(
          `[reconcile] orphan round-trip ${symbol} ${shares}@${entryPrice.toFixed(3)} -> ${exitPrice.toFixed(3)} pnl=${pnl.toFixed(2)}`,
        );
      }
    }
  }

  private async detectBrokerDrivenCloses(
    positions: BrokerPosition[],
    openOrders: BrokerOrder[],
  ): Promise<void> {
    const positionMap = new Map(positions.map((p) => [p.symbol, p]));
    const symbolsWithOpenBuy = new Set(
      openOrders.filter((o) => o.side === 'buy').map((o) => o.symbol),
    );

    // Cache sell-fills lookup across all close-candidates this cycle.
    // getOrdersSince returns up to 500 closed orders; one fetch covers
    // every activeTrade, instead of one fetch per trade.
    let sellFills: BrokerOrder[] | null = null;
    const fetchSellFills = async (): Promise<BrokerOrder[]> => {
      if (sellFills !== null) return sellFills;
      const earliestEntry = this.activeTrades
        .filter((t) => t.status === 'filled')
        .reduce<Date | null>((acc, t) => (!acc || t.entryTime < acc ? t.entryTime : acc), null);
      if (!earliestEntry) {
        sellFills = [];
        return sellFills;
      }
      try {
        const orders = await brokerService.getOrdersSince(
          earliestEntry.toISOString(),
          'closed',
        );
        sellFills = orders.filter(
          (o) => o.side === 'sell' && o.status === 'filled' && o.filledAvgPrice !== null,
        );
      } catch (err) {
        console.warn(
          `detectBrokerDrivenCloses: getOrdersSince failed: ${err instanceof Error ? err.message : err}`,
        );
        sellFills = [];
      }
      return sellFills;
    };

    // Sell fills already attributed to ledger entries earlier in the
    // session shouldn't be re-claimed here. Build a claim set keyed on
    // the broker's order id when ledger entries carry it (existing
    // entries do not; this is purely a guard for future-claimed fills
    // discovered later in the same scan).
    const claimedFillIds = new Set<string>();

    // Iterate a snapshot — we mutate activeTrades mid-loop.
    for (const trade of [...this.activeTrades]) {
      if (trade.status !== 'filled') continue;
      const pos = positionMap.get(trade.symbol);

      // Partial close: broker has fewer shares than we think. Downsize
      // and continue managing the residual.
      if (pos && pos.qty > 0 && pos.qty < trade.shares) {
        console.log(
          `[reconcile] downsizing ${trade.symbol} ${trade.shares} → ${pos.qty} (broker partial close)`,
        );
        trade.shares = pos.qty;
        continue;
      }

      // Full match — managed normally.
      if (pos && pos.qty >= trade.shares) continue;

      // Position is gone (or the bot never owned it). If a buy is still
      // open, this is just an entry that hasn't filled — leave it alone.
      if (symbolsWithOpenBuy.has(trade.symbol)) continue;

      const fills = await fetchSellFills();
      const match = fills.find(
        (o) =>
          o.symbol === trade.symbol &&
          !claimedFillIds.has(o.id) &&
          o.filledAt !== null &&
          new Date(o.filledAt) >= trade.entryTime &&
          // Allow ±0.01 share tolerance for fractional rounding; broker
          // qty reports vary on penny-stock fills.
          Math.abs((o.filledQty ?? 0) - trade.shares) < 0.01,
      );

      if (!match || match.filledAvgPrice === null || match.filledAt === null) {
        // Sell fill not yet visible — could be the broker hasn't surfaced
        // it (just-fired bracket leg), or this trade never filled at the
        // broker in the first place (stale phantom). Either way, we
        // retry next cycle. After 3 cycles with no fill we'd want to
        // surface a "needs human" flag — see the ops-monitor design.
        continue;
      }

      claimedFillIds.add(match.id);

      const exitPrice = match.filledAvgPrice;
      const exitTime = new Date(match.filledAt);
      const pnl = (exitPrice - trade.entryPrice) * trade.shares;
      const pnlPct =
        trade.entryPrice > 0 ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100 : 0;
      const rMultiple =
        trade.riskPerShare > 0 ? (exitPrice - trade.entryPrice) / trade.riskPerShare : 0;
      // Conservative reason mapping: if the trade had a stop leg at the
      // broker AND price was at-or-below the stop level, call it a
      // trailing_stop exit; otherwise call it 'eod'. We don't have
      // enough info from a sell-fill alone to know the exact trigger.
      const looksLikeStopHit = !!trade.stopOrderId && exitPrice <= trade.currentStop * 1.001;
      const reason: TradeLedgerEntry['exitReason'] = looksLikeStopHit
        ? 'trailing_stop'
        : 'eod';

      this.recordClosedTrade({
        symbol: trade.symbol,
        strategy: trade.strategy,
        entryPrice: trade.entryPrice,
        entryTime: trade.entryTime,
        exitPrice,
        exitTime,
        shares: trade.shares,
        riskPerShare: trade.riskPerShare,
        pnl,
        pnlPct,
        rMultiple,
        exitReason: reason,
        exitDetail: `Broker-driven close detected via reconcile (matched ${match.id})`,
        rationale: trade.rationale,
      });

      this.activeTrades = this.activeTrades.filter((t) => t !== trade);
      console.log(
        `[reconcile] closed ${trade.symbol} from broker fill: exit=${exitPrice.toFixed(3)} pnl=${pnl.toFixed(2)} reason=${reason}`,
      );
    }
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
    session: 'pre' | 'rth' | 'post' | 'closed' = 'rth',
  ): Promise<void> {
    // Rebuild rejection map each cycle so stale entries clear naturally.
    const currentCandidateSymbols = new Set(candidates.map((c) => c.symbol));
    for (const symbol of Array.from(this.rejections.keys())) {
      if (!currentCandidateSymbols.has(symbol)) this.rejections.delete(symbol);
    }

    // PDT circuit-breaker: once Alpaca has returned a PDT rejection this
    // trading day, every other day-trade attempt will fail identically.
    // Short-circuit and tag remaining candidates with a structured
    // rejection so the bot/UI can see WHY nothing's getting submitted.
    // Auto-clears at the next ET trading-day boundary (next call sees
    // todayInET() return a new string).
    const today = todayInET();
    if (this.pdtBlockedDay === today) {
      for (const candidate of candidates) {
        if (this.activeTrades.some((t) => t.symbol === candidate.symbol)) continue;
        this.recordRejection(
          candidate,
          'PDT protection (account < $25k, day-trades blocked for the rest of today)',
        );
      }
      return;
    }
    if (this.pdtBlockedDay && this.pdtBlockedDay !== today) {
      // Day rolled — clear so today gets a fresh chance.
      this.pdtBlockedDay = null;
    }

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
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

      let size = tradeFilterService.calculatePositionSize(candidate, account);
      if (size.shares <= 0) {
        this.recordRejection(candidate, size.zeroReason ?? 'position size rounded to 0 shares');
        continue;
      }

      // Ext-hours scaling: cap position size at size_cap_pct of normal
      // and widen the entry-time stop by stop_buffer_pct of risk to
      // absorb thin-session slippage. RTH path is unchanged.
      const isExt = session === 'pre' || session === 'post';
      const extCfg = config.execution.extended_hours;
      let workingStop = candidate.suggestedStop;
      if (isExt) {
        const cappedShares = Math.floor(size.shares * extCfg.size_cap_pct);
        if (cappedShares <= 0) {
          this.recordRejection(candidate, `ext-hours size cap rounded to 0 shares`);
          continue;
        }
        const cappedCost = size.costBasis * (cappedShares / size.shares);
        size = { shares: cappedShares, costBasis: cappedCost };
        // Widen the stop further from entry by stop_buffer_pct of the
        // original risk distance. For a long, that means a lower stop.
        const riskDist = candidate.suggestedEntry - candidate.suggestedStop;
        if (riskDist > 0) {
          workingStop = candidate.suggestedStop - riskDist * extCfg.stop_buffer_pct;
        }
      }

      this.rejections.delete(candidate.symbol);

      try {
        if (isExt) {
          // Ext-hours path: simple limit (Alpaca rejects market + bracket
          // outside RTH). Bot manages stop/target in-process via
          // manageFilled's legacy path — gated on null bracket-leg ids.
          const entry = await brokerService.submitOrder({
            symbol: candidate.symbol,
            qty: size.shares,
            side: 'buy',
            type: 'limit',
            limitPrice: candidate.suggestedEntry,
            extendedHours: true,
          });
          this.activeTrades.push({
            symbol: candidate.symbol,
            strategy: candidate.setup,
            entryPrice: candidate.suggestedEntry,
            entryTime: new Date(),
            shares: size.shares,
            initialStop: workingStop,
            currentStop: workingStop,
            target: candidate.suggestedTarget,
            riskPerShare: candidate.suggestedEntry - workingStop,
            orderId: entry.id,
            // Empty bracket-leg ids → manageFilled runs the in-process
            // exit path (matches adopted-orphan trades).
            targetOrderId: null,
            stopOrderId: null,
            lastBrokerStop: -Infinity,
            status: 'pending',
            trailingState: 'initial',
            maxFavorableR: 0,
            pendingSince: new Date(),
            rationale: [
              ...candidate.rationale,
              `Score ${candidate.score.toFixed(0)} | ${candidate.setup}`,
              `Ext-hours ${session} entry: ${(extCfg.size_cap_pct * 100).toFixed(0)}% size, +${(extCfg.stop_buffer_pct * 100).toFixed(0)}% stop buffer`,
            ],
          });
        } else {
          // RTH path: bracket OCO entry. Broker holds target+stop legs
          // server-side so a bot crash after entry still has the exits
          // queued. tighten_stop later replaces just the stop leg.
          const useLimit =
            candidate.setup === 'red_candle_theory' || candidate.setup === 'momentum_continuation';
          const bracket = await brokerService.submitBracketOrder({
            symbol: candidate.symbol,
            qty: size.shares,
            side: 'buy',
            type: useLimit ? 'limit' : 'market',
            entryLimitPrice: useLimit ? candidate.suggestedEntry : undefined,
            targetPrice: candidate.suggestedTarget,
            stopPrice: candidate.suggestedStop,
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
            orderId: bracket.entry.id,
            targetOrderId: bracket.target.id,
            stopOrderId: bracket.stop.id,
            // Broker stop leg starts at the entry-time stop. Trailing-stop
            // replacement (manageFilled) will advance this monotonically.
            lastBrokerStop: candidate.suggestedStop,
            status: 'pending',
            trailingState: 'initial',
            maxFavorableR: 0,
            pendingSince: new Date(),
            rationale: [...candidate.rationale, `Score ${candidate.score.toFixed(0)} | ${candidate.setup}`],
          });
        }

        account.openPositionCount++;
        account.deployedCapital += size.costBasis;
        reservedSymbols.add(candidate.symbol);
      } catch (err) {
        // Detect Alpaca's PDT (pattern day trader) rejection as a
        // structured rejection rather than a stack-trace log every
        // cycle. The error code is 40310100; we match on either the
        // code or the human-readable phrase to be defensive against
        // adapter wrapping. Once tripped, set a session-level circuit
        // breaker so subsequent candidates this trading day are dropped
        // up front (same outcome, less log spam, clearer rejection
        // panel for the bot/UI to surface).
        if (isPdtError(err)) {
          this.recordRejection(
            candidate,
            'PDT protection (account < $25k, day-trade blocked by Alpaca)',
          );
          this.pdtBlockedDay = todayInET();
          console.warn(
            `[execution] PDT block tripped for ${candidate.symbol} — suppressing further entries today (${this.pdtBlockedDay})`,
          );
          // Tag the remaining candidates in this cycle so the bot/UI
          // sees them as PDT-blocked instead of "evaluating". Subsequent
          // cycles short-circuit at the top of evaluateNewEntries.
          for (let j = i + 1; j < candidates.length; j++) {
            const remaining = candidates[j];
            if (this.activeTrades.some((t) => t.symbol === remaining.symbol)) continue;
            this.recordRejection(
              remaining,
              'PDT protection (account < $25k, day-trades blocked for the rest of today)',
            );
          }
          break;
        }
        console.error(`Failed to submit order for ${candidate.symbol}:`, err);
      }
    }
  }

  private async checkPendingOrders(): Promise<void> {
    for (const trade of this.activeTrades) {
      if (trade.status !== 'pending') continue;
      try {
        const order = await brokerService.getOrder(trade.orderId);
        // Treat 'partial' the same as 'filled' for the pending→filled
        // transition: any qty actually filled means the bot is now long
        // and needs to manage the position. The remaining quantity may
        // still fill on subsequent polls — `shares` tracks the actual
        // filled amount, so trailing-stop math uses the right size.
        if (order.status === 'filled' || order.status === 'partial') {
          trade.status = 'filled';
          if (order.filledAvgPrice) trade.entryPrice = order.filledAvgPrice;
          if (order.filledQty) trade.shares = order.filledQty;
          trade.riskPerShare = trade.entryPrice - trade.initialStop;
        } else if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'rejected') {
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

      // Bracketed trades: the broker holds an OCO exit pair (target +
      // stop) server-side. The bot must NOT also issue a closePosition
      // when price triggers — that would race with the broker's leg
      // and could result in two sells (the bot's market order plus the
      // broker's limit/stop fill). Trust the broker for terminal exits;
      // the bot still manages trailing-stop ratcheting (see below) by
      // replacing the broker's stop leg in place.
      // Empty-string ids count as "no bracket leg" the same as null —
      // adopted positions and synthesized fixtures both use that
      // sentinel.
      const isBracketed = !!trade.stopOrderId;
      if (!isBracketed) {
        // Legacy path: no broker-side legs (e.g. adopted orphan
        // positions, or pre-Phase-2 trades). The bot owns exit
        // execution.
        if (currentPrice <= trade.currentStop) {
          const reason = trade.trailingState !== 'initial' ? 'trailing_stop' : 'stop';
          const detail = reason === 'trailing_stop'
            ? `Price ${currentPrice.toFixed(3)} crossed trailing stop ${trade.currentStop.toFixed(3)} (state=${trade.trailingState})`
            : `Price ${currentPrice.toFixed(3)} crossed initial stop ${trade.currentStop.toFixed(3)}`;
          await this.exitTrade(trade, currentPrice, reason, detail);
          continue;
        }
        if (currentPrice >= trade.target) {
          const detail = `Price ${currentPrice.toFixed(3)} reached target ${trade.target.toFixed(3)}`;
          await this.exitTrade(trade, currentPrice, 'target', detail);
          continue;
        }
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

      // Phase 2.5: when in-memory `currentStop` ratchets up on a
      // bracketed trade, push the change to the broker so the OCO leg
      // protects the new (tighter) level. Failure here is logged but
      // does NOT roll back the in-memory ratchet — the next cycle
      // will retry the replacement, and worst case the bot's view of
      // its risk is tighter than the broker's (graceful degradation,
      // not double exposure).
      //
      // The retry-friendly gate is `currentStop > lastBrokerStop`
      // alone — NOT `currentStop > stopBefore`. After a failed
      // replaceStopLeg the in-cycle ratchet already happened on a
      // prior tick; stopBefore on this tick equals currentStop, so a
      // stopBefore-based gate would skip the retry forever. The
      // lastBrokerStop comparison correctly identifies "broker doesn't
      // have the latest stop yet" without needing same-cycle motion.
      if (
        isBracketed &&
        trade.stopOrderId &&
        trade.currentStop > trade.lastBrokerStop
      ) {
        const stopId = trade.stopOrderId;
        const newPrice = trade.currentStop;
        try {
          const replacedId = await brokerService.replaceStopLeg(stopId, newPrice);
          // Some adapters return a new id (cancel+resubmit semantics).
          // Track it so subsequent ratchets address the right leg.
          trade.stopOrderId = replacedId;
          trade.lastBrokerStop = newPrice;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[bracket trailing] ${trade.symbol}: replaceStopLeg ` +
              `${stopId}→${newPrice.toFixed(3)} failed: ${msg}. ` +
              `In-memory stop is ${trade.currentStop.toFixed(3)}; broker leg unchanged. ` +
              `Will retry next cycle.`,
          );
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
      // Bracketed trades have target+stop legs sitting at the broker as
      // an OCO pair. closePosition submits a market sell, which would
      // cross the bracket — but until those legs see the position go
      // to 0, the broker can still fire one of them. Cancel both legs
      // FIRST so the close is the only sell in flight; otherwise we
      // can end up short the position when the bracket fires after the
      // close already filled. Best-effort: cancel failures (legs
      // already filled, already cancelled) are logged and ignored.
      // truthy guard catches both null and the empty-string sentinel
      // used by adopted-position fixtures.
      const targetId = trade.targetOrderId;
      if (targetId) {
        await brokerService.cancelOrder(targetId).catch((e) => {
          console.warn(
            `[exit] failed to cancel target leg ${targetId} for ` +
              `${trade.symbol}: ${e instanceof Error ? e.message : e}`,
          );
        });
      }
      const stopId = trade.stopOrderId;
      if (stopId) {
        await brokerService.cancelOrder(stopId).catch((e) => {
          console.warn(
            `[exit] failed to cancel stop leg ${stopId} for ` +
              `${trade.symbol}: ${e instanceof Error ? e.message : e}`,
          );
        });
      }
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

    this.recordClosedTrade({
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
