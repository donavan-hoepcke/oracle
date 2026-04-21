import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempDir = mkdtempSync(join(tmpdir(), 'oracle-journal-history-'));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    recording: { enabled: true, dir: '' },
    market_hours: { timezone: 'America/New_York' },
  },
}));
mockConfig.recording.dir = tempDir;

vi.mock('../config.js', () => ({ config: mockConfig }));

import { JournalHistoryService } from '../services/journalHistoryService.js';

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

  it('returns the last cycle of the day as closed trades', () => {
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

    const result = svc.getDay(day);
    expect(result).not.toBeNull();
    expect(result!.closed).toHaveLength(2);
    expect(result!.closed.map((t) => t.symbol)).toEqual(['AAA', 'BBB']);
    expect(result!.lastCycleAt).toBe('2026-04-15T19:59:00Z');
  });

  it('returns null when the date has no recording file', () => {
    expect(svc.getDay('2020-01-01')).toBeNull();
  });

  it('rejects malformed dates', () => {
    expect(svc.getDay('not-a-date')).toBeNull();
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
});
