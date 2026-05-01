import { config } from '../config.js';
import { fetchAlpaca1MinBars } from './alpacaBarService.js';
import { sectorMapService } from './sectorMapService.js';
import type { Bar } from './indicatorService.js';

/**
 * Per-sector hotness ranking. Captures "the market is rotating into X today"
 * — when news hits a sector, the sector ETF moves and (often) volume spikes
 * across the sector members. We surface that as a score nudge for any
 * candidate whose sector lands in the top K hot sectors.
 *
 * v1 metric: today's % change on the sector ETF (slope from session open).
 * RVOL is a planned v2 refinement to catch news pops before price moves.
 */
export interface SectorHotness {
  /** Canonical sector key (matches sectorMapService keys). */
  sector: string;
  /** Sector ETF symbol (XLK, XBI, etc.). */
  etf: string;
  /** Today's session % change on the ETF. null when bars are unavailable. */
  pctChange: number | null;
  /**
   * 1-indexed rank among sectors with a valid pctChange. null when
   * the ETF didn't return enough bars (treated as "not ranked").
   */
  rank: number | null;
}

export interface SectorHotnessSnapshot {
  fetchedAt: string | null;
  /** All sectors, sorted by pctChange desc (unavailable last). */
  ranking: SectorHotness[];
  /**
   * Convenience map sector -> rank for O(1) lookup. Mirrors `ranking[i].rank`
   * but skips the array search at score time.
   */
  bySector: Record<string, SectorHotness>;
  error: string | null;
}

const SECTOR_ETFS: Array<{ sector: string; etf: string }> = [
  { sector: 'materials', etf: 'XLB' },
  { sector: 'communications', etf: 'XLC' },
  { sector: 'energy', etf: 'XLE' },
  { sector: 'financials', etf: 'XLF' },
  { sector: 'industrials', etf: 'XLI' },
  { sector: 'technology', etf: 'XLK' },
  { sector: 'software', etf: 'IGV' },
  { sector: 'consumer_staples', etf: 'XLP' },
  { sector: 'real_estate', etf: 'XLRE' },
  { sector: 'utilities', etf: 'XLU' },
  { sector: 'healthcare', etf: 'XLV' },
  { sector: 'consumer_discretionary', etf: 'XLY' },
  { sector: 'biotechnology', etf: 'XBI' },
];

function computePctChange(bars: Bar[]): number | null {
  if (bars.length < 2) return null;
  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  if (first <= 0) return null;
  return (last - first) / first;
}

/**
 * Build a hotness snapshot from a pre-fetched bars map. Pure function so
 * tests can drive the ranking with synthetic bars.
 */
export function buildSnapshot(barsByEtf: Map<string, Bar[]>): SectorHotnessSnapshot {
  const rows: SectorHotness[] = SECTOR_ETFS.map(({ sector, etf }) => ({
    sector,
    etf,
    pctChange: computePctChange(barsByEtf.get(etf) ?? []),
    rank: null,
  }));
  // Sort: defined pctChange descending, undefined to the end.
  rows.sort((a, b) => {
    if (a.pctChange === null && b.pctChange === null) return 0;
    if (a.pctChange === null) return 1;
    if (b.pctChange === null) return -1;
    return b.pctChange - a.pctChange;
  });
  let nextRank = 1;
  for (const row of rows) {
    if (row.pctChange !== null) {
      row.rank = nextRank++;
    }
  }
  const bySector: Record<string, SectorHotness> = {};
  for (const row of rows) bySector[row.sector] = row;
  return {
    fetchedAt: new Date().toISOString(),
    ranking: rows,
    bySector,
    error: null,
  };
}

export class SectorHotnessService {
  private snapshot: SectorHotnessSnapshot = {
    fetchedAt: null,
    ranking: [],
    bySector: {},
    error: null,
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlight = false;

  getSnapshot(): SectorHotnessSnapshot {
    return this.snapshot;
  }

  isStale(maxAgeSeconds: number): boolean {
    if (!this.snapshot.fetchedAt) return true;
    const ageMs = Date.now() - new Date(this.snapshot.fetchedAt).getTime();
    return ageMs > maxAgeSeconds * 1000;
  }

  /**
   * Lookup helper used at scoring time. Returns the SectorHotness for the
   * given symbol's sector, or null if the snapshot is stale / sector
   * unknown. Callers use `rank <= top_k` to decide whether to apply the
   * hotness bump.
   */
  async getHotnessForSymbol(
    symbol: string,
    maxAgeSeconds: number,
  ): Promise<SectorHotness | null> {
    if (this.isStale(maxAgeSeconds)) return null;
    const sector = await sectorMapService.getSectorFor(symbol);
    if (!sector || sector === 'unknown') return null;
    return this.snapshot.bySector[sector] ?? null;
  }

  async start(): Promise<void> {
    const cfg = config.execution.sector_hotness;
    if (!cfg?.enabled) return;
    if (this.pollTimer) return;
    const intervalMs = cfg.refresh_interval_seconds * 1000;
    this.pollOnce().catch((err) => {
      console.warn('sector hotness initial poll failed:', err instanceof Error ? err.message : err);
    });
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => {
        console.warn('sector hotness poll failed:', err instanceof Error ? err.message : err);
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      // 1m bars over a session-length lookback so the first/last close
      // approximates today's session move. 60m gives the last hour during
      // regular hours and degrades gracefully outside.
      const lookbackMin = config.execution.sector_hotness?.lookback_minutes ?? 60;
      const barsByEtf = new Map<string, Bar[]>();
      // Sequential fetch keeps us under Alpaca's per-burst rate limit when
      // the live ticker scraper is also running.
      for (const { etf } of SECTOR_ETFS) {
        try {
          const bars = await fetchAlpaca1MinBars(etf, lookbackMin);
          barsByEtf.set(etf, bars);
        } catch (err) {
          // Per-ETF failure shouldn't sink the whole snapshot.
          console.warn(
            `sector hotness: ${etf} bars failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      this.snapshot = buildSnapshot(barsByEtf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = { ...this.snapshot, error: msg };
    } finally {
      this.inFlight = false;
    }
  }
}

export const sectorHotnessService = new SectorHotnessService();
