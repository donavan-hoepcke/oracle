import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock config
vi.mock('../config.js', () => ({
  config: { execution: { paper: true } },
  alpacaApiKeyId: 'test-key',
  alpacaApiSecretKey: 'test-secret',
}));

import { alpacaOrderService } from '../services/alpacaOrderService.js';

beforeEach(() => {
  mockFetch.mockReset();
});

describe('AlpacaOrderService', () => {
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
