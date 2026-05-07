import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    market_hours: { open: '09:30', close: '16:00', timezone: 'America/New_York' },
  },
  alpacaApiKeyId: 'test-key',
  alpacaApiSecretKey: 'test-secret',
  alpacaDataFeed: 'iex',
}));

const { mockFetchAlpacaBars } = vi.hoisted(() => ({
  mockFetchAlpacaBars: vi.fn(),
}));
vi.mock('../services/alpacaBarService.js', () => ({
  fetchAlpacaBars: mockFetchAlpacaBars,
  getAlpacaRateLimiterStats: () => ({}),
}));

import { SessionLevelsService } from '../services/sessionLevelsService.js';
import type { Bar } from '../services/indicatorService.js';

// Build a 1-minute bar at the given UTC ISO timestamp.
function bar(tsIso: string, price: number, vol: number): Bar {
  return {
    timestamp: new Date(tsIso),
    open: price,
    high: price,
    low: price,
    close: price,
    volume: vol,
  };
}

describe('SessionLevelsService', () => {
  let svc: SessionLevelsService;

  beforeEach(() => {
    svc = new SessionLevelsService();
    mockFetchAlpacaBars.mockReset();
  });

  it('returns nulls when there are no bars at all (e.g. no IEX activity / no API key)', async () => {
    mockFetchAlpacaBars.mockResolvedValue([]);
    // Mid-RTH, 2026-05-06 14:00 UTC = 10:00 ET
    const now = new Date('2026-05-06T14:00:00Z');
    const out = await svc.compute('AREB', { isOnWatchlist: true, now });
    expect(out.premarket).toBeNull();
    expect(out.indicators).toBeNull();
  });

  it('builds premarket levels from bars in [04:00, 09:30) ET and ignores RTH bars for that window', async () => {
    // 2026-05-06: 04:00 ET = 08:00 UTC, 09:30 ET = 13:30 UTC, 10:00 ET = 14:00 UTC.
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T08:00:00Z', 0.30, 100_000), // first PM print
      bar('2026-05-06T11:00:00Z', 0.41, 200_000), // PM high
      bar('2026-05-06T13:29:00Z', 0.34, 50_000),  // last PM print
      bar('2026-05-06T14:00:00Z', 0.28, 80_000),  // RTH bar — must be excluded from premarket
    ]);
    const now = new Date('2026-05-06T15:00:00Z'); // 11:00 ET, RTH active, PM frozen
    const out = await svc.compute('AREB', { isOnWatchlist: true, now });
    expect(out.premarket).not.toBeNull();
    expect(out.premarket!.session_date).toBe('2026-05-06');
    expect(out.premarket!.high).toBeCloseTo(0.41);
    // Low across PM bars only (RTH 0.28 must NOT pull low down)
    expect(out.premarket!.low).toBeCloseTo(0.30);
    expect(out.premarket!.volume).toBe(350_000);
    expect(out.premarket!.first_print_at).toBe('2026-05-06T08:00:00.000Z');
    expect(out.premarket!.last_print_at).toBe('2026-05-06T13:29:00.000Z');
  });

  it('freezes premarket as_of to 09:30 ET once RTH has opened', async () => {
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T11:00:00Z', 0.41, 100_000),
    ]);
    // Now is 14:00 UTC = 10:00 ET (RTH open)
    const now = new Date('2026-05-06T14:00:00Z');
    const out = await svc.compute('AREB', { isOnWatchlist: true, now });
    // 09:30 ET on 2026-05-06 = 13:30 UTC
    expect(out.premarket!.as_of).toBe('2026-05-06T13:30:00.000Z');
  });

  it('keeps premarket as_of as the live "now" while still inside the PM window', async () => {
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T09:00:00Z', 0.41, 100_000),
    ]);
    // 09:00 UTC = 05:00 ET (in PM)
    const now = new Date('2026-05-06T09:00:00Z');
    const out = await svc.compute('AREB', { isOnWatchlist: true, now });
    expect(out.premarket!.as_of).toBe(now.toISOString());
  });

  it('builds indicators (session VWAP) from RTH bars only and computes price_vs_vwap_pct as percent', async () => {
    // 2026-05-06: 09:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC.
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T11:00:00Z', 0.40, 1_000), // PM bar — must NOT contribute
      bar('2026-05-06T14:00:00Z', 1.00, 100), // RTH start
      bar('2026-05-06T15:00:00Z', 1.50, 100), // RTH later
    ]);
    const now = new Date('2026-05-06T16:00:00Z'); // 12:00 ET
    const out = await svc.compute('AREB', {
      isOnWatchlist: true,
      now,
      lastPrice: 1.30,
    });
    expect(out.indicators).not.toBeNull();
    expect(out.indicators!.session_vwap_volume).toBe(200);
    // VWAP should ignore the PM bar — value is between 1.00 and 1.50.
    expect(out.indicators!.session_vwap).toBeGreaterThan(1.0);
    expect(out.indicators!.session_vwap).toBeLessThan(1.5);
    // price_vs_vwap_pct is percent (×100). For lastPrice=1.30 vs VWAP≈1.25,
    // value should be roughly +4.0 (i.e. ~+4%, not ~+0.04).
    expect(out.indicators!.price_vs_vwap_pct).toBeGreaterThan(2);
    expect(out.indicators!.price_vs_vwap_pct).toBeLessThan(7);
  });

  it('freezes indicators as_of to 16:00 ET once RTH has closed', async () => {
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T14:00:00Z', 1.00, 1_000),
    ]);
    // 21:00 UTC = 17:00 ET (post-close)
    const now = new Date('2026-05-06T21:00:00Z');
    const out = await svc.compute('AREB', { isOnWatchlist: true, now });
    // 16:00 ET on 2026-05-06 = 20:00 UTC
    expect(out.indicators!.as_of).toBe('2026-05-06T20:00:00.000Z');
  });

  it('keeps a cached value across calls within the 30s TTL (does not refetch)', async () => {
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T11:00:00Z', 0.41, 100_000),
    ]);
    const now = new Date('2026-05-06T14:00:00Z');
    await svc.compute('AREB', { isOnWatchlist: true, now });
    await svc.compute('AREB', { isOnWatchlist: true, now });
    expect(mockFetchAlpacaBars).toHaveBeenCalledTimes(1);
  });

  it('logs an audit line when the symbol is not on the watchlist', async () => {
    mockFetchAlpacaBars.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = new Date('2026-05-06T14:00:00Z');
    await svc.compute('OFFLIST', { isOnWatchlist: false, now });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('off-watchlist compute for OFFLIST'),
    );
    logSpy.mockRestore();
  });

  it('does not log when the symbol is on the watchlist', async () => {
    mockFetchAlpacaBars.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = new Date('2026-05-06T14:00:00Z');
    await svc.compute('AREB', { isOnWatchlist: true, now });
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('refreshes price_vs_vwap_pct on cache hit when lastPrice changes', async () => {
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T14:00:00Z', 1.00, 1_000),
      bar('2026-05-06T15:00:00Z', 1.00, 1_000),
    ]);
    const now = new Date('2026-05-06T16:00:00Z');
    const first = await svc.compute('AREB', { isOnWatchlist: true, now, lastPrice: 1.00 });
    expect(first.indicators!.price_vs_vwap_pct).toBeCloseTo(0, 1);

    // Same TTL window, but a different last price arrives — the percent
    // must reflect the new tick rather than holding the stale 0%.
    const second = await svc.compute('AREB', { isOnWatchlist: true, now, lastPrice: 1.10 });
    expect(second.indicators!.price_vs_vwap_pct).toBeGreaterThan(5);
    expect(mockFetchAlpacaBars).toHaveBeenCalledTimes(1);
  });

  it('uses a different cache slot per ET trading day', async () => {
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-06T11:00:00Z', 0.41, 100_000),
    ]);
    await svc.compute('AREB', { isOnWatchlist: true, now: new Date('2026-05-06T14:00:00Z') });
    // Next-day call should re-fetch.
    mockFetchAlpacaBars.mockResolvedValue([
      bar('2026-05-07T11:00:00Z', 0.50, 50_000),
    ]);
    const day2 = await svc.compute('AREB', {
      isOnWatchlist: true,
      now: new Date('2026-05-07T14:00:00Z'),
    });
    expect(day2.premarket!.session_date).toBe('2026-05-07');
    expect(mockFetchAlpacaBars).toHaveBeenCalledTimes(2);
  });
});
