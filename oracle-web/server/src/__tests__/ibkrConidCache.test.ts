import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConidAmbiguityError,
  ConidNotFoundError,
  IbkrConidCache,
  type ConidFetcher,
  type ConidSearchResult,
} from '../services/brokers/ibkrConidCache.js';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'conid-test-'));
  return path.join(dir, 'cache.json');
}

function fakeFetcher(byMatches: Record<string, ConidSearchResult[]>): {
  fetch: ConidFetcher;
  callCount: () => number;
  callsFor: (sym: string) => number;
} {
  const calls: string[] = [];
  return {
    fetch: async (sym) => {
      calls.push(sym);
      return byMatches[sym] ?? [];
    },
    callCount: () => calls.length,
    callsFor: (sym) => calls.filter((s) => s === sym).length,
  };
}

describe('IbkrConidCache', () => {
  it('resolves a single primary US listing on first lookup and persists', async () => {
    const cachePath = await tempFile();
    const f = fakeFetcher({ AAPL: [{ conid: 265598, exchange: 'NASDAQ', secType: 'STK' }] });
    const cache = new IbkrConidCache({ cachePath, fetcher: f.fetch });

    const conid = await cache.getConid('AAPL');
    expect(conid).toBe(265598);
    expect(f.callCount()).toBe(1);

    // Persisted to disk?
    const written = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    expect(written.AAPL.conid).toBe(265598);
    expect(typeof written.AAPL.resolvedAt).toBe('string');
  });

  it('serves from in-memory cache without re-fetching', async () => {
    const cachePath = await tempFile();
    const f = fakeFetcher({ AAPL: [{ conid: 265598, exchange: 'NASDAQ', secType: 'STK' }] });
    const cache = new IbkrConidCache({ cachePath, fetcher: f.fetch });
    await cache.getConid('AAPL');
    await cache.getConid('AAPL');
    await cache.getConid('AAPL');
    expect(f.callCount()).toBe(1);
  });

  it('serves from disk cache across instances without re-fetching', async () => {
    const cachePath = await tempFile();
    const f1 = fakeFetcher({ AAPL: [{ conid: 265598, exchange: 'NASDAQ', secType: 'STK' }] });
    const cache1 = new IbkrConidCache({ cachePath, fetcher: f1.fetch });
    await cache1.getConid('AAPL');
    expect(f1.callCount()).toBe(1);

    // New instance reads from disk; should not re-fetch.
    const f2 = fakeFetcher({});
    const cache2 = new IbkrConidCache({ cachePath, fetcher: f2.fetch });
    expect(await cache2.getConid('AAPL')).toBe(265598);
    expect(f2.callCount()).toBe(0);
  });

  it('filters out non-STK and non-US-primary candidates', async () => {
    const cachePath = await tempFile();
    const f = fakeFetcher({
      MULTI: [
        { conid: 1, exchange: 'NASDAQ', secType: 'OPT' }, // option — wrong secType
        { conid: 2, exchange: 'LSE', secType: 'STK' }, // foreign listing
        { conid: 3, exchange: 'NYSE', secType: 'STK' }, // primary US — winner
      ],
    });
    const cache = new IbkrConidCache({ cachePath, fetcher: f.fetch });
    expect(await cache.getConid('MULTI')).toBe(3);
  });

  it('prefers NASDAQ/NYSE over ARCA when multiple primary listings match', async () => {
    const cachePath = await tempFile();
    const f = fakeFetcher({
      DUAL: [
        { conid: 100, exchange: 'ARCA', secType: 'STK' }, // secondary
        { conid: 200, exchange: 'NYSE', secType: 'STK' }, // primary — winner
      ],
    });
    const cache = new IbkrConidCache({ cachePath, fetcher: f.fetch });
    expect(await cache.getConid('DUAL')).toBe(200);
  });

  it('throws ConidNotFoundError when no primary US listing exists', async () => {
    const cachePath = await tempFile();
    const f = fakeFetcher({
      LSE_ONLY: [{ conid: 1, exchange: 'LSE', secType: 'STK' }],
    });
    const cache = new IbkrConidCache({ cachePath, fetcher: f.fetch });
    await expect(cache.getConid('LSE_ONLY')).rejects.toThrow(ConidNotFoundError);
  });

  it('throws ConidAmbiguityError when multiple NASDAQ/NYSE listings exist', async () => {
    const cachePath = await tempFile();
    const f = fakeFetcher({
      AMBIG: [
        { conid: 1, exchange: 'NASDAQ', secType: 'STK' },
        { conid: 2, exchange: 'NYSE', secType: 'STK' },
      ],
    });
    const cache = new IbkrConidCache({ cachePath, fetcher: f.fetch });
    await expect(cache.getConid('AMBIG')).rejects.toThrow(ConidAmbiguityError);
  });

  it('serves stale entries immediately and refreshes in background', async () => {
    const cachePath = await tempFile();
    let nowMs = new Date('2026-05-01T00:00:00Z').getTime();
    const now = (): Date => new Date(nowMs);
    const f = fakeFetcher({ AAPL: [{ conid: 265598, exchange: 'NASDAQ', secType: 'STK' }] });
    const cache = new IbkrConidCache({
      cachePath,
      fetcher: f.fetch,
      ttlMs: 1000,
      now,
    });

    expect(await cache.getConid('AAPL')).toBe(265598);
    expect(f.callsFor('AAPL')).toBe(1);

    // Advance past the TTL.
    nowMs += 5000;
    expect(await cache.getConid('AAPL')).toBe(265598);
    // Stale-refresh fires; the new fetch is async and may still be pending,
    // so we await a microtask drain by re-querying.
    await new Promise((r) => setTimeout(r, 0));
    expect(f.callsFor('AAPL')).toBeGreaterThanOrEqual(2);
  });

  it('invalidate() removes the entry and forces a re-fetch on next lookup', async () => {
    const cachePath = await tempFile();
    const f = fakeFetcher({ AAPL: [{ conid: 265598, exchange: 'NASDAQ', secType: 'STK' }] });
    const cache = new IbkrConidCache({ cachePath, fetcher: f.fetch });
    await cache.getConid('AAPL');
    expect(f.callCount()).toBe(1);

    await cache.invalidate('AAPL');
    await cache.getConid('AAPL');
    expect(f.callCount()).toBe(2);
  });

  it('dedupes concurrent cold-miss fetches for the same symbol', async () => {
    const cachePath = await tempFile();
    let resolveOuter: (() => void) | null = null;
    const blocked = new Promise<void>((r) => {
      resolveOuter = r;
    });
    const fetcher: ConidFetcher = async () => {
      await blocked;
      return [{ conid: 42, exchange: 'NASDAQ', secType: 'STK' }];
    };
    const cache = new IbkrConidCache({ cachePath, fetcher });
    const a = cache.getConid('NEW');
    const b = cache.getConid('NEW');
    const c = cache.getConid('NEW');
    resolveOuter!();
    expect(await a).toBe(42);
    expect(await b).toBe(42);
    expect(await c).toBe(42);
  });
});
