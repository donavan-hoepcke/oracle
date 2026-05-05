import { config, alpacaApiKeyId, alpacaApiSecretKey } from '../../config.js';
import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerOrder,
  BrokerPosition,
  OrderStatusFilter,
  SubmitOrderParams,
} from '../../types/broker.js';

const PAPER_BASE = 'https://paper-api.alpaca.markets/v2';
const LIVE_BASE = 'https://api.alpaca.markets/v2';

function baseUrl(): string {
  return config.execution.paper ? PAPER_BASE : LIVE_BASE;
}

function headers(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': alpacaApiKeyId,
    'APCA-API-SECRET-KEY': alpacaApiSecretKey,
    'Content-Type': 'application/json',
  };
}

export class AlpacaAdapter implements BrokerAdapter {
  readonly name = 'alpaca' as const;

  get isCashAccount(): boolean {
    return config.broker.alpaca.cash_account;
  }

  async getAccount(): Promise<BrokerAccount> {
    const res = await fetch(`${baseUrl()}/account`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca account error: ${res.status}`);
    const data = await res.json();
    const cash = parseFloat(data.cash);
    // Alpaca exposes `cash_withdrawable` for the settled-cash component on
    // cash accounts. On margin accounts the field equals `cash` (no T+1
    // settlement constraint), so the mapping is safe in both cases.
    // Explicit null/undefined check, NOT truthy: a fully-unsettled cash
    // account legitimately reports `cash_withdrawable: 0` (or "0") which
    // a truthy check would treat as missing and fall back to `cash`,
    // making us under-count unsettled funds and over-count settled.
    const settledCash =
      data.cash_withdrawable != null ? parseFloat(data.cash_withdrawable) : cash;
    return {
      cash,
      portfolioValue: parseFloat(data.portfolio_value),
      buyingPower: parseFloat(data.buying_power),
      settledCash,
      unsettledCash: Math.max(0, cash - settledCash),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const res = await fetch(`${baseUrl()}/positions`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca positions error: ${res.status}`);
    const data = await res.json();
    return data.map((p: Record<string, string>) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPl: parseFloat(p.unrealized_pl),
    }));
  }

  async submitOrder(params: SubmitOrderParams): Promise<BrokerOrder> {
    const body: Record<string, string> = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type,
      time_in_force: 'day',
    };
    if (params.type === 'limit' && params.limitPrice !== undefined) {
      body.limit_price = String(params.limitPrice);
    }
    const res = await fetch(`${baseUrl()}/orders`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca order error: ${res.status} ${text}`);
    }
    const data = await res.json();
    return mapOrder(data);
  }

  async getOrder(orderId: string): Promise<BrokerOrder> {
    const res = await fetch(`${baseUrl()}/orders/${orderId}`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca getOrder error: ${res.status}`);
    const data = await res.json();
    return mapOrder(data);
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    const res = await fetch(`${baseUrl()}/orders?status=open`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca getOpenOrders error: ${res.status}`);
    const data = await res.json();
    return data.map((o: Record<string, unknown>) => mapOrder(o));
  }

  async getOrdersSince(
    sinceIso: string,
    status: OrderStatusFilter = 'closed',
  ): Promise<BrokerOrder[]> {
    const qs = new URLSearchParams({
      status,
      after: sinceIso,
      limit: '500',
      direction: 'desc',
    });
    const res = await fetch(`${baseUrl()}/orders?${qs.toString()}`, { headers: headers() });
    if (!res.ok) throw new Error(`Alpaca getOrdersSince error: ${res.status}`);
    const data = await res.json();
    return data.map((o: Record<string, unknown>) => mapOrder(o));
  }

  async cancelOrder(orderId: string): Promise<void> {
    const res = await fetch(`${baseUrl()}/orders/${orderId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error(`Alpaca cancel error: ${res.status}`);
  }

  async closePosition(symbol: string): Promise<void> {
    const res = await fetch(`${baseUrl()}/positions/${symbol}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) {
      // Alpaca's body usually contains the actionable reason (e.g. "trade
      // denied due to pattern day trading protection") — surface it so the UI
      // shows something meaningful instead of just "403".
      const body = await res.text().catch(() => '');
      let detail = body;
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.message === 'string') detail = parsed.message;
      } catch {
        // body wasn't JSON — keep raw text
      }
      throw new Error(`Alpaca closePosition ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  async closeAllPositions(): Promise<void> {
    const res = await fetch(`${baseUrl()}/positions`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) throw new Error(`Alpaca closeAll error: ${res.status}`);
  }
}

/**
 * Map Alpaca's order status string to our normalized BrokerOrderStatus enum.
 * Per Alpaca docs the full set is:
 *   new, accepted, pending_new, accepted_for_bidding, stopped, rejected,
 *   suspended, calculated, partially_filled, filled, done_for_day, canceled,
 *   expired, replaced, pending_cancel, pending_replace
 *
 * We collapse this into 7 broker-neutral states. Anything we don't
 * recognize maps to 'pending' (safest — caller keeps polling) and is
 * warned so we can extend the mapping if Alpaca introduces a new state.
 */
function normalizeAlpacaStatus(
  raw: string,
): import('../../types/broker.js').BrokerOrderStatus {
  switch (raw) {
    case 'new':
    case 'pending_new':
    case 'pending_replace':
    case 'pending_cancel':
    case 'replaced':
    case 'accepted_for_bidding':
    case 'suspended':
    case 'calculated':
    case 'stopped':
    case 'done_for_day':
      return 'pending';
    case 'accepted':
      return 'accepted';
    case 'partially_filled':
      return 'partial';
    case 'filled':
      return 'filled';
    case 'canceled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    default:
      console.warn(`[AlpacaAdapter] unknown order status "${raw}" — mapping to 'pending'`);
      return 'pending';
  }
}

function mapOrder(data: Record<string, unknown>): BrokerOrder {
  const rawStatus = data.status as string;
  return {
    id: data.id as string,
    symbol: data.symbol as string,
    status: normalizeAlpacaStatus(rawStatus),
    rawStatus,
    side: data.side === 'sell' ? 'sell' : 'buy',
    filledAvgPrice: data.filled_avg_price
      ? parseFloat(data.filled_avg_price as string)
      : null,
    filledQty: data.filled_qty ? parseFloat(data.filled_qty as string) : null,
    filledAt: (data.filled_at as string | null) ?? null,
    submittedAt: (data.submitted_at as string | null) ?? null,
  };
}
