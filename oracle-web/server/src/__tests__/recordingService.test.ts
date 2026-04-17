import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempDir = mkdtempSync(join(tmpdir(), 'oracle-recording-'));

const { mockConfig } = vi.hoisted(() => {
  return {
    mockConfig: {
      recording: { enabled: true, dir: '' },
      market_hours: { timezone: 'America/New_York' },
    },
  };
});
mockConfig.recording.dir = tempDir;

vi.mock('../config.js', () => ({ config: mockConfig }));

import { RecordingService, CycleInputs } from '../services/recordingService.js';
import type { StockState } from '../websocket/priceSocket.js';
import type { TradeCandidate } from '../services/ruleEngineService.js';
import type { FilterRejection } from '../services/executionService.js';

function makeStock(symbol: string, price: number): StockState {
  return {
    symbol,
    targetPrice: 0,
    resistance: null,
    currentPrice: price,
    lastPrice: price * 0.95,
    change: 0,
    changePercent: 5,
    stopPrice: price * 0.9,
    buyZonePrice: price * 0.95,
    sellZonePrice: price * 1.2,
    profitDeltaPct: 20,
    maxVolume: 1000,
    premarketVolume: 500,
    relativeVolume: 2,
    floatMillions: 50,
    trend30m: 'up',
    inTargetRange: false,
    alerted: false,
    source: '',
    lastUpdate: null,
    signal: 'BRK',
    boxTop: price * 1.05,
    boxBottom: price * 0.95,
    signalTimestamp: null,
  } as StockState;
}

function makeCandidate(symbol: string, score: number): TradeCandidate {
  return {
    symbol,
    score,
    setup: 'momentum_continuation',
    rationale: ['reason A'],
    oracleScore: 50,
    messageScore: 50,
    executionScore: 50,
    messageContext: { symbol, mentionCount: 0, convictionScore: 0, tagCounts: {}, latestMessages: [] },
    snapshot: {
      currentPrice: 1,
      buyZonePrice: 1,
      stopPrice: 0.9,
      sellZonePrice: 1.2,
      profitDeltaPct: null,
      trend30m: 'up',
    },
    suggestedEntry: 1,
    suggestedStop: 0.9,
    suggestedTarget: 1.2,
  } as unknown as TradeCandidate;
}

function makeRejection(symbol: string, reason: string): FilterRejection {
  return {
    symbol,
    reason,
    score: 40,
    setup: 'momentum_continuation',
    suggestedEntry: 1,
    suggestedStop: 0.9,
    suggestedTarget: 1.2,
    timestamp: new Date(),
  };
}

function makeInputs(overrides: Partial<CycleInputs> = {}): CycleInputs {
  return {
    stocks: [makeStock('AGAE', 0.5)],
    candidates: [makeCandidate('AGAE', 75)],
    rejections: [makeRejection('HUBC', 'risk too high')],
    activeTrades: [],
    closedTrades: [],
    marketStatus: { isOpen: true, openTime: '09:30', closeTime: '16:00' },
    ...overrides,
  };
}

describe('RecordingService', () => {
  let service: RecordingService;
  let caseDir: string;

  beforeEach(() => {
    service = new RecordingService();
    caseDir = mkdtempSync(join(tempDir, 'case-'));
    mockConfig.recording.enabled = true;
    mockConfig.recording.dir = caseDir;
  });

  afterEach(() => {
    // noop; tempDir cleaned at the end
  });

  it('writes one JSON line per cycle', async () => {
    const noon = new Date('2026-04-17T16:00:00Z'); // 12:00 ET
    await service.writeCycle(makeInputs(), noon);

    const filePath = join(caseDir, '2026-04-17.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.tradingDay).toBe('2026-04-17');
    expect(record.tsEt).toBe('12:00:00');
    expect(record.items).toHaveLength(1);
    expect(record.items[0].symbol).toBe('AGAE');
    expect(record.decisions).toHaveLength(2);
    expect(record.decisions[0].kind).toBe('candidate');
    expect(record.decisions[1].kind).toBe('rejection');
    expect(record.decisions[1].rejectionReason).toBe('risk too high');
  });

  it('appends subsequent cycles to the same day file', async () => {
    const t1 = new Date('2026-04-17T16:00:00Z');
    const t2 = new Date('2026-04-17T16:00:30Z');
    await service.writeCycle(makeInputs(), t1);
    await service.writeCycle(makeInputs(), t2);

    const filePath = join(caseDir, '2026-04-17.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('rotates to a new file when ET trading day changes', async () => {
    const t1 = new Date('2026-04-17T20:00:00Z'); // 4pm ET, 2026-04-17
    const t2 = new Date('2026-04-18T13:30:00Z'); // 9:30am ET, 2026-04-18
    await service.writeCycle(makeInputs(), t1);
    await service.writeCycle(makeInputs(), t2);

    expect(existsSync(join(caseDir, '2026-04-17.jsonl'))).toBe(true);
    expect(existsSync(join(caseDir, '2026-04-18.jsonl'))).toBe(true);
  });

  it('is a no-op when recording is disabled', async () => {
    mockConfig.recording.enabled = false;
    const sentinelDay = '2099-12-31';
    const t = new Date(`${sentinelDay}T17:00:00Z`);
    await service.writeCycle(makeInputs(), t);
    // No file for 2099-12-31 should exist
    expect(existsSync(join(caseDir, '2099-12-31.jsonl'))).toBe(false);
  });

  it('creates the target directory if missing', async () => {
    const nested = join(caseDir, 'nested', 'deeper');
    mockConfig.recording.dir = nested;
    const t = new Date('2026-04-17T16:00:00Z');
    await service.writeCycle(makeInputs(), t);
    expect(existsSync(join(nested, '2026-04-17.jsonl'))).toBe(true);
  });
});

// Best-effort cleanup of the top-level tempDir after tests run
process.on('exit', () => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
