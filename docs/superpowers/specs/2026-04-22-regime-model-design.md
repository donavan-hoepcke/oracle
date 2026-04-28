# Regime-Aware Trade Decisions — Design Spec

> **Status:** Design approved, implementation pending.

## Context

Recent 8-day backtest of the post-momentum-rewrite + position-sizing engine came in at -$12.39 on a $1,000 account (23W/25L, 48%) across four February days and four April days. The individual setups (ORB, momentum, red-candle) all behave reasonably in isolation; the losses cluster on days where the overall market is in a hostile regime and every setup is fighting tape.

Concrete example: 2026-04-22 had ORB fire on five tickers (SLNH, BURU, BMNU, DCX, ASBP); four were stop-outs in a chop-then-reverse tape. The engine had no awareness that small-cap breadth was negative and micro-cap breakouts were not holding. Similar pattern on 2026-04-20 and 2026-04-21.

This spec adds a regime layer that observes three scopes — market, sector, ticker — and influences the rule engine in two ways: a soft score contribution that shifts borderline candidates, and a small set of hard vetos that block trading in obvious panic or graveyard conditions.

## Design decisions already locked in

From brainstorming session on 2026-04-22 with the user:

- **Scope:** All three tiers (market + sector + ticker) in v1. No half measures.
- **Effect model:** Hybrid — soft score contribution by default, hard vetos for extreme states only.
- **Architecture:** Upstream `RegimeService` emits a `RegimeSnapshot` per poll cycle. Snapshot is passed as an argument to `scoreFromInputs` and `filterCandidate`, matching the functional pattern already used by `orbSignal` and `momentumSignal`. Snapshot is recorded into `CycleRecord` so backtest replay is loss-free.
- **Signals chosen for v1:**
  - Market: SPY 30m trend, VXX 1d ROC (as VIX proxy since Alpaca cannot stream CBOE VIX).
  - Sector: parent-SPDR ETF 30m trend (XBI for biotech, XLE for energy, etc.).
  - Ticker: ATR-relative range ratio (today's range ÷ 20-day ATR), recent win rate on (symbol, setup) combo.
- **Sector map source:** Finnhub `/stock/profile2` with a persistent JSON cache; hand-curated overrides YAML for Finnhub misclassifications.
- **Win-rate data source:** scan recording JSONLs for prior closed trades on (symbol, setup). Lookback = last 20 trades or 30 calendar days, whichever is smaller. Live and backtest share the same reader; backtest reads strictly *before* the replay day to avoid lookahead.

## Architecture

```
PriceSocket (30s poll)
  ├─ RegimeService.buildRegimeSnapshot(symbols, now)
  │    ├─ fetch SPY/VXX bars → market tier
  │    ├─ fetch sector ETFs (per distinct sector in `symbols`) → sector tier
  │    └─ per symbol: ATR from daily bars + win-rate from TradeHistoryService → ticker tier
  │
  └─ RuleEngine.evaluateStock(stock, regimeSnapshot)
        ├─ scoreFromInputs(...) + composite × 10 contribution
        │
        └─ TradeFilterService.filterCandidate(candidate, account, regimeSnapshot)
              ├─ existing gates (drawdown, max_positions, capital, max_risk)
              └─ new regime vetos: market panic, ticker graveyard, exhaustion
```

### New files

| File | Purpose |
|------|---------|
| `server/src/services/regimeService.ts` | Builds per-cycle `RegimeSnapshot`. Exposes pure computers `computeMarketRegime`, `computeSectorRegime`, `computeTickerRegime` and orchestrator `buildRegimeSnapshot`. |
| `server/src/services/sectorMapService.ts` | Ticker→sector lookup with Finnhub primary + local JSON cache + YAML override merge. |
| `server/src/services/tradeHistoryService.ts` | Reads closed trades from recording JSONLs, filtered by (symbol, setup) and date window. One interface used live and in backtest. |
| `server/config/sector_overrides.yaml` | Hand-curated overrides; empty by default, edited as Finnhub misclassifications are discovered. |

### Modified files

| File | Change |
|------|--------|
| `ruleEngineService.ts` | `scoreFromInputs` gains `regime?: RegimeSnapshot` param; adds `composite × 10` to weighted score before threshold check. `evaluateStock` accepts and forwards the snapshot. |
| `tradeFilterService.ts` | `filterCandidate` gains `regime?: RegimeSnapshot`; runs the three vetos if provided. |
| `priceSocket.ts` | Calls `regimeService.buildRegimeSnapshot` once per poll cycle, passes to rule engine and filter. |
| `recordingService.ts` | `CycleRecord` gains `regime: RegimeSnapshot` field. |
| `historicalReplay.ts` | Fetches SPY/VXX/sector-ETF bars for the replay day, builds per-minute snapshots, passes through. Reads prior-day JSONLs for win-rate data. |
| `backtestRunner.ts` | Consumes `regime` from each `CycleRecord`, passes into filter. |
| `config.ts` / `config.yaml` | Add `execution.regime.*` block with zod schema. |

## Components

### RegimeService

**Shape:**

```ts
interface RegimeSnapshot {
  ts: string;                                  // ISO
  market: MarketRegime;                        // single instance per snapshot
  sectors: Record<string, SectorRegime>;       // keyed by SPDR symbol (XBI, XLE, ...)
  tickers: Record<string, TickerRegime>;       // keyed by watchlist symbol
}

interface MarketRegime {
  score: number;                   // [-1, +1], composite of SPY trend and VXX ROC
  spyTrendPct: number | null;      // slope-fit % change over last 30 1m closes
  vxxRocPct: number | null;        // (latestClose - prevClose) / prevClose
  status: 'ok' | 'unavailable';
}

interface SectorRegime {
  score: number;                   // [-1, +1]
  etfSymbol: string;               // e.g. "XBI"
  trendPct: number | null;         // slope-fit % change over last 30 1m closes
  status: 'ok' | 'unavailable';
}

interface TickerRegime {
  score: number;                   // [-1, +1]
  sector: string;                  // from sectorMapService; "unknown" if unmapped
  atrRatio: number | null;         // today's range / 20-day ATR
  winRate: number | null;          // wins / total over lookback window
  sampleSize: number;              // how many prior trades inform winRate
  status: 'ok' | 'unavailable';
}
```

**Pure computers** (each testable in isolation, reused by live and backtest paths):

- `computeMarketRegime(spyBars, vxxBars, now) → MarketRegime`
  - `spyTrendPct`: linear regression of last 30 1m closes, slope × 30 as % of first close
  - `vxxRocPct`: (latestClose − prevDayClose) / prevDayClose
  - `score`: `0.5 × clamp(spyTrendPct / 0.005, -1, 1) + 0.5 × clamp(-vxxRocPct / 0.05, -1, 1)`
    (SPY up 0.5% in 30m = +1, VXX up 5% in 1d = -1; both normalized and averaged)
- `computeSectorRegime(etfBars, now) → SectorRegime`
  - `trendPct`: same slope method as SPY
  - `score`: `clamp(trendPct / 0.01, -1, 1)`
- `computeTickerRegime(symbol, setup, dailyBars, todayBars, pastTrades, now) → TickerRegime`
  - `todayRange`: `max(todayBars.high) − min(todayBars.low)` across today's 1m bars from 09:30 ET up to `now`
  - `atrRatio`: `todayRange / atr14(dailyBars)`, where `atr14` is the standard Wilder ATR over the last 14 completed daily bars
  - `pastTrades` is `ClosedTrade[]` (same shape as `CycleRecord.closedTrades[number]` from `recordingService.ts`); scoring uses only trades where `exitReason` is a terminal state (target/stop/trailing_stop/eod)
  - `winRate`: `wins / total` across `pastTrades`; `null` when `total < winrate_min_sample` (default 3)
  - `atrPenalty`: -1 if `atrRatio ≥ atr_penalty_ratio` (default 2.5), 0 otherwise (soft; hard veto is separate at 3.0)
  - `winRateScore`: `(wins − losses) / total` if `total ≥ winrate_min_sample`, else 0
  - `score`: `0.5 × atrPenalty + 0.5 × winRateScore`

**Orchestrator:**

```ts
async function buildRegimeSnapshot(
  symbols: string[],
  now: Date,
): Promise<RegimeSnapshot>;
```

- Fetches SPY+VXX bars once per cycle (not per symbol)
- Determines distinct sectors across `symbols` via sectorMapService, fetches each ETF once
- For each symbol: fetches 20 daily bars (cached), fetches today's bars (already cached upstream), reads pastTrades via tradeHistoryService
- Returns the assembled snapshot

All Alpaca fetches use the existing pattern from `historicalReplay.ts`. Snapshot build is a single `Promise.all` over the per-symbol ticker-regime work, gated only by data availability.

### SectorMapService

**Interface:**

```ts
getSectorFor(symbol: string): Promise<string>;    // returns e.g. "biotechnology", "energy", "unknown"
getEtfFor(sector: string): string;                 // sector → SPDR symbol mapping (static table)
```

**Lookup order:**

1. Hand-curated overrides from `server/config/sector_overrides.yaml` (loaded at boot)
2. Local JSON cache at `F:/oracle_data/sector_map.json` (keyed by symbol)
3. Finnhub `/stock/profile2` — on success, write to cache
4. On failure: return `"unknown"`, do not cache the failure (retry next time)

The sector → SPDR-ETF mapping is a static table inside the service covering the SPDR ecosystem (XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY) plus the small-cap biotech (XBI) and tech (IGV) proxies. Unknown sectors fall through to SPY itself (sector regime = market regime for those symbols).

### TradeHistoryService

**Interface:**

```ts
getRecentTrades(
  symbol: string,
  setup: string,
  now: Date,
  options?: { maxTrades?: number; maxCalendarDays?: number },
): Promise<ClosedTrade[]>;
```

- Scans recording JSONLs in `config.recording.dir`
- For backtest: reads strictly files with `day < now`
- For live: reads current file + prior N days
- Default options: `{ maxTrades: 20, maxCalendarDays: 30 }`
- Returns chronological list of closed trades (from the `closedTrades` field already present in `CycleRecord`)

### Score integration

In `scoreFromInputs`:

```ts
let score = oracleScore * 0.45 + messageScore * 0.35 + executionScore * 0.2;

if (regime) {
  const tickerRegime = regime.tickers[stock.symbol];
  const sectorRegime = regime.sectors[tickerRegime?.sector ?? ''];
  const composite =
    0.5 * regime.market.score +
    0.2 * (sectorRegime?.score ?? 0) +
    0.3 * (tickerRegime?.score ?? 0);
  score += composite * 10;
}
```

Candidate threshold (currently ~65) is unchanged. A hostile regime shaves up to 10 points; a friendly one adds up to 10.

### Veto integration

In `tradeFilterService.filterCandidate`, after existing gates:

```ts
if (!regime) return { passed: true, reason: null };

// Market panic
if (
  regime.market.spyTrendPct !== null &&
  regime.market.vxxRocPct !== null &&
  regime.market.spyTrendPct <= -0.01 &&
  regime.market.vxxRocPct >= 0.05
) {
  return { passed: false, reason: 'market panic (SPY ≤ -1% AND VXX ≥ +5%)' };
}

// Setup-ticker graveyard
const tr = regime.tickers[candidate.symbol];
if (tr && tr.sampleSize >= 5 && tr.winRate === 0) {
  return { passed: false, reason: `ticker+setup graveyard (0/${tr.sampleSize} on ${candidate.setup})` };
}

// Exhaustion
if (tr && tr.atrRatio !== null && tr.atrRatio >= 3.0) {
  return { passed: false, reason: `exhaustion (ATR ratio ${tr.atrRatio.toFixed(2)})` };
}

return { passed: true, reason: null };
```

All thresholds come from `config.execution.regime.*` so they are tunable without code changes.

### Configuration

```yaml
execution:
  # ... existing keys ...
  regime:
    enabled: true
    score_weight: 10                  # max points regime can add/subtract
    market_weight: 0.5
    sector_weight: 0.2
    ticker_weight: 0.3
    spy_trend_normalize_pct: 0.005    # SPY 30m trend that maps to score=1
    vxx_roc_normalize_pct: 0.05       # VXX 1d ROC that maps to score=-1
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

## Data flow

**Live cycle:**

```
priceSocket tick (30s)
  └─ regimeService.buildRegimeSnapshot(watchlistSymbols, now)
      ├─ market: Alpaca bars for SPY + VXX (one call each, cached 30s)
      ├─ sectors: one Alpaca call per distinct sector ETF
      └─ tickers: for each symbol, ATR from Alpaca daily bars (cached all-day) +
                   tradeHistoryService.getRecentTrades(symbol, setup)
  └─ ruleEngineService.evaluateStock(stock, regimeSnapshot) → candidate with regime-adjusted score
  └─ tradeFilterService.filterCandidate(candidate, account, regimeSnapshot) → pass/reject
  └─ recordingService writes CycleRecord including regimeSnapshot
```

**Backtest cycle:**

```
historicalReplay --day 2026-04-17
  ├─ up-front: fetch 1m bars for watchlist + SPY + VXX + distinct sector ETFs (one batch)
  ├─ up-front: fetch daily bars for watchlist (20-day lookback) for ATR
  ├─ up-front: load prior days' recording JSONLs for trade history
  └─ per minute t:
      ├─ build RegimeSnapshot from cached bars + prior trade history up to t
      ├─ call ruleEngineService.scoreFromInputs with regime
      └─ write CycleRecord with regime
backtestRunner --day 2026-04-17 --starting-cash 1000 --max-trade-cost 100
  └─ reads CycleRecord.regime, passes into tradeFilterService for veto replay
```

## Error handling

Regime data is advisory, not load-bearing. Failures degrade to neutral, never block trading:

- **Market ETF bar fetch fails (SPY/VXX):** `computeMarketRegime` returns `{ score: 0, status: 'unavailable', spyTrendPct: null, vxxRocPct: null }`. Score contribution is 0. Market-panic veto disabled (cannot veto on missing data).
- **Sector ETF bar fetch fails:** Same pattern at sector scope. Affects only the tickers mapped to that sector.
- **Finnhub sector lookup fails:** Symbol mapped to `sector: 'unknown'`, sector regime → score 0 for that symbol. Successful lookups are cached permanently; failures are retried next cycle.
- **ATR unavailable (new ticker, <14 daily bars):** `atrRatio: null`, exhaustion veto disabled for that symbol, win-rate portion of ticker score still counts.
- **No prior trades for (symbol, setup):** `winRate: null, sampleSize: 0`. Score contribution 0, graveyard veto disabled.
- **tradeHistoryService read fails:** Logged, returns empty list. Equivalent to "no prior trades" path.

Every `*Regime` object has a `status` field. Cycles containing non-`ok` statuses are recorded as-is — backtests will see the same degradation the live run experienced.

## Testing

**Unit tests** (target ~15 new):

- `computeMarketRegime`: SPY up/down/flat × VXX up/down/flat → 9 cases, plus null-input and single-bar edge cases.
- `computeSectorRegime`: 4 slope bands (strong up, mild up, flat, strong down).
- `computeTickerRegime`: ATR ratio bands (1.0, 2.0, 2.5, 3.5) × win-rate bands (0/5, 2/5, 5/5).
- `sectorMapService`: override file wins over cache wins over Finnhub; cache hit; Finnhub failure.
- `tradeHistoryService`: reads only files with `day < now`; respects maxTrades and maxCalendarDays caps; handles malformed lines.

**Veto tests** in `tradeFilterService.test.ts`:

- Market panic: SPY -1.5%, VXX +6% → rejected with "market panic".
- Market panic counter: SPY -1.5%, VXX +2% → passes (one condition met, not both).
- Graveyard: 0/5 prior trades → rejected.
- Graveyard counter: 0/3 prior trades → passes (below min_sample).
- Exhaustion: ATR ratio 3.5 → rejected.
- Exhaustion counter: ATR ratio 2.8 → passes (below veto threshold, still inside soft penalty zone).

**Integration test**: one test that constructs a canned `RegimeSnapshot`, runs a candidate through `scoreFromInputs` then `filterCandidate`, asserts the score shifts by the expected amount and the veto fires / does not fire as expected.

**Backtest regression**: run `backtestBreakdown` across all 8 existing days (2026-02-03/04/05/06 and 2026-04-17/20/21/22) with regime on, compare to the -$12.39 baseline from the current branch. Document both numbers in the PR, including per-day deltas and a count of how many trades the vetos blocked.

**Not tested** (mocked): live Finnhub calls, live Alpaca calls. No live-integration tests.

## Rollout

1. Implement with `execution.regime.enabled: false` by default in `config.ts` zod schema.
2. Merge with regime off. Verify live server still behaves identically.
3. Turn on in YAML (`config.yaml` can override default to `true`). Monitor a live session.
4. Run the backtest regression; if aggregate improves, keep on. If worse, triage — most likely culprit is a veto threshold that is too tight.

## Open questions / deferred

- **Volume/float ratio as a ticker-tier signal:** Deliberately deferred. Float data is scraped and patchy; will revisit if exhaustion veto alone undercounts.
- **Ticker beta:** Deferred; adds noise over sector trend.
- **Sector rotation (sector ETF vs. SPY):** Deferred. Sector absolute trend is cheaper and usually sufficient.
- **Per-setup score weights:** The `score_weight: 10` ceiling is uniform across setups in v1. A follow-up can make it setup-specific if backtest shows e.g. momentum benefits more from regime than ORB.
