import { config, alpacaApiKeyId, alpacaApiSecretKey } from '../../config.js';
import type {
  BracketOrderResult,
  BrokerAccount,
  BrokerAdapter,
  BrokerOrder,
  BrokerPosition,
  OrderStatusFilter,
  SubmitBracketOrderParams,
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

/**
 * Round a price to Alpaca's accepted tick increment before submit.
 *
 * Alpaca rejects sub-penny prices for stocks ≥ $1.00 (rule 612 / "minimum
 * pricing increment"). Sub-$1 stocks are allowed 4-decimal precision.
 * Our RCT rule sources prices from 1m IEX bars where 0.5¢ ticks are
 * common in pre-market thin trading; submitting them verbatim produced
 * "invalid stop_loss.stop_price 19.525. sub-penny increment does not
 * fulfill minimum pricing criteria" rejections on 2026-05-07 (FSLY,
 * ATRA). Rounding to penny on the way to the broker fixes that without
 * changing the rule-engine's internal precision (used for display +
 * R-multiple computation).
 *
 * Exported as `formatTickPrice` for testability.
 */
export function formatTickPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return String(price);
  // ≥ $1: 2 decimal places (whole cents).
  // <  $1: 4 decimal places (Alpaca allows sub-penny here).
  const decimals = price >= 1 ? 2 : 4;
  const factor = decimals === 2 ? 100 : 10000;
  const rounded = Math.round(price * factor) / factor;
  return rounded.toFixed(decimals);
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
    // Extended-hours orders are limit-only at Alpaca. Refuse the wrong
    // shape at the adapter boundary so we never even hit the broker with
    // an obviously-rejected order.
    if (params.type === 'limit' && params.extendedHours && !params.limitPrice) {
      throw new Error('extended-hours order requires a limit price');
    }
    if (params.type === 'market' && (params as { extendedHours?: boolean }).extendedHours) {
      throw new Error('extended-hours orders must be limit orders (Alpaca constraint)');
    }
    const body: Record<string, string | boolean> = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type,
      time_in_force: 'day',
    };
    if (params.type === 'limit' && params.limitPrice !== undefined) {
      body.limit_price = formatTickPrice(params.limitPrice);
      if (params.extendedHours) body.extended_hours = true;
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

  async submitBracketOrder(
    params: SubmitBracketOrderParams,
  ): Promise<BracketOrderResult> {
    // Alpaca bracket orders: order_class=bracket with take_profit and
    // stop_loss in the body. The response includes a `legs` array with
    // the two child orders. The parent order's id is the entry handle;
    // legs[i].id are handles for the target/stop legs (used by
    // tighten_stop to replace the stop leg specifically).
    //
    // Alpaca paper simulates a margin account so bracket orders work
    // there; on a real cash account they're documented to work but the
    // first live integration should verify (Alpaca occasionally rejects
    // bracket orders on cash accounts citing "complex orders not
    // supported on cash accounts" — fallback path is to submit entry
    // alone and place OCO sell pair on fill, which is more code).
    const body: Record<string, unknown> = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type,
      time_in_force: 'day',
      order_class: 'bracket',
      take_profit: { limit_price: formatTickPrice(params.targetPrice) },
      stop_loss: { stop_price: formatTickPrice(params.stopPrice) },
    };
    if (params.type === 'limit') {
      if (params.entryLimitPrice === undefined) {
        // SubmitBracketOrderParams documents entryLimitPrice as required
        // for limit entries. Throw locally rather than letting Alpaca
        // reject with a vague "invalid order" — the latter is harder to
        // diagnose from a log line.
        throw new Error('AlpacaAdapter.submitBracketOrder: limit entry requires entryLimitPrice');
      }
      body.limit_price = formatTickPrice(params.entryLimitPrice);
    }
    const res = await fetch(`${baseUrl()}/orders`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca bracket order error: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown> & {
      legs?: Array<Record<string, unknown>>;
    };
    const entry = mapOrder(data);
    const legs = data.legs ?? [];
    // Alpaca returns legs in submission order: [target, stop] for our
    // body shape. Identify by type rather than position to be defensive
    // — if Alpaca ever changes ordering, we still pick the right legs.
    const target = legs.find((l) => l.type === 'limit') ?? legs[0];
    const stop = legs.find((l) => l.type === 'stop' || l.type === 'stop_limit') ?? legs[1];
    if (!target || !stop) {
      throw new Error(
        `Alpaca bracket response missing legs (got ${legs.length}). Body: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    return {
      entry,
      target: mapOrder(target),
      stop: mapOrder(stop),
    };
  }

  async replaceStopLeg(stopOrderId: string, newStopPrice: number): Promise<string> {
    // Alpaca supports in-place modification via PATCH /v2/orders/{id}.
    // The bracket relationship is preserved — the leg keeps its parent
    // and stays linked to the take_profit sibling as an OCO pair.
    // Returns the same id (Alpaca preserves it on PATCH).
    const res = await fetch(`${baseUrl()}/orders/${stopOrderId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ stop_price: formatTickPrice(newStopPrice) }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca replaceStopLeg error: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return String(data.id ?? stopOrderId);
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
    // 'held' is the bracket-leg state Alpaca uses for the take_profit /
    // stop_loss children that haven't activated yet. Mapping it to
    // 'pending' (rather than the unknown-status fallback) keeps the
    // state machine clean and avoids spamming console.warn on every
    // bracket leg.
    case 'held':
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
  const rawClass = data.order_class as string | undefined;
  // Only forward known order_class values; an unrecognized one stays
  // undefined so reconcileWithBroker can treat it as "don't attribute."
  const orderClass: BrokerOrder['orderClass'] | undefined =
    rawClass === 'simple' || rawClass === 'bracket' || rawClass === 'oco' || rawClass === 'oto'
      ? rawClass
      : undefined;
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
    orderClass,
  };
}
