import { describe, expect, it } from 'vitest';
import {
  sanitizeWatchlistItems,
  shouldReload,
  type WatchlistItem,
} from '../services/tickerBotService.js';

function makeItem(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    symbol: 'ATAI',
    targetPrice: 5.52,
    resistance: 5.39,
    stopPrice: 4.04,
    buyZonePrice: 5.1,
    sellZonePrice: 5.39,
    ...overrides,
  };
}

describe('sanitizeWatchlistItems', () => {
  it('keeps a normal ticker row', () => {
    const items = sanitizeWatchlistItems([makeItem()]);
    expect(items).toHaveLength(1);
    expect(items[0].symbol).toBe('ATAI');
  });

  it('drops pseudo-symbol blobs scraped from descriptive text', () => {
    const items = sanitizeWatchlistItems([
      makeItem({
        symbol:
          'PRICE LEVELS FOR ATAI LIVE DATA SUPPORT 4.04 CURRENT PRICE 5.18 RES 5.39 TARGET ZONE 5.39',
        stopPrice: null,
        buyZonePrice: null,
        sellZonePrice: null,
      }),
    ]);

    expect(items).toHaveLength(0);
  });

  it('drops rows with inverted stop/buy/sell ordering', () => {
    const items = sanitizeWatchlistItems([
      makeItem({
        symbol: 'ATAI',
        stopPrice: 4.04,
        buyZonePrice: 5.52,
        sellZonePrice: 5.39,
      }),
    ]);

    expect(items).toHaveLength(0);
  });
});

describe('shouldReload', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const last = 1_000_000_000;

  it('returns false before the interval has elapsed', () => {
    expect(shouldReload(last, 60, last + HOUR_MS - 1)).toBe(false);
  });

  it('returns true at exactly the interval', () => {
    expect(shouldReload(last, 60, last + HOUR_MS)).toBe(true);
  });

  it('returns true past the interval', () => {
    expect(shouldReload(last, 60, last + 2 * HOUR_MS)).toBe(true);
  });

  it('returns false when feature is disabled (interval <= 0)', () => {
    expect(shouldReload(last, 0, last + 24 * HOUR_MS)).toBe(false);
    expect(shouldReload(last, -5, last + 24 * HOUR_MS)).toBe(false);
  });

  it('returns false when lastReloadAt is the never-loaded sentinel', () => {
    // Caller is responsible for stamping lastReloadAt on bootstrap; this
    // guard prevents an immediate reload that would tear down a freshly
    // bootstrapped page.
    expect(shouldReload(0, 60, last + 100 * HOUR_MS)).toBe(false);
  });
});
