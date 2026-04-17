import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      enabled: true,
      paper: true,
      risk_per_trade: 100,
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.05,
      max_risk_pct: 0.10,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      trailing_breakeven_r: 1.0,
      trailing_start_r: 2.0,
      trailing_distance_r: 1.0,
      eod_flatten_time: '15:50',
    },
    market_hours: { timezone: 'America/New_York' },
  },
}));

const mockOrderService = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getPositions: vi.fn(),
  getOpenOrders: vi.fn(),
  submitOrder: vi.fn(),
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
  closePosition: vi.fn(),
  closeAllPositions: vi.fn(),
}));

vi.mock('../services/alpacaOrderService.js', () => ({
  alpacaOrderService: mockOrderService,
}));

vi.mock('../services/tradeFilterService.js', () => ({
  tradeFilterService: {
    filterCandidate: vi.fn().mockReturnValue({ passed: true, reason: null }),
    calculatePositionSize: vi.fn().mockReturnValue({ shares: 100, costBasis: 50 }),
  },
}));

import { ExecutionService } from '../services/executionService.js';
import { tradeFilterService } from '../services/tradeFilterService.js';
import type { TradeCandidate } from '../services/ruleEngineService.js';
import type { StockState } from '../websocket/priceSocket.js';

function makeCandidate(symbol: string, entry: number, stop: number, target: number): TradeCandidate {
  return {
    symbol,
    score: 70,
    setup: 'momentum_continuation',
    rationale: [],
    oracleScore: 50,
    messageScore: 50,
    executionScore: 50,
    messageContext: { symbol, mentionCount: 0, convictionScore: 0, tagCounts: {}, latestMessages: [], lastMentionAt: null },
    snapshot: { currentPrice: entry, buyZonePrice: entry, stopPrice: stop, sellZonePrice: target, profitDeltaPct: null, trend30m: 'up' },
    suggestedEntry: entry,
    suggestedStop: stop,
    suggestedTarget: target,
  } as TradeCandidate;
}

function makeStockState(symbol: string, price: number): StockState {
  return { symbol, currentPrice: price } as StockState;
}

describe('ExecutionService', () => {
  let service: ExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderService.getAccount.mockResolvedValue({ cash: 10000, portfolioValue: 10000, buyingPower: 10000 });
    mockOrderService.getPositions.mockResolvedValue([]);
    mockOrderService.getOpenOrders.mockResolvedValue([]);
    mockOrderService.submitOrder.mockResolvedValue({ id: 'order-1', symbol: 'AGAE', status: 'accepted', filledAvgPrice: null, filledQty: null });
    service = new ExecutionService();
  });

  describe('entry', () => {
    it('places an order for a passing candidate', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.30, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];

      await service.onPriceCycle(candidates, stocks);

      expect(mockOrderService.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'AGAE', side: 'buy', qty: 100 }),
      );
      expect(service.getActiveTrades()).toHaveLength(1);
      expect(service.getActiveTrades()[0].symbol).toBe('AGAE');
    });

    it('skips candidate that fails filter', async () => {
      vi.mocked(tradeFilterService.filterCandidate).mockReturnValueOnce({ passed: false, reason: 'risk too high' });
      const candidates = [makeCandidate('HUBC', 0.226, 0.11, 0.37)];
      await service.onPriceCycle(candidates, [makeStockState('HUBC', 0.226)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
    });

    it('skips candidate if Alpaca already has a position in that symbol', async () => {
      mockOrderService.getPositions.mockResolvedValue([
        { symbol: 'AGAE', qty: 100, avgEntryPrice: 0.5, currentPrice: 0.52, marketValue: 52, unrealizedPl: 2 },
      ]);
      const candidates = [makeCandidate('AGAE', 0.50, 0.30, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
    });

    it('skips candidate if Alpaca already has an open order for that symbol', async () => {
      mockOrderService.getOpenOrders.mockResolvedValue([
        { id: 'order-x', symbol: 'AGAE', status: 'new', filledAvgPrice: null, filledQty: null },
      ]);
      const candidates = [makeCandidate('AGAE', 0.50, 0.30, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
    });

    it('does not duplicate entry for symbol already in active trades', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.30, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);
      await service.onPriceCycle(candidates, stocks);
      expect(mockOrderService.submitOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('trailing stop', () => {
    it('moves stop to breakeven at 1R', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.40, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);

      // Simulate fill
      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price moves to 1R (0.50 + 0.10 = 0.60)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.60)]);

      const trade = service.getActiveTrades().find(t => t.symbol === 'AGAE');
      expect(trade?.currentStop).toBe(0.50);
      expect(trade?.trailingState).toBe('breakeven');
    });

    it('trails at 1R behind after 2R', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.40, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price at 2R (0.50 + 0.20 = 0.70)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.70)]);

      const trade = service.getActiveTrades().find(t => t.symbol === 'AGAE');
      // currentStop = 0.70 - 1R(0.10) = 0.60
      expect(trade?.currentStop).toBe(0.60);
      expect(trade?.trailingState).toBe('trailing');
    });
  });

  describe('exit', () => {
    it('exits when price hits stop', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.40, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price drops to stop
      await service.onPriceCycle([], [makeStockState('AGAE', 0.39)]);

      expect(mockOrderService.closePosition).toHaveBeenCalledWith('AGAE');
      expect(service.getActiveTrades()).toHaveLength(0);
      expect(service.getLedger()).toHaveLength(1);
      expect(service.getLedger()[0].exitReason).toBe('stop');
    });
  });

  describe('circuit breaker', () => {
    it('blocks new entries after exceeding daily drawdown', async () => {
      vi.mocked(tradeFilterService.filterCandidate).mockReturnValue({ passed: false, reason: 'drawdown exceeded' });
      const candidates = [makeCandidate('TEST', 1.00, 0.95, 1.50)];
      await service.onPriceCycle(candidates, [makeStockState('TEST', 1.00)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
    });
  });
});
