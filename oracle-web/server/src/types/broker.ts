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

export interface BrokerOrder {
  id: string;
  symbol: string;
  /**
   * Broker-native status string. Kept untyped in Phase 1 so we don't
   * silently change executionService's status comparisons (e.g.
   * order.status === 'filled'). Phase 2 introduces a normalized enum
   * alongside this raw string.
   */
  status: string;
  side: 'buy' | 'sell';
  filledAvgPrice: number | null;
  filledQty: number | null;
  filledAt: string | null;
  submittedAt: string | null;
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
