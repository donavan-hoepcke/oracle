import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  alpacaApiKeyId,
  alpacaApiSecretKey,
  alpacaDataFeed,
  polygonApiKey,
  config,
} from '../config.js';

const ET = 'America/New_York';
const POLYGON_MIN_INTERVAL_MS = 13_000;

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface PolygonBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface NormalizedBar {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Args {
  day: string;
  symbols: string[];
  startEt: string;
  endEt: string;
  outPath: string;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function todayEt(): string {
  return formatInTimeZone(new Date(), ET, 'yyyy-MM-dd');
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };

  const symbolsRaw = get('--symbols');
  if (!symbolsRaw) {
    fail(
      'Usage: npm run compare-feeds -- --symbols AAPL,TSLA [--day YYYY-MM-DD] [--start HH:MM] [--end HH:MM] [--out path.csv]',
    );
  }
  const symbols = symbolsRaw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) fail('No symbols supplied');

  const day = get('--day') ?? todayEt();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`Invalid --day: ${day}`);

  const startEt = get('--start') ?? '04:00';
  const endEt = get('--end') ?? '20:00';
  for (const hhmm of [startEt, endEt]) {
    if (!/^\d{2}:\d{2}$/.test(hhmm)) fail(`Invalid time: ${hhmm} (expected HH:MM)`);
  }

  const defaultOut = resolve(config.recording.dir, `feed-diff-${day}.csv`);
  const outPath = get('--out') ?? defaultOut;

  return { day, symbols, startEt, endEt, outPath };
}

function etWallToUtcMs(day: string, hhmm: string): number {
  return fromZonedTime(`${day}T${hhmm}:00`, ET).getTime();
}

async function fetchAlpacaBars(
  symbols: string[],
  startMs: number,
  endMs: number,
): Promise<Record<string, NormalizedBar[]>> {
  if (!alpacaApiKeyId || !alpacaApiSecretKey) {
    fail('APCA_API_KEY_ID / APCA_API_SECRET_KEY not set');
  }
  const out: Record<string, NormalizedBar[]> = Object.fromEntries(symbols.map((s) => [s, []]));
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe: '1Min',
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      feed: alpacaDataFeed || 'iex',
      limit: '10000',
      adjustment: 'raw',
    });
    if (pageToken) params.set('page_token', pageToken);

    const res = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${params}`, {
      headers: {
        'APCA-API-KEY-ID': alpacaApiKeyId,
        'APCA-API-SECRET-KEY': alpacaApiSecretKey,
      },
    });
    if (!res.ok) fail(`Alpaca ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      bars: Record<string, AlpacaBar[]>;
      next_page_token: string | null;
    };
    for (const [sym, bars] of Object.entries(data.bars ?? {})) {
      for (const b of bars) {
        out[sym].push({
          tsMs: new Date(b.t).getTime(),
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
          volume: b.v,
        });
      }
    }
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }
  for (const sym of symbols) out[sym].sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

async function fetchPolygonBarsOne(
  symbol: string,
  day: string,
): Promise<NormalizedBar[]> {
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
    symbol,
  )}/range/1/minute/${day}/${day}?adjusted=true&sort=asc&limit=50000&apiKey=${polygonApiKey}`;
  const res = await fetch(url);
  if (res.status === 429) {
    console.error(`  ${symbol}: 429 rate-limited, backing off 65s`);
    await new Promise((r) => setTimeout(r, 65_000));
    return fetchPolygonBarsOne(symbol, day);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`  ${symbol}: Polygon ${res.status}: ${body.slice(0, 200)}`);
    return [];
  }
  const data = (await res.json()) as {
    results?: PolygonBar[];
    resultsCount?: number;
    status?: string;
  };
  const bars = data.results ?? [];
  return bars
    .map((b) => ({ tsMs: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
    .sort((a, b) => a.tsMs - b.tsMs);
}

async function fetchPolygonBars(
  symbols: string[],
  day: string,
  startMs: number,
  endMs: number,
): Promise<Record<string, NormalizedBar[]>> {
  if (!polygonApiKey) fail('POLYGON_API_KEY not set in oracle-web/.env');
  const out: Record<string, NormalizedBar[]> = {};
  let lastCallMs = 0;
  for (const sym of symbols) {
    const waitMs = lastCallMs + POLYGON_MIN_INTERVAL_MS - Date.now();
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    lastCallMs = Date.now();
    const bars = await fetchPolygonBarsOne(sym, day);
    out[sym] = bars.filter((b) => b.tsMs >= startMs && b.tsMs < endMs);
    console.error(`  ${sym}: polygon ${out[sym].length} bars`);
  }
  return out;
}

interface DiffRow {
  tsMs: number;
  symbol: string;
  alpaca: NormalizedBar | null;
  polygon: NormalizedBar | null;
}

interface SymbolStats {
  symbol: string;
  alpacaBars: number;
  polygonBars: number;
  overlapBars: number;
  avgCloseDiffBps: number;
  maxCloseDiffBps: number;
  avgVolumeDiffPct: number;
}

function diffPerBar(
  symbol: string,
  alpacaBars: NormalizedBar[],
  polygonBars: NormalizedBar[],
): { rows: DiffRow[]; stats: SymbolStats } {
  const byMs = new Map<number, { a?: NormalizedBar; p?: NormalizedBar }>();
  for (const b of alpacaBars) byMs.set(b.tsMs, { ...(byMs.get(b.tsMs) ?? {}), a: b });
  for (const b of polygonBars) byMs.set(b.tsMs, { ...(byMs.get(b.tsMs) ?? {}), p: b });

  const rows: DiffRow[] = [...byMs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tsMs, { a, p }]) => ({ tsMs, symbol, alpaca: a ?? null, polygon: p ?? null }));

  let closeDiffSumBps = 0;
  let closeDiffMaxBps = 0;
  let volumeDiffSumPct = 0;
  let overlap = 0;
  for (const row of rows) {
    if (!row.alpaca || !row.polygon) continue;
    overlap++;
    const refClose = row.alpaca.close || row.polygon.close;
    if (refClose > 0) {
      const diffBps = Math.abs((row.polygon.close - row.alpaca.close) / refClose) * 10_000;
      closeDiffSumBps += diffBps;
      if (diffBps > closeDiffMaxBps) closeDiffMaxBps = diffBps;
    }
    const refVol = Math.max(row.alpaca.volume, row.polygon.volume);
    if (refVol > 0) {
      const diffPct = Math.abs((row.polygon.volume - row.alpaca.volume) / refVol) * 100;
      volumeDiffSumPct += diffPct;
    }
  }
  return {
    rows,
    stats: {
      symbol,
      alpacaBars: alpacaBars.length,
      polygonBars: polygonBars.length,
      overlapBars: overlap,
      avgCloseDiffBps: overlap ? closeDiffSumBps / overlap : 0,
      maxCloseDiffBps: closeDiffMaxBps,
      avgVolumeDiffPct: overlap ? volumeDiffSumPct / overlap : 0,
    },
  };
}

function writeCsv(outPath: string, rows: DiffRow[]): void {
  const header =
    'ts_utc,ts_et,symbol,coverage,alpaca_close,polygon_close,close_diff_bps,alpaca_volume,polygon_volume,volume_diff_pct';
  const lines = [header];
  for (const row of rows) {
    const tsUtc = new Date(row.tsMs).toISOString();
    const tsEt = formatInTimeZone(new Date(row.tsMs), ET, 'HH:mm');
    const coverage = row.alpaca && row.polygon ? 'both' : row.alpaca ? 'alpaca_only' : 'polygon_only';
    const aClose = row.alpaca ? row.alpaca.close.toFixed(4) : '';
    const pClose = row.polygon ? row.polygon.close.toFixed(4) : '';
    const ref = row.alpaca?.close || row.polygon?.close || 0;
    const closeDiffBps =
      row.alpaca && row.polygon && ref > 0
        ? (((row.polygon.close - row.alpaca.close) / ref) * 10_000).toFixed(2)
        : '';
    const aVol = row.alpaca ? String(Math.round(row.alpaca.volume)) : '';
    const pVol = row.polygon ? String(Math.round(row.polygon.volume)) : '';
    const refVol = Math.max(row.alpaca?.volume ?? 0, row.polygon?.volume ?? 0);
    const volDiffPct =
      row.alpaca && row.polygon && refVol > 0
        ? (((row.polygon.volume - row.alpaca.volume) / refVol) * 100).toFixed(1)
        : '';
    lines.push(
      [tsUtc, tsEt, row.symbol, coverage, aClose, pClose, closeDiffBps, aVol, pVol, volDiffPct].join(
        ',',
      ),
    );
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
}

function printSummary(stats: SymbolStats[], feed: string, day: string, outPath: string): void {
  console.error('');
  console.error(`feed-diff summary: ${day}, alpaca feed=${feed}`);
  console.error(
    'symbol  | alpaca | polygon | overlap | avg Δclose (bps) | max Δclose (bps) | avg Δvol %',
  );
  console.error(
    '--------+--------+---------+---------+------------------+------------------+-----------',
  );
  for (const s of stats) {
    console.error(
      `${s.symbol.padEnd(7)} | ${String(s.alpacaBars).padStart(6)} | ${String(s.polygonBars).padStart(7)} | ${String(s.overlapBars).padStart(7)} | ${s.avgCloseDiffBps.toFixed(2).padStart(16)} | ${s.maxCloseDiffBps.toFixed(2).padStart(16)} | ${s.avgVolumeDiffPct.toFixed(1).padStart(9)}`,
    );
  }
  console.error('');
  console.error(`wrote ${outPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const startMs = etWallToUtcMs(args.day, args.startEt);
  const endMs = etWallToUtcMs(args.day, args.endEt);

  console.error(
    `comparing feeds for ${args.symbols.length} symbols on ${args.day}, ${args.startEt}–${args.endEt} ET`,
  );
  console.error('fetching alpaca (batch)...');
  const alpacaBars = await fetchAlpacaBars(args.symbols, startMs, endMs);
  for (const sym of args.symbols) {
    console.error(`  ${sym}: alpaca ${alpacaBars[sym]?.length ?? 0} bars`);
  }

  console.error('fetching polygon (per-ticker, throttled)...');
  const polygonBars = await fetchPolygonBars(args.symbols, args.day, startMs, endMs);

  const allRows: DiffRow[] = [];
  const allStats: SymbolStats[] = [];
  for (const sym of args.symbols) {
    const { rows, stats } = diffPerBar(sym, alpacaBars[sym] ?? [], polygonBars[sym] ?? []);
    allRows.push(...rows);
    allStats.push(stats);
  }

  writeCsv(args.outPath, allRows);
  printSummary(allStats, alpacaDataFeed || 'iex', args.day, args.outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
