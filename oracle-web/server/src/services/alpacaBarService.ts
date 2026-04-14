import { alpacaApiKeyId, alpacaApiSecretKey, alpacaDataFeed } from '../config.js';

export interface AlpacaBar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

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
): Promise<AlpacaBar[]> {
  if (!alpacaApiKeyId || !alpacaApiSecretKey) {
    return [];
  }

  const now = new Date();
  const start = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  // Alpaca expects RFC3339 format
  const startStr = start.toISOString();
  const endStr = now.toISOString();

  const baseUrl = 'https://data.alpaca.markets/v2/stocks';
  const url = `${baseUrl}/${symbol}/bars?timeframe=${timeframe}&start=${startStr}&end=${endStr}&feed=${feed}&limit=10000`;

  const response = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': alpacaApiKeyId,
      'APCA-API-SECRET-KEY': alpacaApiSecretKey,
    },
  });

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
): Promise<AlpacaBar[]> {
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
): Promise<AlpacaBar[]> {
  return fetchAlpacaBars(symbol, '1Min', lookbackMinutes);
}

/**
 * Fetches 5-minute bars for the specified lookback period
 */
export async function fetchAlpaca5MinBars(
  symbol: string,
  lookbackMinutes: number = 120
): Promise<AlpacaBar[]> {
  return fetchAlpacaBars(symbol, '5Min', lookbackMinutes);
}
