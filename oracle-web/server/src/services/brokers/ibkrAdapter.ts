import type {
  BracketOrderResult,
  BrokerAdapter,
  BrokerAccount,
  BrokerOrder,
  BrokerOrderStatus,
  BrokerPosition,
  OrderStatusFilter,
  SubmitBracketOrderParams,
  SubmitOrderParams,
} from '../../types/broker.js';
import { IbkrSession } from './ibkrSession.js';
import { IbkrConidCache, type ConidSearchResult } from './ibkrConidCache.js';

/**
 * IBKR Client Portal Web API adapter.
 *
 * Talks to the **locally-running Client Portal Gateway** (`https://localhost:5000`
 * by default). The gateway is a Java process the user starts separately
 * and authenticates once via browser; thereafter it issues a session
 * cookie that this adapter rides on, kept alive by `IbkrSession.tickle()`
 * every minute.
 *
 * IMPORTANT — *unverified-against-live-API* sections:
 *  - Field names on `/portfolio/{accountId}/summary` (`totalcashvalue`,
 *    `equitywithloanvalue`, `buyingpower`, `settledcash`, `cushion`) are
 *    drawn from the spec / IBKR docs and have NOT been verified against
 *    a real gateway response. The smoke script in `scripts/ibkr-smoke.ts`
 *    is the verification path; expect at least minor key-name fixes the
 *    first time it's run.
 *  - Order-reply auto-confirmation (`maybeAutoConfirmReplies`) is based
 *    on the documented warning IDs. The first live run should LOG every
 *    reply ID we see and let an operator extend the allowlist if a new
 *    benign warning appears.
 *  - Status normalization (`normalizeIbkrStatus`) covers the documented
 *    states; unknown states map to 'pending' with a warn so we can extend.
 *
 * Once verified, remove these markers from the file header.
 */

interface IbkrAdapterConfig {
  baseUrl: string;
  accountId: string;
  cashAccount: boolean;
  allowSelfSignedTls: boolean;
}

export interface IbkrAdapterDeps {
  config: IbkrAdapterConfig;
  /** HTTP fetch — defaults to global fetch with self-signed-TLS handling. */
  fetch?: typeof globalThis.fetch;
  /** Session keepalive — adapter assumes start() has been called externally. */
  session?: IbkrSession;
  /** Symbol → conid resolver. */
  conidCache?: IbkrConidCache;
}

/**
 * Order-reply confirmation IDs that we trust to auto-confirm on submit.
 * These are documented "informational" warnings IBKR returns when the
 * order is structurally valid but has a benign quirk (e.g. price outside
 * the recent NBBO, after-hours session). Anything NOT in this set throws
 * so an operator can review.
 *
 * Source: IBKR Client Portal API docs — "Order Reply ID Reference". The
 * docs are sometimes incomplete; the first weeks of live operation will
 * log every reply ID we see, and an operator extends this allowlist after
 * confirming each is benign.
 */
const AUTO_CONFIRM_REPLY_IDS = new Set<string>([
  // "Price exceeds the X% range of the average price". Common on penny
  // stocks where the recent average is volatile.
  'o163',
  // "Order will be triggered or executed during off-hours". We submit
  // tif=DAY which IBKR honors; this is informational.
  'o354',
]);

interface IbkrOrderReply {
  id?: string;
  message?: string[];
  isSuppressed?: boolean;
}

interface IbkrSubmitResult {
  /** When IBKR accepts the order, the response includes `order_id` (and
   *  some other fields, but we only need the id). */
  order_id?: string;
  orderId?: string;
}

export class IbkrAdapter implements BrokerAdapter {
  readonly name = 'ibkr' as const;
  readonly isCashAccount: boolean;

  private readonly cfg: IbkrAdapterConfig;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly session: IbkrSession;
  private readonly conidCache: IbkrConidCache;

  constructor(deps: IbkrAdapterDeps) {
    this.cfg = deps.config;
    this.isCashAccount = deps.config.cashAccount;
    this.fetcher = deps.fetch ?? globalThis.fetch;
    this.session =
      deps.session ?? new IbkrSession({ tickle: () => this.tickleViaFetch() });
    this.conidCache =
      deps.conidCache ??
      new IbkrConidCache({
        cachePath: '.ibkr-state/conid-cache.json',
        fetcher: (sym) => this.searchConid(sym),
      });
  }

  /** Production wiring calls this once at startup. Idempotent — safe to
   *  call multiple times. */
  async init(): Promise<void> {
    await this.session.start();
    await this.conidCache.ensureLoaded();
  }

  // -- BrokerAdapter -------------------------------------------------------

  async getAccount(): Promise<BrokerAccount> {
    const data = (await this.get(`/portfolio/${this.accountId}/summary`)) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    // IBKR returns each field as { amount, currency, value? }. We ride the
    // `amount` (number) through. If the shape ever changes the tests will
    // catch it; live verification confirms the keys.
    const cash = num(data.totalcashvalue?.amount);
    const portfolioValue = num(data.equitywithloanvalue?.amount);
    const buyingPower = num(
      this.cfg.cashAccount ? data.availablefunds?.amount : data.buyingpower?.amount,
    );
    // settledcash is THE cash-account field that drives Phase 3 sizing.
    // For margin accounts IBKR reports it equal to cash; for cash accounts
    // it lags `cash` while T+1 settles.
    const settledCash = num(data.settledcash?.amount, cash);
    return {
      cash,
      portfolioValue,
      buyingPower,
      settledCash,
      unsettledCash: Math.max(0, cash - settledCash),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const data = (await this.get(
      `/portfolio/${this.accountId}/positions/0`,
    )) as Array<Record<string, unknown>>;
    return data.map((p) => ({
      symbol: String(p.contractDesc ?? p.ticker ?? ''),
      qty: num(p.position),
      avgEntryPrice: num(p.avgPrice ?? p.avgCost),
      currentPrice: num(p.mktPrice),
      marketValue: num(p.mktValue),
      unrealizedPl: num(p.unrealizedPnl),
    }));
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    const data = (await this.get('/iserver/account/orders')) as { orders?: unknown[] };
    const orders = (data.orders ?? []) as Array<Record<string, unknown>>;
    return orders.map(mapIbkrOrder).filter((o) => !isClosed(o.status));
  }

  async getOrdersSince(
    sinceIso: string,
    status: OrderStatusFilter = 'closed',
  ): Promise<BrokerOrder[]> {
    // IBKR's /iserver/account/orders returns recent orders (the gateway
    // documents "the last 7 days" in practice). We pull the full list and
    // filter client-side by submittedAt + status.
    const since = new Date(sinceIso).getTime();
    const data = (await this.get('/iserver/account/orders')) as { orders?: unknown[] };
    const all = ((data.orders ?? []) as Array<Record<string, unknown>>).map(mapIbkrOrder);
    return all.filter((o) => {
      if (o.submittedAt && new Date(o.submittedAt).getTime() < since) return false;
      if (status === 'all') return true;
      if (status === 'open') return !isClosed(o.status);
      // 'closed' includes filled/cancelled/rejected/expired.
      return isClosed(o.status);
    });
  }

  async submitOrder(params: SubmitOrderParams): Promise<BrokerOrder> {
    const conid = await this.conidCache.getConid(params.symbol);
    const body: Record<string, unknown> = {
      conid,
      orderType: params.type === 'limit' ? 'LMT' : 'MKT',
      side: params.side === 'buy' ? 'BUY' : 'SELL',
      quantity: params.qty,
      tif: 'DAY',
    };
    if (params.type === 'limit') body.price = params.limitPrice;

    const replies = (await this.post(`/iserver/account/${this.accountId}/orders`, {
      orders: [body],
    })) as IbkrOrderReply[];

    // IBKR returns either a list of order replies (warnings to confirm) or
    // a list of submission results. The shape isn't perfectly self-describing
    // — we discriminate on the presence of `order_id`/`orderId`.
    const finalReplies = await this.maybeAutoConfirmReplies(replies);
    const submitted = finalReplies.find(
      (r) => (r as IbkrSubmitResult).order_id || (r as IbkrSubmitResult).orderId,
    ) as IbkrSubmitResult | undefined;
    if (!submitted) {
      throw new Error(
        `IBKR submitOrder: no order_id in final reply set (${JSON.stringify(finalReplies)})`,
      );
    }
    const orderId = String(submitted.order_id ?? submitted.orderId ?? '');
    return this.getOrder(orderId);
  }

  async submitBracketOrder(
    params: SubmitBracketOrderParams,
  ): Promise<BracketOrderResult> {
    // IBKR bracket: three orders posted together with a shared `cOID`
    // (client order id) and `parentId` linking the children to the
    // entry. IBKR matches them as an OCO group server-side — when the
    // entry fills, target+stop become an active OCO pair, and when one
    // of those fills the other auto-cancels.
    //
    // Per IBKR docs, the body is { orders: [parent, child1, child2] }
    // where children carry the parent's cOID via `parentId`. cOIDs are
    // arbitrary strings we generate; making them human-grep-friendly
    // (symbol + ms timestamp) helps live debugging.
    const conid = await this.conidCache.getConid(params.symbol);
    const parentCoid = `bracket-${params.symbol}-${Date.now()}`;
    const sideOpp: 'BUY' | 'SELL' = params.side === 'buy' ? 'SELL' : 'BUY';

    const parent: Record<string, unknown> = {
      conid,
      orderType: params.type === 'limit' ? 'LMT' : 'MKT',
      side: params.side === 'buy' ? 'BUY' : 'SELL',
      quantity: params.qty,
      tif: 'DAY',
      cOID: parentCoid,
    };
    if (params.type === 'limit') {
      if (params.entryLimitPrice === undefined) {
        throw new Error('IBKR submitBracketOrder: limit entry requires entryLimitPrice');
      }
      parent.price = params.entryLimitPrice;
    }

    const target: Record<string, unknown> = {
      conid,
      orderType: 'LMT',
      side: sideOpp,
      quantity: params.qty,
      tif: 'GTC', // exits live across sessions until they fill or we cancel
      price: params.targetPrice,
      parentId: parentCoid,
    };

    const stop: Record<string, unknown> = {
      conid,
      orderType: 'STP',
      side: sideOpp,
      quantity: params.qty,
      tif: 'GTC',
      auxPrice: params.stopPrice, // IBKR uses auxPrice for stop trigger
      parentId: parentCoid,
    };

    const replies = (await this.post(`/iserver/account/${this.accountId}/orders`, {
      orders: [parent, target, stop],
    })) as IbkrOrderReply[];

    const finalReplies = await this.maybeAutoConfirmReplies(replies);

    // IBKR returns one submission result per order in the same order we
    // sent them. Pick them out by position rather than by content; the
    // cOID/parentId fields don't always echo back consistently.
    const submitted = finalReplies.filter(
      (r) => (r as IbkrSubmitResult).order_id || (r as IbkrSubmitResult).orderId,
    );
    if (submitted.length < 3) {
      throw new Error(
        `IBKR submitBracketOrder: expected 3 order ids in reply, got ${submitted.length}. ` +
          `Replies: ${JSON.stringify(finalReplies).slice(0, 400)}`,
      );
    }
    const [entryR, targetR, stopR] = submitted as IbkrSubmitResult[];
    return {
      entry: await this.getOrder(String(entryR.order_id ?? entryR.orderId ?? '')),
      target: await this.getOrder(String(targetR.order_id ?? targetR.orderId ?? '')),
      stop: await this.getOrder(String(stopR.order_id ?? stopR.orderId ?? '')),
    };
  }

  async getOrder(id: string): Promise<BrokerOrder> {
    const data = (await this.get('/iserver/account/orders')) as { orders?: unknown[] };
    const orders = (data.orders ?? []) as Array<Record<string, unknown>>;
    const found = orders.find(
      (o) => String(o.orderId ?? o.order_id ?? '') === id,
    );
    if (!found) {
      throw new Error(`IBKR getOrder: id ${id} not in orders list`);
    }
    return mapIbkrOrder(found);
  }

  async cancelOrder(id: string): Promise<void> {
    await this.delete(`/iserver/account/${this.accountId}/order/${id}`);
  }

  async closePosition(symbol: string): Promise<void> {
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
    if (!pos || pos.qty === 0) return;
    const qty = Math.abs(pos.qty);
    const side = pos.qty > 0 ? 'sell' : 'buy';
    await this.submitOrder({ symbol, qty, side, type: 'market' });
  }

  async closeAllPositions(): Promise<void> {
    const positions = await this.getPositions();
    await Promise.all(positions.map((p) => this.closePosition(p.symbol)));
  }

  // -- internals -----------------------------------------------------------

  private get accountId(): string {
    if (!this.cfg.accountId) {
      throw new Error('IBKR adapter: config.broker.ibkr.account_id is empty');
    }
    return this.cfg.accountId;
  }

  /**
   * Walk through any reply IDs IBKR asked us to confirm. For each known-
   * benign ID we POST a confirmation and chain the result. Anything we
   * don't recognize throws — operator review required.
   */
  private async maybeAutoConfirmReplies(
    replies: IbkrOrderReply[],
  ): Promise<IbkrOrderReply[]> {
    let current = replies;
    // Cap iterations defensively — IBKR docs imply up to 2 sequential
    // warnings; cap at 5 to avoid infinite confirmation loops if the
    // gateway ever returns the same warning indefinitely.
    for (let depth = 0; depth < 5; depth++) {
      const needsConfirm = current.find((r) => r.id && !(r as IbkrSubmitResult).order_id);
      if (!needsConfirm || !needsConfirm.id) return current;
      if (!AUTO_CONFIRM_REPLY_IDS.has(needsConfirm.id)) {
        throw new Error(
          `IBKR submitOrder: unknown reply ID ${needsConfirm.id} requires confirmation. ` +
            `Message: ${(needsConfirm.message ?? []).join(' / ')}. ` +
            `Add to AUTO_CONFIRM_REPLY_IDS only after operator review.`,
        );
      }
      current = (await this.post(`/iserver/reply/${needsConfirm.id}`, {
        confirmed: true,
      })) as IbkrOrderReply[];
    }
    throw new Error(
      'IBKR submitOrder: confirmation loop exceeded 5 iterations — refusing to retry further',
    );
  }

  private async tickleViaFetch(): Promise<void> {
    const res = await this.fetcher(`${this.cfg.baseUrl}/tickle`, {
      method: 'POST',
      ...this.tlsOptions(),
    });
    if (!res.ok) throw new Error(`IBKR tickle failed: ${res.status}`);
  }

  private async searchConid(symbol: string): Promise<ConidSearchResult[]> {
    const data = (await this.get(
      `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=STK`,
    )) as Array<Record<string, unknown>>;
    return data.map((c) => ({
      conid: num(c.conid),
      exchange: String(c.listingExchange ?? c.exchange ?? ''),
      secType: String(c.secType ?? 'STK'),
    }));
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetcher(`${this.cfg.baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...this.tlsOptions(),
    });
    if (!res.ok) throw new Error(`IBKR GET ${path} failed: ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetcher(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      ...this.tlsOptions(),
    });
    if (!res.ok) throw new Error(`IBKR POST ${path} failed: ${res.status}`);
    return res.json();
  }

  private async delete(path: string): Promise<void> {
    const res = await this.fetcher(`${this.cfg.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
      ...this.tlsOptions(),
    });
    if (!res.ok) throw new Error(`IBKR DELETE ${path} failed: ${res.status}`);
  }

  private tlsOptions(): { dispatcher?: unknown } {
    // The gateway uses a self-signed cert by default. node-undici (the
    // global fetch impl in Node 18+) refuses self-signed TLS unless we
    // pass a permissive dispatcher. The flag is an explicit opt-in so
    // production deployments behind a proper TLS frontend keep strict
    // verification.
    if (!this.cfg.allowSelfSignedTls) return {};
    // We avoid importing undici at module scope so the tests' fake fetch
    // path doesn't hit it. Production callers will set allow_self_signed_tls
    // true and the gateway is reachable; if Node's fetch can't connect at
    // all, the adapter surfaces the underlying TLS error.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require('undici') as { Agent: new (opts: unknown) => unknown };
    return {
      dispatcher: new undici.Agent({
        connect: { rejectUnauthorized: false },
      }),
    };
  }
}

// -- mapping helpers (exported for tests) ----------------------------------

/**
 * Map IBKR's order status string to our normalized BrokerOrderStatus.
 * IBKR's documented states (Client Portal API order status field):
 *   PendingSubmit, PreSubmitted, Submitted, Filled, Cancelled, Rejected,
 *   Inactive, ApiCancelled
 *
 * Any unknown state maps to 'pending' (safest — caller will keep polling)
 * with a warn so we can extend the mapping.
 */
export function normalizeIbkrStatus(raw: string): BrokerOrderStatus {
  switch (raw) {
    case 'PendingSubmit':
    case 'PreSubmitted':
      return 'pending';
    case 'Submitted':
      return 'accepted';
    case 'Filled':
      return 'filled';
    case 'Cancelled':
    case 'ApiCancelled':
      return 'cancelled';
    case 'Rejected':
      return 'rejected';
    case 'Inactive':
      return 'expired';
    default:
      console.warn(`[IbkrAdapter] unknown order status "${raw}" — mapping to 'pending'`);
      return 'pending';
  }
}

export function mapIbkrOrder(data: Record<string, unknown>): BrokerOrder {
  const rawStatus = String(data.status ?? data.orderStatus ?? '');
  return {
    id: String(data.orderId ?? data.order_id ?? ''),
    symbol: String(data.ticker ?? data.symbol ?? ''),
    status: normalizeIbkrStatus(rawStatus),
    rawStatus,
    side: data.side === 'SELL' || data.side === 'sell' ? 'sell' : 'buy',
    filledAvgPrice:
      data.avgPrice != null
        ? Number(data.avgPrice)
        : data.avg_price != null
        ? Number(data.avg_price)
        : null,
    filledQty:
      data.filledQuantity != null
        ? Number(data.filledQuantity)
        : data.filled_quantity != null
        ? Number(data.filled_quantity)
        : null,
    filledAt: (data.filled_at as string | null) ?? (data.lastExecutionTime as string | null) ?? null,
    submittedAt:
      (data.submittedAt as string | null) ?? (data.orderTime as string | null) ?? null,
  };
}

function num(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isClosed(status: BrokerOrderStatus): boolean {
  return (
    status === 'filled' ||
    status === 'cancelled' ||
    status === 'rejected' ||
    status === 'expired'
  );
}
