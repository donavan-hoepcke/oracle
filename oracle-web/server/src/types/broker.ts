/**
 * Broker-neutral types and the BrokerAdapter interface that all concrete
 * broker integrations implement. Downstream services (executionService,
 * tradeReconciliationService, journal/scanner endpoints) depend only on
 * this module — never on a specific broker SDK.
 *
 * Phase 1 of the broker-adapter migration matches the existing Alpaca
 * surface exactly; Phase 2 (IBKR) extends with status normalization and
 * cash-account settlement awareness.
 */

export interface BrokerAccount {
  cash: number;
  portfolioValue: number;
  buyingPower: number;
  /**
   * Cash that has settled (T+1) and is freely deployable on a cash account.
   * Margin adapters set this equal to `cash` since margin sidesteps T+1
   * settlement. Phase 3 wires this into tradeFilterService sizing so cash
   * accounts cannot inadvertently spend unsettled proceeds.
   */
  settledCash: number;
  unsettledCash: number;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
}

/**
 * Broker-neutral order status. Each adapter normalizes its broker-native
 * status (Alpaca's 'accepted'|'new'|'pending_new'|'partially_filled'|...,
 * IBKR's 'Submitted'|'PreSubmitted'|'Filled'|...) into one of these values.
 *
 * The set is intentionally small. Adapters that see a status they don't
 * recognize map it to 'pending' (most conservative — caller will keep
 * polling) and emit a warning so we can extend the mapping.
 */
export type BrokerOrderStatus =
  | 'pending'    // submitted, broker has not yet acknowledged
  | 'accepted'   // broker has the order in its book, not yet filled
  | 'partial'    // partially filled
  | 'filled'     // fully filled
  | 'cancelled'  // cancelled by us or by the broker
  | 'rejected'   // broker rejected outright (PDT, insufficient funds, etc.)
  | 'expired';   // tif expired

export interface BrokerOrder {
  id: string;
  symbol: string;
  status: BrokerOrderStatus;
  side: 'buy' | 'sell';
  filledAvgPrice: number | null;
  filledQty: number | null;
  filledAt: string | null;
  submittedAt: string | null;
  /**
   * Broker-native status string for log/debug only. Useful when an order
   * stalls in an unexpected state — log lines should include rawStatus
   * so we can grep upstream. Never used for control flow.
   */
  rawStatus?: string;
}

/**
 * Discriminated union: `limitPrice` is required for limit orders and not
 * permitted on market orders. Using a union (vs an optional field) makes
 * "limit without a price" a compile error rather than a runtime check that
 * has to live in every adapter.
 */
export type SubmitOrderParams =
  | {
      symbol: string;
      qty: number;
      side: 'buy' | 'sell';
      type: 'market';
    }
  | {
      symbol: string;
      qty: number;
      side: 'buy' | 'sell';
      type: 'limit';
      limitPrice: number;
    };

/**
 * A bracketed entry: an entry order plus a take-profit (limit-sell) target
 * and a stop-loss, all submitted atomically. When the entry fills, the
 * target and stop become an OCO pair — whichever fills first cancels the
 * other server-side.
 *
 * Why this exists: without it, exits are managed entirely in-process. A
 * bot crash after entry leaves you exposed with an open position and no
 * pending exit. Bracket orders push exit management into the broker so a
 * crashed/restarting bot still gets out at a sane price.
 *
 * Notes on partial fills (decided 2026-05-04): we always bracket the
 * original `qty`. The broker handles partial-fill semantics at exit time
 * — when the stop or target fires, it sells whatever quantity actually
 * ended up filled.
 */
export interface SubmitBracketOrderParams {
  symbol: string;
  qty: number;
  /** Side of the ENTRY order. Target+stop are inferred (opposite). v1
   *  only supports long entries; short entries can be added later. */
  side: 'buy';
  /** Entry order type. Limit entries require entryLimitPrice. */
  type: 'market' | 'limit';
  entryLimitPrice?: number;
  /** Take-profit price for the limit-sell target leg. */
  targetPrice: number;
  /** Stop-loss trigger for the stop-sell leg. */
  stopPrice: number;
}

export interface BracketOrderResult {
  /** The entry order. status field reflects its current broker state. */
  entry: BrokerOrder;
  /** The take-profit limit-sell. Becomes active when entry fills. */
  target: BrokerOrder;
  /** The stop-loss. Becomes active when entry fills. */
  stop: BrokerOrder;
}

export type OrderStatusFilter = 'all' | 'closed' | 'open';

export interface BrokerAdapter {
  /** Stable identifier for logs, recordings, and config. */
  readonly name: 'alpaca' | 'ibkr';
  /** True when the underlying account is registered as a cash account. */
  readonly isCashAccount: boolean;

  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<BrokerPosition[]>;
  getOpenOrders(): Promise<BrokerOrder[]>;
  /**
   * Orders submitted on or after `sinceIso`. `status` defaults to 'closed'
   * because the wash-sale and reconciliation paths only care about fills;
   * other call sites can opt in to 'open' or 'all'.
   */
  getOrdersSince(sinceIso: string, status?: OrderStatusFilter): Promise<BrokerOrder[]>;
  submitOrder(params: SubmitOrderParams): Promise<BrokerOrder>;
  /**
   * Submit a bracket order: entry + target (take-profit limit-sell) +
   * stop (stop-loss). The target and stop are linked OCO at the broker
   * — when one fills, the other is cancelled server-side.
   *
   * Returns the three constituent orders. The entry's id is the trade
   * handle for status-checking; target.id and stop.id are the handles
   * for replacing/cancelling those legs (e.g. tighten_stop replaces the
   * stop leg in-place).
   */
  submitBracketOrder(params: SubmitBracketOrderParams): Promise<BracketOrderResult>;
  getOrder(id: string): Promise<BrokerOrder>;
  cancelOrder(id: string): Promise<void>;
  closePosition(symbol: string): Promise<void>;
  closeAllPositions(): Promise<void>;
}
