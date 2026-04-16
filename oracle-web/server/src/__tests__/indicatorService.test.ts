import { describe, it, expect } from 'vitest';
import {
  calculateEMA,
  calculateATR,
  calculateVWAP,
  calculateRelativeVolume,
  isEmaRising,
  Bar,
} from '../services/indicatorService.js';

function makeBar(overrides: Partial<Bar> & { close: number }): Bar {
  return {
    timestamp: new Date(),
    open: overrides.open ?? overrides.close,
    high: overrides.high ?? overrides.close + 0.5,
    low: overrides.low ?? overrides.close - 0.5,
    close: overrides.close,
    volume: overrides.volume ?? 1000,
  };
}

describe('calculateEMA', () => {
  it('returns empty array for empty input', () => {
    expect(calculateEMA([], 10)).toEqual([]);
  });

  it('returns empty array for period <= 0', () => {
    expect(calculateEMA([1, 2, 3], 0)).toEqual([]);
  });

  it('calculates SMA for first value', () => {
    const result = calculateEMA([2, 4, 6], 3);
    expect(result[0]).toBeCloseTo(4); // SMA of [2,4,6] with period 3 = (2+4+6)/3 = 4
  });

  it('returns correct number of values', () => {
    const closes = [10, 11, 12, 13, 14, 15];
    const result = calculateEMA(closes, 3);
    expect(result).toHaveLength(closes.length);
  });

  it('produces values between min and max of input', () => {
    const closes = [10, 15, 12, 18, 14, 20];
    const result = calculateEMA(closes, 3);
    for (const val of result) {
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThanOrEqual(20);
    }
  });

  it('with period=1, EMA equals input values', () => {
    const closes = [5, 10, 15];
    const result = calculateEMA(closes, 1);
    expect(result[0]).toBeCloseTo(5);
    expect(result[1]).toBeCloseTo(10);
    expect(result[2]).toBeCloseTo(15);
  });

  it('handles single value input', () => {
    const result = calculateEMA([42], 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(42);
  });
});

describe('calculateATR', () => {
  it('returns empty array for less than 2 bars', () => {
    expect(calculateATR([], 14)).toEqual([]);
    expect(calculateATR([makeBar({ close: 10 })], 14)).toEqual([]);
  });

  it('returns empty array for period <= 0', () => {
    expect(calculateATR([makeBar({ close: 10 }), makeBar({ close: 11 })], 0)).toEqual([]);
  });

  it('computes first TR as high - low', () => {
    const bars = [
      makeBar({ open: 10, high: 12, low: 8, close: 11 }),
      makeBar({ open: 11, high: 13, low: 9, close: 12 }),
    ];
    const result = calculateATR(bars, 1);
    // First TR = 12 - 8 = 4
    expect(result[0]).toBeCloseTo(4);
  });

  it('returns correct number of values', () => {
    const bars = Array.from({ length: 20 }, (_, i) => makeBar({ close: 100 + i }));
    const result = calculateATR(bars, 14);
    expect(result).toHaveLength(bars.length);
  });

  it('considers previous close for true range', () => {
    const bars = [
      makeBar({ open: 10, high: 12, low: 9, close: 11 }),
      makeBar({ open: 15, high: 16, low: 14, close: 15 }), // gap up
    ];
    const result = calculateATR(bars, 1);
    // Second TR: max(16-14=2, |16-11|=5, |14-11|=3) = 5
    expect(result[1]).toBeCloseTo(5);
  });
});

describe('calculateVWAP', () => {
  it('returns empty array for empty input', () => {
    expect(calculateVWAP([])).toEqual([]);
  });

  it('first VWAP equals typical price of first bar', () => {
    const bar = makeBar({ open: 10, high: 12, low: 8, close: 10, volume: 100 });
    const result = calculateVWAP([bar]);
    const typical = (bar.high + bar.low + bar.close) / 3;
    expect(result[0]).toBeCloseTo(typical);
  });

  it('returns correct number of values', () => {
    const bars = Array.from({ length: 5 }, (_, i) =>
      makeBar({ close: 100 + i, volume: 1000 + i * 100 })
    );
    const result = calculateVWAP(bars);
    expect(result).toHaveLength(5);
  });

  it('handles zero volume bars gracefully', () => {
    const bars = [
      makeBar({ open: 10, high: 12, low: 8, close: 10, volume: 0 }),
      makeBar({ open: 11, high: 13, low: 9, close: 11, volume: 0 }),
    ];
    const result = calculateVWAP(bars);
    expect(result).toHaveLength(2);
    // With zero volume, VWAP falls back to typical price
    expect(result[0]).toBeCloseTo((12 + 8 + 10) / 3);
    expect(result[1]).toBeCloseTo((13 + 9 + 11) / 3);
  });
});

describe('calculateRelativeVolume', () => {
  it('returns 0 for empty input', () => {
    expect(calculateRelativeVolume([])).toBe(0);
  });

  it('returns 1 for single value', () => {
    expect(calculateRelativeVolume([500])).toBe(1);
  });

  it('returns 2.0 when current is double the average', () => {
    const volumes = [100, 100, 100, 200];
    expect(calculateRelativeVolume(volumes)).toBeCloseTo(2.0);
  });

  it('returns 0.5 when current is half the average', () => {
    const volumes = [200, 200, 200, 100];
    expect(calculateRelativeVolume(volumes)).toBeCloseTo(0.5);
  });

  it('returns 0 when average volume is 0', () => {
    const volumes = [0, 0, 0, 100];
    expect(calculateRelativeVolume(volumes)).toBe(0);
  });
});

describe('isEmaRising', () => {
  it('returns false for less than 2 values', () => {
    expect(isEmaRising([])).toBe(false);
    expect(isEmaRising([1])).toBe(false);
  });

  it('returns true for strictly rising values', () => {
    expect(isEmaRising([1, 2, 3, 4, 5])).toBe(true);
  });

  it('returns false for flat values', () => {
    expect(isEmaRising([5, 5, 5])).toBe(false);
  });

  it('returns false for falling values', () => {
    expect(isEmaRising([5, 4, 3])).toBe(false);
  });

  it('uses lookback parameter', () => {
    // First values fall, but last 2 rise
    expect(isEmaRising([10, 5, 6, 7], 2)).toBe(true);
    // Last 3 don't all rise
    expect(isEmaRising([10, 5, 6, 7], 3)).toBe(true);
    // Includes the fall
    expect(isEmaRising([10, 5, 6, 7], 4)).toBe(false);
  });
});
