import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

vi.mock('../config.js', () => ({
  config: {
    recording: { dir: '' },
    execution: {
      regime: {
        trade_history_max_trades: 20,
        trade_history_max_calendar_days: 30,
      },
    },
  },
}));

import { TradeHistoryService } from '../services/tradeHistoryService.js';
import type { CycleRecord } from '../services/recordingService.js';
import type { TradeLedgerEntry } from '../services/executionService.js';

function makeLedgerEntry(overrides: Partial<TradeLedgerEntry>): TradeLedgerEntry {
  return {
    symbol: 'ABC',
    strategy: 'orb_breakout',
    entryPrice: 1.0,
    entryTime: new Date('2026-04-01T14:00:00Z'),
    exitPrice: 1.1,
    exitTime: new Date('2026-04-01T15:00:00Z'),
    shares: 100,
    riskPerShare: 0.05,
    pnl: 10,
    pnlPct: 0.1,
    rMultiple: 2.0,
    exitReason: 'target',
    exitDetail: '',
    rationale: [],
    ...overrides,
  };
}

function writeCycleFile(dir: string, day: string, records: Array<Partial<CycleRecord>>): void {
  const lines = records
    .map((r) => JSON.stringify({
      ts: `${day}T14:00:00Z`,
      tsEt: '10:00:00',
      tradingDay: day,
      marketStatus: { isOpen: true, openTime: '09:30', closeTime: '16:00' },
      items: [],
      decisions: [],
      activeTrades: [],
      closedTrades: [],
      ...r,
    }))
    .join('\n');
  writeFileSync(resolve(dir, `${day}.jsonl`), lines + '\n', 'utf-8');
}

describe('TradeHistoryService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'th-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns closed trades for matching symbol+setup', async () => {
    writeCycleFile(dir, '2026-04-15', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', strategy: 'orb_breakout', pnl: 5 })] },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades).toHaveLength(1);
    expect(trades[0].pnl).toBe(5);
  });

  it('excludes files with day >= now', async () => {
    writeCycleFile(dir, '2026-04-15', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 5 })] },
    ]);
    writeCycleFile(dir, '2026-04-20', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 99 })] },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades.map((t) => t.pnl)).toEqual([5]);
  });

  it('filters by symbol and setup', async () => {
    writeCycleFile(dir, '2026-04-15', [
      {
        closedTrades: [
          makeLedgerEntry({ symbol: 'ABC', strategy: 'orb_breakout' }),
          makeLedgerEntry({ symbol: 'ABC', strategy: 'momentum_continuation' }),
          makeLedgerEntry({ symbol: 'XYZ', strategy: 'orb_breakout' }),
        ],
      },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('ABC');
    expect(trades[0].strategy).toBe('orb_breakout');
  });

  it('respects maxCalendarDays window', async () => {
    writeCycleFile(dir, '2026-03-01', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 1 })] },
    ]);
    writeCycleFile(dir, '2026-04-15', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 2 })] },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades(
      'ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'),
      { maxCalendarDays: 30 },
    );
    expect(trades.map((t) => t.pnl)).toEqual([2]);
  });

  it('respects maxTrades cap (keeps most recent)', async () => {
    writeCycleFile(dir, '2026-04-15', [{
      closedTrades: Array.from({ length: 10 }, (_, i) => makeLedgerEntry({ symbol: 'ABC', pnl: i })),
    }]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'), { maxTrades: 3 });
    expect(trades.map((t) => t.pnl)).toEqual([7, 8, 9]);
  });

  it('handles malformed lines gracefully', async () => {
    writeFileSync(resolve(dir, '2026-04-15.jsonl'), 'not json\n{bad}\n', 'utf-8');
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades).toEqual([]);
  });

  it('returns empty list when recording dir is missing', async () => {
    const service = new TradeHistoryService('/nonexistent/path/xxx');
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date());
    expect(trades).toEqual([]);
  });
});
