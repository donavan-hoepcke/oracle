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
  computeOrbSignal,
} from '../services/ruleEngineService.js';
import type { Bar } from '../services/indicatorService.js';
import type { CycleRecord, RecordedItem, RecordedDecision } from '../services/recordingService.js';
import { sectorMapService } from '../services/sectorMapService.js';
import { tradeHistoryService } from '../services/tradeHistoryService.js';
import {
  computeMarketRegime,
  computeSectorRegime,
  computeTickerRegime,
  type RegimeSnapshot,
  type SectorRegime,
  type TickerRegime,
} from '../services/regimeService.js';
import type { TradeLedgerEntry } from '../services/executionService.js';

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

async function fetchBarsWithTimeframe(
  symbols: string[],
  timeframe: string,
  startIso: string,
  endIso: string,
): Promise<Record<string, RawBar[]>> {
  if (!alpacaApiKeyId || !alpacaApiSecretKey) fail('APCA_API_KEY_ID / APCA_API_SECRET_KEY not set');
  const out: Record<string, RawBar[]> = Object.fromEntries(symbols.map((s) => [s, []]));
  let pageToken: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe,
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
    if (!res.ok) {
      // Non-fatal: return what we have so far (e.g. ETF not on IEX feed).
      console.error(`Alpaca ${res.status} fetching [${symbols.join(',')}] timeframe=${timeframe}: ${await res.text()}`);
      return out;
    }
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

// ---------------------------------------------------------------------------
// Helpers for slicing minute-aligned bars into Bar[] for regime computers
// ---------------------------------------------------------------------------

function extractMinuteWindow(
  m: Map<number, CachedBar>,
  tMs: number,
  windowMin: number,
): Bar[] {
  const out: Bar[] = [];
  for (let offset = windowMin - 1; offset >= 0; offset--) {
    const bar = m.get(tMs - offset * 60_000);
    if (!bar) continue;
    out.push({
      timestamp: new Date(bar.ts),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    });
  }
  return out;
}

function extractBarsFromStart(
  m: Map<number, CachedBar>,
  startMs: number,
  endMs: number,
): Bar[] {
  const out: Bar[] = [];
  for (const b of m.values()) {
    if (b.ts >= startMs && b.ts <= endMs) {
      out.push({
        timestamp: new Date(b.ts),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      });
    }
  }
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}

function vxxBarsToBar(raw: RawBar[]): Bar[] {
  return raw.map((b) => ({
    timestamp: new Date(b.t),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
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
  const barsRaw = await fetchBarsWithTimeframe(
    symbols,
    '1Min',
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

  // ---------------------------------------------------------------------------
  // Regime up-front fetches
  // ---------------------------------------------------------------------------
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Resolve sector per symbol (may call Finnhub; results are cached on disk).
  console.error('resolving sectors for watchlist symbols...');
  const sectorBySymbol = new Map<string, string>();
  for (const sym of symbols) {
    sectorBySymbol.set(sym, await sectorMapService.getSectorFor(sym));
  }

  const distinctEtfs = Array.from(new Set(
    Array.from(sectorBySymbol.values()).map((s) => sectorMapService.getEtfFor(s)),
  ));

  // Fetch SPY + sector ETFs as 1m over the same RTH window as the watchlist.
  const etfSymbolsForMinuteFetch = Array.from(new Set(['SPY', ...distinctEtfs]));
  console.error(`fetching 1m bars for ETFs: ${etfSymbolsForMinuteFetch.join(', ')}`);
  const etfRaw = await fetchBarsWithTimeframe(
    etfSymbolsForMinuteFetch,
    '1Min',
    new Date(premarketStartMs).toISOString(),
    new Date(rthEndMs).toISOString(),
  );
  const etfBarsByMs: Record<string, Map<number, CachedBar>> = {};
  for (const etf of etfSymbolsForMinuteFetch) {
    etfBarsByMs[etf] = indexBars(etfRaw[etf] ?? []);
  }

  // VXX as 1Day: fetch 3 days ending at RTH start of replay day.
  console.error('fetching VXX daily bars (3 days)...');
  const vxxDailyRaw = await fetchBarsWithTimeframe(
    ['VXX'],
    '1Day',
    new Date(rthStartMs - 3 * DAY_MS).toISOString(),
    new Date(rthStartMs).toISOString(),
  );

  // Watchlist daily bars (30 days prior to replay day).
  console.error('fetching watchlist daily bars (30 days)...');
  const dailyRaw = await fetchBarsWithTimeframe(
    symbols,
    '1Day',
    new Date(rthStartMs - 30 * DAY_MS).toISOString(),
    new Date(rthStartMs).toISOString(),
  );
  const dailyBars: Record<string, Bar[]> = {};
  for (const sym of symbols) {
    dailyBars[sym] = (dailyRaw[sym] ?? []).map((b) => ({
      timestamp: new Date(b.t),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  }

  // Prior-day closed trades (no lookahead — tradeHistoryService reads only day < now).
  console.error('loading prior-day trade history...');
  const historyBySymbol = new Map<string, TradeLedgerEntry[]>();
  for (const sym of symbols) {
    const history = await tradeHistoryService.getRecentTrades(
      sym,
      'orb_breakout',
      new Date(`${day}T00:00:00Z`),
    );
    historyBySymbol.set(sym, history);
  }

  // ---------------------------------------------------------------------------
  // Replay loop
  // ---------------------------------------------------------------------------
  const cycles: CycleRecord[] = [];
  let candidateCount = 0;
  let setupCounts: Record<string, number> = {};

  for (let tMs = rthStartMs; tMs < rthEndMs; tMs += 60_000) {
    const tsUtcIso = new Date(tMs).toISOString();
    const tsEt = formatInTimeZone(new Date(tMs), ET, 'HH:mm:ss');
    const items: RecordedItem[] = [];
    const decisions: RecordedDecision[] = [];

    // Build per-minute regime snapshot (shared across all symbols this minute).
    const spyBarsForMinute = etfBarsByMs['SPY']
      ? extractMinuteWindow(etfBarsByMs['SPY'], tMs, 30)
      : [];
    const vxxBars = vxxBarsToBar(vxxDailyRaw['VXX'] ?? []);
    const sectorBarsByEtf: Record<string, Bar[]> = {};
    for (const etf of distinctEtfs) {
      const m = etfBarsByMs[etf];
      if (m) sectorBarsByEtf[etf] = extractMinuteWindow(m, tMs, 30);
    }

    const market = computeMarketRegime(spyBarsForMinute, vxxBars, new Date(tMs));
    const sectors: Record<string, SectorRegime> = {};
    for (const [etf, bars] of Object.entries(sectorBarsByEtf)) {
      sectors[etf] = computeSectorRegime(bars, etf, new Date(tMs));
    }
    const tickers: Record<string, TickerRegime> = {};
    for (const sym of symbols) {
      const todayBars = extractBarsFromStart(barsByMs[sym] ?? new Map(), rthStartMs, tMs);
      const sector = sectorBySymbol.get(sym) ?? 'unknown';
      tickers[sym] = computeTickerRegime(
        sym,
        'orb_breakout',
        dailyBars[sym] ?? [],
        todayBars,
        historyBySymbol.get(sym) ?? [],
        sector,
        new Date(tMs),
      );
    }
    const snapshot: RegimeSnapshot = {
      ts: new Date(tMs).toISOString(),
      market,
      sectors,
      tickers,
    };

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
      const candidate = ruleEngineService.scoreFromInputs(
        stock,
        emptyMessageContext(sym),
        emptyRedCandleSignal(),
        orbSignal,
        snapshot,
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
      regime: snapshot,
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
