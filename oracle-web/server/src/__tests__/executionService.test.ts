import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      enabled: true,
      paper: true,
      risk_per_trade: 100,
      max_trade_cost: 0,
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.05,
      max_risk_pct: 0.10,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      momentum_max_chase_pct: 0.05,
      cooldown_after_stop_ms: 60 * 60 * 1000,
      require_uptrend_for_momentum: true,
      wash_sale_lookback_days: 30,
      wash_sale_min_score: 75,
      wash_sale_min_rr: 3.0,
      wash_sale_require_no_chase: true,
      trailing_breakeven_r: 1.0,
      trailing_start_r: 2.0,
      trailing_distance_r: 1.0,
      trailing_mfe_activate_r: 0.5,
      trailing_mfe_giveback_pct: 0.5,
      eod_flatten_time: '15:50',
    },
    market_hours: { timezone: 'America/New_York' },
  },
}));

const mockOrderService = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getPositions: vi.fn(),
  getOpenOrders: vi.fn(),
  getOrdersSince: vi.fn(),
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
    mockOrderService.getOrdersSince.mockResolvedValue([]);
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

    it('does not place new entries while paused', async () => {
      service.setEnabled(false);

      await service.onPriceCycle([makeCandidate('AGAE', 0.50, 0.45, 0.94)], [makeStockState('AGAE', 0.50)]);

      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
      expect(service.getActiveTrades()).toHaveLength(0);
    });
  });

  describe('trailing stop', () => {
    it('moves stop past breakeven at 1R (MFE lock dominates)', async () => {
      // Risk=10% (entry 0.50, stop 0.45) to stay within the max_risk_pct clamp
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);

      // Simulate fill
      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price moves to 1R (0.50 + 0.05 = 0.55). MFE lock at 50% giveback
      // pulls the stop to entry + 0.5R = 0.525, which beats the bare-breakeven
      // 0.50. State marker flips to 'breakeven' to reflect the tier progression.
      await service.onPriceCycle([], [makeStockState('AGAE', 0.55)]);

      const trade = service.getActiveTrades().find(t => t.symbol === 'AGAE');
      expect(trade?.currentStop).toBeCloseTo(0.525, 3);
      expect(trade?.trailingState).toBe('breakeven');
    });

    it('does not move stop when MFE stays below the give-back activation threshold', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Peak 0.4R = 0.50 + 0.4 * 0.05 = 0.52 (below 0.5R activate)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.52)]);

      const trade = service.getActiveTrades().find((t) => t.symbol === 'AGAE');
      expect(trade?.currentStop).toBeCloseTo(0.45, 3);
      expect(trade?.trailingState).toBe('initial');
      expect(trade?.maxFavorableR).toBeCloseTo(0.4, 3);
    });

    it('locks in 50% of peak gain once MFE crosses 0.5R and holds on pullback', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Peak 0.6R (0.50 + 0.6 * 0.05 = 0.53)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.53)]);
      // Pull back to 0.4R (0.52)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.52)]);

      const trade = service.getActiveTrades().find((t) => t.symbol === 'AGAE');
      // Stop = entry + 0.6R * (1 - 0.5) = 0.50 + 0.015 = 0.515
      expect(trade?.currentStop).toBeCloseTo(0.515, 3);
      expect(trade?.trailingState).toBe('mfe_lock');
      expect(trade?.maxFavorableR).toBeCloseTo(0.6, 3);
    });

    it('exits via trailing_stop when a post-peak pullback crosses the MFE lock', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Peak 0.8R (0.54), lock = entry + 0.4R = 0.52
      await service.onPriceCycle([], [makeStockState('AGAE', 0.54)]);
      // Pullback to 0.515 — below the 0.52 lock
      await service.onPriceCycle([], [makeStockState('AGAE', 0.515)]);

      expect(mockOrderService.closePosition).toHaveBeenCalledWith('AGAE');
      const ledger = service.getLedger();
      expect(ledger).toHaveLength(1);
      expect(ledger[0].exitReason).toBe('trailing_stop');
      expect(ledger[0].pnl).toBeGreaterThan(0);
    });

    it('keeps the 1R breakeven tier when MFE lock is tighter-or-equal at 1R', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Peak at exactly 1R (0.55). MFE stop = entry + 0.5R = 0.525, breakeven = 0.50.
      // The 1R tier flips the state label to 'breakeven' as a progression marker,
      // but the MFE lock is tighter so it wins the currentStop via Math.max.
      await service.onPriceCycle([], [makeStockState('AGAE', 0.55)]);

      const trade = service.getActiveTrades().find((t) => t.symbol === 'AGAE');
      expect(trade?.currentStop).toBeCloseTo(0.525, 3);
      expect(trade?.trailingState).toBe('breakeven');
    });

    it('trails at 1R behind after 2R', async () => {
      // Risk=10% (entry 0.50, stop 0.45) to stay within the max_risk_pct clamp
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      const stocks = [makeStockState('AGAE', 0.50)];
      await service.onPriceCycle(candidates, stocks);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price at 2R (0.50 + 0.10 = 0.60)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.60)]);

      const trade = service.getActiveTrades().find(t => t.symbol === 'AGAE');
      // currentStop = 0.60 - 1R(0.05) = 0.55
      expect(trade?.currentStop).toBeCloseTo(0.55, 3);
      expect(trade?.trailingState).toBe('trailing');
    });
  });

  describe('exit', () => {
    it('exits when price hits stop', async () => {
      // Risk=10% to stay within max_risk_pct clamp
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price drops below stop (0.45)
      await service.onPriceCycle([], [makeStockState('AGAE', 0.44)]);

      expect(mockOrderService.closePosition).toHaveBeenCalledWith('AGAE');
      expect(service.getActiveTrades()).toHaveLength(0);
      expect(service.getLedger()).toHaveLength(1);
      expect(service.getLedger()[0].exitReason).toBe('stop');
    });

    it('continues managing an open position while paused', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      service.setEnabled(false);
      await service.onPriceCycle([], [makeStockState('AGAE', 0.44)]);

      expect(mockOrderService.closePosition).toHaveBeenCalledWith('AGAE');
      expect(service.getActiveTrades()).toHaveLength(0);
      expect(service.getLedger()).toHaveLength(1);
      expect(service.getLedger()[0].exitReason).toBe('stop');
    });
  });

  describe('wash-sale awareness', () => {
    function makeFilledOrder(symbol: string) {
      return { id: `o-${symbol}`, symbol, status: 'filled', filledAvgPrice: 1.0, filledQty: 100 };
    }

    it('blocks entry when score below wash_sale_min_score', async () => {
      mockOrderService.getOrdersSince.mockResolvedValue([makeFilledOrder('AGAE')]);
      const candidate = makeCandidate('AGAE', 0.50, 0.48, 2.00);
      candidate.score = 60; // below 75 threshold
      candidate.snapshot.buyZonePrice = 0.50;

      await service.onPriceCycle([candidate], [makeStockState('AGAE', 0.50)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
      const rej = service.getRejections().find((r) => r.symbol === 'AGAE');
      expect(rej?.reason).toContain('wash-sale risk: score');
    });

    it('blocks entry when R:R below wash_sale_min_rr', async () => {
      mockOrderService.getOrdersSince.mockResolvedValue([makeFilledOrder('AGAE')]);
      // risk = 0.50 - 0.47 = 0.03; reward = 0.55 - 0.50 = 0.05; R:R ~ 1.67 (< 3.0)
      const candidate = makeCandidate('AGAE', 0.50, 0.47, 0.55);
      candidate.score = 80;
      candidate.snapshot.buyZonePrice = 0.50;

      await service.onPriceCycle([candidate], [makeStockState('AGAE', 0.50)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
      const rej = service.getRejections().find((r) => r.symbol === 'AGAE');
      expect(rej?.reason).toContain('wash-sale risk: R:R');
    });

    it('blocks entry when chasing above buy zone', async () => {
      mockOrderService.getOrdersSince.mockResolvedValue([makeFilledOrder('AGAE')]);
      // entry above buy zone
      const candidate = makeCandidate('AGAE', 0.55, 0.50, 0.80);
      candidate.score = 80;
      candidate.snapshot.buyZonePrice = 0.50; // entry 0.55 is above

      await service.onPriceCycle([candidate], [makeStockState('AGAE', 0.55)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
      const rej = service.getRejections().find((r) => r.symbol === 'AGAE');
      expect(rej?.reason).toContain('chasing');
    });

    it('allows entry when all wash-sale bars are met', async () => {
      mockOrderService.getOrdersSince.mockResolvedValue([makeFilledOrder('AGAE')]);
      // high score, good R:R (= 5), entry at buy zone
      const candidate = makeCandidate('AGAE', 0.50, 0.48, 0.60);
      candidate.score = 80;
      candidate.snapshot.buyZonePrice = 0.50;

      await service.onPriceCycle([candidate], [makeStockState('AGAE', 0.50)]);
      expect(mockOrderService.submitOrder).toHaveBeenCalled();
    });

    it('does not apply wash-sale bar to symbols not recently traded', async () => {
      mockOrderService.getOrdersSince.mockResolvedValue([]); // no recent orders
      const candidate = makeCandidate('AGAE', 0.50, 0.48, 0.55);
      candidate.score = 50; // below wash_sale_min_score but not applicable
      candidate.snapshot.buyZonePrice = 0.50;

      await service.onPriceCycle([candidate], [makeStockState('AGAE', 0.50)]);
      expect(mockOrderService.submitOrder).toHaveBeenCalled();
    });
  });

  describe('cooldown after stop', () => {
    it('blocks same-session re-entry for a symbol that just stopped out', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price drops below stop -> bot exits
      await service.onPriceCycle([], [makeStockState('AGAE', 0.44)]);
      expect(service.getActiveTrades()).toHaveLength(0);
      expect(service.getLedger()).toHaveLength(1);

      // Next cycle, same symbol shows up as a candidate -> must be blocked
      mockOrderService.submitOrder.mockClear();
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.52)]);
      expect(mockOrderService.submitOrder).not.toHaveBeenCalled();
      expect(service.getCooldownSymbols().map((c) => c.symbol)).toContain('AGAE');
    });

    it('does not block re-entry for a symbol that exited on target', async () => {
      const candidates = [makeCandidate('AGAE', 0.50, 0.45, 0.60)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);

      mockOrderService.getOrder.mockResolvedValue({ id: 'order-1', status: 'filled', filledAvgPrice: 0.50, filledQty: 100 });
      await service.onPriceCycle([], [makeStockState('AGAE', 0.50)]);

      // Price reaches target -> clean exit, no cooldown
      await service.onPriceCycle([], [makeStockState('AGAE', 0.61)]);
      expect(service.getLedger()[0].exitReason).toBe('target');
      expect(service.getCooldownSymbols().map((c) => c.symbol)).not.toContain('AGAE');
    });
  });

  describe('reconciliation', () => {
    it('adopts an orphaned Alpaca position into activeTrades', async () => {
      mockOrderService.getPositions.mockResolvedValue([
        { symbol: 'ORPHAN', qty: 500, avgEntryPrice: 2.00, currentPrice: 2.10, marketValue: 1050, unrealizedPl: 50 },
      ]);

      await service.onPriceCycle([], [makeStockState('ORPHAN', 2.10)]);

      const active = service.getActiveTrades();
      expect(active).toHaveLength(1);
      const adopted = active[0];
      expect(adopted.symbol).toBe('ORPHAN');
      expect(adopted.entryPrice).toBe(2.00);
      expect(adopted.status).toBe('filled');
      // Default stop uses max_risk_pct (10%) when no watchlist stop available
      expect(adopted.initialStop).toBeCloseTo(1.80, 3);
      expect(adopted.shares).toBe(500);
    });

    it('does not re-adopt a position already in activeTrades', async () => {
      mockOrderService.getPositions.mockResolvedValueOnce([]);
      const candidates = [makeCandidate('AGAE', 0.50, 0.30, 0.94)];
      await service.onPriceCycle(candidates, [makeStockState('AGAE', 0.50)]);
      expect(service.getActiveTrades()).toHaveLength(1);

      // Now Alpaca reports the same symbol as a position
      mockOrderService.getPositions.mockResolvedValue([
        { symbol: 'AGAE', qty: 100, avgEntryPrice: 0.50, currentPrice: 0.52, marketValue: 52, unrealizedPl: 2 },
      ]);

      await service.onPriceCycle([], [makeStockState('AGAE', 0.52)]);
      expect(service.getActiveTrades()).toHaveLength(1);
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

  describe('hydrateLedger', () => {
    const entry = (symbol: string, entryTime: string, pnl: number) =>
      ({
        symbol,
        strategy: 'momentum_continuation' as const,
        entryPrice: 1,
        entryTime: entryTime as unknown as Date,
        exitPrice: 1 + pnl,
        exitTime: entryTime as unknown as Date,
        shares: 100,
        riskPerShare: 1,
        pnl,
        pnlPct: pnl * 100,
        rMultiple: pnl,
        exitReason: 'target' as const,
        exitDetail: '',
        rationale: [],
      });

    it('imports entries, normalizes dates, and contributes to daily P&L', () => {
      service.hydrateLedger([
        entry('AAA', '2026-04-21T13:30:00.000Z', 10),
        entry('BBB', '2026-04-21T14:00:00.000Z', -4),
      ]);
      const ledger = service.getLedger();
      expect(ledger).toHaveLength(2);
      expect(ledger[0].entryTime).toBeInstanceOf(Date);
      expect(ledger[0].exitTime).toBeInstanceOf(Date);
      expect(service.getDailyPnl()).toBeCloseTo(6, 5);
    });

    it('dedupes on symbol + entryTime across repeated hydrations', () => {
      const first = entry('AAA', '2026-04-21T13:30:00.000Z', 10);
      service.hydrateLedger([first]);
      const added = service.hydrateLedger([first, entry('CCC', '2026-04-21T15:00:00.000Z', 7)]);
      expect(added).toBe(1);
      expect(service.getLedger()).toHaveLength(2);
      expect(service.getLedger().map((e) => e.symbol).sort()).toEqual(['AAA', 'CCC']);
    });
  });
});
