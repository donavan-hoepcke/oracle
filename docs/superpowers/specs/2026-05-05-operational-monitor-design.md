# Operational Monitor — Design Spec

> **Status:** Proposed. Not yet implemented.

## Context

Today's debugging session surfaced a class of failure that the bot doesn't catch on its own: a dependency goes quietly wrong while the trading loop keeps running. Concrete examples:

- The Playwright/Chrome scraper session went stale ("Target page, context or browser has been closed") and emitted no further symbols for hours; nothing in the bot log flagged it.
- The Alpaca paper account hit PDT for the day, every flatten attempt was rejected with HTTP 403, and the bot kept retrying without surfacing the lockout state to the operator.
- A bracket OCO leg fired at the broker; the bot didn't know the position was closed (state-divergence bug fixed in PR #85). Even after that fix, similar drift can happen if the broker's order history doesn't surface a fill for a long time.

The common shape: a dependency is in a broken or degraded state and the bot can't tell. Without an external probe, the operator only finds out when a trade does or doesn't happen.

## Goals

- Probe every external dependency and internal staleness signal on a fixed cadence.
- Surface results in two places: a tiny status-bar dot (always visible, click → open Health tab) and a dedicated Health tab with per-probe history.
- Self-heal the failure modes that have a clean restart path (Playwright session, scraper services).
- Escalate to "needs human" when self-heal repeatedly fails, so the bot stops thrashing.

## Non-goals

- External alerting (Slack, email, push). The operator works with the dashboard open. Adding outbound alerts can layer on later if the use case appears.
- Persisting probe history across restarts. The 200-event in-memory ring is sufficient for "is this flapping right now?"; long-term history would just add disk cost without changing operator behavior.
- Probing things outside the bot's process (CPU, memory, network) — those are the OS's job.
- Replacing existing per-service `getSnapshot()` patterns. The monitor consumes them; it does not subsume them.

## Architecture

```
                    ┌───────────────────────────────────┐
                    │         opsMonitorService          │
                    │  (single 30s loop, fan-out probes) │
                    └─────────────┬─────────────────────┘
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       │                          │                          │
   probe fns               recovery actions         200-event ring
   (return ProbeResult)    (per-probe, gated)       (in-memory)
                                  │
                                  ▼
                          ┌───────────────────┐
                          │ rawStreamService   │ ◄── WS clients
                          │   ops_health event │
                          └───────────────────┘
                                  │
                ┌─────────────────┴─────────────────┐
                │                                   │
        StatusBar dots                       /health page
       (rollup + per-probe)                 (table + history)
```

A new `opsMonitorService.ts` runs a single probe loop every **30 seconds** — same cadence as the price-poll loop, no extra timer subsystem. Each probe is a small async function returning a `ProbeResult`:

```ts
{
  name: string;
  status: 'ok' | 'warn' | 'red' | 'needs_human' | 'unknown';
  lastProbeAt: string;       // ISO
  lastOkAt: string | null;
  message: string;            // human-readable for tooltip
  attemptedRecovery?: boolean;
  recoveredAt?: string;
}
```

Probes run via `Promise.allSettled` so one bad probe can't break others. Per-probe state plus a 200-event in-memory history ring lives on the service. State is broadcast to clients via the existing `WS /api/raw/stream` as a new `ops_health` event kind, and exposed via three HTTP endpoints:

- `GET /api/ops/health` — current snapshot of all probes
- `GET /api/ops/health/history?probe=<name>` — ring slice for the Health tab's flapping detection view
- `POST /api/ops/health/reset` — clears all `needs_human` flags without a backend restart

History is in-memory only (lost on restart). Persisting to recordings is overkill for one operator.

## Probes

Each probe has a staleness threshold and a recovery action.

| # | Probe | Threshold | Recovery |
|---|---|---|---|
| 1 | **Oracle scraper (Playwright)** | `tickerBotService.lastSync` older than 90s OR `lastError` non-null | Stop + start `tickerBotService` |
| 2 | Alpaca `/account` | 2 consecutive 5xx or timeouts | Passive — flag |
| 3 | Recording disk | Available bytes < 1GB OR write probe fails | Passive — flag, can't auto-fix |
| 4 | WS clients | Always informational, not a failure | n/a |
| 5 | moderatorAlerts | `fetchedAt` older than 6 min OR `error` set | Stop + start `moderatorAlertService` |
| 6 | incomeTraderChat | `fetchedAt` older than 3 min OR `error` set | Stop + start `incomeTraderChatService` |
| 7 | FloatMap | `fetchedAt` older than 4 min OR `error` set | Stop + start `floatMapService` |
| 8 | Sector Hotness | `fetchedAt` older than 10 min OR `error` set | Stop + start `sectorHotnessService` |
| 9 | Polygon API | Rolling window: 5+ of last 10 fetches are 4xx/5xx | Passive — likely rate limit |
| 10 | Alpaca IEX bars | Rolling window: 5+ of last 10 fetches are 4xx/5xx (excl 429) | Passive — flag |
| 11 | IBKR gateway | Active when `broker.active === 'ibkr'`. `tickle` returns `iserver.authenticated:false` | Passive — flag "re-auth needed" |
| 12 | Chrome debug-port | TCP connect to `chrome_cdp_url` fails | Passive — flag "Chrome down" |

### Recovery rules

- **Cooldown:** max 1 recovery attempt per probe per 5-minute window. Prevents thrash if a service can't actually be revived.
- **Escalation:** if 3 consecutive recovery attempts fail (i.e. probe still red 30s after restart), the probe goes to `needs_human` — won't auto-restart again until the next process restart or a manual `POST /api/ops/health/reset`.
- **Probes 9 & 10** (Polygon, IEX) sample existing call outcomes from those services rather than firing fresh requests — we don't add API call volume just to monitor.

## UI Surface

### StatusBar dots

Always visible in the existing `StatusBar`, between bot-status and websocket-connectivity indicators:

- One dot per probe, color: `ok` green / `warn` amber / `red` red / `needs_human` dark red / `unknown` grey.
- Hover tooltip: probe name + last-probe time + last-error message if any.
- Click: routes to `/health`.
- A "rollup" dot to the left summarizes worst-state across all probes — the at-a-glance signal.

### Health tab

New nav entry at `/health`, between Backtest and Symbol Detail in `App.tsx` routes:

- One row per probe. Columns: name, status, last-probe age, last-ok age, last-error message, recovery-attempt count, `needs_human` flag.
- Click a row → expands a 200-event history sparkline showing transitions over the recent window. Helps spot flapping ("scraper green/red/green/red every 90s = something wrong with the page").
- Footer: **Reset all `needs_human` flags** button — calls `POST /api/ops/health/reset`.

The dots and tab share the same underlying snapshot from `GET /api/ops/health`, so the dashboard auto-updates when WS pushes a new `ops_health` event.

## Components

### `opsMonitorService.ts`

```ts
class OpsMonitorService {
  private probeStates: Map<string, ProbeState>;
  private history: ProbeEvent[];           // ring, 200 entries
  private timer: NodeJS.Timeout | null;
  private emitter: EventEmitter;            // 'update' fires after each tick

  start(): void;                            // begins the 30s loop
  stop(): void;
  getSnapshot(): ProbeResult[];
  getHistory(name: string): ProbeEvent[];
  reset(): void;                            // clears needs_human flags
  onUpdate(listener: (snap) => void): () => void;
}
```

Each probe is a function `(prevState: ProbeState) => Promise<ProbeResult>`. The service holds per-probe state (last probe time, consecutive-failure counter, recovery-attempt counter, last-recovery-time) and threads it through.

### Recovery action wiring

A probe whose recovery action is "stop + start service X" doesn't import service X directly — it goes through a small `recoveryRegistry` keyed by probe name. The registry is initialized at startup with handles into `tickerBotService`, `moderatorAlertService`, etc. This keeps `opsMonitorService` decoupled from individual scrapers and makes it trivial to test (the registry is just a `Map<string, () => Promise<void>>`).

### `rawStreamService` integration

Add a `bindOpsMonitorService(monitor: OpsMonitorService)` method analogous to the existing `bindModeratorAlertService`. It subscribes to `monitor.onUpdate` and emits `ops_health` events on the WS stream. Reuses the existing event-id / Last-Event-ID replay buffer.

## Data flow

```
30s tick
  │
  ├── for each probe:
  │     ProbeFn(prevState) → ProbeResult
  │       (inside try/catch — throw → status: 'red')
  │
  ├── for each probe whose status is 'red':
  │     if cooldown not elapsed → skip recovery
  │     elif consecutive failures >= 3 → mark needs_human
  │     else → invoke recoveryRegistry[probe.name](), bump counters
  │
  ├── append diff entries to 200-event ring
  ├── emit 'update' on internal emitter
  └── rawStreamService picks it up → ops_health WS event
```

## Error handling

- Each probe wraps its own logic in try/catch; throwing means the probe loop flags `red` with `err.message` in the result. One bad probe never breaks others — `Promise.allSettled` for the fan-out.
- Recovery actions wrapped in their own try/catch. A throwing recovery increments the failure counter just like a non-throwing recovery that didn't actually restore service.
- The probe loop itself runs inside try/catch so an unexpected exception in `tick()` doesn't stop the timer.
- Probe results are immutable; per-tick state mutations happen on the per-probe `ProbeState` map keyed by name.

## Testing

Single test file: `opsMonitorService.test.ts`. Covers:

- Each probe's threshold logic with mocked service-snapshot inputs (e.g. `{lastSync: <90s ago>}` → ok; `<200s ago>` → red).
- Cooldown — a second recovery attempt within 5 min is blocked.
- Escalation — 3 consecutive failures trip `needs_human`.
- Reset — `needs_human` flag clears via `reset()`.
- One bad probe doesn't break the others (one throws, rest produce results).

StatusBar rollup is a pure function (`worst-of-states`); one small frontend test for the reduction.

No browser automation tests for the Health tab itself — the page is thin (a table + a sparkline).

## Phasing for a single PR

1. `opsMonitorService.ts` + 12 probes + recovery registry + `/api/ops/health` + `/api/ops/health/history` + `/api/ops/health/reset` endpoints.
2. WS event kind `ops_health` wired through `rawStreamService`.
3. `StatusBar` dots + rollup.
4. `HealthPage.tsx` + nav entry in `App.tsx`.
5. Tests for (1).

Single PR. Estimated 600–800 lines including tests.

## Risks & open questions

1. **False positives on transient failures.** Polygon's 429 rate-limit window can briefly look indistinguishable from a real outage. Mitigation: probes 9 & 10 use a rolling-window threshold (5 of 10), not first-failure. If false positives still bite, raise the window to 10 of 20.
2. **Recovery action that doesn't actually recover.** If `tickerBotService.start()` claims success but the page is still broken, the probe stays red and hits escalation — by design. Operator sees `needs_human`, intervenes.
3. **`ops_health` event volume.** WS clients see one event per probe per 30s × 12 probes = 24 events/min. Diff-only emission (only if state changed) cuts this to near-zero in the steady state. Implementation should diff per-probe before emitting.
4. **What counts as a successful recovery?** Decision: the probe must transition to `ok` on the cycle immediately following the recovery attempt. Anything later doesn't reset the consecutive-failure counter.

## Future work (out of scope for this spec)

- Outbound alerting (Slack webhook, email) when `needs_human` fires while the operator isn't at the dashboard.
- Auto-restarting the entire backend when N+ probes are red simultaneously (drastic, but a useful escape valve).
- Persisting probe history to recordings for retrospective debugging across days.
- Probe-cadence overrides per probe (some, like sector hotness, only need to be checked every 5 min).
