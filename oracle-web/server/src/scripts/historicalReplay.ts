import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { alpacaApiKeyId, alpacaApiSecretKey, alpacaDataFeed, config } from '../config.js';
import { StockState } from '../websocket/priceSocket.js';
import {
  ruleEngineService,
  emptyMessageContext,
  emptyRedCandleSignal,
  emptyOrbSignal,
  emptyMomentumSignal,
  computeOrbSignal,
  computeMomentumSignal,
} from '../services/ruleEngineService.js';
import type { Bar } from '../services/indicatorService.js';
import type { CycleRecord, RecordedItem, RecordedDecision } from '../services/recordingService.js';

const LEVELS_DIR = 'F:/oracle_data/levels';
const ET = 'America/New_York';

interface LevelEntry {
  stopPrice: number | null;
  buyZonePrice: number | null;
  sellZonePrice: number | null;
  lastPrice: number | null;
  floatMillions: number | null;
}

interface LevelsFile {
  day: string;
  tickers: Record<string, LevelEntry>;
}

interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CachedBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(): { day: string } {
  const args = process.argv.slice(2);
  const dayIdx = args.indexOf('--day');
  if (dayIdx === -1 || !args[dayIdx + 1]) {
    fail('Usage: npm run historical-replay -- --day YYYY-MM-DD');
  }
  const day = args[dayIdx + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`Invalid --day: ${day}`);
  return { day };
}

function loadLevels(day: string): LevelsFile {
  const path = resolve(LEVELS_DIR, `${day}.json`);
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as LevelsFile;
  } catch (err) {
    fail(`Could not read levels file ${path}: ${(err as Error).message}\nRun extract_levels.py first.`);
  }
}

function etWallToUtcMs(day: string, hour: number, minute: number): number {
  // Treat "day + hour:minute" as ET wall-clock and return its UTC epoch ms.
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return fromZonedTime(`${day}T${hh}:${mm}:00`, ET).getTime();
}

async function fetchBarsBatch(symbols: string[], startIso: string, endIso: string): Promise<Record<string, RawBar[]>> {
  if (!alpacaApiKeyId || !alpacaApiSecretKey) fail('APCA_API_KEY_ID / APCA_API_SECRET_KEY not set');
  const out: Record<string, RawBar[]> = Object.fromEntries(symbols.map((s) => [s, []]));
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe: '1Min',
      start: startIso,
      end: endIso,
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
    const data = (await res.json()) as { bars: Record<string, RawBar[]>; next_page_token: string | null };
    for (const [sym, bars] of Object.entries(data.bars ?? {})) {
      out[sym] = (out[sym] ?? []).concat(bars);
    }
    if (!data.next_page_token) return out;
    pageToken = data.next_page_token;
  }
}

function indexBars(bars: RawBar[]): Map<number, CachedBar> {
  const m = new Map<number, CachedBar>();
  for (const b of bars) {
    const ts = new Date(b.t).getTime();
    m.set(ts, { ts, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
  }
  return m;
}

function computeTrend30m(bars: CachedBar[]): 'up' | 'down' | 'flat' {
  if (bars.length < 5) return 'flat';
  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  if (first <= 0) return 'flat';
  const pct = (last - first) / first;
  if (pct > 0.005) return 'up';
  if (pct < -0.005) return 'down';
  return 'flat';
}

function toRecordedItem(s: StockState, floatMillions: number | null): RecordedItem {
  return {
    symbol: s.symbol,
    currentPrice: s.currentPrice,
    lastPrice: s.lastPrice ?? null,
    changePercent: s.changePercent,
    stopPrice: s.stopPrice ?? null,
    buyZonePrice: s.buyZonePrice ?? null,
    sellZonePrice: s.sellZonePrice ?? null,
    profitDeltaPct: s.profitDeltaPct ?? null,
    maxVolume: s.maxVolume ?? null,
    premarketVolume: s.premarketVolume ?? null,
    relativeVolume: s.relativeVolume ?? null,
    floatMillions,
    signal: null,
    trend30m: s.trend30m,
    boxTop: null,
    boxBottom: null,
  };
}

async function main(): Promise<void> {
  const { day } = parseArgs();
  const levels = loadLevels(day);
  const symbols = Object.keys(levels.tickers).sort();
  if (symbols.length === 0) fail('No symbols in levels file');

  const rthStartMs = etWallToUtcMs(day, 9, 30);
  const rthEndMs = etWallToUtcMs(day, 16, 0);
  const premarketStartMs = etWallToUtcMs(day, 4, 0);

  console.error(`fetching ${symbols.length} symbols, ${day} 04:00–16:00 ET`);
  const barsRaw = await fetchBarsBatch(
    symbols,
    new Date(premarketStartMs).toISOString(),
    new Date(rthEndMs).toISOString(),
  );
  const totalBars = Object.values(barsRaw).reduce((sum, arr) => sum + arr.length, 0);
  console.error(`fetched ${totalBars} bars`);

  const barsByMs: Record<string, Map<number, CachedBar>> = {};
  const barSeries: Record<string, CachedBar[]> = {};
  const barSeriesForOrb: Record<string, Bar[]> = {};
  for (const sym of symbols) {
    const raw = barsRaw[sym] ?? [];
    const cached = raw.map((b) => ({
      ts: new Date(b.t).getTime(),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
    cached.sort((a, b) => a.ts - b.ts);
    barSeries[sym] = cached;
    barsByMs[sym] = indexBars(raw);
    barSeriesForOrb[sym] = cached.map((b) => ({
      timestamp: new Date(b.ts),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
  }

  const premarketVolume: Record<string, number> = {};
  const cumulativeVolume: Record<string, number> = {};
  for (const sym of symbols) {
    let pm = 0;
    for (const b of barSeries[sym]) {
      if (b.ts < rthStartMs) pm += b.volume;
    }
    premarketVolume[sym] = pm;
    cumulativeVolume[sym] = 0;
  }

  const cycles: CycleRecord[] = [];
  let candidateCount = 0;
  let setupCounts: Record<string, number> = {};

  for (let tMs = rthStartMs; tMs < rthEndMs; tMs += 60_000) {
    const tsUtcIso = new Date(tMs).toISOString();
    const tsEt = formatInTimeZone(new Date(tMs), ET, 'HH:mm:ss');
    const items: RecordedItem[] = [];
    const decisions: RecordedDecision[] = [];

    for (const sym of symbols) {
      const lv = levels.tickers[sym];
      const bar = barsByMs[sym].get(tMs);
      if (!bar) continue;
      cumulativeVolume[sym] += bar.volume;

      const windowStart = tMs - 29 * 60_000;
      const window = barSeries[sym].filter((b) => b.ts >= windowStart && b.ts <= tMs);
      const trend30m = computeTrend30m(window);

      const lastPriceRef = lv.lastPrice;
      const changePct = lastPriceRef && lastPriceRef > 0 ? (bar.close - lastPriceRef) / lastPriceRef : null;

      const stock: StockState = {
        symbol: sym,
        targetPrice: lv.sellZonePrice ?? 0,
        resistance: lv.sellZonePrice ?? null,
        stopLossPct: null,
        stopPrice: lv.stopPrice ?? null,
        longPrice: lv.buyZonePrice ?? null,
        buyZonePrice: lv.buyZonePrice ?? null,
        sellZonePrice: lv.sellZonePrice ?? null,
        profitDeltaPct: null,
        maxVolume: cumulativeVolume[sym],
        lastVolume: bar.volume,
        premarketVolume: premarketVolume[sym],
        relativeVolume: null,
        floatMillions: lv.floatMillions ?? null,
        gapPercent: changePct,
        lastPrice: lastPriceRef ?? null,
        currentPrice: bar.close,
        change: lastPriceRef ? bar.close - lastPriceRef : null,
        changePercent: changePct,
        trend30m,
        inTargetRange: false,
        alerted: false,
        source: 'historical-replay',
        lastUpdate: tsUtcIso,
        signal: null,
        boxTop: null,
        boxBottom: null,
        signalTimestamp: null,
      };

      items.push(toRecordedItem(stock, lv.floatMillions));

      const orbSignal = tMs >= rthStartMs
        ? computeOrbSignal(stock, barSeriesForOrb[sym], new Date(tMs))
        : emptyOrbSignal();
      const momentumSignal = tMs >= rthStartMs
        ? computeMomentumSignal(stock, barSeriesForOrb[sym], new Date(tMs))
        : emptyMomentumSignal();
      const candidate = ruleEngineService.scoreFromInputs(
        stock,
        emptyMessageContext(sym),
        emptyRedCandleSignal(),
        orbSignal,
        momentumSignal,
      );
      if (candidate) {
        decisions.push({
          symbol: sym,
          kind: 'candidate',
          setup: candidate.setup,
          score: candidate.score,
          rationale: candidate.rationale,
          suggestedEntry: candidate.suggestedEntry,
          suggestedStop: candidate.suggestedStop,
          suggestedTarget: candidate.suggestedTarget,
        });
        candidateCount++;
        setupCounts[candidate.setup] = (setupCounts[candidate.setup] ?? 0) + 1;
      }
    }

    cycles.push({
      ts: tsUtcIso,
      tsEt,
      tradingDay: day,
      marketStatus: { isOpen: true, openTime: '09:30', closeTime: '16:00' },
      items,
      decisions,
      activeTrades: [],
      closedTrades: [],
    });
  }

  const outPath = resolve(config.recording.dir, `${day}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, cycles.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf-8');

  console.error(`cycles: ${cycles.length}, candidate-decisions emitted: ${candidateCount}`);
  console.error(`by setup: ${JSON.stringify(setupCounts)}`);
  console.error(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
