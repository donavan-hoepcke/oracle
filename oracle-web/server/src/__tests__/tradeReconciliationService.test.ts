import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfig, getOrdersSinceMock } = vi.hoisted(() => ({
  mockConfig: {
    market_hours: { timezone: 'America/New_York' },
    execution: { paper: true },
  },
  getOrdersSinceMock: vi.fn<() => Promise<unknown[]>>(async () => []),
}));

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../services/alpacaOrderService.js', () => ({
  alpacaOrderService: { getOrdersSince: getOrdersSinceMock },
}));

import {
  applyFillsToLedger,
  TradeReconciliationService,
} from '../services/tradeReconciliationService.js';
import type { TradeLedgerEntry } from '../services/executionService.js';
import type { AlpacaOrder } from '../services/alpacaOrderService.js';

function trade(overrides: Partial<TradeLedgerEntry> = {}): TradeLedgerEntry {
  return {
    symbol: 'AAA',
    strategy: 'momentum_continuation',
    entryPrice: 10,
    entryTime: new Date('2026-04-16T14:00:00Z'),
    exitPrice: 10,
    exitTime: new Date('2026-04-16T20:00:00Z'),
    shares: 100,
    riskPerShare: 0.5,
    pnl: 0,
    pnlPct: 0,
    rMultiple: 0,
    exitReason: 'eod',
    exitDetail: 'End-of-day flatten',
    rationale: [],
    ...overrides,
  };
}

function sellFill(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'fill-1',
    symbol: 'AAA',
    status: 'filled',
    side: 'sell',
    filledAvgPrice: 11,
    filledQty: 100,
    filledAt: '2026-04-16T20:00:05Z',
    submittedAt: '2026-04-16T20:00:00Z',
    ...overrides,
  };
}

describe('applyFillsToLedger', () => {
  it('rewrites exitPrice/pnl/rMultiple from the matching sell fill', () => {
    const { reconciled, changed } = applyFillsToLedger([trade()], [sellFill()]);
    expect(changed).toBe(1);
    expect(reconciled[0].exitPrice).toBe(11);
    expect(reconciled[0].pnl).toBe(100);
    expect(reconciled[0].pnlPct).toBeCloseTo(10);
    expect(reconciled[0].rMultiple).toBe(2);
    expect(reconciled[0].exitDetail).toContain('reconciled from Alpaca fill');
  });

  it('ignores buy fills, unfilled orders, and symbol/qty mismatches', () => {
    const { changed } = applyFillsToLedger(
      [trade()],
      [
        sellFill({ id: 'b1', side: 'buy' }),
        sellFill({ id: 'b2', status: 'canceled' }),
        sellFill({ id: 'b3', symbol: 'BBB' }),
        sellFill({ id: 'b4', filledQty: 50 }),
      ],
    );
    expect(changed).toBe(0);
  });

  it('ignores sell fills that happened before the entry', () => {
    const { changed } = applyFillsToLedger(
      [trade()],
      [sellFill({ filledAt: '2026-04-16T13:00:00Z' })],
    );
    expect(changed).toBe(0);
  });

  it('does not double-claim a single fill for two trades', () => {
    const t1 = trade({ entryTime: new Date('2026-04-16T14:00:00Z') });
    const t2 = trade({ entryTime: new Date('2026-04-16T15:00:00Z') });
    const { reconciled, changed } = applyFillsToLedger([t1, t2], [sellFill()]);
    expect(changed).toBe(1);
    const rewritten = reconciled.filter((t) => t.exitPrice === 11);
    expect(rewritten).toHaveLength(1);
  });

  it('skips trades whose recorded exit already matches the fill', () => {
    const { changed } = applyFillsToLedger(
      [trade({ exitPrice: 11 })],
      [sellFill()],
    );
    expect(changed).toBe(0);
  });

  it('preserves the existing exitDetail prefix when reconciling', () => {
    const { reconciled } = applyFillsToLedger(
      [trade({ exitDetail: 'Original note' })],
      [sellFill()],
    );
    expect(reconciled[0].exitDetail).toBe('Original note (reconciled from Alpaca fill)');
  });
});

describe('TradeReconciliationService.reconcileDay', () => {
  beforeEach(() => {
    getOrdersSinceMock.mockReset();
    getOrdersSinceMock.mockResolvedValue([]);
  });

  it('returns trades unchanged on Alpaca fetch failure', async () => {
    getOrdersSinceMock.mockRejectedValueOnce(new Error('boom'));
    const svc = new TradeReconciliationService();
    const trades = [trade()];
    const result = await svc.reconcileDay('2026-04-16', trades);
    expect(result.changed).toBe(0);
    expect(result.reconciled).toBe(false);
    expect(result.trades[0].exitPrice).toBe(10);
  });

  it('caches reconciled rows so a second call does not refetch', async () => {
    getOrdersSinceMock.mockResolvedValue([sellFill()]);
    const svc = new TradeReconciliationService();
    const trades = [trade()];
    const first = await svc.reconcileDay('2026-04-16', trades);
    expect(first.changed).toBe(1);
    const second = await svc.reconcileDay('2026-04-16', trades);
    expect(second.changed).toBe(0);
    expect(second.reconciled).toBe(true);
    expect(second.trades[0].exitPrice).toBe(11);
    expect(getOrdersSinceMock).toHaveBeenCalledTimes(1);
  });

  it('short-circuits empty ledgers', async () => {
    const svc = new TradeReconciliationService();
    const result = await svc.reconcileDay('2026-04-16', []);
    expect(result.changed).toBe(0);
    expect(getOrdersSinceMock).not.toHaveBeenCalled();
  });
});
