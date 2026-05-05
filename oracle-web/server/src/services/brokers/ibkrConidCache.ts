import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Symbol → IBKR contract id (conid) cache, file-backed so we don't
 * re-resolve every symbol on every restart. IBKR identifies instruments
 * by `conid` rather than ticker, and resolution requires a network call
 * to /iserver/secdef/search.
 *
 * Cache rules:
 * - Lookup: in-memory map first, then disk, then network. Network result
 *   is written through to both.
 * - Multiple matches (ADRs, foreign listings) are filtered to NYSE /
 *   NASDAQ / ARCA primary common-stock listings. Ambiguity throws —
 *   silent ambiguity could fill the wrong instrument.
 * - TTL: entries are considered fresh for `ttlMs` (default 7d). Stale
 *   entries trigger a background refresh; the existing conid keeps
 *   serving requests until the refresh completes.
 *
 * Network IO is injected as a `fetcher` callback so unit tests can
 * exercise cache logic without hitting a real gateway. The default
 * binding sends a `GET /iserver/secdef/search` request to the
 * configured base URL.
 */

export interface ConidEntry {
  conid: number;
  resolvedAt: string; // ISO-8601 UTC
}

export interface ConidSearchResult {
  /** IBKR's `conid` field — numeric contract identifier. */
  conid: number;
  /** Primary listing exchange, e.g. "NYSE", "NASDAQ", "ARCA". */
  exchange: string;
  /** Security type. We only ever want "STK". */
  secType: string;
}

export type ConidFetcher = (symbol: string) => Promise<ConidSearchResult[]>;

export interface ConidCacheOptions {
  /** Path to the persisted JSON cache. */
  cachePath: string;
  /** Live API resolver (mocked in tests). */
  fetcher: ConidFetcher;
  /** Entries older than this trigger a background refresh. Default 7 days. */
  ttlMs?: number;
  /** Override clock for deterministic tests. */
  now?: () => Date;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'ARCA', 'AMEX']);

export class ConidAmbiguityError extends Error {
  constructor(symbol: string, candidates: ConidSearchResult[]) {
    super(
      `IBKR returned ${candidates.length} primary-listing matches for ${symbol} ` +
        `(${candidates.map((c) => `${c.conid}@${c.exchange}`).join(', ')}). ` +
        `Refusing to guess — fix upstream or add to a manual override.`,
    );
    this.name = 'ConidAmbiguityError';
  }
}

export class ConidNotFoundError extends Error {
  constructor(symbol: string) {
    super(`IBKR has no STK conid for ${symbol} on a primary US exchange.`);
    this.name = 'ConidNotFoundError';
  }
}

export class IbkrConidCache {
  private mem = new Map<string, ConidEntry>();
  private loaded = false;
  // Track in-flight refreshes so concurrent lookups don't pile up duplicate
  // network calls for the same symbol.
  private inFlight = new Map<string, Promise<ConidEntry>>();
  private readonly cachePath: string;
  private readonly fetcher: ConidFetcher;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(opts: ConidCacheOptions) {
    this.cachePath = opts.cachePath;
    this.fetcher = opts.fetcher;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Resolve `symbol` to a conid. Returns immediately from memory or disk
   * if a fresh-enough entry exists; falls through to a network resolution
   * otherwise. Stale entries serve the cached value AND kick off a
   * background refresh.
   */
  async getConid(symbol: string): Promise<number> {
    const sym = symbol.toUpperCase();
    await this.ensureLoaded();

    const entry = this.mem.get(sym);
    if (entry && !this.isStale(entry)) return entry.conid;

    if (entry) {
      // Stale: serve cached value immediately, refresh in background.
      this.scheduleRefresh(sym).catch((err) => {
        console.warn(`[IbkrConidCache] background refresh of ${sym} failed:`, err);
      });
      return entry.conid;
    }

    // Cold miss — resolve synchronously so the caller has a valid conid.
    const resolved = await this.resolveOnce(sym);
    return resolved.conid;
  }

  /** Drop an entry — used by `--refresh-conid` CLI. */
  async invalidate(symbol: string): Promise<void> {
    const sym = symbol.toUpperCase();
    this.mem.delete(sym);
    await this.persist();
  }

  /** Load the cache from disk if not already loaded. Idempotent. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const text = await fs.readFile(this.cachePath, 'utf-8');
      const data = JSON.parse(text) as Record<string, ConidEntry>;
      for (const [sym, entry] of Object.entries(data)) {
        if (typeof entry?.conid === 'number' && typeof entry.resolvedAt === 'string') {
          this.mem.set(sym, entry);
        }
      }
    } catch (err) {
      // ENOENT (first run) is fine. Anything else we surface so an admin
      // can intervene rather than silently start with an empty cache.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[IbkrConidCache] failed to load ${this.cachePath}:`, err);
      }
    }
    this.loaded = true;
  }

  private isStale(entry: ConidEntry): boolean {
    const ageMs = this.now().getTime() - new Date(entry.resolvedAt).getTime();
    return ageMs > this.ttlMs;
  }

  private async resolveOnce(symbol: string): Promise<ConidEntry> {
    const existing = this.inFlight.get(symbol);
    if (existing) return existing;

    const promise = (async () => {
      const candidates = await this.fetcher(symbol);
      const filtered = candidates.filter(
        (c) => c.secType === 'STK' && ALLOWED_EXCHANGES.has(c.exchange),
      );
      if (filtered.length === 0) {
        throw new ConidNotFoundError(symbol);
      }
      if (filtered.length > 1) {
        // Prefer NASDAQ/NYSE primary listings if multiple — common case is
        // a stock that also trades on ARCA as a secondary listing. If
        // still ambiguous after that filter, throw.
        const primaries = filtered.filter((c) => c.exchange === 'NASDAQ' || c.exchange === 'NYSE');
        if (primaries.length === 1) {
          const winner = primaries[0];
          const entry: ConidEntry = { conid: winner.conid, resolvedAt: this.now().toISOString() };
          this.mem.set(symbol, entry);
          await this.persist();
          return entry;
        }
        throw new ConidAmbiguityError(symbol, filtered);
      }
      const winner = filtered[0];
      const entry: ConidEntry = { conid: winner.conid, resolvedAt: this.now().toISOString() };
      this.mem.set(symbol, entry);
      await this.persist();
      return entry;
    })();

    this.inFlight.set(symbol, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(symbol);
    }
  }

  private async scheduleRefresh(symbol: string): Promise<void> {
    // Reuse resolveOnce — it dedupes via inFlight, so even if a cold miss
    // and a stale-refresh race for the same symbol, only one network call
    // is made and both paths receive the same fresh entry.
    await this.resolveOnce(symbol);
  }

  // Serialize disk writes via a chained promise so concurrent
  // resolveOnce() calls for different symbols don't race each other:
  // each call snapshots the in-memory map AT THE TIME ITS WRITE RUNS,
  // not at schedule time, so the on-disk file always reflects the
  // latest set of entries rather than an arbitrarily-stale subset.
  private persistChain: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const next = this.persistChain.then(async () => {
      const data: Record<string, ConidEntry> = {};
      for (const [sym, entry] of this.mem) data[sym] = entry;
      try {
        await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
        await fs.writeFile(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
      } catch (err) {
        // Cache persistence failure is non-fatal — we keep working from
        // the in-memory copy and log so an operator can fix permissions.
        console.warn(`[IbkrConidCache] failed to persist ${this.cachePath}:`, err);
      }
    });
    this.persistChain = next;
    return next;
  }
}
