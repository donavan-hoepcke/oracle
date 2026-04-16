import { describe, it, expect } from 'vitest';
import {
  formatPrice,
  formatPricePrecise,
  formatChange,
  formatPct,
  getChangeColor,
  getTrendArrow,
  scoreColor,
  setupLabel,
  robinhoodUrl,
  ROBINHOOD_URL_BASE,
} from '../utils/format';

describe('formatPrice', () => {
  it('returns -- for null', () => {
    expect(formatPrice(null)).toBe('--');
  });

  it('formats number to 2 decimal places with $', () => {
    expect(formatPrice(123.456)).toBe('$123.46');
  });

  it('formats integer', () => {
    expect(formatPrice(100)).toBe('$100.00');
  });
});

describe('formatPricePrecise', () => {
  it('returns -- for null', () => {
    expect(formatPricePrecise(null)).toBe('--');
  });

  it('returns -- for undefined', () => {
    expect(formatPricePrecise(undefined)).toBe('--');
  });

  it('returns -- for NaN', () => {
    expect(formatPricePrecise(NaN)).toBe('--');
  });

  it('formats number to 3 decimal places', () => {
    expect(formatPricePrecise(123.4567)).toBe('$123.457');
  });
});

describe('formatChange', () => {
  it('returns -- when either value is null', () => {
    expect(formatChange(null, 1.5)).toBe('--');
    expect(formatChange(0.5, null)).toBe('--');
    expect(formatChange(null, null)).toBe('--');
  });

  it('formats positive change with + sign', () => {
    expect(formatChange(1.23, 2.5)).toBe('+1.23 (+2.50%)');
  });

  it('formats negative change without + sign', () => {
    expect(formatChange(-1.23, -2.5)).toBe('-1.23 (-2.50%)');
  });

  it('formats zero change', () => {
    expect(formatChange(0, 0)).toBe('+0.00 (+0.00%)');
  });
});

describe('formatPct', () => {
  it('returns -- for null', () => {
    expect(formatPct(null)).toBe('--');
  });

  it('returns -- for NaN', () => {
    expect(formatPct(NaN)).toBe('--');
  });

  it('formats percentage to 2 decimal places', () => {
    expect(formatPct(12.345)).toBe('12.35%');
  });
});

describe('getChangeColor', () => {
  it('returns gray for null', () => {
    expect(getChangeColor(null)).toBe('text-gray-500');
  });

  it('returns green for positive', () => {
    expect(getChangeColor(1)).toBe('text-green-600');
  });

  it('returns red for negative', () => {
    expect(getChangeColor(-1)).toBe('text-red-600');
  });

  it('returns gray for zero', () => {
    expect(getChangeColor(0)).toBe('text-gray-500');
  });
});

describe('getTrendArrow', () => {
  it('returns empty for null', () => {
    expect(getTrendArrow(null)).toEqual({ arrow: '', color: '' });
  });

  it('returns up arrow for up trend', () => {
    const result = getTrendArrow('up');
    expect(result.arrow).toBe('▲');
    expect(result.color).toBe('text-green-600');
  });

  it('returns down arrow for down trend', () => {
    const result = getTrendArrow('down');
    expect(result.arrow).toBe('▼');
    expect(result.color).toBe('text-red-600');
  });

  it('returns dash for flat trend', () => {
    const result = getTrendArrow('flat');
    expect(result.arrow).toBe('–');
    expect(result.color).toBe('text-gray-400');
  });
});

describe('scoreColor', () => {
  it('returns emerald for score >= 75', () => {
    expect(scoreColor(75)).toContain('emerald');
    expect(scoreColor(100)).toContain('emerald');
  });

  it('returns amber for score 60-74', () => {
    expect(scoreColor(60)).toContain('amber');
    expect(scoreColor(74)).toContain('amber');
  });

  it('returns slate for score < 60', () => {
    expect(scoreColor(59)).toContain('slate');
    expect(scoreColor(0)).toContain('slate');
  });
});

describe('setupLabel', () => {
  it('converts red_candle_theory', () => {
    expect(setupLabel('red_candle_theory')).toBe('Red Candle Theory');
  });

  it('converts momentum_continuation', () => {
    expect(setupLabel('momentum_continuation')).toBe('Momentum Continuation');
  });

  it('converts pullback_reclaim', () => {
    expect(setupLabel('pullback_reclaim')).toBe('Pullback Reclaim');
  });

  it('converts crowded_extension_watch', () => {
    expect(setupLabel('crowded_extension_watch')).toBe('Crowded Extension Watch');
  });

  it('falls back to raw value for unknown setup', () => {
    expect(setupLabel('unknown_setup' as any)).toBe('unknown_setup');
  });
});

describe('robinhoodUrl', () => {
  it('generates correct URL', () => {
    expect(robinhoodUrl('AAPL')).toBe('https://robinhood.com/stocks/AAPL');
  });
});
