// @ts-expect-error - finnhub lacks type definitions
import finnhub from 'finnhub';
import { finnhubApiKey } from '../config.js';

export interface PriceData {
  symbol: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  timestamp: Date;
  source: 'finnhub' | 'yahoo' | 'error';
  error?: string;
}

interface FinnhubQuote {
  c?: number; // Current price
  d?: number; // Change
  dp?: number; // Change percent
}

// Initialize Finnhub client
const finnhubClient = new finnhub.DefaultApi();
const apiKey = finnhub.ApiClient.instance.authentications['api_key'];
apiKey.apiKey = finnhubApiKey;

function finnhubQuote(symbol: string): Promise<PriceData> {
  return new Promise((resolve) => {
    finnhubClient.quote(symbol, (error: Error | null, data: FinnhubQuote) => {
      if (error || !data || data.c === undefined || data.c === 0) {
        resolve({
          symbol,
          price: null,
          change: null,
          changePercent: null,
          timestamp: new Date(),
          source: 'error',
          error: error?.message || 'No data returned',
        });
        return;
      }

      resolve({
        symbol,
        price: data.c,
        change: data.d ?? null,
        changePercent: data.dp ?? null,
        timestamp: new Date(),
        source: 'finnhub',
      });
    });
  });
}

interface YahooQuote {
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
}

async function yahooFallback(symbol: string): Promise<PriceData> {
  try {
    // Dynamic import for yahoo-finance2 (ESM module)
    const yahooFinance = await import('yahoo-finance2');
    const yf = yahooFinance.default;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quote: YahooQuote = await (yf as any).quote(symbol);

    if (!quote || !quote.regularMarketPrice) {
      throw new Error('No price data');
    }

    return {
      symbol,
      price: quote.regularMarketPrice,
      change: quote.regularMarketChange ?? null,
      changePercent: quote.regularMarketChangePercent ?? null,
      timestamp: new Date(),
      source: 'yahoo',
    };
  } catch (err) {
    return {
      symbol,
      price: null,
      change: null,
      changePercent: null,
      timestamp: new Date(),
      source: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export async function getPrice(symbol: string): Promise<PriceData> {
  // Try Finnhub first
  if (finnhubApiKey) {
    const result = await finnhubQuote(symbol);
    if (result.price !== null) {
      return result;
    }
    console.log(`Finnhub failed for ${symbol}, trying Yahoo fallback`);
  }

  // Fallback to Yahoo Finance
  return yahooFallback(symbol);
}

export async function getPrices(symbols: string[]): Promise<Map<string, PriceData>> {
  const results = new Map<string, PriceData>();

  // Fetch prices with some parallelism but rate-limited
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(getPrice));

    for (const result of batchResults) {
      results.set(result.symbol, result);
    }

    // Small delay between batches to avoid rate limits
    if (i + batchSize < symbols.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return results;
}
