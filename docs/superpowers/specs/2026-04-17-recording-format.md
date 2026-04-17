# Daily Pick Recording — Design Spec

## Goal

Persist per-cycle snapshots of scraped Oracle data + rule-engine decisions so that:

1. **Backtest** — we can replay a day through the current rule engine / execution service to measure how parameter changes would have affected outcomes.
2. **Audit** — when a trade goes wrong we can see exactly what the system saw at each cycle, not just the final Alpaca fill.
3. **Review UI** — a future page that shows the day's picks, rejections, and decisions in a timeline.

This is the data foundation. The backtest runner and parameter tuner UI are separate follow-ups.

## Storage

- **Format:** JSONL (newline-delimited JSON). One cycle = one line.
- **Location:** configurable via `recording.dir`; defaults to `F:/oracle_data/recordings`.
- **Naming:** `YYYY-MM-DD.jsonl` keyed by trading day in `market_hours.timezone` (America/New_York).
- **Append-only.** Server restart mid-day continues appending.
- **No auto-rotation, no retention policy.** Disk usage is ~500 KB/day uncompressed; add gzip rotation later if it becomes a problem.

Why JSONL: no new dependencies, every line is independently parseable, `tail -f` works during debugging, streaming reads don't need a parser state machine.

## Cycle Record Schema

```typescript
interface CycleRecord {
  ts: string;                 // ISO 8601 UTC, cycle start
  tsEt: string;               // "HH:MM:SS" ET, for quick visual scanning
  tradingDay: string;         // "YYYY-MM-DD" ET — the file's day key
  marketStatus: {
    isOpen: boolean;
    openTime: string;
    closeTime: string;
  };
  items: RecordedItem[];      // one per symbol in the watchlist this cycle
  candidates: RecordedDecision[]; // rule-engine output
  trades: TradeEvent[];       // state changes emitted during this cycle
}

interface RecordedItem {
  symbol: string;
  currentPrice: number | null;
  lastPrice: number | null;           // Oracle "Last" (prior close)
  changePercent: number | null;
  stopPrice: number | null;
  buyZonePrice: number | null;
  sellZonePrice: number | null;
  profitDeltaPct: number | null;
  max: number | null;
  volume: number | null;
  relativeVolume: number | null;
  floatMillions: number | null;
  signal: 'BRK' | 'RC' | null;
  trend30m: 'up' | 'down' | 'flat' | null;
  boxTop: number | null;
  boxBottom: number | null;
}

interface RecordedDecision {
  symbol: string;
  kind: 'candidate' | 'rejection';
  setup: CandidateSetup;
  score: number;
  rationale: string[];
  rejectionReason?: string;           // only when kind === 'rejection'
}

interface TradeEvent {
  kind: 'open' | 'stop_update' | 'exit';
  symbol: string;
  strategy: CandidateSetup;
  price: number;                      // entry / new-stop / exit price
  shares?: number;                    // open & exit
  rMultiple?: number;                 // stop_update & exit
  exitReason?: ExitReason;            // exit only
  trailingState?: TrailingState;      // stop_update only
}
```

Keeping `items` and `candidates` both on the same cycle record means a replay can feed `items` back into the rule engine and compare its output against `candidates` (golden-file test for rule-engine regressions).

## When a Cycle is Written

After the price-fetch + rule-engine + execution pass in `priceSocket.runFetchCycle`, the service calls `recordingService.writeCycle(record)`. One line, one cycle. If the cycle errored early (scraper/price fetch failed), nothing is written for that cycle.

Writes are `fs.appendFile` — synchronous enough for a 30s cadence, survives server crash without buffered data loss.

Rotation happens implicitly: each `writeCycle` computes today's ET date and chooses the file based on that. A cycle that spans midnight lands in whichever day it finishes in.

## Config

```yaml
recording:
  enabled: true
  dir: "F:/oracle_data/recordings"
```

If the dir doesn't exist, the service creates it (recursively) on first write. If `enabled: false`, every call is a no-op.

## What This Does NOT Include (Yet)

- **Indexed queries.** JSONL is sequential; full-day replay is fine. Cross-day analytics want either a SQLite index or a DuckDB scan over the directory. Out of scope here.
- **Compression.** Completed days compress ~10:1 with gzip. Add a nightly rotate-and-compress job once we have a few weeks of data.
- **Trade-event streaming to a separate file.** Could split per-cycle items from trade events if item writes start dominating replay speed, but one file is simpler until we hit a performance ceiling.
- **Replay tooling.** That's the next PR. This one just writes.

## Testing

1. Unit: `writeCycle` produces one valid JSON line per call; `JSON.parse(line)` returns the same record.
2. Unit: `writeCycle` creates the target directory if missing.
3. Unit: when `recording.enabled === false`, no filesystem calls are made.
4. Unit: rotating across trading days writes to the correct file per record.
5. Smoke: run the server for two cycles against a temp dir, assert the expected line count and that each line parses.

## Operational Notes

- `F:/oracle_data` is the user's data directory (same one used by the previous Excel path, intentionally kept alive). Recordings live under `recordings/` inside it so the root stays readable.
- No PII concerns — everything is public market data plus the bot's own decisions.
- If Alpaca is unreachable, the execution service may skip its pass; the record still captures `items` and `candidates`, with `trades: []`.
