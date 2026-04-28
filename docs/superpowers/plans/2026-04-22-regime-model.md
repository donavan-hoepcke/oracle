# Regime-Aware Trade Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a regime layer (market + sector + ticker) that soft-scores and hard-vetos trade candidates so the engine stops entering hostile tapes.

**Architecture:** New upstream `RegimeService` emits a `RegimeSnapshot` per poll cycle (SPY/VXX for market, SPDR ETFs for sector, ATR + win-rate for ticker). Snapshot is threaded through `scoreFromInputs` and `filterCandidate` as an argument, recorded into `CycleRecord`, and replayed losslessly in backtest. Two supporting services — `SectorMapService` (Finnhub + cache + overrides) and `TradeHistoryService` (reads prior recording JSONLs) — feed the regime snapshot.

**Tech Stack:** TypeScript/Node, Vitest, Alpaca Market Data (bars), Finnhub `/stock/profile2` (sector lookup), zod config, JSONL recordings.

**Reference spec:** `docs/superpowers/specs/2026-04-22-regime-model-design.md`

---

## File Structure

**New:**
- `oracle-web/server/src/services/regimeService.ts` — pure computers + async orchestrator, ~250 lines
- `oracle-web/server/src/services/sectorMapService.ts` — ticker→sector with Finnhub fallback, ~120 lines
- `oracle-web/server/src/services/tradeHistoryService.ts` — JSONL reader filtered by (symbol, setup, date window), ~100 lines
- `oracle-web/server/config/sector_overrides.yaml` — empty override map
- `oracle-web/server/src/__tests__/regimeService.test.ts`
- `oracle-web/server/src/__tests__/sectorMapService.test.ts`
- `oracle-web/server/src/__tests__/tradeHistoryService.test.ts`

**Modified:**
- `oracle-web/server/src/services/ruleEngineService.ts` — `scoreFromInputs` gains optional `regime?: RegimeSnapshot`, `evaluateStock` and `getRankedCandidates` forward it
- `oracle-web/server/src/services/tradeFilterService.ts` — `filterCandidate` gains optional `regime?: RegimeSnapshot`, runs three vetos
- `oracle-web/server/src/services/recordingService.ts` — `CycleRecord` gains `regime: RegimeSnapshot | null`, `CycleInputs` gains `regime`
- `oracle-web/server/src/websocket/priceSocket.ts` — build snapshot once per cycle, pass through to rule engine + filter + recording
- `oracle-web/server/src/scripts/historicalReplay.ts` — fetch SPY/VXX/sector ETF bars, pre-load prior-day trade history, build per-minute snapshots, write into `CycleRecord.regime`
- `oracle-web/server/src/services/backtestRunner.ts` — read `cycle.regime`, call filter with it
- `oracle-web/server/src/config.ts` — `execution.regime.*` block with zod schema
- `oracle-web/server/config.yaml` — add `execution.regime.*` with `enabled: false` default (override in YAML)
- `oracle-web/server/src/__tests__/tradeFilterService.test.ts` — add 6 veto tests
- `oracle-web/server/src/__tests__/ruleEngineService.test.ts` (if present) — add score-contribution test

---

## Execution order

Services are built bottom-up so each task is independently verifiable:

1. **Config + scaffolding** (Task 1) — schema lands first so later code can reference `config.execution.regime.*`.
2. **SectorMapService** (Task 2) — no deps on other new code.
3. **TradeHistoryService** (Task 3) — no deps on other new code.
4. **RegimeService pure computers** (Task 4) — pure functions, unit-tested in isolation.
5. **RegimeService orchestrator** (Task 5) — wires the three services above.
6. **Rule engine integration** (Task 6) — adds optional arg, score contribution.
7. **Trade filter veto integration** (Task 7) — three vetos behind `regime` presence.
8. **Recording schema update** (Task 8) — `CycleRecord.regime` persisted.
9. **priceSocket integration** (Task 9) — builds + forwards snapshot in live loop.
10. **historicalReplay update** (Task 10) — builds per-minute snapshots, writes into JSONL.
11. **backtestRunner update** (Task 11) — consumes `cycle.regime`, passes to filter.
12. **Sector overrides + rollout** (Task 12) — seed overrides file, flip `enabled: true` in YAML.
13. **Backtest regression** (Task 13) — 8-day sweep, document deltas in PR.

Each task ends with a commit. Run the full server test suite (`cd oracle-web/server && npx vitest run`) at the end of each task to catch unintended regressions.

---

### Task 1: Config — add `execution.regime.*` block

**Files:**
- Modify: `oracle-web/server/src/config.ts` — extend `execution` zod schema
- Modify: `oracle-web/server/config.yaml` — add `regime:` block with `enabled: false`

- [ ] **Step 1: Add regime schema to `config.ts`**

In `oracle-web/server/src/config.ts`, inside the `execution:` object (right after `eod_flatten_time`), add:

```ts
      eod_flatten_time: z.string().regex(/^\d{2}:\d{2}$/).default('15:50'),
      regime: z
        .object({
          enabled: z.boolean().default(false),
          score_weight: z.number().min(0).max(50).default(10),
          market_weight: z.number().min(0).max(1).default(0.5),
          sector_weight: z.number().min(0).max(1).default(0.2),
          ticker_weight: z.number().min(0).max(1).default(0.3),
          spy_trend_normalize_pct: z.number().positive().default(0.005),
          vxx_roc_normalize_pct: z.number().positive().default(0.05),
          sector_trend_normalize_pct: z.number().positive().default(0.01),
          veto_market_spy_trend_pct: z.number().max(0).default(-0.01),
          veto_market_vxx_roc_pct: z.number().positive().default(0.05),
          veto_graveyard_min_sample: z.number().int().positive().default(5),
          veto_exhaustion_atr_ratio: z.number().positive().default(3.0),
          winrate_min_sample: z.number().int().positive().default(3),
          atr_penalty_ratio: z.number().positive().default(2.5),
          sector_etf_bars_lookback_min: z.number().int().positive().default(30),
          trade_history_max_trades: z.number().int().positive().default(20),
          trade_history_max_calendar_days: z.number().int().positive().default(30),
        })
        .default({}),
    })
    .default({}),
```

- [ ] **Step 2: Add YAML block to `config.yaml`**

In `oracle-web/server/config.yaml`, under `execution:`, add:

```yaml
execution:
  # ... existing keys ...
  regime:
    enabled: false
    score_weight: 10
    market_weight: 0.5
    sector_weight: 0.2
    ticker_weight: 0.3
    spy_trend_normalize_pct: 0.005
    vxx_roc_normalize_pct: 0.05
    sector_trend_normalize_pct: 0.01
    veto_market_spy_trend_pct: -0.01
    veto_market_vxx_roc_pct: 0.05
    veto_graveyard_min_sample: 5
    veto_exhaustion_atr_ratio: 3.0
    winrate_min_sample: 3
    atr_penalty_ratio: 2.5
    sector_etf_bars_lookback_min: 30
    trade_history_max_trades: 20
    trade_history_max_calendar_days: 30
```

- [ ] **Step 3: Verify typecheck + tests still pass**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add oracle-web/server/src/config.ts oracle-web/server/config.yaml
git commit -m "feat(regime): add execution.regime config block (disabled by default)"
```

---

### Task 2: SectorMapService — ticker→sector with cache

**Files:**
- Create: `oracle-web/server/src/services/sectorMapService.ts`
- Create: `oracle-web/server/config/sector_overrides.yaml` (empty overrides file)
- Create: `oracle-web/server/src/__tests__/sectorMapService.test.ts`

- [ ] **Step 1: Write failing tests in `sectorMapService.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SectorMapService } from '../services/sectorMapService.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

describe('SectorMapService', () => {
  let service: SectorMapService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps known sector strings to SPDR ETFs', () => {
    service = new SectorMapService({ overrides: {}, cache: {}, cachePath: '', finnhubKey: '' });
    expect(service.getEtfFor('biotechnology')).toBe('XBI');
    expect(service.getEtfFor('energy')).toBe('XLE');
    expect(service.getEtfFor('technology')).toBe('XLK');
    expect(service.getEtfFor('unknown')).toBe('SPY');
  });

  it('override wins over cache wins over finnhub', async () => {
    service = new SectorMapService({
      overrides: { ABCD: 'energy' },
      cache: { ABCD: 'technology' },
      cachePath: '',
      finnhubKey: 'fake',
    });
    expect(await service.getSectorFor('ABCD')).toBe('energy');
  });

  it('returns cache when no override', async () => {
    service = new SectorMapService({
      overrides: {},
      cache: { WXYZ: 'healthcare' },
      cachePath: '',
      finnhubKey: 'fake',
    });
    expect(await service.getSectorFor('WXYZ')).toBe('healthcare');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls finnhub when no override and no cache hit, then caches the result', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ finnhubIndustry: 'Biotechnology' }),
    });
    service = new SectorMapService({
      overrides: {},
      cache: {},
      cachePath: '',
      finnhubKey: 'fake',
    });
    const sector = await service.getSectorFor('NEW');
    expect(sector).toBe('biotechnology');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // second call hits cache, not network
    await service.getSectorFor('NEW');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns unknown on finnhub failure and does not cache', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'));
    service = new SectorMapService({
      overrides: {},
      cache: {},
      cachePath: '',
      finnhubKey: 'fake',
    });
    expect(await service.getSectorFor('FAIL')).toBe('unknown');
    // retry path: still fetches next time
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ finnhubIndustry: 'Energy' }) });
    expect(await service.getSectorFor('FAIL')).toBe('energy');
  });

  it('returns unknown when finnhub key is missing', async () => {
    service = new SectorMapService({
      overrides: {},
      cache: {},
      cachePath: '',
      finnhubKey: '',
    });
    expect(await service.getSectorFor('NOKEY')).toBe('unknown');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/sectorMapService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create empty overrides file**

Write `oracle-web/server/config/sector_overrides.yaml`:

```yaml
# Hand-curated overrides for tickers Finnhub misclassifies.
# Key = symbol, value = canonical sector (lower-case).
# Canonical sectors: materials, communications, energy, financials, industrials,
# technology, consumer_staples, real_estate, utilities, healthcare,
# consumer_discretionary, biotechnology, software, unknown
overrides: {}
```

- [ ] **Step 4: Implement `sectorMapService.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import { finnhubApiKey } from '../config.js';

type SectorKey =
  | 'materials' | 'communications' | 'energy' | 'financials' | 'industrials'
  | 'technology' | 'software' | 'consumer_staples' | 'real_estate' | 'utilities'
  | 'healthcare' | 'consumer_discretionary' | 'biotechnology' | 'unknown';

const SECTOR_TO_ETF: Record<SectorKey, string> = {
  materials: 'XLB',
  communications: 'XLC',
  energy: 'XLE',
  financials: 'XLF',
  industrials: 'XLI',
  technology: 'XLK',
  software: 'IGV',
  consumer_staples: 'XLP',
  real_estate: 'XLRE',
  utilities: 'XLU',
  healthcare: 'XLV',
  consumer_discretionary: 'XLY',
  biotechnology: 'XBI',
  unknown: 'SPY',
};

const FINNHUB_TO_CANONICAL: Array<[RegExp, SectorKey]> = [
  [/biotech/i, 'biotechnology'],
  [/pharma|drug|medical|health|life science|hospital/i, 'healthcare'],
  [/software|semiconductor|computer/i, 'software'],
  [/technology|electronic|it services/i, 'technology'],
  [/oil|gas|energy|coal/i, 'energy'],
  [/bank|insurance|financial|capital/i, 'financials'],
  [/retail|apparel|auto|leisure|consumer discretionary|restaurants|hotels/i, 'consumer_discretionary'],
  [/food|beverage|tobacco|household|consumer staples/i, 'consumer_staples'],
  [/real estate|reit/i, 'real_estate'],
  [/utilities/i, 'utilities'],
  [/telecom|media|communication/i, 'communications'],
  [/metal|mining|chemical|material/i, 'materials'],
  [/airline|transport|machinery|industrial|aerospace|defense/i, 'industrials'],
];

function normalizeFinnhubIndustry(raw: string | null | undefined): SectorKey {
  if (!raw) return 'unknown';
  for (const [pattern, key] of FINNHUB_TO_CANONICAL) {
    if (pattern.test(raw)) return key;
  }
  return 'unknown';
}

export interface SectorMapDeps {
  overrides: Record<string, string>;
  cache: Record<string, string>;
  cachePath: string;
  finnhubKey: string;
}

export class SectorMapService {
  private overrides: Record<string, SectorKey>;
  private cache: Record<string, SectorKey>;
  private readonly cachePath: string;
  private readonly finnhubKey: string;

  constructor(deps: SectorMapDeps) {
    this.overrides = Object.fromEntries(
      Object.entries(deps.overrides).map(([k, v]) => [k.toUpperCase(), this.coerce(v)]),
    );
    this.cache = Object.fromEntries(
      Object.entries(deps.cache).map(([k, v]) => [k.toUpperCase(), this.coerce(v)]),
    );
    this.cachePath = deps.cachePath;
    this.finnhubKey = deps.finnhubKey;
  }

  private coerce(v: string): SectorKey {
    const lower = v.toLowerCase();
    return lower in SECTOR_TO_ETF ? (lower as SectorKey) : 'unknown';
  }

  getEtfFor(sector: string): string {
    const key = this.coerce(sector);
    return SECTOR_TO_ETF[key];
  }

  async getSectorFor(symbol: string): Promise<string> {
    const up = symbol.toUpperCase();
    if (this.overrides[up]) return this.overrides[up];
    if (this.cache[up]) return this.cache[up];
    if (!this.finnhubKey) return 'unknown';

    try {
      const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(up)}&token=${this.finnhubKey}`;
      const res = await fetch(url);
      if (!res.ok) return 'unknown';
      const data = (await res.json()) as { finnhubIndustry?: string };
      const sector = normalizeFinnhubIndustry(data.finnhubIndustry);
      if (sector !== 'unknown') {
        this.cache[up] = sector;
        this.persist();
      }
      return sector;
    } catch {
      return 'unknown';
    }
  }

  private persist(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch {
      // cache persistence is best-effort
    }
  }
}

export function loadOverridesFromYaml(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseYaml(raw) as { overrides?: Record<string, string> } | null;
    return parsed?.overrides ?? {};
  } catch {
    return {};
  }
}

export function loadCacheFromJson(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

const __dirname = dirname(new URL(import.meta.url).pathname);
const OVERRIDES_PATH = resolve(__dirname, '../../config/sector_overrides.yaml');
const CACHE_PATH = 'F:/oracle_data/sector_map.json';

export const sectorMapService = new SectorMapService({
  overrides: loadOverridesFromYaml(OVERRIDES_PATH),
  cache: loadCacheFromJson(CACHE_PATH),
  cachePath: CACHE_PATH,
  finnhubKey: finnhubApiKey,
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/sectorMapService.test.ts`
Expected: all 6 PASS.

- [ ] **Step 6: Run typecheck + full test suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add oracle-web/server/src/services/sectorMapService.ts \
        oracle-web/server/src/__tests__/sectorMapService.test.ts \
        oracle-web/server/config/sector_overrides.yaml
git commit -m "feat(regime): add SectorMapService with Finnhub + cache + overrides"
```

---

### Task 3: TradeHistoryService — read prior closed trades from JSONL

**Files:**
- Create: `oracle-web/server/src/services/tradeHistoryService.ts`
- Create: `oracle-web/server/src/__tests__/tradeHistoryService.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { TradeHistoryService } from '../services/tradeHistoryService.js';
import type { CycleRecord } from '../services/recordingService.js';
import type { TradeLedgerEntry } from '../services/executionService.js';

function makeLedgerEntry(overrides: Partial<TradeLedgerEntry>): TradeLedgerEntry {
  return {
    symbol: 'ABC',
    strategy: 'orb_breakout',
    entryPrice: 1.0,
    entryTime: new Date('2026-04-01T14:00:00Z'),
    exitPrice: 1.1,
    exitTime: new Date('2026-04-01T15:00:00Z'),
    shares: 100,
    riskPerShare: 0.05,
    pnl: 10,
    pnlPct: 0.1,
    rMultiple: 2.0,
    exitReason: 'target',
    exitDetail: '',
    rationale: [],
    ...overrides,
  };
}

function writeCycleFile(dir: string, day: string, records: Array<Partial<CycleRecord>>): void {
  const lines = records
    .map((r) => JSON.stringify({
      ts: `${day}T14:00:00Z`,
      tsEt: '10:00:00',
      tradingDay: day,
      marketStatus: { isOpen: true, openTime: '09:30', closeTime: '16:00' },
      items: [],
      decisions: [],
      activeTrades: [],
      closedTrades: [],
      ...r,
    }))
    .join('\n');
  writeFileSync(resolve(dir, `${day}.jsonl`), lines + '\n', 'utf-8');
}

describe('TradeHistoryService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'th-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns closed trades for matching symbol+setup', async () => {
    writeCycleFile(dir, '2026-04-15', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', strategy: 'orb_breakout', pnl: 5 })] },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades).toHaveLength(1);
    expect(trades[0].pnl).toBe(5);
  });

  it('excludes files with day >= now', async () => {
    writeCycleFile(dir, '2026-04-15', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 5 })] },
    ]);
    writeCycleFile(dir, '2026-04-20', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 99 })] },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades.map((t) => t.pnl)).toEqual([5]);
  });

  it('filters by symbol and setup', async () => {
    writeCycleFile(dir, '2026-04-15', [
      {
        closedTrades: [
          makeLedgerEntry({ symbol: 'ABC', strategy: 'orb_breakout' }),
          makeLedgerEntry({ symbol: 'ABC', strategy: 'momentum_continuation' }),
          makeLedgerEntry({ symbol: 'XYZ', strategy: 'orb_breakout' }),
        ],
      },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('ABC');
    expect(trades[0].strategy).toBe('orb_breakout');
  });

  it('respects maxCalendarDays window', async () => {
    writeCycleFile(dir, '2026-03-01', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 1 })] },
    ]);
    writeCycleFile(dir, '2026-04-15', [
      { closedTrades: [makeLedgerEntry({ symbol: 'ABC', pnl: 2 })] },
    ]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades(
      'ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'),
      { maxCalendarDays: 30 },
    );
    expect(trades.map((t) => t.pnl)).toEqual([2]);
  });

  it('respects maxTrades cap', async () => {
    writeCycleFile(dir, '2026-04-15', [{
      closedTrades: Array.from({ length: 10 }, (_, i) => makeLedgerEntry({ symbol: 'ABC', pnl: i })),
    }]);
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'), { maxTrades: 3 });
    // Service keeps the MOST RECENT maxTrades, so pnls 7, 8, 9.
    expect(trades.map((t) => t.pnl)).toEqual([7, 8, 9]);
  });

  it('handles malformed lines gracefully', async () => {
    writeFileSync(resolve(dir, '2026-04-15.jsonl'), 'not json\n{bad}\n', 'utf-8');
    const service = new TradeHistoryService(dir);
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date('2026-04-20T14:00:00Z'));
    expect(trades).toEqual([]);
  });

  it('returns empty list when recording dir is missing', async () => {
    const service = new TradeHistoryService('/nonexistent/path/xxx');
    const trades = await service.getRecentTrades('ABC', 'orb_breakout', new Date());
    expect(trades).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd oracle-web/server && npx vitest run src/__tests__/tradeHistoryService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tradeHistoryService.ts`**

```ts
import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';
import type { CycleRecord } from './recordingService.js';
import type { TradeLedgerEntry } from './executionService.js';

export interface TradeHistoryOptions {
  maxTrades?: number;
  maxCalendarDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class TradeHistoryService {
  constructor(private readonly dir: string = config.recording.dir) {}

  async getRecentTrades(
    symbol: string,
    setup: string,
    now: Date,
    options: TradeHistoryOptions = {},
  ): Promise<TradeLedgerEntry[]> {
    const maxTrades = options.maxTrades ?? config.execution.regime.trade_history_max_trades;
    const maxCalendarDays =
      options.maxCalendarDays ?? config.execution.regime.trade_history_max_calendar_days;

    if (!existsSync(this.dir)) return [];

    const nowMs = now.getTime();
    const windowStartMs = nowMs - maxCalendarDays * DAY_MS;
    const nowDay = now.toISOString().slice(0, 10);

    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }

    const eligibleDays = files
      .map((name) => {
        const match = DAY_FILE_RE.exec(name);
        return match ? match[1] : null;
      })
      .filter((d): d is string => {
        if (!d) return false;
        if (d >= nowDay) return false;
        const dayMs = new Date(`${d}T00:00:00Z`).getTime();
        return dayMs >= windowStartMs;
      })
      .sort(); // ascending

    const collected: TradeLedgerEntry[] = [];
    for (const day of eligibleDays) {
      const filePath = resolve(this.dir, `${day}.jsonl`);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let record: CycleRecord;
        try {
          record = JSON.parse(line) as CycleRecord;
        } catch {
          continue;
        }
        for (const trade of record.closedTrades ?? []) {
          if (trade.symbol !== symbol) continue;
          if (trade.strategy !== setup) continue;
          const key = `${trade.symbol}|${trade.entryTime}|${trade.exitTime}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push(trade);
        }
      }
    }

    // keep most recent maxTrades (assumes files are date-sorted and records within a file are time-sorted)
    return collected.slice(-maxTrades);
  }
}

export const tradeHistoryService = new TradeHistoryService();
```

- [ ] **Step 4: Run tests**

Run: `cd oracle-web/server && npx vitest run src/__tests__/tradeHistoryService.test.ts`
Expected: all 7 PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add oracle-web/server/src/services/tradeHistoryService.ts \
        oracle-web/server/src/__tests__/tradeHistoryService.test.ts
git commit -m "feat(regime): add TradeHistoryService reading closed trades from recording JSONL"
```

---

### Task 4: RegimeService — pure computers (market / sector / ticker)

**Files:**
- Create: `oracle-web/server/src/services/regimeService.ts` (types + pure computers only; orchestrator arrives in Task 5)
- Create: `oracle-web/server/src/__tests__/regimeService.test.ts`

- [ ] **Step 1: Write failing tests for pure computers**

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      regime: {
        enabled: true,
        score_weight: 10,
        market_weight: 0.5,
        sector_weight: 0.2,
        ticker_weight: 0.3,
        spy_trend_normalize_pct: 0.005,
        vxx_roc_normalize_pct: 0.05,
        sector_trend_normalize_pct: 0.01,
        veto_market_spy_trend_pct: -0.01,
        veto_market_vxx_roc_pct: 0.05,
        veto_graveyard_min_sample: 5,
        veto_exhaustion_atr_ratio: 3.0,
        winrate_min_sample: 3,
        atr_penalty_ratio: 2.5,
        sector_etf_bars_lookback_min: 30,
        trade_history_max_trades: 20,
        trade_history_max_calendar_days: 30,
      },
    },
    market_hours: { timezone: 'America/New_York', open: '09:30', close: '16:00' },
  },
}));

import {
  computeMarketRegime,
  computeSectorRegime,
  computeTickerRegime,
  atr14,
} from '../services/regimeService.js';
import type { Bar } from '../services/indicatorService.js';
import type { TradeLedgerEntry } from '../services/executionService.js';

function makeBar(ts: Date, close: number, high = close, low = close, open = close): Bar {
  return { timestamp: ts, open, high, low, close, volume: 1000 };
}

function makeSlope(pct: number, count = 30, start = 100): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const close = start * (1 + (pct * i) / (count - 1));
    bars.push(makeBar(new Date(2026, 3, 22, 13, i), close));
  }
  return bars;
}

describe('atr14', () => {
  it('computes Wilder ATR over 14 daily bars', () => {
    const bars: Bar[] = [];
    let prevClose = 10;
    for (let i = 0; i < 15; i++) {
      const high = prevClose + 1;
      const low = prevClose - 1;
      const close = prevClose + 0.1;
      bars.push(makeBar(new Date(2026, 3, i + 1), close, high, low, prevClose));
      prevClose = close;
    }
    const v = atr14(bars);
    expect(v).toBeGreaterThan(1.5);
    expect(v).toBeLessThan(2.5);
  });

  it('returns null with fewer than 15 bars', () => {
    expect(atr14([])).toBeNull();
    expect(atr14(Array.from({ length: 14 }, (_, i) => makeBar(new Date(2026, 3, i + 1), 10)))).toBeNull();
  });
});

describe('computeMarketRegime', () => {
  it('returns positive score when SPY up, VXX flat', () => {
    const spyBars = makeSlope(0.005); // +0.5% over 30m
    const vxxBars = [makeBar(new Date(2026, 3, 21), 20), makeBar(new Date(2026, 3, 22), 20)];
    const r = computeMarketRegime(spyBars, vxxBars, new Date(2026, 3, 22));
    expect(r.status).toBe('ok');
    expect(r.score).toBeGreaterThan(0.4);
    expect(r.spyTrendPct).toBeGreaterThan(0);
    expect(r.vxxRocPct).toBe(0);
  });

  it('returns negative score when SPY down and VXX spiking', () => {
    const spyBars = makeSlope(-0.005);
    const vxxBars = [makeBar(new Date(2026, 3, 21), 20), makeBar(new Date(2026, 3, 22), 22)]; // +10%
    const r = computeMarketRegime(spyBars, vxxBars, new Date(2026, 3, 22));
    expect(r.score).toBeLessThan(-0.4);
  });

  it('clamps extreme values to [-1, +1]', () => {
    const spyBars = makeSlope(0.05); // absurdly fast
    const vxxBars = [makeBar(new Date(), 20), makeBar(new Date(), 5)];
    const r = computeMarketRegime(spyBars, vxxBars, new Date());
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(-1);
  });

  it('returns unavailable when SPY bars missing', () => {
    const r = computeMarketRegime([], [], new Date());
    expect(r.status).toBe('unavailable');
    expect(r.score).toBe(0);
    expect(r.spyTrendPct).toBeNull();
    expect(r.vxxRocPct).toBeNull();
  });

  it('returns partial score when only SPY available', () => {
    const r = computeMarketRegime(makeSlope(0.005), [], new Date());
    expect(r.spyTrendPct).not.toBeNull();
    expect(r.vxxRocPct).toBeNull();
    expect(r.status).toBe('ok');
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('computeSectorRegime', () => {
  it('maps strong uptrend to positive score', () => {
    const r = computeSectorRegime(makeSlope(0.02), 'XBI', new Date());
    expect(r.score).toBeCloseTo(1);
    expect(r.etfSymbol).toBe('XBI');
  });

  it('maps strong downtrend to negative score', () => {
    const r = computeSectorRegime(makeSlope(-0.02), 'XLE', new Date());
    expect(r.score).toBeCloseTo(-1);
  });

  it('returns unavailable with empty bars', () => {
    const r = computeSectorRegime([], 'XBI', new Date());
    expect(r.status).toBe('unavailable');
    expect(r.score).toBe(0);
  });
});

function makePastTrades(wins: number, losses: number): TradeLedgerEntry[] {
  const t: TradeLedgerEntry[] = [];
  for (let i = 0; i < wins; i++) {
    t.push({
      symbol: 'ABC', strategy: 'orb_breakout',
      entryPrice: 1, entryTime: new Date(), exitPrice: 1.1, exitTime: new Date(),
      shares: 100, riskPerShare: 0.05, pnl: 10, pnlPct: 0.1, rMultiple: 2,
      exitReason: 'target', exitDetail: '', rationale: [],
    });
  }
  for (let i = 0; i < losses; i++) {
    t.push({
      symbol: 'ABC', strategy: 'orb_breakout',
      entryPrice: 1, entryTime: new Date(), exitPrice: 0.95, exitTime: new Date(),
      shares: 100, riskPerShare: 0.05, pnl: -5, pnlPct: -0.05, rMultiple: -1,
      exitReason: 'stop', exitDetail: '', rationale: [],
    });
  }
  return t;
}

describe('computeTickerRegime', () => {
  const dailyBars = (() => {
    const bars: Bar[] = [];
    let prev = 10;
    for (let i = 0; i < 15; i++) {
      bars.push(makeBar(new Date(2026, 3, i + 1), prev + 0.05, prev + 1, prev - 1, prev));
      prev = prev + 0.05;
    }
    return bars;
  })();

  it('positive score when low ATR ratio and high win rate', () => {
    const today = [makeBar(new Date(), 10, 10.2, 9.8)]; // range = 0.4, ATR ~ 2 → ratio 0.2
    const r = computeTickerRegime('ABC', 'orb_breakout', dailyBars, today, makePastTrades(4, 1), 'energy', new Date());
    expect(r.status).toBe('ok');
    expect(r.atrRatio).toBeLessThan(1);
    expect(r.winRate).toBeCloseTo(0.8);
    expect(r.sampleSize).toBe(5);
    expect(r.score).toBeGreaterThan(0);
  });

  it('negative score when ATR ratio high and win rate low', () => {
    const today = [makeBar(new Date(), 10, 15, 9)];
    const r = computeTickerRegime('ABC', 'orb_breakout', dailyBars, today, makePastTrades(1, 4), 'energy', new Date());
    expect(r.atrRatio).toBeGreaterThan(2.5);
    expect(r.winRate).toBeCloseTo(0.2);
    expect(r.score).toBeLessThan(0);
  });

  it('sample size below threshold → winRate null', () => {
    const today = [makeBar(new Date(), 10, 10.1, 9.9)];
    const r = computeTickerRegime('ABC', 'orb_breakout', dailyBars, today, makePastTrades(1, 1), 'energy', new Date());
    expect(r.winRate).toBeNull();
    expect(r.sampleSize).toBe(2);
  });

  it('returns unavailable when daily bars insufficient for ATR', () => {
    const r = computeTickerRegime('ABC', 'orb_breakout', [], [], [], 'energy', new Date());
    expect(r.atrRatio).toBeNull();
    expect(r.status).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/regimeService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types + pure computers in `regimeService.ts`**

```ts
import type { Bar } from './indicatorService.js';
import type { TradeLedgerEntry } from './executionService.js';
import type { CandidateSetup } from './ruleEngineService.js';
import { config } from '../config.js';

export interface MarketRegime {
  score: number;
  spyTrendPct: number | null;
  vxxRocPct: number | null;
  status: 'ok' | 'unavailable';
}

export interface SectorRegime {
  score: number;
  etfSymbol: string;
  trendPct: number | null;
  status: 'ok' | 'unavailable';
}

export interface TickerRegime {
  score: number;
  sector: string;
  atrRatio: number | null;
  winRate: number | null;
  sampleSize: number;
  status: 'ok' | 'unavailable';
}

export interface RegimeSnapshot {
  ts: string;
  market: MarketRegime;
  sectors: Record<string, SectorRegime>;
  tickers: Record<string, TickerRegime>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function slopeTrendPct(bars: Bar[], windowSize = 30): number | null {
  if (bars.length < 2) return null;
  const window = bars.slice(-windowSize);
  if (window.length < 2) return null;
  const n = window.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += window[i].close;
    sumXY += i * window[i].close;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const first = window[0].close;
  if (first <= 0) return null;
  return (slope * (n - 1)) / first;
}

export function atr14(dailyBars: Bar[]): number | null {
  if (dailyBars.length < 15) return null;
  const bars = dailyBars.slice(-15);
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }
  const seed = trs.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  let atr = seed;
  for (let i = 14; i < trs.length; i++) {
    atr = (atr * 13 + trs[i]) / 14;
  }
  return atr;
}

export function computeMarketRegime(spyBars: Bar[], vxxBars: Bar[], _now: Date): MarketRegime {
  const cfg = config.execution.regime;
  const spyTrendPct = slopeTrendPct(spyBars, 30);

  let vxxRocPct: number | null = null;
  if (vxxBars.length >= 2) {
    const latest = vxxBars[vxxBars.length - 1].close;
    const prev = vxxBars[0].close;
    if (prev > 0) vxxRocPct = (latest - prev) / prev;
  }

  if (spyTrendPct === null && vxxRocPct === null) {
    return { score: 0, spyTrendPct: null, vxxRocPct: null, status: 'unavailable' };
  }

  const spyPart = spyTrendPct !== null
    ? clamp(spyTrendPct / cfg.spy_trend_normalize_pct, -1, 1)
    : 0;
  const vxxPart = vxxRocPct !== null
    ? clamp(-vxxRocPct / cfg.vxx_roc_normalize_pct, -1, 1)
    : 0;

  const score = spyTrendPct !== null && vxxRocPct !== null
    ? 0.5 * spyPart + 0.5 * vxxPart
    : spyTrendPct !== null
      ? spyPart
      : vxxPart;

  return { score, spyTrendPct, vxxRocPct, status: 'ok' };
}

export function computeSectorRegime(bars: Bar[], etfSymbol: string, _now: Date): SectorRegime {
  const cfg = config.execution.regime;
  const trendPct = slopeTrendPct(bars, 30);
  if (trendPct === null) {
    return { score: 0, etfSymbol, trendPct: null, status: 'unavailable' };
  }
  const score = clamp(trendPct / cfg.sector_trend_normalize_pct, -1, 1);
  return { score, etfSymbol, trendPct, status: 'ok' };
}

function todayRangeFromBars(bars: Bar[]): number | null {
  if (bars.length === 0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (!isFinite(hi) || !isFinite(lo)) return null;
  return hi - lo;
}

export function computeTickerRegime(
  _symbol: string,
  _setup: CandidateSetup | string,
  dailyBars: Bar[],
  todayBars: Bar[],
  pastTrades: TradeLedgerEntry[],
  sector: string,
  _now: Date,
): TickerRegime {
  const cfg = config.execution.regime;
  const atr = atr14(dailyBars);
  const range = todayRangeFromBars(todayBars);
  const atrRatio = atr !== null && atr > 0 && range !== null ? range / atr : null;

  const terminalReasons = new Set(['target', 'stop', 'trailing_stop', 'eod']);
  const closed = pastTrades.filter((t) => terminalReasons.has(t.exitReason));
  const total = closed.length;
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = total - wins;
  const winRate = total >= cfg.winrate_min_sample ? wins / total : null;

  const atrPenalty = atrRatio !== null && atrRatio >= cfg.atr_penalty_ratio ? -1 : 0;
  const winRateScore = total >= cfg.winrate_min_sample ? (wins - losses) / total : 0;
  const score = 0.5 * atrPenalty + 0.5 * winRateScore;

  const status = atrRatio === null ? 'unavailable' : 'ok';
  return { score, sector, atrRatio, winRate, sampleSize: total, status };
}
```

- [ ] **Step 4: Run tests to verify passing**

Run: `cd oracle-web/server && npx vitest run src/__tests__/regimeService.test.ts`
Expected: all pass (atr14 ×2, market ×5, sector ×3, ticker ×4).

- [ ] **Step 5: Typecheck + full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add oracle-web/server/src/services/regimeService.ts \
        oracle-web/server/src/__tests__/regimeService.test.ts
git commit -m "feat(regime): add pure regime computers (market, sector, ticker) + ATR"
```

---

### Task 5: RegimeService orchestrator — `buildRegimeSnapshot`

**Files:**
- Modify: `oracle-web/server/src/services/regimeService.ts`
- Modify: `oracle-web/server/src/__tests__/regimeService.test.ts` (add orchestrator test with mocks)

- [ ] **Step 1: Add failing test for orchestrator**

Append to `regimeService.test.ts`:

```ts
import { RegimeService } from '../services/regimeService.js';

function okBar(close: number, i = 0): Bar {
  return makeBar(new Date(2026, 3, 22, 13, i), close);
}

describe('RegimeService.buildRegimeSnapshot', () => {
  it('assembles market, sector, and ticker entries for the watchlist', async () => {
    const fetchBars = vi.fn(async (symbol: string, timeframe: string) => {
      if (timeframe === '1Day') {
        const bars: Bar[] = [];
        let p = 10;
        for (let i = 0; i < 15; i++) {
          bars.push({ timestamp: new Date(2026, 3, i + 1), open: p, high: p + 1, low: p - 1, close: p + 0.1, volume: 100 });
          p += 0.1;
        }
        return bars;
      }
      if (symbol === 'VXX') {
        return [okBar(20, 0), okBar(20, 29)];
      }
      if (symbol === 'SPY') {
        return makeSlope(0.003);
      }
      return makeSlope(0.005); // sector ETFs uptrending
    });

    const fetchTodayBars = vi.fn(async (_symbol: string) => [okBar(10.05, 0), okBar(10.08, 1)]);

    const sectorMap = {
      getSectorFor: vi.fn(async (sym: string) => (sym === 'ABC' ? 'biotechnology' : 'energy')),
      getEtfFor: (sector: string) => (sector === 'biotechnology' ? 'XBI' : sector === 'energy' ? 'XLE' : 'SPY'),
    };
    const tradeHistory = {
      getRecentTrades: vi.fn(async () => []),
    };

    const service = new RegimeService({ fetchBars, fetchTodayBars, sectorMap, tradeHistory });
    const now = new Date(2026, 3, 22, 14, 0);
    const snapshot = await service.buildRegimeSnapshot(['ABC', 'XYZ'], 'orb_breakout', now);

    expect(snapshot.market.status).toBe('ok');
    expect(snapshot.sectors.XBI.status).toBe('ok');
    expect(snapshot.sectors.XLE.status).toBe('ok');
    expect(snapshot.tickers.ABC.sector).toBe('biotechnology');
    expect(snapshot.tickers.XYZ.sector).toBe('energy');
    // SPY + VXX fetched once
    expect(fetchBars.mock.calls.filter(([s]) => s === 'SPY').length).toBe(1);
    expect(fetchBars.mock.calls.filter(([s]) => s === 'VXX').length).toBe(1);
    // each distinct sector ETF fetched once
    expect(fetchBars.mock.calls.filter(([s]) => s === 'XBI').length).toBe(1);
    expect(fetchBars.mock.calls.filter(([s]) => s === 'XLE').length).toBe(1);
  });

  it('degrades to status=unavailable on fetch failure but still returns snapshot', async () => {
    const fetchBars = vi.fn(async () => { throw new Error('network'); });
    const fetchTodayBars = vi.fn(async () => []);
    const sectorMap = {
      getSectorFor: vi.fn(async () => 'unknown'),
      getEtfFor: (_: string) => 'SPY',
    };
    const tradeHistory = { getRecentTrades: vi.fn(async () => []) };

    const service = new RegimeService({ fetchBars, fetchTodayBars, sectorMap, tradeHistory });
    const snapshot = await service.buildRegimeSnapshot(['ABC'], 'orb_breakout', new Date());
    expect(snapshot.market.status).toBe('unavailable');
    expect(snapshot.tickers.ABC.status).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/regimeService.test.ts`
Expected: FAIL — `RegimeService` is not exported.

- [ ] **Step 3: Implement `RegimeService` class in `regimeService.ts`**

Append to `regimeService.ts`:

```ts
import { fetchAlpacaBars } from './alpacaBarService.js';
import { sectorMapService, SectorMapService } from './sectorMapService.js';
import { tradeHistoryService, TradeHistoryService } from './tradeHistoryService.js';

export interface RegimeDeps {
  fetchBars: (symbol: string, timeframe: string, lookbackMinutes: number) => Promise<Bar[]>;
  fetchTodayBars: (symbol: string) => Promise<Bar[]>;
  sectorMap: Pick<SectorMapService, 'getSectorFor' | 'getEtfFor'>;
  tradeHistory: Pick<TradeHistoryService, 'getRecentTrades'>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class RegimeService {
  constructor(private readonly deps: RegimeDeps) {}

  async buildRegimeSnapshot(
    symbols: string[],
    setup: CandidateSetup | string,
    now: Date,
  ): Promise<RegimeSnapshot> {
    const cfg = config.execution.regime;

    const spyPromise = this.deps.fetchBars('SPY', '1Min', cfg.sector_etf_bars_lookback_min).catch(() => []);
    const vxxLookbackMin = 2 * 24 * 60;
    const vxxPromise = this.deps.fetchBars('VXX', '1Day', vxxLookbackMin).catch(() => []);

    const sectorBySymbol = new Map<string, string>();
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          const s = await this.deps.sectorMap.getSectorFor(sym);
          sectorBySymbol.set(sym, s);
        } catch {
          sectorBySymbol.set(sym, 'unknown');
        }
      }),
    );

    const distinctEtfs = Array.from(new Set(Array.from(sectorBySymbol.values()).map((s) => this.deps.sectorMap.getEtfFor(s))));
    const etfBarsPromise = Promise.all(
      distinctEtfs.map(async (etf) => {
        const bars = await this.deps.fetchBars(etf, '1Min', cfg.sector_etf_bars_lookback_min).catch(() => []);
        return [etf, bars] as const;
      }),
    );

    const [spyBars, vxxBars, etfBarsList] = await Promise.all([spyPromise, vxxPromise, etfBarsPromise]);
    const market = computeMarketRegime(spyBars, vxxBars, now);

    const sectors: Record<string, SectorRegime> = {};
    for (const [etf, bars] of etfBarsList) {
      sectors[etf] = computeSectorRegime(bars, etf, now);
    }

    const tickers: Record<string, TickerRegime> = {};
    await Promise.all(
      symbols.map(async (sym) => {
        const sector = sectorBySymbol.get(sym) ?? 'unknown';
        const [dailyBars, todayBars, pastTrades] = await Promise.all([
          this.deps.fetchBars(sym, '1Day', 30 * DAY_MS / 60000).catch(() => [] as Bar[]),
          this.deps.fetchTodayBars(sym).catch(() => [] as Bar[]),
          this.deps.tradeHistory.getRecentTrades(sym, String(setup), now).catch(() => []),
        ]);
        tickers[sym] = computeTickerRegime(sym, setup, dailyBars, todayBars, pastTrades, sector, now);
      }),
    );

    return { ts: now.toISOString(), market, sectors, tickers };
  }
}

export const regimeService = new RegimeService({
  fetchBars: fetchAlpacaBars,
  fetchTodayBars: (symbol) => fetchAlpacaBars(symbol, '1Min', 390),
  sectorMap: sectorMapService,
  tradeHistory: tradeHistoryService,
});
```

Note: the orchestrator computes a snapshot for a single `setup`. Upstream callers pass the candidate's setup (or a placeholder) in; this keeps the win-rate scoped to the right `(symbol, setup)` pair. When multiple setups are in flight (rare in practice), call `buildRegimeSnapshot` once per setup that the rule engine is actively evaluating. For v1, the orchestrator is invoked once per cycle with the configured default setup `'orb_breakout'` and the rule engine recomputes ticker win-rate per-candidate if needed (see Task 6 — currently the ticker score uses the snapshot as-is for simplicity).

- [ ] **Step 4: Run tests**

Run: `cd oracle-web/server && npx vitest run src/__tests__/regimeService.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck + full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add oracle-web/server/src/services/regimeService.ts \
        oracle-web/server/src/__tests__/regimeService.test.ts
git commit -m "feat(regime): add RegimeService orchestrator with graceful degradation"
```

---

### Task 6: Rule engine integration — thread `RegimeSnapshot` through scoring

**Files:**
- Modify: `oracle-web/server/src/services/ruleEngineService.ts`
- Modify: `oracle-web/server/src/__tests__/ruleEngineService.test.ts` (if exists) or add a new file

- [ ] **Step 1: Write failing test for regime score contribution**

Add to / create `oracle-web/server/src/__tests__/ruleEngineService.regime.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    execution: {
      orb_enabled: true,
      orb_range_minutes: 15,
      orb_volume_mult: 1.3,
      orb_max_chase_pct: 0.03,
      orb_min_range_pct: 0.01,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      momentum_max_chase_pct: 0.05,
      require_uptrend_for_momentum: true,
      max_risk_pct: 0.1,
      regime: {
        enabled: true,
        score_weight: 10,
        market_weight: 0.5,
        sector_weight: 0.2,
        ticker_weight: 0.3,
        spy_trend_normalize_pct: 0.005,
        vxx_roc_normalize_pct: 0.05,
        sector_trend_normalize_pct: 0.01,
        veto_market_spy_trend_pct: -0.01,
        veto_market_vxx_roc_pct: 0.05,
        veto_graveyard_min_sample: 5,
        veto_exhaustion_atr_ratio: 3.0,
        winrate_min_sample: 3,
        atr_penalty_ratio: 2.5,
        sector_etf_bars_lookback_min: 30,
        trade_history_max_trades: 20,
        trade_history_max_calendar_days: 30,
      },
    },
    market_hours: { timezone: 'America/New_York', open: '09:30', close: '16:00' },
  },
}));

import {
  ruleEngineService,
  emptyMessageContext,
  emptyRedCandleSignal,
  emptyOrbSignal,
} from '../services/ruleEngineService.js';
import type { StockState } from '../websocket/priceSocket.js';
import type { RegimeSnapshot } from '../services/regimeService.js';

function makeStock(symbol = 'ABC'): StockState {
  return {
    symbol,
    targetPrice: 1.5,
    resistance: 1.5,
    stopLossPct: null,
    stopPrice: 0.95,
    longPrice: 1.0,
    buyZonePrice: 1.0,
    sellZonePrice: 1.5,
    profitDeltaPct: 5,
    maxVolume: 5_000_000,
    lastVolume: 1000,
    premarketVolume: 2_000_000,
    relativeVolume: 1.5,
    floatMillions: 10,
    gapPercent: 0.05,
    lastPrice: 0.95,
    currentPrice: 1.01,
    change: 0.06,
    changePercent: 0.063,
    trend30m: 'up',
    inTargetRange: false,
    alerted: false,
    source: 'test',
    lastUpdate: new Date().toISOString(),
    signal: null,
    boxTop: null,
    boxBottom: null,
    signalTimestamp: null,
  };
}

function makeRegime(marketScore: number, sectorScore: number, tickerScore: number): RegimeSnapshot {
  return {
    ts: new Date().toISOString(),
    market: { score: marketScore, spyTrendPct: 0, vxxRocPct: 0, status: 'ok' },
    sectors: { XBI: { score: sectorScore, etfSymbol: 'XBI', trendPct: 0, status: 'ok' } },
    tickers: {
      ABC: {
        score: tickerScore, sector: 'biotechnology', atrRatio: 1.0, winRate: 0.5,
        sampleSize: 4, status: 'ok',
      },
    },
  };
}

describe('scoreFromInputs regime contribution', () => {
  it('adds composite × 10 when regime friendly', () => {
    const stock = makeStock();
    const baseline = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
    );
    const friendly = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
      makeRegime(1, 1, 1),
    );
    expect(baseline).not.toBeNull();
    expect(friendly).not.toBeNull();
    // composite = 0.5×1 + 0.2×1 + 0.3×1 = 1.0 → +10
    expect(friendly!.score - baseline!.score).toBeCloseTo(10, 1);
  });

  it('subtracts up to 10 when regime hostile', () => {
    const stock = makeStock();
    const baseline = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
    );
    const hostile = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
      makeRegime(-1, -1, -1),
    );
    expect(hostile!.score - baseline!.score).toBeCloseTo(-10, 1);
  });

  it('leaves score unchanged when regime=undefined', () => {
    const stock = makeStock();
    const baseline = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
    );
    const noRegime = ruleEngineService.scoreFromInputs(
      stock, emptyMessageContext('ABC'), emptyRedCandleSignal(), emptyOrbSignal(),
      undefined,
    );
    expect(noRegime!.score).toBe(baseline!.score);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/ruleEngineService.regime.test.ts`
Expected: FAIL — signature mismatch or score unchanged.

- [ ] **Step 3: Update `scoreFromInputs` signature + add contribution**

In `oracle-web/server/src/services/ruleEngineService.ts`:

1. Add import near the top:

```ts
import type { RegimeSnapshot } from './regimeService.js';
```

2. Change `scoreFromInputs` signature and body:

```ts
  scoreFromInputs(
    stock: StockState,
    messageContext: SymbolMessageContext,
    redCandleSignal: RedCandleSignal,
    orbSignal: OrbSignal = emptyOrbSignal(),
    regime?: RegimeSnapshot,
  ): TradeCandidate | null {
    const oracleScore = this.scoreOracle(stock);
    const messageScore = Math.min(100, messageContext.convictionScore);
    const executionScore = this.scoreExecution(stock, redCandleSignal);

    let weighted = oracleScore * 0.45 + messageScore * 0.35 + executionScore * 0.2;
    if (redCandleSignal.matched) {
      weighted += 8;
    }
    if (orbSignal.matched) {
      weighted += 6;
    }

    if (regime && config.execution.regime.enabled) {
      const cfg = config.execution.regime;
      const tickerRegime = regime.tickers[stock.symbol];
      const sectorEtf = tickerRegime
        ? (regime.sectors[tickerRegime.sector] ? tickerRegime.sector : null)
        : null;
      // Sector lookup is actually keyed by ETF, not the sector name — resolve via any matching entry.
      const sectorRegime = tickerRegime
        ? Object.values(regime.sectors).find((s) => s.etfSymbol && regime.sectors[s.etfSymbol])
        : undefined;
      const composite =
        cfg.market_weight * (regime.market.score ?? 0) +
        cfg.sector_weight * (sectorRegime?.score ?? 0) +
        cfg.ticker_weight * (tickerRegime?.score ?? 0);
      weighted += composite * cfg.score_weight;
    }

    // ... rest of body unchanged ...
```

Note: the snapshot keys `regime.sectors` by ETF symbol (from Task 5). To look up sector regime for a ticker, we resolve the ticker's sector → ETF, then look that ETF up. Simpler: put the ETF lookup helper in `regimeService.ts` and use it here.

Cleaner implementation:

```ts
    if (regime && config.execution.regime.enabled) {
      const cfg = config.execution.regime;
      const tickerRegime = regime.tickers[stock.symbol];
      const sectorRegime = tickerRegime
        ? this.findSectorRegimeForTicker(regime, tickerRegime.sector)
        : undefined;
      const composite =
        cfg.market_weight * (regime.market.score ?? 0) +
        cfg.sector_weight * (sectorRegime?.score ?? 0) +
        cfg.ticker_weight * (tickerRegime?.score ?? 0);
      weighted += composite * cfg.score_weight;
    }
```

And add a private helper on the class (outside `scoreFromInputs`):

```ts
  private findSectorRegimeForTicker(regime: RegimeSnapshot, sector: string) {
    for (const sr of Object.values(regime.sectors)) {
      // sectorMapService.getEtfFor(sector) would match the key, but we can't import
      // that here without coupling. Instead: regimeService keys `sectors` by ETF.
      // Resolve via etfSymbol match — snapshot contains the ETF that was fetched
      // for this sector, so the first SectorRegime whose etfSymbol corresponds to
      // the ticker's sector is the right one.
      if (sr.etfSymbol && sector && this.etfMatchesSector(sr.etfSymbol, sector)) {
        return sr;
      }
    }
    return undefined;
  }

  private etfMatchesSector(etf: string, sector: string): boolean {
    const map: Record<string, string> = {
      biotechnology: 'XBI', healthcare: 'XLV', energy: 'XLE', technology: 'XLK',
      software: 'IGV', financials: 'XLF', industrials: 'XLI', materials: 'XLB',
      communications: 'XLC', consumer_staples: 'XLP', consumer_discretionary: 'XLY',
      real_estate: 'XLRE', utilities: 'XLU', unknown: 'SPY',
    };
    return map[sector] === etf;
  }
```

Alternative (cleaner long-term): expose `getEtfFor` on `sectorMapService` and import it here. For v1, the inline map is fine — it mirrors the one in `sectorMapService.ts`.

3. Update `evaluateStock` and `getRankedCandidates` to accept and forward `regime`:

```ts
  async getRankedCandidates(
    watchlist: StockState[],
    limit: number = 5,
    regime?: RegimeSnapshot,
  ): Promise<TradeCandidate[]> {
    // ... existing message-context resolution ...
    const evaluated = await Promise.all(
      watchlist.map(async (stock) => {
        const context = messageContextBySymbol.get(stock.symbol) ?? emptyMessageContext(stock.symbol);
        return await this.evaluateStock(stock, context, regime);
      })
    );
    // ... rest unchanged ...
  }

  private async evaluateStock(
    stock: StockState,
    messageContext: SymbolMessageContext,
    regime?: RegimeSnapshot,
  ): Promise<TradeCandidate | null> {
    const [redCandleSignal, orbSignal] = await Promise.all([
      this.detectRedCandleTheory(stock),
      this.detectOrbBreakout(stock),
    ]);
    return this.scoreFromInputs(stock, messageContext, redCandleSignal, orbSignal, regime);
  }
```

- [ ] **Step 4: Run tests**

Run: `cd oracle-web/server && npx vitest run src/__tests__/ruleEngineService.regime.test.ts`
Expected: all 3 pass.

- [ ] **Step 5: Typecheck + full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green. Existing tests still pass because `regime` is optional.

- [ ] **Step 6: Commit**

```bash
git add oracle-web/server/src/services/ruleEngineService.ts \
        oracle-web/server/src/__tests__/ruleEngineService.regime.test.ts
git commit -m "feat(regime): rule engine adds composite × score_weight from regime snapshot"
```

---

### Task 7: Trade filter vetos — market panic / graveyard / exhaustion

**Files:**
- Modify: `oracle-web/server/src/services/tradeFilterService.ts`
- Modify: `oracle-web/server/src/__tests__/tradeFilterService.test.ts`

- [ ] **Step 1: Add failing veto tests**

Append to `tradeFilterService.test.ts`, inside the outer `describe('TradeFilterService', ...)`:

```ts
  describe('regime vetos', () => {
    function makeRegime(overrides: {
      spyTrendPct?: number | null;
      vxxRocPct?: number | null;
      tickerAtrRatio?: number | null;
      winRate?: number | null;
      sampleSize?: number;
    } = {}): import('../services/regimeService.js').RegimeSnapshot {
      return {
        ts: new Date().toISOString(),
        market: {
          score: 0,
          spyTrendPct: overrides.spyTrendPct ?? 0,
          vxxRocPct: overrides.vxxRocPct ?? 0,
          status: 'ok',
        },
        sectors: {},
        tickers: {
          TEST: {
            score: 0,
            sector: 'energy',
            atrRatio: overrides.tickerAtrRatio ?? 1.0,
            winRate: overrides.winRate ?? 0.5,
            sampleSize: overrides.sampleSize ?? 4,
            status: 'ok',
          },
        },
      };
    }

    it('vetos on market panic (SPY ≤ -1% AND VXX ≥ +5%)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ spyTrendPct: -0.015, vxxRocPct: 0.06 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('market panic');
    });

    it('passes when only one panic condition is met', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ spyTrendPct: -0.015, vxxRocPct: 0.02 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(true);
    });

    it('vetos on graveyard (0/5 prior trades on (symbol, setup))', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ winRate: 0, sampleSize: 5 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('graveyard');
    });

    it('passes when sample size below min_sample', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ winRate: 0, sampleSize: 3 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(true);
    });

    it('vetos on exhaustion (ATR ratio ≥ 3.0)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ tickerAtrRatio: 3.5 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('exhaustion');
    });

    it('passes at ATR ratio 2.8 (soft penalty zone, no veto)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const regime = makeRegime({ tickerAtrRatio: 2.8 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount(), regime);
      expect(result.passed).toBe(true);
    });

    it('no-ops when regime undefined (preserves legacy behavior)', () => {
      const candidate = makeCandidate({ suggestedEntry: 1.0, suggestedStop: 0.95 });
      const result = tradeFilterService.filterCandidate(candidate, makeAccount());
      expect(result.passed).toBe(true);
    });
  });
```

Also update the existing `vi.mock('../config.js', ...)` at the top of the file to include `regime` config:

```ts
vi.mock('../config.js', () => ({
  config: {
    execution: {
      max_positions: 8,
      max_capital_pct: 0.5,
      max_daily_drawdown_pct: 0.05,
      max_risk_pct: 0.10,
      risk_per_trade: 100,
      max_trade_cost: 0,
      red_candle_vol_mult: 1.5,
      momentum_gap_pct: 0.03,
      regime: {
        enabled: true,
        veto_market_spy_trend_pct: -0.01,
        veto_market_vxx_roc_pct: 0.05,
        veto_graveyard_min_sample: 5,
        veto_exhaustion_atr_ratio: 3.0,
      },
    },
  },
}));
```

And inside the existing inline `vi.doMock` block in the `max trade cost` describe, add the same `regime` object so the isolated service still has it.

- [ ] **Step 2: Run — expect fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/tradeFilterService.test.ts`
Expected: new veto tests fail.

- [ ] **Step 3: Modify `filterCandidate` in `tradeFilterService.ts`**

```ts
import { config } from '../config.js';
import { TradeCandidate as BaseTradeCandidate } from './ruleEngineService.js';
import type { RegimeSnapshot } from './regimeService.js';

type TradeCandidate = BaseTradeCandidate & {
  suggestedEntry: number;
  suggestedStop: number;
  suggestedTarget: number;
};

// ... unchanged AccountState, FilterResult, PositionSize interfaces ...

class TradeFilterService {
  filterCandidate(
    candidate: TradeCandidate,
    account: AccountState,
    regime?: RegimeSnapshot,
  ): FilterResult {
    const exec = config.execution;

    // ... existing gates (drawdown, max_positions, capital, max_risk) unchanged ...

    if (regime && exec.regime?.enabled) {
      const vetoResult = this.runRegimeVetos(candidate, regime);
      if (!vetoResult.passed) return vetoResult;
    }

    return { passed: true, reason: null };
  }

  private runRegimeVetos(candidate: TradeCandidate, regime: RegimeSnapshot): FilterResult {
    const cfg = config.execution.regime;
    const m = regime.market;
    if (
      m.spyTrendPct !== null &&
      m.vxxRocPct !== null &&
      m.spyTrendPct <= cfg.veto_market_spy_trend_pct &&
      m.vxxRocPct >= cfg.veto_market_vxx_roc_pct
    ) {
      return {
        passed: false,
        reason: `market panic (SPY ${(m.spyTrendPct * 100).toFixed(2)}% / VXX ${(m.vxxRocPct * 100).toFixed(2)}%)`,
      };
    }

    const tr = regime.tickers[candidate.symbol];
    if (tr) {
      if (tr.sampleSize >= cfg.veto_graveyard_min_sample && tr.winRate === 0) {
        return {
          passed: false,
          reason: `ticker+setup graveyard (0/${tr.sampleSize} on ${candidate.setup})`,
        };
      }
      if (tr.atrRatio !== null && tr.atrRatio >= cfg.veto_exhaustion_atr_ratio) {
        return {
          passed: false,
          reason: `exhaustion (ATR ratio ${tr.atrRatio.toFixed(2)})`,
        };
      }
    }
    return { passed: true, reason: null };
  }

  calculatePositionSize(candidate: TradeCandidate, account: AccountState): PositionSize {
    // ... unchanged ...
  }
}

export const tradeFilterService = new TradeFilterService();
```

- [ ] **Step 4: Run tests**

Run: `cd oracle-web/server && npx vitest run src/__tests__/tradeFilterService.test.ts`
Expected: all (existing 10 + new 7) pass.

- [ ] **Step 5: Typecheck + full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add oracle-web/server/src/services/tradeFilterService.ts \
        oracle-web/server/src/__tests__/tradeFilterService.test.ts
git commit -m "feat(regime): add market panic / graveyard / exhaustion vetos to trade filter"
```

---

### Task 8: Record `RegimeSnapshot` into `CycleRecord`

**Files:**
- Modify: `oracle-web/server/src/services/recordingService.ts`

- [ ] **Step 1: Extend `CycleRecord` and `CycleInputs`**

Change the relevant blocks in `recordingService.ts`:

```ts
import type { RegimeSnapshot } from './regimeService.js';

export interface CycleRecord {
  ts: string;
  tsEt: string;
  tradingDay: string;
  marketStatus: {
    isOpen: boolean;
    openTime: string;
    closeTime: string;
  };
  items: RecordedItem[];
  decisions: RecordedDecision[];
  activeTrades: ActiveTrade[];
  closedTrades: TradeLedgerEntry[];
  regime: RegimeSnapshot | null;
}

export interface CycleInputs {
  stocks: StockState[];
  candidates: TradeCandidate[];
  rejections: FilterRejection[];
  activeTrades: ActiveTrade[];
  closedTrades: TradeLedgerEntry[];
  marketStatus: { isOpen: boolean; openTime: string; closeTime: string };
  regime: RegimeSnapshot | null;
}
```

And update `writeCycle` to set `regime: inputs.regime` on the built record:

```ts
    const record: CycleRecord = {
      ts: now.toISOString(),
      tsEt,
      tradingDay,
      marketStatus: inputs.marketStatus,
      items: inputs.stocks.map(toRecordedItem),
      decisions: toDecisions(inputs.candidates, inputs.rejections),
      activeTrades: inputs.activeTrades,
      closedTrades: inputs.closedTrades,
      regime: inputs.regime,
    };
```

- [ ] **Step 2: Typecheck**

Run: `cd oracle-web/server && npx tsc --noEmit`
Expected: errors in `priceSocket.ts` and `historicalReplay.ts` because `regime` is now required on `CycleInputs` / `CycleRecord` — those call sites are updated in Tasks 9 and 10.

To keep the typecheck clean between tasks, make the field optional first:

Change both to `regime?: RegimeSnapshot | null;` and default to `null` in `writeCycle`:

```ts
      regime: inputs.regime ?? null,
```

Likewise make `CycleRecord.regime` optional: `regime?: RegimeSnapshot | null;`.

- [ ] **Step 3: Full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green (existing tests don't pass `regime`; recorder accepts null).

- [ ] **Step 4: Commit**

```bash
git add oracle-web/server/src/services/recordingService.ts
git commit -m "feat(regime): persist RegimeSnapshot in CycleRecord (optional for backfill)"
```

---

### Task 9: PriceSocket — build snapshot once per cycle, thread through

**Files:**
- Modify: `oracle-web/server/src/websocket/priceSocket.ts`

- [ ] **Step 1: Import regimeService + thread snapshot**

In `priceSocket.ts`:

1. Add import near the top:

```ts
import { regimeService } from '../services/regimeService.js';
import type { RegimeSnapshot } from '../services/regimeService.js';
```

2. In the `fetchPrices` method, immediately before the candidate evaluation block (around line 341), build the snapshot:

```ts
    // Build regime snapshot once per cycle (symbols, setup-agnostic for v1).
    let regimeSnapshot: RegimeSnapshot | null = null;
    if (config.execution.regime.enabled) {
      try {
        const symbols = Array.from(this.stockStates.keys());
        regimeSnapshot = await regimeService.buildRegimeSnapshot(symbols, 'orb_breakout', new Date());
      } catch (err) {
        console.error('Regime snapshot build failed:', err);
        regimeSnapshot = null;
      }
    }

    // Get ranked candidates for alerts and execution
    let candidates: Awaited<ReturnType<typeof ruleEngineService.getRankedCandidates>> = [];
    try {
      candidates = await ruleEngineService.getRankedCandidates(
        Array.from(this.stockStates.values()),
        20,
        regimeSnapshot ?? undefined,
      );
```

3. In the `executionService.onPriceCycle` call, pass the snapshot:

```ts
        await executionService.onPriceCycle(candidates, Array.from(this.stockStates.values()), regimeSnapshot ?? undefined);
```

(`onPriceCycle` already calls `tradeFilterService.filterCandidate`; in a follow-up step we'll add the parameter there. For v1 commit the change here — `executionService` signature updated below.)

4. In the `recordingService.writeCycle` call, add `regime: regimeSnapshot`:

```ts
      await recordingService.writeCycle({
        stocks: Array.from(this.stockStates.values()),
        candidates,
        rejections: executionService.getRejections(),
        activeTrades: executionService.getActiveTrades(),
        closedTrades: executionService.getLedger(),
        marketStatus,
        regime: regimeSnapshot,
      });
```

- [ ] **Step 2: Update `ExecutionService.onPriceCycle` to accept regime**

In `oracle-web/server/src/services/executionService.ts`, locate `onPriceCycle` and add an optional `regime` param that is forwarded into every `tradeFilterService.filterCandidate(candidate, account, regime)` call within the method. This may be a single call site — search and replace.

Run: `Grep pattern="filterCandidate" path="oracle-web/server/src/services/executionService.ts"` to find the call sites.

For each, change to pass the third arg. Example:

```ts
async onPriceCycle(
  candidates: TradeCandidate[],
  stocks: StockState[],
  regime?: RegimeSnapshot,
): Promise<void> {
  // ...
  for (const candidate of candidates) {
    const result = tradeFilterService.filterCandidate(candidate, accountState, regime);
    // ...
  }
}
```

Add the import `import type { RegimeSnapshot } from './regimeService.js';` at the top.

- [ ] **Step 3: Typecheck + full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green. (Existing `executionService` tests call `onPriceCycle` without `regime` → optional param keeps them compiling.)

- [ ] **Step 4: Smoke-run the server**

Run: `cd oracle-web/server && npm run dev`
Expected: server boots without errors. (Feature is gated by `execution.regime.enabled: false` in YAML → snapshot not built yet, so no functional change.)

Stop the server with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add oracle-web/server/src/websocket/priceSocket.ts \
        oracle-web/server/src/services/executionService.ts
git commit -m "feat(regime): build snapshot per cycle, thread through rule engine + execution"
```

---

### Task 10: historicalReplay — build snapshots per minute

**Files:**
- Modify: `oracle-web/server/src/scripts/historicalReplay.ts`

- [ ] **Step 1: Fetch market + sector + daily bars up-front**

Add near the top of `main()` (after `loadLevels`), batching extra symbols alongside the watchlist fetch:

```ts
  // Market + sector ETF symbols we always want to fetch alongside the watchlist
  const marketSymbols = ['SPY', 'VXX'];
  const sectorByTicker = new Map<string, string>();
  for (const sym of symbols) {
    sectorByTicker.set(sym, await sectorMapService.getSectorFor(sym));
  }
  const distinctEtfs = Array.from(new Set(
    Array.from(sectorByTicker.values()).map((s) => sectorMapService.getEtfFor(s)),
  ));

  const allSymbols = Array.from(new Set([...symbols, ...marketSymbols, ...distinctEtfs]));
```

And use `allSymbols` instead of `symbols` in `fetchBarsBatch` — the watchlist still drives the replay loop, but now `barsByMs['SPY']` etc. are populated.

- [ ] **Step 2: Fetch daily bars per watchlist symbol for ATR**

Add a second batched fetch (1Day bars, ~30 calendar days lookback):

```ts
  const dailyStartMs = etWallToUtcMs(day, 0, 0) - 30 * DAY_MS;
  const dailyBarsByMs: Record<string, Map<number, CachedBar>> = {};
  const dailyBars: Record<string, Bar[]> = {};
  const dailyRaw = await fetchBarsBatch1Day(
    symbols,
    new Date(dailyStartMs).toISOString(),
    new Date(etWallToUtcMs(day, 0, 0)).toISOString(),
  );
  for (const sym of symbols) {
    dailyBars[sym] = (dailyRaw[sym] ?? []).map((b) => ({
      timestamp: new Date(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
    }));
  }
```

Add a helper `fetchBarsBatch1Day` modeled on `fetchBarsBatch` but with `timeframe=1Day`. Factor out to a shared helper:

```ts
async function fetchBarsWithTimeframe(
  symbols: string[],
  timeframe: string,
  startIso: string,
  endIso: string,
): Promise<Record<string, RawBar[]>> {
  // same body as fetchBarsBatch but with `timeframe: timeframe` in params
}
```

Replace existing `fetchBarsBatch` calls with `fetchBarsWithTimeframe(..., '1Min', ...)`.

- [ ] **Step 3: Pre-load trade history per symbol (prior days only)**

```ts
  const historyBySymbol = new Map<string, TradeLedgerEntry[]>();
  for (const sym of symbols) {
    const history = await tradeHistoryService.getRecentTrades(sym, 'orb_breakout', new Date(`${day}T00:00:00Z`));
    historyBySymbol.set(sym, history);
  }
```

This reads JSONLs `day' < day`. Matches the live-vs-backtest no-lookahead contract.

- [ ] **Step 4: Build per-minute snapshot inside the existing loop**

Before scoring each symbol at time `tMs`, build the snapshot once per minute:

```ts
    const spyBarsForMinute = (barsByMs['SPY'] ? extractMinuteBars(barsByMs['SPY'], tMs, 30) : []) as Bar[];
    const vxxBarsForMinute = (barsByMs['VXX'] ? extractLatestTwoDailyBars(barsByMs['VXX'], tMs) : []) as Bar[];
    const sectorBarsByEtf: Record<string, Bar[]> = {};
    for (const etf of distinctEtfs) {
      const m = barsByMs[etf];
      if (m) sectorBarsByEtf[etf] = extractMinuteBars(m, tMs, 30);
    }

    const market = computeMarketRegime(spyBarsForMinute, vxxBarsForMinute, new Date(tMs));
    const sectors: Record<string, SectorRegime> = {};
    for (const [etf, bars] of Object.entries(sectorBarsByEtf)) {
      sectors[etf] = computeSectorRegime(bars, etf, new Date(tMs));
    }
    const tickers: Record<string, TickerRegime> = {};
    for (const sym of symbols) {
      const todayBars = extractBarsFromStart(barsByMs[sym] ?? new Map(), rthStartMs, tMs);
      const sector = sectorByTicker.get(sym) ?? 'unknown';
      tickers[sym] = computeTickerRegime(sym, 'orb_breakout', dailyBars[sym] ?? [], todayBars, historyBySymbol.get(sym) ?? [], sector, new Date(tMs));
    }
    const snapshot: RegimeSnapshot = {
      ts: new Date(tMs).toISOString(),
      market,
      sectors,
      tickers,
    };
```

Where:

```ts
function extractMinuteBars(m: Map<number, CachedBar>, tMs: number, windowMin: number): Bar[] {
  const bars: Bar[] = [];
  for (let offset = windowMin - 1; offset >= 0; offset--) {
    const bar = m.get(tMs - offset * 60_000);
    if (bar) bars.push({ timestamp: new Date(bar.ts), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
  }
  return bars;
}

function extractLatestTwoDailyBars(m: Map<number, CachedBar>, tMs: number): Bar[] {
  // For VXX, we really want daily bars. The simplest approximation when we only have 1m bars is
  // first bar of yesterday's RTH close vs latest bar of today. Keep trivial for v1.
  const sorted = Array.from(m.values()).filter((b) => b.ts <= tMs).sort((a, b) => a.ts - b.ts);
  if (sorted.length < 2) return [];
  return [
    { timestamp: new Date(sorted[0].ts), open: sorted[0].open, high: sorted[0].high, low: sorted[0].low, close: sorted[0].close, volume: sorted[0].volume },
    { timestamp: new Date(sorted[sorted.length - 1].ts), open: sorted[sorted.length - 1].open, high: sorted[sorted.length - 1].high, low: sorted[sorted.length - 1].low, close: sorted[sorted.length - 1].close, volume: sorted[sorted.length - 1].volume },
  ];
}

function extractBarsFromStart(m: Map<number, CachedBar>, startMs: number, endMs: number): Bar[] {
  const out: Bar[] = [];
  for (const b of m.values()) {
    if (b.ts >= startMs && b.ts <= endMs) {
      out.push({ timestamp: new Date(b.ts), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
  }
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}
```

Note: the VXX helper is a compromise — the replay feed is 1m bars; to get a clean daily ROC we would add a separate 1Day fetch for VXX. If the test is noisy, convert the VXX fetch in Step 1 to use `'1Day'` specifically. Simpler: fetch VXX daily separately alongside the watchlist daily fetch.

- [ ] **Step 5: Pass snapshot into `scoreFromInputs` and write into `CycleRecord`**

Change the scoring call:

```ts
      const candidate = ruleEngineService.scoreFromInputs(
        stock,
        emptyMessageContext(sym),
        emptyRedCandleSignal(),
        orbSignal,
        snapshot,
      );
```

And at cycle push:

```ts
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
```

- [ ] **Step 6: Run replay on an existing day and verify output**

Run:

```bash
cd oracle-web/server && npx tsx src/scripts/historicalReplay.ts --day 2026-04-17
```

Expected: exit 0, JSONL written, console shows the same kind of cycle/candidate counts as before. Inspect one line:

```bash
head -1 F:/oracle_data/recordings/2026-04-17.jsonl | python -c "import sys,json; d=json.loads(sys.stdin.read()); print(list(d.keys())); print(d['regime']['market'])"
```

Expected: `regime` key present with `market.status: 'ok'` (or `unavailable` if SPY bars failed — shouldn't happen given the up-front fetch).

- [ ] **Step 7: Typecheck + full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add oracle-web/server/src/scripts/historicalReplay.ts
git commit -m "feat(regime): compute per-minute regime snapshot in historical replay"
```

---

### Task 11: BacktestRunner — consume `cycle.regime` for vetos

**Files:**
- Modify: `oracle-web/server/src/services/backtestRunner.ts`
- Modify: `oracle-web/server/src/__tests__/backtestRunner.test.ts`

- [ ] **Step 1: Add failing test for veto replay**

Add to `backtestRunner.test.ts`:

```ts
import type { RegimeSnapshot } from '../services/regimeService.js';

describe('regime vetos in backtest', () => {
  it('blocks entry when cycle.regime flags market panic', () => {
    const panicRegime: RegimeSnapshot = {
      ts: '2026-04-17T13:30:00Z',
      market: { score: -1, spyTrendPct: -0.02, vxxRocPct: 0.07, status: 'ok' },
      sectors: {},
      tickers: {},
    };
    const cycle: CycleRecord = makeCycle({
      ts: '2026-04-17T13:30:00Z',
      regime: panicRegime,
      items: [{ symbol: 'ABC', currentPrice: 1, /* ... */ }],
      decisions: [{ symbol: 'ABC', kind: 'candidate', setup: 'orb_breakout', score: 80, rationale: [],
                    suggestedEntry: 1, suggestedStop: 0.95, suggestedTarget: 1.5 }],
    });
    const result = backtestRunner.runCycles([cycle]);
    expect(result.trades).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason.includes('market panic'))).toBe(true);
  });
});
```

Adapt `makeCycle` to match whatever helper the existing test uses; extend it to include `regime`.

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Modify `evaluateNewEntries`**

Right after the existing `riskPct` gate:

```ts
      if (cycle.regime) {
        const m = cycle.regime.market;
        if (
          m.spyTrendPct !== null &&
          m.vxxRocPct !== null &&
          m.spyTrendPct <= exec.regime.veto_market_spy_trend_pct &&
          m.vxxRocPct >= exec.regime.veto_market_vxx_roc_pct
        ) {
          skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: 'market panic' });
          continue;
        }
        const tr = cycle.regime.tickers[decision.symbol];
        if (tr) {
          if (tr.sampleSize >= exec.regime.veto_graveyard_min_sample && tr.winRate === 0) {
            skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: `graveyard 0/${tr.sampleSize}` });
            continue;
          }
          if (tr.atrRatio !== null && tr.atrRatio >= exec.regime.veto_exhaustion_atr_ratio) {
            skipped.push({ symbol: decision.symbol, ts: cycle.ts, reason: `exhaustion ${tr.atrRatio.toFixed(2)}` });
            continue;
          }
        }
      }
```

- [ ] **Step 4: Run tests**

Run: `cd oracle-web/server && npx vitest run src/__tests__/backtestRunner.test.ts`
Expected: new veto test passes, existing tests still pass.

- [ ] **Step 5: Typecheck + full suite**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add oracle-web/server/src/services/backtestRunner.ts \
        oracle-web/server/src/__tests__/backtestRunner.test.ts
git commit -m "feat(regime): backtest runner honors CycleRecord.regime vetos"
```

---

### Task 12: Enable in YAML + sector overrides seed

**Files:**
- Modify: `oracle-web/server/config.yaml`
- Modify: `oracle-web/server/config/sector_overrides.yaml`

- [ ] **Step 1: Flip `execution.regime.enabled: true` in YAML**

Change `oracle-web/server/config.yaml`:

```yaml
  regime:
    enabled: true
    # ... rest unchanged ...
```

(Leaves the zod default at `false` so anyone using a minimal `config.yaml` stays off-by-default.)

- [ ] **Step 2: Smoke-run server**

```bash
cd oracle-web/server && npm run dev
```

Expected: server boots, regime snapshot builds each cycle, logs show no errors around sector lookup or ETF fetch. Let it run for two cycles, then Ctrl+C.

- [ ] **Step 3: Inspect today's recording for `regime` presence**

```bash
tail -1 F:/oracle_data/recordings/$(date +%F).jsonl | python -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['regime']['market']); print(list(d['regime']['sectors'].keys()))"
```

Expected: `market.status: 'ok'` (or `'unavailable'` if SPY/VXX fetch failed — investigate). At least one sector ETF present.

- [ ] **Step 4: Commit**

```bash
git add oracle-web/server/config.yaml
git commit -m "chore(regime): enable regime layer in local config.yaml"
```

---

### Task 13: Backtest regression — 8-day sweep

**Files:**
- None modified (verification only)
- Create: `docs/superpowers/plans/2026-04-22-regime-model-regression.md` (regression record; committed in this task)

- [ ] **Step 1: Re-run historical replay for all 8 days (regime now embedded in JSONL)**

```bash
cd oracle-web/server
for d in 2026-02-03 2026-02-04 2026-02-05 2026-02-06 2026-04-17 2026-04-20 2026-04-21 2026-04-22; do
  npx tsx src/scripts/historicalReplay.ts --day $d
done
```

Expected: all 8 succeed. (If 2026-04-22 collides with the live recording, use the same `.live.jsonl.bak` swap pattern documented in the spec's "clobbering live recording" note.)

- [ ] **Step 2: Run backtest breakdown for each day**

```bash
for d in 2026-02-03 2026-02-04 2026-02-05 2026-02-06 2026-04-17 2026-04-20 2026-04-21 2026-04-22; do
  echo "=== $d ===";
  npx tsx src/scripts/backtestBreakdown.ts --day $d --starting-cash 1000 --max-trade-cost 100 --risk-per-trade 10;
done
```

Expected: per-day summary of trades/wins/losses/pnl. Capture totals.

- [ ] **Step 3: Compare against the `-$12.39` baseline**

Record in the regression doc:

```markdown
# Regime Regression — 2026-04-22

Compared 8-day backtest with regime ON vs. prior branch baseline (post-momentum-rewrite + position-sizing, regime OFF).

| Day | Baseline P&L | Regime P&L | Δ | Vetos fired | Trades (base → regime) |
|-----|--------------|------------|---|-------------|------------------------|
| 2026-02-03 |   |   |   |   |   |
| 2026-02-04 |   |   |   |   |   |
| 2026-02-05 |   |   |   |   |   |
| 2026-02-06 |   |   |   |   |   |
| 2026-04-17 |   |   |   |   |   |
| 2026-04-20 |   |   |   |   |   |
| 2026-04-21 |   |   |   |   |   |
| 2026-04-22 |   |   |   |   |   |
| **Total**  | -12.39 |   |   |   |   |

**Veto breakdown across 8 days:**
- market panic: _n_ blocks
- graveyard: _n_ blocks
- exhaustion: _n_ blocks

**Interpretation:** ...
```

Fill in with real numbers from the per-day output.

- [ ] **Step 4: Decision gate**

If aggregate P&L improves OR stays flat with materially lower drawdown → keep regime ON and proceed to PR.

If aggregate P&L is worse by > $5 → triage the worst two days: pull the `decisions` arrays from their JSONL, find any candidate where the regime blocked a winning trade (check trade history to see which trades would have passed without vetos). The most likely culprit is `veto_exhaustion_atr_ratio` too tight or `veto_graveyard_min_sample` too permissive. Adjust, re-run the regression, commit threshold tweaks.

- [ ] **Step 5: Commit regression doc**

```bash
git add docs/superpowers/plans/2026-04-22-regime-model-regression.md
git commit -m "docs(regime): 8-day backtest regression results"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin docs/regime-model-design
gh pr create --title "feat: regime-aware trade decisions (market + sector + ticker)" --body "$(cat <<'EOF'
## Summary
- Add upstream `RegimeService` that emits a `RegimeSnapshot` per cycle (SPY/VXX + SPDR sectors + per-ticker ATR & win-rate)
- Hybrid effect: soft composite × 10 score contribution + hard vetos for market panic, (symbol, setup) graveyard, and ATR exhaustion
- Snapshot is recorded into `CycleRecord` so backtest replay sees the exact same regime

See `docs/superpowers/specs/2026-04-22-regime-model-design.md` for design, `docs/superpowers/plans/2026-04-22-regime-model.md` for plan, `docs/superpowers/plans/2026-04-22-regime-model-regression.md` for 8-day backtest deltas.

## Test plan
- [ ] `npx vitest run` — unit + integration tests green
- [ ] `npx tsc --noEmit` — typecheck clean
- [ ] `historicalReplay --day` across all 8 baseline days produces JSONL with `regime` field
- [ ] `backtestBreakdown` aggregate P&L reviewed against baseline (-$12.39)
- [ ] Smoke-run server with `execution.regime.enabled: true` — verify snapshot appears in live recording
EOF
)"
```

- [ ] **Step 7: Close out**

- Ensure PR has a clean CI run.
- Link the spec and plan in the PR description.
- Merge policy: `gh pr merge <N> --squash --admin --delete-branch`, then `git checkout main && git pull`.

---

## Self-review checklist (fill out after implementation, before opening PR)

- [ ] Spec coverage: every section of `docs/superpowers/specs/2026-04-22-regime-model-design.md` has a task above that implements it (market + sector + ticker tiers, hybrid score + veto, regime in `CycleRecord`, backtest replay, config block, rollout).
- [ ] All three veto paths have both a positive-fail test and a negative-pass (below-threshold) test.
- [ ] No unused imports or dead code introduced.
- [ ] `execution.regime.enabled` default in `config.ts` is `false` (YAML overrides to `true` in Task 12).
- [ ] Every error path in the orchestrator returns a neutral / status='unavailable' result, never throws up the stack.
- [ ] No live Finnhub or Alpaca calls in unit tests — all mocked.
- [ ] `TradeHistoryService` only reads files with `day < now` (no lookahead in backtest).
- [ ] Sector overrides YAML is valid YAML and loads on boot even when empty.
