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
  getOrder(id: string): Promise<BrokerOrder>;
  cancelOrder(id: string): Promise<void>;
  closePosition(symbol: string): Promise<void>;
  closeAllPositions(): Promise<void>;
}
