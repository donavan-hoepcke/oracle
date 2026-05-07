import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: { paper: true },
    broker: { alpaca: { cash_account: false } },
  },
  alpacaApiKeyId: 'test',
  alpacaApiSecretKey: 'test',
}));

import { formatTickPrice } from '../services/brokers/alpacaAdapter.js';

describe('formatTickPrice', () => {
  it('rounds prices at $1.00+ to whole pennies', () => {
    // The exact 2026-05-07 rejections — both should round to 2 decimals.
    // Both 2026-05-07 rejected prices land on a valid penny grid after
    // rounding. .5¢ values can round either direction depending on IEEE
    // 754 representation — both adjacent pennies are valid for Alpaca,
    // we just need the function to land on one of them deterministically.
    expect(['19.52', '19.53']).toContain(formatTickPrice(19.525)); // FSLY stop
    expect(['7.84', '7.85']).toContain(formatTickPrice(7.845));    // ATRA limit
    expect(['2.24', '2.25']).toContain(formatTickPrice(2.245));
  });

  it('preserves prices that are already on the penny grid', () => {
    expect(formatTickPrice(19.5)).toBe('19.50');
    expect(formatTickPrice(7.84)).toBe('7.84');
    expect(formatTickPrice(100)).toBe('100.00');
  });

  it('uses 4-decimal precision for sub-$1 stocks (Alpaca allows sub-penny)', () => {
    // Penny stocks like $GLE at $0.36 commonly trade at sub-cent ticks.
    expect(formatTickPrice(0.3617)).toBe('0.3617');
    expect(formatTickPrice(0.4)).toBe('0.4000');
    expect(formatTickPrice(0.99999)).toBe('1.0000');
  });

  it('rounds sub-$1 prices at the 4th decimal', () => {
    expect(formatTickPrice(0.36175)).toBe('0.3618');
    expect(formatTickPrice(0.36174)).toBe('0.3617');
  });

  it('crosses the $1 boundary using the appropriate precision', () => {
    // 1.00 itself: 2 decimals.
    expect(formatTickPrice(1.0)).toBe('1.00');
    // Just above: 2 decimals.
    expect(formatTickPrice(1.001)).toBe('1.00');
    // Just below: 4 decimals.
    expect(formatTickPrice(0.9999)).toBe('0.9999');
  });

  it('passes through non-finite or non-positive values without crashing', () => {
    expect(formatTickPrice(0)).toBe('0');
    expect(formatTickPrice(NaN)).toBe('NaN');
    expect(formatTickPrice(-1)).toBe('-1');
  });
});
