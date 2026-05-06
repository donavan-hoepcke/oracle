import { alpacaApiKeyId, alpacaApiSecretKey, alpacaDataFeed, config } from '../config.js';
import { Bar } from './indicatorService.js';
import { AlpacaRateLimiter } from './alpacaRateLimiter.js';

// Lazy singleton so every fetch path (1m bars, 5m bars, sector ETFs,
// regime, RCT lookups) shares one budget. The lazy init dodges
// import-time crashes in test files whose `vi.mock('../config.js')`
// doesn't define `bot.alpaca_bars` — the limiter is only constructed on
// first real fetch, and tests that mock the bar-fetch boundary higher up
// never trigger it. Defaults match config schema in case `bot.alpaca_bars`
// is partially defined.
let limiter: AlpacaRateLimiter | null = null;
function getLimiter(): AlpacaRateLimiter {
  if (limiter) return limiter;
  const cfg = (config as { bot?: { alpaca_bars?: { rate_per_min?: number; burst?: number } } })
    .bot?.alpaca_bars;
  limiter = new AlpacaRateLimiter({
    ratePerMin: cfg?.rate_per_min ?? 180,
    burst: cfg?.burst ?? 30,
  });
  return limiter;
}

/** Diagnostic accessor — used by tests and (next iteration) an ops probe. */
export function getAlpacaRateLimiterStats() {
  return getLimiter().getStats();
}

// Short-TTL cache so concurrent callers (price-poll cycle + /api/scanner +
// /api/trade-candidates all running in parallel) don't each fire their own
// fetch for the same symbol+timeframe. Keyed on (symbol|timeframe|lookback).
// 5s TTL is short enough that the data stays fresh through a 30s polling
// cycle, but long enough to dedupe the burst of fetches that arrives within
// a few hundred ms of each other when an HTTP handler calls into the rule
// engine while the price-poll cycle is also running.
const BAR_CACHE_TTL_MS = 5_000;
interface CacheEntry {
  ts: number;
  bars: Bar[];
}
const barCache = new Map<string, CacheEntry>();
const barInflight = new Map<string, Promise<Bar[]>>();

function cacheKey(symbol: string, timeframe: string, lookbackMinutes: number, feed: string): string {
  return `${symbol}|${timeframe}|${lookbackMinutes}|${feed}`;
}

/** @deprecated Use `Bar` from indicatorService instead */
export type AlpacaBar = Bar;

interface AlpacaBarResponse {
  bars: Array<{
    t: string;  // timestamp ISO string
    o: number;  // open
    h: number;  // high
    l: number;  // low
    c: number;  // close
    v: number;  // volume
  }>;
  next_page_token?: string;
}

/**
 * Fetches historical bars from Alpaca Data API
 * @param symbol - Stock ticker symbol
 * @param timeframe - Bar timeframe: '1Min', '5Min', '15Min', '1Hour', '1Day'
 * @param lookbackMinutes - How far back to fetch data
 * @param feed - Data feed to use ('sip' or 'iex')
 */
async function fetchAlpacaBarsWithFeed(
  symbol: string,
  timeframe: string,
  lookbackMinutes: number,
  feed: string
): Promise<Bar[]> {
  if (!alpacaApiKeyId || !alpacaApiSecretKey) {
    return [];
  }

  // Cache hit on a fresh entry — return immediately, skip the rate limiter
  // and the network entirely. This is the load-shedding path for concurrent
  // callers asking for the same bars within the TTL.
  const key = cacheKey(symbol, timeframe, lookbackMinutes, feed);
  const cached = barCache.get(key);
  if (cached && Date.now() - cached.ts < BAR_CACHE_TTL_MS) {
    return cached.bars;
  }
  // In-flight dedupe: if a fetch for the same key is already running,
  // wait on its promise rather than firing a second HTTP request.
  const inflight = barInflight.get(key);
  if (inflight) return inflight;

  const fetchPromise = doFetchAlpacaBars(symbol, timeframe, lookbackMinutes, feed);
  barInflight.set(key, fetchPromise);
  try {
    const bars = await fetchPromise;
    barCache.set(key, { ts: Date.now(), bars });
    return bars;
  } finally {
    barInflight.delete(key);
  }
}

async function doFetchAlpacaBars(
  symbol: string,
  timeframe: string,
  lookbackMinutes: number,
  feed: string
): Promise<Bar[]> {
  const now = new Date();
  const start = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  // Alpaca expects RFC3339 format
  const startStr = start.toISOString();
  const endStr = now.toISOString();

  const baseUrl = 'https://data.alpaca.markets/v2/stocks';
  const url = `${baseUrl}/${symbol}/bars?timeframe=${timeframe}&start=${startStr}&end=${endStr}&feed=${feed}&limit=10000`;

  // Park here until a token is available. On a cold start with 50+ symbols
  // this serializes the burst into the configured per-minute budget;
  // steady-state polls flow through immediately because tokens refill
  // faster than we consume them.
  const rateLimiter = getLimiter();
  await rateLimiter.acquire();

  const response = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': alpacaApiKeyId,
      'APCA-API-SECRET-KEY': alpacaApiSecretKey,
    },
  });

  // Record outcome for the ops monitor's alpaca_iex_bars probe. The probe
  // filters out 429s (rate limits) since they're transient and routine.
  // Optional chaining + voided return so unit tests that don't import
  // index.ts don't blow up here.
  (globalThis as { __opsApiOutcomes?: { iex: (ok: boolean, status?: number) => void } })
    .__opsApiOutcomes?.iex(response.ok, response.status);

  // 429 means our budget estimate is off (or someone outside this process
  // shares the API key). Empty the bucket and set a penalty so subsequent
  // callers wait through the rolling-minute window rather than re-firing
  // into a closed door. Honor Retry-After when present.
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader
      ? Math.max(1000, Number.parseFloat(retryAfterHeader) * 1000)
      : 5000;
    rateLimiter.notifyRateLimited(retryAfterMs);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${response.status} - ${errorText}`);
  }

  const data: AlpacaBarResponse = await response.json();

  if (!data.bars || data.bars.length === 0) {
    return [];
  }

  return data.bars.map((bar) => ({
    timestamp: new Date(bar.t),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  }));
}

/**
 * Fetches historical bars from Alpaca Data API
 * Tries configured feed first, falls back to IEX if SIP fails
 */
export async function fetchAlpacaBars(
  symbol: string,
  timeframe: string,
  lookbackMinutes: number
): Promise<Bar[]> {
  if (!alpacaApiKeyId || !alpacaApiSecretKey) {
    return [];
  }

  try {
    // Try configured feed first
    return await fetchAlpacaBarsWithFeed(symbol, timeframe, lookbackMinutes, alpacaDataFeed);
  } catch (error) {
    const errorStr = String(error);
    // If SIP subscription error, fall back to IEX
    if (alpacaDataFeed === 'sip' && errorStr.includes('subscription')) {
      console.log(`Falling back to IEX for ${symbol}...`);
      try {
        return await fetchAlpacaBarsWithFeed(symbol, timeframe, lookbackMinutes, 'iex');
      } catch (iexError) {
        console.error(`Alpaca IEX API error for ${symbol}:`, iexError);
        return [];
      }
    }
    console.error(`Alpaca API error for ${symbol}:`, error);
    return [];
  }
}

/**
 * Fetches 1-minute bars for the specified lookback period
 */
export async function fetchAlpaca1MinBars(
  symbol: string,
  lookbackMinutes: number = 60
): Promise<Bar[]> {
  return fetchAlpacaBars(symbol, '1Min', lookbackMinutes);
}

/**
 * Fetches 5-minute bars for the specified lookback period
 */
export async function fetchAlpaca5MinBars(
  symbol: string,
  lookbackMinutes: number = 120
): Promise<Bar[]> {
  return fetchAlpacaBars(symbol, '5Min', lookbackMinutes);
}
