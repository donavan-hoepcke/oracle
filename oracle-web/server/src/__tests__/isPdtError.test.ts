import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: { enabled: true, paper: true, eod_flatten_time: '15:50' },
    market_hours: { timezone: 'America/New_York' },
  },
}));

vi.mock('../services/brokers/index.js', () => ({
  brokerService: {},
}));

vi.mock('../services/ledgerStore.js', () => ({
  appendLedgerEntry: vi.fn(),
  readLedgerForDay: vi.fn(() => []),
}));

import { isPdtError } from '../services/executionService.js';

describe('isPdtError', () => {
  it('matches the verbatim Alpaca error string from 2026-05-07', () => {
    const err = new Error(
      'Alpaca bracket order error: 403 {"code":40310100,"message":"trade denied due to pattern day trading protection"}',
    );
    expect(isPdtError(err)).toBe(true);
  });

  it('matches a paraphrased "pattern day trader" message (defensive against future formatting changes)', () => {
    expect(isPdtError(new Error('rejected: pattern day trader rule'))).toBe(true);
    expect(isPdtError(new Error('Pattern Day Trading limit reached'))).toBe(true);
  });

  it('matches on the bare error code', () => {
    expect(isPdtError(new Error('code 40310100'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isPdtError(new Error('insufficient buying power'))).toBe(false);
    expect(isPdtError(new Error('429 rate limited'))).toBe(false);
    expect(isPdtError(null)).toBe(false);
    expect(isPdtError(undefined)).toBe(false);
  });
});
