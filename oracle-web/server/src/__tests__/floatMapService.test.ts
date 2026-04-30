import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    bot: {
      floatmap: {
        enabled: false,
        url: '',
        poll_interval_sec: 120,
        frame_url_contains: 'amplifyapp.com',
        hydration_wait_ms: 0,
      },
      playwright: { chrome_cdp_url: '' },
    },
  },
}));

import { FloatMapService, parseFloatMapText } from '../services/floatMapService.js';

const SAMPLE = `Oracle FloatMAP
SYMBOL
\t
ROTATION
\t
LAST
\t
FLOAT
\t
NEXT ORACLE SUPPORT
\t
NEXT ORACLE RESISTANCE



FCHL
\t
364x
\t
0.264
\t
411.97k
\t
0.167
\t
0.298


EDBL
\t
60x
\t
1.13
\t
904.62k
\t
1.10
\t
1.21


XRTX
\t
44x
\t
2.90
\t
1.36M
\t
2.68
\t
2.94


LOCL
\t
3x
\t
2.73
\t
16.79M
\t
2.37
\t
2.74
ALBT - LEVELS
0
0.0908
0.146
0
0.237
0.0900
`;

describe('parseFloatMapText', () => {
  it('extracts the ranked FloatMAP table into typed entries', () => {
    const entries = parseFloatMapText(SAMPLE);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      symbol: 'FCHL',
      rotation: 364,
      last: 0.264,
      floatMillions: 0.41197,
      nextOracleSupport: 0.167,
      nextOracleResistance: 0.298,
    });
    expect(entries[2]).toMatchObject({ symbol: 'XRTX', floatMillions: 1.36 });
    expect(entries[3]).toMatchObject({ symbol: 'LOCL', floatMillions: 16.79 });
  });

  it('stops cleanly at the per-symbol LEVELS volume-at-price block', () => {
    const entries = parseFloatMapText(SAMPLE);
    // If parsing bled into the LEVELS numeric pairs, we would see extra entries
    // or a malformed symbol.
    expect(entries.every((e) => /^[A-Z]+$/.test(e.symbol))).toBe(true);
  });

  it('returns empty array when the header is missing', () => {
    expect(parseFloatMapText('')).toEqual([]);
    expect(parseFloatMapText('not a floatmap table')).toEqual([]);
  });

  it('isStale returns true when never fetched, false when fresh, true when over max age', () => {
    const svc = new FloatMapService();
    // Never fetched.
    expect(svc.isStale(600)).toBe(true);

    // Manually seed a fresh snapshot.
    (svc as unknown as { snapshot: { fetchedAt: string; entries: unknown[]; error: null } }).snapshot = {
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      entries: [],
      error: null,
    };
    expect(svc.isStale(600)).toBe(false);
    expect(svc.isStale(30)).toBe(true); // 60s old, max 30s → stale
  });

  it('getEntryForSymbol returns null when stale even if symbol is present', () => {
    const svc = new FloatMapService();
    (svc as unknown as { snapshot: { fetchedAt: string; entries: unknown[]; error: null } }).snapshot = {
      fetchedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1 hour old
      entries: [
        { symbol: 'AGAE', rotation: 2.0, last: 1, floatMillions: 5, nextOracleSupport: null, nextOracleResistance: null },
      ],
      error: null,
    };
    expect(svc.getEntryForSymbol('AGAE', 600)).toBeNull(); // stale → null
    expect(svc.getEntryForSymbol('AGAE', 7200)).not.toBeNull(); // bigger window → fresh
  });

  it('parses k / M / B float suffixes into millions', () => {
    const raw = `SYMBOL
ROTATION
LAST
FLOAT
NEXT ORACLE SUPPORT
NEXT ORACLE RESISTANCE
AAAA
1x
10
500k
9
11
BBBB
1x
20
2M
18
22
CCCC
1x
30
1.5B
28
32
`;
    const entries = parseFloatMapText(raw);
    expect(entries.map((e) => e.floatMillions)).toEqual([0.5, 2, 1500]);
  });
});
