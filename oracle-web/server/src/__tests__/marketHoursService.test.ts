import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    market_hours: {
      open: '09:30',
      close: '16:00',
      timezone: 'America/New_York',
    },
  },
}));

import {
  getMarketSession,
  isExtendedHours,
  minutesUntilSessionEnd,
} from '../services/marketHoursService.js';

/**
 * Build a UTC Date that represents the given wall-clock time in
 * America/New_York for a chosen weekday. ET is UTC-5 (or UTC-4 during
 * DST) — for these tests we anchor on a non-DST winter weekday so the
 * UTC offset is a stable +5h. Boundary tests would also pass with DST
 * because getMarketSession compares zoned components, not raw UTC.
 */
function et(day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', hour: number, minute = 0): Date {
  // 2026-01-05 is a Monday, well outside DST — UTC = ET + 5h.
  const dayOffsets: Record<typeof day, number> = {
    mon: 5, tue: 6, wed: 7, thu: 8, fri: 9, sat: 10, sun: 11,
  };
  const dom = dayOffsets[day];
  // ET hour H → UTC hour H+5.
  return new Date(Date.UTC(2026, 0, dom, hour + 5, minute));
}

describe('getMarketSession', () => {
  it('returns "pre" at 04:00 ET (start of pre-market)', () => {
    expect(getMarketSession(et('mon', 4, 0))).toBe('pre');
  });

  it('returns "pre" at 09:29 ET (last minute before RTH open)', () => {
    expect(getMarketSession(et('mon', 9, 29))).toBe('pre');
  });

  it('returns "rth" at 09:30 ET sharp (RTH open)', () => {
    expect(getMarketSession(et('mon', 9, 30))).toBe('rth');
  });

  it('returns "rth" at 15:59 ET (last minute before RTH close)', () => {
    expect(getMarketSession(et('mon', 15, 59))).toBe('rth');
  });

  it('returns "post" at 16:00 ET sharp (RTH close = post-market start)', () => {
    expect(getMarketSession(et('mon', 16, 0))).toBe('post');
  });

  it('returns "post" at 19:59 ET (last minute of post-market)', () => {
    expect(getMarketSession(et('mon', 19, 59))).toBe('post');
  });

  it('returns "closed" at 20:00 ET sharp (post-market over)', () => {
    expect(getMarketSession(et('mon', 20, 0))).toBe('closed');
  });

  it('returns "closed" at 03:59 ET (before pre-market starts)', () => {
    expect(getMarketSession(et('mon', 3, 59))).toBe('closed');
  });

  it('returns "closed" all day Saturday', () => {
    expect(getMarketSession(et('sat', 10, 0))).toBe('closed');
    expect(getMarketSession(et('sat', 14, 0))).toBe('closed');
  });

  it('returns "closed" all day Sunday', () => {
    expect(getMarketSession(et('sun', 4, 0))).toBe('closed');
    expect(getMarketSession(et('sun', 19, 30))).toBe('closed');
  });
});

describe('isExtendedHours', () => {
  it('true in pre-market', () => {
    expect(isExtendedHours(et('mon', 7, 0))).toBe(true);
  });
  it('true in post-market', () => {
    expect(isExtendedHours(et('mon', 18, 0))).toBe(true);
  });
  it('false during RTH', () => {
    expect(isExtendedHours(et('mon', 12, 0))).toBe(false);
  });
  it('false when closed', () => {
    expect(isExtendedHours(et('mon', 22, 0))).toBe(false);
  });
});

describe('minutesUntilSessionEnd', () => {
  it('counts down to RTH open during pre-market', () => {
    // 09:00 ET → 30 minutes until 09:30 RTH open.
    expect(minutesUntilSessionEnd(et('mon', 9, 0))).toBe(30);
  });

  it('counts down to RTH close during RTH', () => {
    // 15:45 ET → 15 minutes until 16:00 RTH close.
    expect(minutesUntilSessionEnd(et('mon', 15, 45))).toBe(15);
  });

  it('counts down to 20:00 ET during post-market', () => {
    // 19:45 ET → 15 minutes until 20:00 post-market end.
    expect(minutesUntilSessionEnd(et('mon', 19, 45))).toBe(15);
  });

  it('returns null when session is closed', () => {
    expect(minutesUntilSessionEnd(et('mon', 22, 0))).toBeNull();
    expect(minutesUntilSessionEnd(et('sat', 10, 0))).toBeNull();
  });
});
