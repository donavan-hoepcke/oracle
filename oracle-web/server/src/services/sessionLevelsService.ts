import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { config } from '../config.js';
import { fetchAlpacaBars } from './alpacaBarService.js';
import { calculateVWAP, type Bar } from './indicatorService.js';

/**
 * Premarket session extremes for one symbol on one ET trading day. Derived
 * from 1-minute IEX bars in `[04:00 ET, 09:30 ET)`. After RTH opens, the
 * values freeze for the rest of the trading day; consumers asking "did
 * intraday high break premarket high?" need `high` to remain available.
 */
export interface PremarketLevels {
  /** ET calendar date of the upcoming RTH open, e.g. "2026-05-06". */
  session_date: string;
  high: number;
  low: number;
  vwap: number;
  volume: number;
  first_print_at: string;
  last_print_at: string;
  /** Wall-clock when these values were finalized. During PM this advances
   *  with each recompute; after 09:30 ET it locks to that 09:30 ET moment
   *  so the bot can distinguish "frozen-because-RTH-started" from
   *  "stale-because-no-data." */
  as_of: string;
}

/**
 * Session-level indicators for one symbol on one ET trading day. Currently
 * exposes RTH session VWAP only — `[09:30 ET, 16:00 ET]`. Pre and post
 * VWAP are intentionally out of scope per the bot's 2026-05-06 answers
 * (Q4: RTH-only, no postmarket.vwap).
 */
export interface SessionIndicators {
  session_vwap: number | null;
  session_vwap_volume: number;
  /** (last - vwap) / vwap * 100. Null when last price isn't known. */
  price_vs_vwap_pct: number | null;
  /** Wall-clock when these values were computed. Locks to 16:00 ET after
   *  the RTH session closes — same freeze semantics as PremarketLevels. */
  as_of: string;
}

export interface SessionLevels {
  premarket: PremarketLevels | null;
  indicators: SessionIndicators | null;
}

export interface ComputeOptions {
  /** If false, the service still computes (per Q6) but logs an audit line
   *  so we can correlate off-watchlist fetches against rate-limit usage. */
  isOnWatchlist: boolean;
  /** Latest known price for the symbol — used by `price_vs_vwap_pct`. When
   *  null, the field is omitted (set to null). */
  lastPrice?: number | null;
  /** Test seam — defaults to wall clock. */
  now?: Date;
}

interface CacheEntry {
  sessionDate: string;
  premarket: PremarketLevels | null;
  premarketFrozen: boolean;
  indicators: SessionIndicators | null;
  indicatorsFrozen: boolean;
  computedAt: number;
  /** Last `lastPrice` used to compute `price_vs_vwap_pct`. We re-derive
   *  the percent on cache hit when the new lastPrice differs, since that
   *  is cheap and sidesteps stale percent readings inside the 30s TTL. */
  lastPrice: number | null;
}

const CACHE_TTL_MS = 30_000;

function tz(): string {
  return config.market_hours?.timezone || 'America/New_York';
}

function tradingDayET(now: Date): string {
  const z = toZonedTime(now, tz());
  const y = z.getFullYear();
  const m = String(z.getMonth() + 1).padStart(2, '0');
  const d = String(z.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function etMinutes(d: Date): number {
  const z = toZonedTime(d, tz());
  return z.getHours() * 60 + z.getMinutes();
}

function premarketStartUtc(tradingDate: string): Date {
  return fromZonedTime(`${tradingDate}T04:00:00`, tz());
}
function premarketEndUtc(tradingDate: string): Date {
  return fromZonedTime(`${tradingDate}T09:30:00`, tz());
}
function rthEndUtc(tradingDate: string): Date {
  return fromZonedTime(`${tradingDate}T16:00:00`, tz());
}

function isInPremarket(barTs: Date, tradingDate: string): boolean {
  if (tradingDayET(barTs) !== tradingDate) return false;
  const m = etMinutes(barTs);
  return m >= 4 * 60 && m < 9 * 60 + 30;
}

function isInRth(barTs: Date, tradingDate: string): boolean {
  if (tradingDayET(barTs) !== tradingDate) return false;
  const m = etMinutes(barTs);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

function buildPremarket(
  bars: Bar[],
  tradingDate: string,
  now: Date,
  frozen: boolean,
): PremarketLevels {
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let cumulativeVolumePrice = 0;
  let firstTs = bars[0].timestamp;
  let lastTs = bars[0].timestamp;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
    const typicalPrice = (b.high + b.low + b.close) / 3;
    cumulativeVolumePrice += typicalPrice * b.volume;
    if (b.timestamp.getTime() < firstTs.getTime()) firstTs = b.timestamp;
    if (b.timestamp.getTime() > lastTs.getTime()) lastTs = b.timestamp;
  }
  const vwap = volume > 0 ? cumulativeVolumePrice / volume : (high + low) / 2;
  const asOf = frozen ? premarketEndUtc(tradingDate) : now;
  return {
    session_date: tradingDate,
    high,
    low,
    vwap,
    volume,
    first_print_at: firstTs.toISOString(),
    last_print_at: lastTs.toISOString(),
    as_of: asOf.toISOString(),
  };
}

function buildIndicators(
  bars: Bar[],
  lastPrice: number | null,
  now: Date,
  frozen: boolean,
): SessionIndicators {
  const vwapSeries = calculateVWAP(bars);
  const sessionVwap = vwapSeries.length > 0 ? vwapSeries[vwapSeries.length - 1] : null;
  const volume = bars.reduce((acc, b) => acc + b.volume, 0);
  const priceVsVwapPct = computePriceVsVwap(lastPrice, sessionVwap);
  const tradingDate = tradingDayET(now);
  const asOf = frozen ? rthEndUtc(tradingDate) : now;
  return {
    session_vwap: sessionVwap,
    session_vwap_volume: volume,
    price_vs_vwap_pct: priceVsVwapPct,
    as_of: asOf.toISOString(),
  };
}

function computePriceVsVwap(
  lastPrice: number | null,
  sessionVwap: number | null,
): number | null {
  if (lastPrice === null || sessionVwap === null || sessionVwap <= 0) return null;
  // Round to 2 decimal places of percent — matches `gapPercent` precision.
  return Math.round(((lastPrice - sessionVwap) / sessionVwap) * 10000) / 100;
}

export class SessionLevelsService {
  private cache = new Map<string, CacheEntry>();

  /**
   * Compute (or return cached) premarket levels + session VWAP for one
   * symbol. Off-watchlist callers (Q6) trigger the same fetch path but
   * emit an audit log line so we can correlate against rate-limit usage.
   *
   * Returns `{ premarket: null, indicators: null }` when the underlying
   * Alpaca call returns no bars in either window — no IEX activity for
   * this symbol on this trading day.
   */
  async compute(symbol: string, opts: ComputeOptions): Promise<SessionLevels> {
    const upper = symbol.toUpperCase();
    const now = opts.now ?? new Date();
    const tradingDate = tradingDayET(now);
    const cached = this.cache.get(upper);

    if (cached && cached.sessionDate === tradingDate) {
      const fresh = Date.now() - cached.computedAt < CACHE_TTL_MS;
      const allFrozen = cached.premarketFrozen && cached.indicatorsFrozen;
      if (fresh || allFrozen) {
        return this.refreshPriceVsVwap(cached, opts.lastPrice ?? null);
      }
    }

    if (!opts.isOnWatchlist) {
      console.log(
        `[session-levels] off-watchlist compute for ${upper} (tradingDate=${tradingDate})`,
      );
    }

    const startUtcMs = premarketStartUtc(tradingDate).getTime();
    const lookbackMinutes = Math.max(1, Math.ceil((now.getTime() - startUtcMs) / 60_000));
    // fetchAlpacaBars uses the configured feed (`APCA_DATA_FEED`, default IEX)
    // and falls back to IEX on SIP subscription errors. We don't override the
    // feed per-call: the data is fungible for both windows, and the budgeted
    // limiter and 5s bar cache behind this call are shared with everything
    // else in the codebase.
    const bars = await fetchAlpacaBars(upper, '1Min', lookbackMinutes);

    const pmBars = bars.filter((b) => isInPremarket(b.timestamp, tradingDate));
    const rthBars = bars.filter((b) => isInRth(b.timestamp, tradingDate));

    const premarketFrozen = now.getTime() >= premarketEndUtc(tradingDate).getTime();
    const indicatorsFrozen = now.getTime() >= rthEndUtc(tradingDate).getTime();

    const premarket =
      pmBars.length > 0 ? buildPremarket(pmBars, tradingDate, now, premarketFrozen) : null;
    const indicators =
      rthBars.length > 0
        ? buildIndicators(rthBars, opts.lastPrice ?? null, now, indicatorsFrozen)
        : null;

    const entry: CacheEntry = {
      sessionDate: tradingDate,
      premarket,
      premarketFrozen,
      indicators,
      indicatorsFrozen,
      computedAt: Date.now(),
      lastPrice: opts.lastPrice ?? null,
    };
    this.cache.set(upper, entry);
    return { premarket, indicators };
  }

  /**
   * On a cache hit, the bars haven't been re-fetched but the caller may
   * have a fresher last price. Recompute `price_vs_vwap_pct` against it
   * so the percent doesn't lag the price tick by up to 30s. The vwap and
   * volume themselves are stable across the TTL window.
   */
  private refreshPriceVsVwap(
    cached: CacheEntry,
    newLastPrice: number | null,
  ): SessionLevels {
    if (!cached.indicators || newLastPrice === cached.lastPrice) {
      return { premarket: cached.premarket, indicators: cached.indicators };
    }
    const indicators: SessionIndicators = {
      ...cached.indicators,
      price_vs_vwap_pct: computePriceVsVwap(newLastPrice, cached.indicators.session_vwap),
    };
    cached.lastPrice = newLastPrice;
    cached.indicators = indicators;
    return { premarket: cached.premarket, indicators };
  }

  /** Test seam — drops all cached entries. */
  clearCache(): void {
    this.cache.clear();
  }
}

export const sessionLevelsService = new SessionLevelsService();
