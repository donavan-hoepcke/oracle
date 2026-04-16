import { polygonApiKey } from '../config.js';
import { Bar } from './indicatorService.js';

/** @deprecated Use `Bar` from indicatorService instead */
export type PolygonBar = Bar;

interface PolygonAggResponse {
  results?: Array<{
    t: number;  // timestamp (ms)
    o: number;  // open
    h: number;  // high
    l: number;  // low
    c: number;  // close
    v: number;  // volume
  }>;
  status: string;
  resultsCount?: number;
}

/**
 * Fetches historical bars from Polygon.io
 * @param symbol - Stock ticker symbol
 * @param multiplier - Bar size multiplier (e.g., 1 for 1-minute bars)
 * @param timespan - Time unit: 'minute', 'hour', 'day'
 * @param lookbackMinutes - How far back to fetch data
 */
export async function fetchBars(
  symbol: string,
  multiplier: number,
  timespan: string,
  lookbackMinutes: number
): Promise<Bar[]> {
  if (!polygonApiKey) {
    console.warn('POLYGON_API_KEY not set, cannot fetch bars');
    return [];
  }

  const now = new Date();
  const from = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  // Format dates as YYYY-MM-DD
  const fromStr = from.toISOString().split('T')[0];
  const toStr = now.toISOString().split('T')[0];

  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=50000`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${polygonApiKey}`,
      },
    });
    if (!response.ok) {
      console.error(`Polygon API error for ${symbol}: ${response.status}`);
      return [];
    }

    const data: PolygonAggResponse = await response.json();

    if (!data.results || data.results.length === 0) {
      return [];
    }

    return data.results.map((bar) => ({
      timestamp: new Date(bar.t),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));
  } catch (error) {
    console.error(`Failed to fetch bars for ${symbol}:`, error);
    return [];
  }
}

/**
 * Fetches 1-minute bars for the specified lookback period
 */
export async function fetch1MinBars(
  symbol: string,
  lookbackMinutes: number = 60
): Promise<Bar[]> {
  return fetchBars(symbol, 1, 'minute', lookbackMinutes);
}

/**
 * Fetches 5-minute bars for the specified lookback period
 */
export async function fetch5MinBars(
  symbol: string,
  lookbackMinutes: number = 120
): Promise<Bar[]> {
  return fetchBars(symbol, 5, 'minute', lookbackMinutes);
}
