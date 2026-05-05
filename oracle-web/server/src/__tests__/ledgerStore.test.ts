import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// vi.mock and any state it references is hoisted to the top of the file
// before regular imports are initialized. We have to create the temp dir
// inside vi.hoisted(), and require its dependencies inside that block too
// so they're available before the static imports run.
const { tempDir } = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  return {
    tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-ledger-store-')),
  };
});

vi.mock('../config.js', () => ({
  config: { recording: { enabled: true, dir: tempDir } },
}));

import { appendLedgerEntry, readLedgerForDay } from '../services/ledgerStore.js';
import type { TradeLedgerEntry } from '../services/executionService.js';

function makeEntry(overrides: Partial<TradeLedgerEntry> = {}): TradeLedgerEntry {
  return {
    symbol: 'AAA',
    strategy: 'momentum_continuation',
    entryPrice: 1,
    entryTime: new Date('2026-05-05T14:00:00Z'),
    exitPrice: 1.1,
    exitTime: new Date('2026-05-05T14:30:00Z'),
    shares: 100,
    riskPerShare: 0.05,
    pnl: 10,
    pnlPct: 10,
    rMultiple: 2,
    exitReason: 'target',
    exitDetail: 'reached target',
    rationale: ['test'],
    ...overrides,
  };
}

describe('ledgerStore', () => {
  beforeEach(() => {
    // Each test gets a clean ledger file for the test "now". Using a
    // fixed date keeps file names predictable across the suite.
    const path = join(tempDir, 'ledger-2026-05-05.jsonl');
    if (existsSync(path)) rmSync(path);
  });

  it('appends an entry as one JSON line and readLedgerForDay returns it', () => {
    const now = new Date('2026-05-05T14:00:00Z');
    appendLedgerEntry(makeEntry({ symbol: 'AAA' }), now);
    const entries = readLedgerForDay(now);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbol).toBe('AAA');
    expect(entries[0].pnl).toBe(10);
  });

  it('append is additive — second call adds a second line, both readable', () => {
    const now = new Date('2026-05-05T14:00:00Z');
    appendLedgerEntry(makeEntry({ symbol: 'AAA', pnl: 10 }), now);
    appendLedgerEntry(makeEntry({ symbol: 'BBB', pnl: -3 }), now);
    const entries = readLedgerForDay(now);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.symbol)).toEqual(['AAA', 'BBB']);
  });

  it('serializes Date fields as ISO strings on disk', () => {
    const now = new Date('2026-05-05T14:00:00Z');
    appendLedgerEntry(makeEntry({ symbol: 'AAA' }), now);
    const path = join(tempDir, 'ledger-2026-05-05.jsonl');
    const raw = readFileSync(path, 'utf-8').trim();
    const parsed = JSON.parse(raw);
    expect(typeof parsed.entryTime).toBe('string');
    expect(parsed.entryTime).toBe('2026-05-05T14:00:00.000Z');
    expect(parsed.exitTime).toBe('2026-05-05T14:30:00.000Z');
  });

  it('readLedgerForDay returns [] when the file is missing', () => {
    expect(readLedgerForDay(new Date('2020-01-01'))).toEqual([]);
  });

  it('skips malformed lines instead of throwing', () => {
    const now = new Date('2026-05-05T14:00:00Z');
    const path = join(tempDir, 'ledger-2026-05-05.jsonl');
    appendLedgerEntry(makeEntry({ symbol: 'AAA' }), now);
    // Inject a corrupt line in the middle.
    writeFileSync(
      path,
      `${JSON.stringify({ ...makeEntry({ symbol: 'AAA' }), entryTime: '2026-05-05T14:00:00.000Z', exitTime: '2026-05-05T14:30:00.000Z' })}\n` +
        `not valid json\n` +
        `${JSON.stringify({ ...makeEntry({ symbol: 'CCC' }), entryTime: '2026-05-05T15:00:00.000Z', exitTime: '2026-05-05T15:30:00.000Z' })}\n`,
      'utf-8',
    );
    const entries = readLedgerForDay(now);
    expect(entries.map((e) => e.symbol)).toEqual(['AAA', 'CCC']);
  });
});
