import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrokerOrder } from '../types/broker.js';

const tempDir = mkdtempSync(join(tmpdir(), 'oracle-journal-history-'));

const { mockConfig, getOrdersSinceMock } = vi.hoisted(() => ({
  mockConfig: {
    recording: { enabled: true, dir: '' },
    market_hours: { timezone: 'America/New_York' },
    execution: { paper: true },
  },
  getOrdersSinceMock: vi.fn<() => Promise<unknown[]>>(async () => []),
}));
mockConfig.recording.dir = tempDir;

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../services/brokers/index.js', () => ({
  brokerService: { getOrdersSince: getOrdersSinceMock },
}));

import { JournalHistoryService } from '../services/journalHistoryService.js';
import { tradeReconciliationService } from '../services/tradeReconciliationService.js';

function cycle(ts: string, tradingDay: string, closed: Array<{ symbol: string; pnl: number }>) {
  return {
    ts,
    tsEt: ts,
    tradingDay,
    marketStatus: { isOpen: true, openTime: '', closeTime: '' },
    items: [],
    decisions: [],
    activeTrades: [],
    closedTrades: closed.map((t) => ({
      symbol: t.symbol,
      strategy: 'momentum_continuation',
      entryPrice: 10,
      entryTime: ts,
      exitPrice: 10 + t.pnl,
      exitTime: ts,
      shares: 1,
      riskPerShare: 1,
      pnl: t.pnl,
      pnlPct: t.pnl * 10,
      rMultiple: t.pnl,
      exitReason: 'target',
      exitDetail: '',
      rationale: [],
    })),
  };
}

describe('JournalHistoryService', () => {
  const svc = new JournalHistoryService();

  beforeEach(() => {
    getOrdersSinceMock.mockReset();
    getOrdersSinceMock.mockResolvedValue([]);
    tradeReconciliationService.invalidate();
  });

  it('returns the last cycle of the day as closed trades', async () => {
    const day = '2026-04-15';
    writeFileSync(
      join(tempDir, `${day}.jsonl`),
      [
        JSON.stringify(cycle('2026-04-15T13:30:00Z', day, [{ symbol: 'AAA', pnl: 10 }])),
        JSON.stringify(cycle('2026-04-15T19:59:00Z', day, [
          { symbol: 'AAA', pnl: 10 },
          { symbol: 'BBB', pnl: -5 },
        ])),
        '',
      ].join('\n'),
    );

    const result = await svc.getDay(day);
    expect(result).not.toBeNull();
    expect(result!.closed).toHaveLength(2);
    expect(result!.closed.map((t) => t.symbol)).toEqual(['AAA', 'BBB']);
    expect(result!.lastCycleAt).toBe('2026-04-15T19:59:00Z');
    expect(result!.reconciled).toBe(true);
  });

  it('returns null when the date has no recording file', async () => {
    expect(await svc.getDay('2020-01-01')).toBeNull();
  });

  it('rejects malformed dates', async () => {
    expect(await svc.getDay('not-a-date')).toBeNull();
  });

  it('lists recorded days plus today, newest first', () => {
    writeFileSync(join(tempDir, '2026-04-14.jsonl'), '{"ts":"x","closedTrades":[]}\n');
    const days = svc.listDays();
    expect(days[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(days).toContain('2026-04-15');
    expect(days).toContain('2026-04-14');
    for (let i = 1; i < days.length; i++) {
      expect(days[i - 1].localeCompare(days[i])).toBeGreaterThanOrEqual(0);
    }
  });

  it('rewrites placeholder exit prices with real Alpaca fills', async () => {
    const day = '2026-04-16';
    writeFileSync(
      join(tempDir, `${day}.jsonl`),
      JSON.stringify(cycle('2026-04-16T20:00:00Z', day, [{ symbol: 'CCC', pnl: 0 }])) + '\n',
    );

    const fill: BrokerOrder = {
      id: 'order-1',
      symbol: 'CCC',
      status: 'filled',
      side: 'sell',
      filledAvgPrice: 12,
      filledQty: 1,
      filledAt: '2026-04-16T20:00:30Z',
      submittedAt: '2026-04-16T20:00:29Z',
    };
    getOrdersSinceMock.mockResolvedValue([fill]);

    const result = await svc.getDay(day);
    expect(result).not.toBeNull();
    expect(result!.closed[0].exitPrice).toBe(12);
    expect(result!.closed[0].pnl).toBe(2);
    // Phase 1 broker-adapter rename: the message is now broker-neutral and
    // includes the active adapter's `name`. Match the pattern rather than
    // the literal so this test doesn't have to change again on Phase 2.
    expect(result!.closed[0].exitDetail).toMatch(/Reconciled from \w+ fill/i);
    expect(result!.reconciled).toBe(true);
  });
});
