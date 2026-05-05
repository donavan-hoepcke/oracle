import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock config
vi.mock('../config.js', () => ({
  config: {
    execution: { paper: true },
    broker: { active: 'alpaca', alpaca: { cash_account: false } },
  },
  alpacaApiKeyId: 'test-key',
  alpacaApiSecretKey: 'test-secret',
}));

import { AlpacaAdapter } from '../services/brokers/alpacaAdapter.js';

const alpacaOrderService = new AlpacaAdapter();

beforeEach(() => {
  mockFetch.mockReset();
});

describe('AlpacaAdapter', () => {
  describe('getAccount', () => {
    it('fetches account from paper endpoint when paper mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cash: '10000.00', portfolio_value: '10000.00', buying_power: '10000.00' }),
      });

      const account = await alpacaOrderService.getAccount();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/account',
        expect.objectContaining({
          headers: expect.objectContaining({
            'APCA-API-KEY-ID': 'test-key',
            'APCA-API-SECRET-KEY': 'test-secret',
          }),
        }),
      );
      expect(account.cash).toBe(10000);
      expect(account.portfolioValue).toBe(10000);
    });
  });

  describe('submitOrder', () => {
    it('submits a market buy order', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'order-123', status: 'accepted', filled_avg_price: null }),
      });

      const order = await alpacaOrderService.submitOrder({
        symbol: 'AGAE',
        qty: 100,
        side: 'buy',
        type: 'market',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.symbol).toBe('AGAE');
      expect(body.qty).toBe('100');
      expect(body.side).toBe('buy');
      expect(body.type).toBe('market');
      expect(body.time_in_force).toBe('day');
      expect(order.id).toBe('order-123');
    });

    it('submits a limit buy order with limit price', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'order-456', status: 'accepted', filled_avg_price: null }),
      });

      const order = await alpacaOrderService.submitOrder({
        symbol: 'IMMP',
        qty: 50,
        side: 'buy',
        type: 'limit',
        limitPrice: 0.58,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe('limit');
      expect(body.limit_price).toBe('0.58');
      expect(order.id).toBe('order-456');
    });
  });

  describe('submitBracketOrder', () => {
    it('posts order_class=bracket with take_profit and stop_loss legs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'parent-1',
          symbol: 'AGAE',
          status: 'accepted',
          side: 'buy',
          legs: [
            {
              id: 'leg-target',
              symbol: 'AGAE',
              status: 'held',
              side: 'sell',
              type: 'limit',
              limit_price: '0.94',
            },
            {
              id: 'leg-stop',
              symbol: 'AGAE',
              status: 'held',
              side: 'sell',
              type: 'stop',
              stop_price: '0.30',
            },
          ],
        }),
      });

      const result = await alpacaOrderService.submitBracketOrder({
        symbol: 'AGAE',
        qty: 100,
        side: 'buy',
        type: 'market',
        targetPrice: 0.94,
        stopPrice: 0.30,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.order_class).toBe('bracket');
      expect(body.take_profit).toEqual({ limit_price: '0.94' });
      // String(0.3) drops the trailing zero — Alpaca accepts either form.
      expect(body.stop_loss).toEqual({ stop_price: '0.3' });
      // Identify legs by their type, not array position — defensive against
      // Alpaca ever changing the response ordering.
      expect(result.entry.id).toBe('parent-1');
      expect(result.target.id).toBe('leg-target');
      expect(result.stop.id).toBe('leg-stop');
    });

    it('limit entry includes limit_price on the parent body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'parent-2',
          symbol: 'AGAE',
          status: 'accepted',
          side: 'buy',
          legs: [
            { id: 't', symbol: 'AGAE', status: 'held', side: 'sell', type: 'limit' },
            { id: 's', symbol: 'AGAE', status: 'held', side: 'sell', type: 'stop' },
          ],
        }),
      });

      await alpacaOrderService.submitBracketOrder({
        symbol: 'AGAE',
        qty: 50,
        side: 'buy',
        type: 'limit',
        entryLimitPrice: 0.50,
        targetPrice: 0.94,
        stopPrice: 0.30,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // String(0.5) → '0.5'; trailing zero dropped.
      expect(body.limit_price).toBe('0.5');
    });

    it('throws when Alpaca response is missing one of the bracket legs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'parent-3',
          symbol: 'AGAE',
          status: 'accepted',
          side: 'buy',
          legs: [
            // Only the target leg — broker rejected the stop somehow.
            { id: 't', symbol: 'AGAE', status: 'held', side: 'sell', type: 'limit' },
          ],
        }),
      });

      await expect(
        alpacaOrderService.submitBracketOrder({
          symbol: 'AGAE',
          qty: 50,
          side: 'buy',
          type: 'market',
          targetPrice: 0.94,
          stopPrice: 0.30,
        }),
      ).rejects.toThrow(/missing legs/);
    });
  });

  describe('replaceStopLeg', () => {
    it('PATCHes /v2/orders/{id} with the new stop_price', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'leg-stop', symbol: 'AGAE', status: 'held', side: 'sell', type: 'stop' }),
      });

      const newId = await alpacaOrderService.replaceStopLeg('leg-stop', 0.55);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(String(url)).toContain('/v2/orders/leg-stop');
      expect(init.method).toBe('PATCH');
      const body = JSON.parse(init.body);
      // Alpaca preserves the leg id on PATCH; the bracket relationship
      // stays intact (target/stop OCO pair is still linked).
      expect(body).toEqual({ stop_price: '0.55' });
      expect(newId).toBe('leg-stop');
    });

    it('throws on broker rejection so the caller can retry next cycle', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => '{"message":"trailing too tight"}',
      });
      await expect(alpacaOrderService.replaceStopLeg('leg-stop', 0.99)).rejects.toThrow(
        /Alpaca replaceStopLeg error: 422/,
      );
    });
  });

  describe('getPositions', () => {
    it('maps position response to typed objects', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { symbol: 'AGAE', qty: '100', avg_entry_price: '0.44', current_price: '0.52', market_value: '52.00', unrealized_pl: '8.00' },
        ],
      });

      const positions = await alpacaOrderService.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe('AGAE');
      expect(positions[0].qty).toBe(100);
      expect(positions[0].avgEntryPrice).toBe(0.44);
      expect(positions[0].currentPrice).toBe(0.52);
      expect(positions[0].unrealizedPl).toBe(8);
    });
  });

  describe('cancelOrder', () => {
    it('sends DELETE to order endpoint', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await alpacaOrderService.cancelOrder('order-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/orders/order-123',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('closePosition', () => {
    it('sends DELETE to position endpoint', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await alpacaOrderService.closePosition('AGAE');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/positions/AGAE',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('closeAllPositions', () => {
    it('sends DELETE to positions endpoint', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await alpacaOrderService.closeAllPositions();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/positions',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getOrder', () => {
    it('fetches order by ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'order-123', symbol: 'AGAE', status: 'filled', filled_avg_price: '0.45', filled_qty: '100' }),
      });

      const order = await alpacaOrderService.getOrder('order-123');
      expect(order.id).toBe('order-123');
      expect(order.symbol).toBe('AGAE');
      expect(order.status).toBe('filled');
      expect(order.filledAvgPrice).toBe(0.45);
      expect(order.filledQty).toBe(100);
    });
  });

  describe('getOpenOrders', () => {
    it('fetches open orders with symbols', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'order-a', symbol: 'AGAE', status: 'new', filled_avg_price: null, filled_qty: null },
          { id: 'order-b', symbol: 'IMMP', status: 'new', filled_avg_price: null, filled_qty: null },
        ],
      });

      const orders = await alpacaOrderService.getOpenOrders();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://paper-api.alpaca.markets/v2/orders?status=open',
        expect.any(Object),
      );
      expect(orders).toHaveLength(2);
      expect(orders[0].symbol).toBe('AGAE');
      expect(orders[1].symbol).toBe('IMMP');
    });
  });
});
