import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      sector_hotness: {
        enabled: true,
        top_k_sectors: 3,
        score_bump: 8,
        refresh_interval_seconds: 300,
        max_age_seconds: 900,
        lookback_minutes: 60,
      },
    },
  },
  finnhubApiKey: '',
}));

vi.mock('../services/sectorMapService.js', () => ({
  sectorMapService: {
    getSectorFor: vi.fn().mockResolvedValue('technology'),
    getEtfFor: vi.fn().mockReturnValue('XLK'),
  },
}));

import {
  buildSnapshot,
  SectorHotnessService,
} from '../services/sectorHotnessService.js';
import { sectorMapService } from '../services/sectorMapService.js';
import type { Bar } from '../services/indicatorService.js';

function bar(close: number, ts: number = 0): Bar {
  return { timestamp: new Date(ts), open: close, high: close, low: close, close, volume: 1 };
}

describe('buildSnapshot', () => {
  it('ranks sectors by today % change descending', () => {
    // XLK: +5%, XLE: +1%, XLV: -2% — others: empty
    const bars = new Map<string, Bar[]>([
      ['XLK', [bar(100), bar(105)]],
      ['XLE', [bar(50), bar(50.5)]],
      ['XLV', [bar(80), bar(78.4)]],
    ]);
    const snap = buildSnapshot(bars);

    const ranked = snap.ranking.filter((r) => r.rank !== null);
    expect(ranked[0]).toMatchObject({ etf: 'XLK', rank: 1 });
    expect(ranked[0].pctChange).toBeCloseTo(0.05, 4);
    expect(ranked[1]).toMatchObject({ etf: 'XLE', rank: 2 });
    expect(ranked[2]).toMatchObject({ etf: 'XLV', rank: 3 });
    expect(ranked[2].pctChange).toBeCloseTo(-0.02, 4);
  });

  it('puts sectors without enough bars at the end and leaves rank=null', () => {
    const bars = new Map<string, Bar[]>([
      ['XLK', [bar(100), bar(102)]],
      // XLE: only 1 bar — not enough to compute a change
      ['XLE', [bar(50)]],
      // XLV: empty — also unavailable
    ]);
    const snap = buildSnapshot(bars);

    const xlk = snap.bySector['technology'];
    const xle = snap.bySector['energy'];
    const xlv = snap.bySector['healthcare'];
    expect(xlk.rank).toBe(1);
    expect(xle.rank).toBeNull();
    expect(xle.pctChange).toBeNull();
    expect(xlv.rank).toBeNull();
  });

  it('exposes a bySector map keyed on canonical sector for O(1) lookup', () => {
    const snap = buildSnapshot(new Map([['XLK', [bar(100), bar(101)]]]));
    expect(snap.bySector['technology']).toMatchObject({ etf: 'XLK', sector: 'technology', rank: 1 });
    expect(snap.bySector['biotechnology']).toMatchObject({ etf: 'XBI', rank: null });
  });
});

describe('SectorHotnessService.isStale', () => {
  it('returns true when never fetched, false when fresh, true when over max age', () => {
    const svc = new SectorHotnessService();
    expect(svc.isStale(900)).toBe(true);

    (svc as unknown as { snapshot: { fetchedAt: string; ranking: unknown[]; bySector: Record<string, unknown>; error: null } }).snapshot = {
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      ranking: [],
      bySector: {},
      error: null,
    };
    expect(svc.isStale(900)).toBe(false);
    expect(svc.isStale(30)).toBe(true);
  });
});

describe('SectorHotnessService.getHotnessForSymbol', () => {
  it('returns null when stale even if data exists', async () => {
    const svc = new SectorHotnessService();
    (svc as unknown as { snapshot: { fetchedAt: string; ranking: unknown[]; bySector: Record<string, unknown>; error: null } }).snapshot = {
      fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
      ranking: [],
      bySector: { technology: { sector: 'technology', etf: 'XLK', rank: 1, pctChange: 0.05 } },
      error: null,
    };
    const result = await svc.getHotnessForSymbol('AAPL', 900);
    expect(result).toBeNull();
  });

  it('returns the bySector entry when fresh and sector resolves', async () => {
    const svc = new SectorHotnessService();
    vi.mocked(sectorMapService.getSectorFor).mockResolvedValueOnce('technology');
    (svc as unknown as { snapshot: { fetchedAt: string; ranking: unknown[]; bySector: Record<string, unknown>; error: null } }).snapshot = {
      fetchedAt: new Date().toISOString(),
      ranking: [],
      bySector: { technology: { sector: 'technology', etf: 'XLK', rank: 1, pctChange: 0.05 } },
      error: null,
    };
    const result = await svc.getHotnessForSymbol('AAPL', 900);
    expect(result).toMatchObject({ sector: 'technology', etf: 'XLK', rank: 1 });
  });

  it('returns null when symbol resolves to an unknown sector', async () => {
    const svc = new SectorHotnessService();
    vi.mocked(sectorMapService.getSectorFor).mockResolvedValueOnce('unknown');
    (svc as unknown as { snapshot: { fetchedAt: string; ranking: unknown[]; bySector: Record<string, unknown>; error: null } }).snapshot = {
      fetchedAt: new Date().toISOString(),
      ranking: [],
      bySector: {},
      error: null,
    };
    const result = await svc.getHotnessForSymbol('UNKNOWN_TICKER', 900);
    expect(result).toBeNull();
  });
});
