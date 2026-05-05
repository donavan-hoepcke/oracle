import { describe, it, expect, vi } from 'vitest';
import {
  IbkrAdapter,
  mapIbkrOrder,
  normalizeIbkrStatus,
} from '../services/brokers/ibkrAdapter.js';
import { IbkrSession } from '../services/brokers/ibkrSession.js';
import { IbkrConidCache } from '../services/brokers/ibkrConidCache.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function tempCachePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'ibkr-adapter-test-'));
  return path.join(dir, 'cache.json');
}

function fakeFetch(routes: Record<string, (init?: RequestInit) => unknown>): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    // Strip the base URL — match against path only.
    const u = new URL(url);
    const pathOnly = u.pathname + u.search;
    const handler = Object.entries(routes).find(([key]) => pathOnly.startsWith(key));
    if (!handler) {
      return Promise.resolve(
        new Response(`unmocked ${u.pathname}`, { status: 404 }) as unknown as Response,
      );
    }
    const body = handler[1](init);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200 }) as unknown as Response,
    );
  }) as typeof fetch;
}

function makeAdapter(opts: {
  fetch: typeof globalThis.fetch;
  conidCache?: IbkrConidCache;
  cashAccount?: boolean;
}): IbkrAdapter {
  const session = new IbkrSession({ tickle: () => Promise.resolve() });
  const adapter = new IbkrAdapter({
    config: {
      baseUrl: 'https://localhost:5000/v1/api',
      accountId: 'DU1234567',
      cashAccount: opts.cashAccount ?? false,
      allowSelfSignedTls: false, // bypass undici Agent in tests
    },
    fetch: opts.fetch,
    session,
    conidCache: opts.conidCache,
  });
  return adapter;
}

describe('normalizeIbkrStatus', () => {
  it('maps documented states to the correct enum', () => {
    expect(normalizeIbkrStatus('Submitted')).toBe('accepted');
    expect(normalizeIbkrStatus('PreSubmitted')).toBe('pending');
    expect(normalizeIbkrStatus('PendingSubmit')).toBe('pending');
    expect(normalizeIbkrStatus('Filled')).toBe('filled');
    expect(normalizeIbkrStatus('Cancelled')).toBe('cancelled');
    expect(normalizeIbkrStatus('ApiCancelled')).toBe('cancelled');
    expect(normalizeIbkrStatus('Rejected')).toBe('rejected');
    expect(normalizeIbkrStatus('Inactive')).toBe('expired');
  });

  it('falls back to pending on unknown states (safest — keep polling)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(normalizeIbkrStatus('SomeWeirdNewIbkrState')).toBe('pending');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('mapIbkrOrder', () => {
  it('extracts core fields from an IBKR order payload', () => {
    const o = mapIbkrOrder({
      orderId: 'abc123',
      ticker: 'AAPL',
      status: 'Filled',
      side: 'BUY',
      avgPrice: 150.25,
      filledQuantity: 100,
      lastExecutionTime: '2026-05-04T15:00:00Z',
      orderTime: '2026-05-04T14:59:55Z',
    });
    expect(o.id).toBe('abc123');
    expect(o.symbol).toBe('AAPL');
    expect(o.status).toBe('filled');
    expect(o.rawStatus).toBe('Filled');
    expect(o.side).toBe('buy');
    expect(o.filledAvgPrice).toBe(150.25);
    expect(o.filledQty).toBe(100);
    expect(o.filledAt).toBe('2026-05-04T15:00:00Z');
    expect(o.submittedAt).toBe('2026-05-04T14:59:55Z');
  });

  it('handles snake_case alternative field names', () => {
    const o = mapIbkrOrder({
      order_id: 'xyz',
      symbol: 'TSLA',
      orderStatus: 'Cancelled',
      side: 'SELL',
      avg_price: 200,
      filled_quantity: 10,
    });
    expect(o.id).toBe('xyz');
    expect(o.symbol).toBe('TSLA');
    expect(o.status).toBe('cancelled');
    expect(o.side).toBe('sell');
    expect(o.filledAvgPrice).toBe(200);
    expect(o.filledQty).toBe(10);
  });
});

describe('IbkrAdapter REST methods', () => {
  it('getAccount() reads totalcashvalue/equity/buyingpower/settledcash', async () => {
    const fetch = fakeFetch({
      '/v1/api/portfolio/DU1234567/summary': () => ({
        totalcashvalue: { amount: 50_000 },
        equitywithloanvalue: { amount: 60_000 },
        buyingpower: { amount: 50_000 },
        settledcash: { amount: 30_000 },
      }),
    });
    const adapter = makeAdapter({ fetch });
    const account = await adapter.getAccount();
    expect(account.cash).toBe(50_000);
    expect(account.portfolioValue).toBe(60_000);
    expect(account.buyingPower).toBe(50_000);
    expect(account.settledCash).toBe(30_000);
    expect(account.unsettledCash).toBe(20_000);
  });

  it('getAccount() on a cash account reads availablefunds for buyingPower', async () => {
    const fetch = fakeFetch({
      '/v1/api/portfolio/DU1234567/summary': () => ({
        totalcashvalue: { amount: 10_000 },
        equitywithloanvalue: { amount: 10_000 },
        availablefunds: { amount: 8_000 }, // settled+available
        buyingpower: { amount: 9_999 }, // would be wrong on a cash account
        settledcash: { amount: 8_000 },
      }),
    });
    const adapter = makeAdapter({ fetch, cashAccount: true });
    const account = await adapter.getAccount();
    expect(account.buyingPower).toBe(8_000); // from availablefunds, not buyingpower
  });

  it('getPositions() maps IBKR position payload to BrokerPosition', async () => {
    const fetch = fakeFetch({
      '/v1/api/portfolio/DU1234567/positions/0': () => [
        {
          contractDesc: 'AAPL',
          position: 100,
          avgPrice: 150,
          mktPrice: 155,
          mktValue: 15_500,
          unrealizedPnl: 500,
        },
      ],
    });
    const adapter = makeAdapter({ fetch });
    const positions = await adapter.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual({
      symbol: 'AAPL',
      qty: 100,
      avgEntryPrice: 150,
      currentPrice: 155,
      marketValue: 15_500,
      unrealizedPl: 500,
    });
  });

  it('submitOrder() resolves conid, posts to IBKR, auto-confirms benign reply, returns final order', async () => {
    const conidCache = new IbkrConidCache({
      cachePath: await tempCachePath(),
      fetcher: async () => [{ conid: 265598, exchange: 'NASDAQ', secType: 'STK' }],
    });

    let confirmed = false;
    const fetch = fakeFetch({
      '/v1/api/iserver/account/DU1234567/orders': () => [
        // First reply: a benign warning about price range. Auto-confirmed.
        { id: 'o163', message: ['Price exceeds 5% NBBO'] },
      ],
      '/v1/api/iserver/reply/o163': () => {
        confirmed = true;
        return [{ order_id: 'order-42' }];
      },
      '/v1/api/iserver/account/orders': () => ({
        orders: [
          {
            orderId: 'order-42',
            ticker: 'AAPL',
            status: 'Submitted',
            side: 'BUY',
            avgPrice: null,
            filledQuantity: null,
          },
        ],
      }),
    });

    const adapter = makeAdapter({ fetch, conidCache });
    const order = await adapter.submitOrder({
      symbol: 'AAPL',
      qty: 100,
      side: 'buy',
      type: 'limit',
      limitPrice: 150,
    });

    expect(confirmed).toBe(true);
    expect(order.id).toBe('order-42');
    expect(order.status).toBe('accepted');
    expect(order.symbol).toBe('AAPL');
  });

  it('submitOrder() throws on unknown reply ID rather than auto-confirming', async () => {
    const conidCache = new IbkrConidCache({
      cachePath: await tempCachePath(),
      fetcher: async () => [{ conid: 265598, exchange: 'NASDAQ', secType: 'STK' }],
    });
    const fetch = fakeFetch({
      '/v1/api/iserver/account/DU1234567/orders': () => [
        { id: 'oNOVEL', message: ['Some new warning we have not seen before'] },
      ],
    });
    const adapter = makeAdapter({ fetch, conidCache });
    await expect(
      adapter.submitOrder({ symbol: 'AAPL', qty: 1, side: 'buy', type: 'market' }),
    ).rejects.toThrow(/unknown reply ID oNOVEL/);
  });

  it('getOrdersSince() filters client-side by submittedAt and status=closed', async () => {
    const fetch = fakeFetch({
      '/v1/api/iserver/account/orders': () => ({
        orders: [
          // Recent + filled — INCLUDED in 'closed'
          {
            orderId: 'a',
            ticker: 'AAPL',
            status: 'Filled',
            side: 'SELL',
            avgPrice: 150,
            filledQuantity: 10,
            orderTime: '2026-05-04T15:00:00Z',
          },
          // Recent + open — EXCLUDED from 'closed'
          {
            orderId: 'b',
            ticker: 'TSLA',
            status: 'Submitted',
            side: 'BUY',
            orderTime: '2026-05-04T15:00:00Z',
          },
          // Old + filled — EXCLUDED by sinceIso
          {
            orderId: 'c',
            ticker: 'NVDA',
            status: 'Filled',
            side: 'SELL',
            orderTime: '2026-04-01T15:00:00Z',
          },
        ],
      }),
    });
    const adapter = makeAdapter({ fetch });
    const orders = await adapter.getOrdersSince('2026-05-01T00:00:00Z', 'closed');
    expect(orders.map((o) => o.id)).toEqual(['a']);
  });

  it('cancelOrder() DELETEs the order endpoint', async () => {
    let called = false;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (
        String(url).endsWith('/iserver/account/DU1234567/order/order-9') &&
        init?.method === 'DELETE'
      ) {
        called = true;
        return new Response('{}', { status: 200 }) as unknown as Response;
      }
      return new Response('not mocked', { status: 404 }) as unknown as Response;
    };
    const adapter = makeAdapter({ fetch });
    await adapter.cancelOrder('order-9');
    expect(called).toBe(true);
  });

  it('submitBracketOrder() posts entry+target+stop with shared cOID/parentId', async () => {
    const conidCache = new IbkrConidCache({
      cachePath: await tempCachePath(),
      fetcher: async () => [{ conid: 999, exchange: 'NYSE', secType: 'STK' }],
    });
    let postedBody: { orders: Array<Record<string, unknown>> } | null = null;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = new URL(url as string);
      if (
        u.pathname.endsWith('/iserver/account/DU1234567/orders') &&
        init?.method === 'POST'
      ) {
        postedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify([
            { order_id: 'entry-1' },
            { order_id: 'target-1' },
            { order_id: 'stop-1' },
          ]),
          { status: 200 },
        ) as unknown as Response;
      }
      if (u.pathname.endsWith('/iserver/account/orders')) {
        return new Response(
          JSON.stringify({
            orders: [
              { orderId: 'entry-1', ticker: 'AAPL', status: 'Submitted', side: 'BUY' },
              { orderId: 'target-1', ticker: 'AAPL', status: 'PreSubmitted', side: 'SELL' },
              { orderId: 'stop-1', ticker: 'AAPL', status: 'PreSubmitted', side: 'SELL' },
            ],
          }),
          { status: 200 },
        ) as unknown as Response;
      }
      return new Response('not mocked', { status: 404 }) as unknown as Response;
    };
    const adapter = makeAdapter({ fetch, conidCache });
    const bracket = await adapter.submitBracketOrder({
      symbol: 'AAPL',
      qty: 100,
      side: 'buy',
      type: 'market',
      targetPrice: 200,
      stopPrice: 140,
    });

    expect(postedBody).not.toBeNull();
    const orders = postedBody!.orders;
    expect(orders).toHaveLength(3);

    // Parent: market BUY for the entry
    expect(orders[0].side).toBe('BUY');
    expect(orders[0].orderType).toBe('MKT');
    expect(orders[0].quantity).toBe(100);
    const parentCoid = orders[0].cOID as string;
    expect(parentCoid).toMatch(/^bracket-AAPL-/);

    // Target: limit SELL at 200, parentId == entry's cOID
    expect(orders[1].side).toBe('SELL');
    expect(orders[1].orderType).toBe('LMT');
    expect(orders[1].price).toBe(200);
    expect(orders[1].parentId).toBe(parentCoid);

    // Stop: STP SELL with auxPrice (IBKR's stop trigger), parentId == entry's cOID
    expect(orders[2].side).toBe('SELL');
    expect(orders[2].orderType).toBe('STP');
    expect(orders[2].auxPrice).toBe(140);
    expect(orders[2].parentId).toBe(parentCoid);

    expect(bracket.entry.id).toBe('entry-1');
    expect(bracket.target.id).toBe('target-1');
    expect(bracket.stop.id).toBe('stop-1');
  });

  it('submitBracketOrder() limit entry requires entryLimitPrice', async () => {
    const conidCache = new IbkrConidCache({
      cachePath: await tempCachePath(),
      fetcher: async () => [{ conid: 999, exchange: 'NYSE', secType: 'STK' }],
    });
    const adapter = makeAdapter({
      fetch: fakeFetch({}),
      conidCache,
    });
    await expect(
      adapter.submitBracketOrder({
        symbol: 'AAPL',
        qty: 1,
        side: 'buy',
        type: 'limit',
        // intentionally omitted entryLimitPrice
        targetPrice: 200,
        stopPrice: 140,
      }),
    ).rejects.toThrow(/limit entry requires entryLimitPrice/);
  });

  it('closePosition() submits a market order opposite-side at current qty', async () => {
    const conidCache = new IbkrConidCache({
      cachePath: await tempCachePath(),
      fetcher: async () => [{ conid: 999, exchange: 'NYSE', secType: 'STK' }],
    });
    const submittedBodies: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = new URL(url as string);
      if (u.pathname.endsWith('/portfolio/DU1234567/positions/0')) {
        return new Response(
          JSON.stringify([
            {
              contractDesc: 'XYZ',
              position: 50, // long position
              avgPrice: 10,
              mktPrice: 11,
              mktValue: 550,
              unrealizedPnl: 50,
            },
          ]),
          { status: 200 },
        ) as unknown as Response;
      }
      if (u.pathname.endsWith('/iserver/account/DU1234567/orders')) {
        if (init?.body) submittedBodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify([{ order_id: 'closer-1' }]), {
          status: 200,
        }) as unknown as Response;
      }
      if (u.pathname.endsWith('/iserver/account/orders')) {
        return new Response(
          JSON.stringify({ orders: [{ orderId: 'closer-1', status: 'Filled', side: 'SELL', ticker: 'XYZ' }] }),
          { status: 200 },
        ) as unknown as Response;
      }
      return new Response('not mocked', { status: 404 }) as unknown as Response;
    };
    const adapter = makeAdapter({ fetch, conidCache });
    await adapter.closePosition('XYZ');
    expect(submittedBodies).toHaveLength(1);
    const body = submittedBodies[0] as { orders: Array<Record<string, unknown>> };
    expect(body.orders[0].side).toBe('SELL');
    expect(body.orders[0].quantity).toBe(50);
    expect(body.orders[0].orderType).toBe('MKT');
  });
});
