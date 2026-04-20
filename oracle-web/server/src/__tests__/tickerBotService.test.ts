import { describe, expect, it } from 'vitest';
import { sanitizeWatchlistItems, type WatchlistItem } from '../services/tickerBotService.js';

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
