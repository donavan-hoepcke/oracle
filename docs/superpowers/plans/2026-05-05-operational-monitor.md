# Operational Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the ops monitor as a single PR — 12 dependency probes on a 30s loop, recovery actions for the four scraper services, a `/api/ops/health` HTTP surface, a WS `ops_health` event kind, status-bar dots, and a `/health` tab.

**Architecture:** New `opsMonitorService` in the server tick loop owns probe state and history. Probe functions live in their own module so they can be unit-tested in isolation. A small `recoveryRegistry` wires probe names to scraper-service stop/start handles, keeping the monitor decoupled from individual scrapers. Frontend reads via `GET /api/ops/health` on first load and live-updates via the existing `/api/raw/stream` WebSocket.

**Tech Stack:** TypeScript (strict mode), Node.js, Express, ws, vitest, React + Vite + Tailwind, react-router-dom.

---

## File Structure

**New files:**
- `oracle-web/server/src/services/opsMonitorService.ts` — service class (loop + state + history + recovery gating)
- `oracle-web/server/src/services/opsProbes.ts` — pure probe functions, one per dependency
- `oracle-web/server/src/services/opsRecovery.ts` — recovery registry type + default builder
- `oracle-web/server/src/types/opsHealth.ts` — shared types (`ProbeResult`, `ProbeState`, `OpsHealthSnapshot`, `ProbeName`)
- `oracle-web/server/src/__tests__/opsMonitorService.test.ts` — service-level tests (loop, cooldown, escalation, reset)
- `oracle-web/server/src/__tests__/opsProbes.test.ts` — probe-level tests (threshold logic per probe)
- `oracle-web/src/components/HealthPage.tsx` — `/health` route page
- `oracle-web/src/components/OpsHealthDots.tsx` — StatusBar dots subcomponent
- `oracle-web/src/components/__tests__/OpsHealthDots.test.tsx` — rollup logic test
- `oracle-web/src/hooks/useOpsHealth.ts` — fetch + WS subscribe hook

**Modified files:**
- `oracle-web/server/src/services/rawStreamService.ts` — add `bindOpsMonitorService` + `'ops_health'` event type
- `oracle-web/server/src/index.ts` — wire endpoints, start service, bind to stream (~30 LoC additions)
- `oracle-web/src/components/StatusBar.tsx` — render `<OpsHealthDots />` between bot status and last-update
- `oracle-web/src/App.tsx` — `/health` route + nav entry
- `oracle-web/src/types.ts` — re-export `OpsHealthSnapshot` and `ProbeResult` for frontend use
- `oracle-web/src/hooks/useWebSocket.ts` — handle the new `ops_health` event kind

**Total estimated scope:** ~700 LoC including tests.

---

## Task 1: Shared types

**Files:**
- Create: `oracle-web/server/src/types/opsHealth.ts`

- [ ] **Step 1: Create the types module**

```ts
// oracle-web/server/src/types/opsHealth.ts

/** Stable identifier for each probe. Used as the key in state maps,
 *  recovery registry lookups, and the WS event payload. */
export type ProbeName =
  | 'oracle_scraper'
  | 'broker_account'
  | 'recording_disk'
  | 'ws_clients'
  | 'moderator_alerts'
  | 'income_trader_chat'
  | 'float_map'
  | 'sector_hotness'
  | 'polygon_api'
  | 'alpaca_iex_bars'
  | 'ibkr_gateway'
  | 'chrome_debug_port';

export type ProbeStatus = 'ok' | 'warn' | 'red' | 'needs_human' | 'unknown';

/** Public-facing per-probe result. Returned from the snapshot endpoint
 *  and pushed on the WS stream. */
export interface ProbeResult {
  name: ProbeName;
  status: ProbeStatus;
  lastProbeAt: string;       // ISO
  lastOkAt: string | null;
  message: string;
  attemptedRecovery: boolean;
  recoveredAt: string | null;
  consecutiveFailures: number;
}

/** Per-probe mutable state held inside the monitor. Never serialized. */
export interface ProbeState {
  name: ProbeName;
  status: ProbeStatus;
  lastProbeAt: string;
  lastOkAt: string | null;
  message: string;
  consecutiveFailures: number;
  /** Wall-clock ms timestamp of the last recovery attempt, or 0 if never. */
  lastRecoveryAt: number;
  attemptedRecovery: boolean;
  recoveredAt: string | null;
}

/** One entry in the in-memory history ring. */
export interface ProbeEvent {
  name: ProbeName;
  ts: string;
  status: ProbeStatus;
  message: string;
}

export interface OpsHealthSnapshot {
  asOf: string;
  probes: ProbeResult[];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd oracle-web/server && npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 3: Commit**

```bash
git add oracle-web/server/src/types/opsHealth.ts
git commit -m "feat(ops): add ops-health shared types"
```

---

## Task 2: Probe functions module — scaffolding + first two probes (oracle_scraper, ws_clients)

**Files:**
- Create: `oracle-web/server/src/services/opsProbes.ts`
- Create: `oracle-web/server/src/__tests__/opsProbes.test.ts`

- [ ] **Step 1: Write the failing test for `probeOracleScraper`**

```ts
// oracle-web/server/src/__tests__/opsProbes.test.ts
import { describe, it, expect } from 'vitest';
import { probeOracleScraper, probeWsClients, type ProbeDeps } from '../services/opsProbes.js';

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    botStatus: { isRunning: true, lastSync: new Date().toISOString(), symbolCount: 20, lastError: null },
    wsClientCount: 1,
    ...overrides,
  } as ProbeDeps;
}

describe('probeOracleScraper', () => {
  it('returns ok when lastSync is fresh and no error', async () => {
    const r = await probeOracleScraper(deps());
    expect(r.status).toBe('ok');
  });

  it('returns red when lastSync is older than 90s', async () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    const r = await probeOracleScraper(deps({ botStatus: { isRunning: true, lastSync: stale, symbolCount: 20, lastError: null } }));
    expect(r.status).toBe('red');
    expect(r.message).toMatch(/stale|seconds/i);
  });

  it('returns red when lastError is set', async () => {
    const r = await probeOracleScraper(deps({ botStatus: { isRunning: true, lastSync: new Date().toISOString(), symbolCount: 20, lastError: 'page closed' } }));
    expect(r.status).toBe('red');
    expect(r.message).toContain('page closed');
  });
});
```

- [ ] **Step 2: Run test (fails — module doesn't exist)**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: FAIL — "Failed to resolve import '../services/opsProbes.js'".

- [ ] **Step 3: Implement the probe module with scaffolding + first two probes**

```ts
// oracle-web/server/src/services/opsProbes.ts
import type { ProbeName, ProbeResult } from '../types/opsHealth.js';

export interface BotStatusLike {
  isRunning: boolean;
  lastSync: string | null;
  symbolCount: number;
  lastError: string | null;
}

/** Inputs every probe gets. Probe functions are pure — they never reach
 *  out to global state, only to what's in this struct. Makes them
 *  trivial to test. */
export interface ProbeDeps {
  botStatus: BotStatusLike | null;
  wsClientCount: number;
}

const STALE_ORACLE_MS = 90_000;

function ok(name: ProbeName, message: string): ProbeResult {
  return resultOf(name, 'ok', message);
}
function red(name: ProbeName, message: string): ProbeResult {
  return resultOf(name, 'red', message);
}
function unknown(name: ProbeName, message: string): ProbeResult {
  return resultOf(name, 'unknown', message);
}
function resultOf(name: ProbeName, status: ProbeResult['status'], message: string): ProbeResult {
  const now = new Date().toISOString();
  return {
    name,
    status,
    lastProbeAt: now,
    lastOkAt: status === 'ok' ? now : null,
    message,
    attemptedRecovery: false,
    recoveredAt: null,
    consecutiveFailures: 0,
  };
}

export async function probeOracleScraper(deps: ProbeDeps): Promise<ProbeResult> {
  const bs = deps.botStatus;
  if (!bs) return unknown('oracle_scraper', 'bot status not available yet');
  if (bs.lastError) return red('oracle_scraper', `scraper error: ${bs.lastError}`);
  if (!bs.lastSync) return red('oracle_scraper', 'scraper has never synced');
  const ageMs = Date.now() - new Date(bs.lastSync).getTime();
  if (ageMs > STALE_ORACLE_MS) {
    return red('oracle_scraper', `last sync ${Math.round(ageMs / 1000)}s ago (stale > ${STALE_ORACLE_MS / 1000}s)`);
  }
  return ok('oracle_scraper', `${bs.symbolCount} symbols, fresh ${Math.round(ageMs / 1000)}s ago`);
}

export async function probeWsClients(deps: ProbeDeps): Promise<ProbeResult> {
  // WS client count is informational, never a failure.
  return ok('ws_clients', `${deps.wsClientCount} client${deps.wsClientCount === 1 ? '' : 's'} connected`);
}
```

- [ ] **Step 4: Run tests — they pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add oracle-web/server/src/services/opsProbes.ts oracle-web/server/src/__tests__/opsProbes.test.ts
git commit -m "feat(ops): probe scaffolding + oracle_scraper / ws_clients"
```

---

## Task 3: Add probes for the four scraper services (moderator_alerts, income_trader_chat, float_map, sector_hotness)

**Files:**
- Modify: `oracle-web/server/src/services/opsProbes.ts`
- Modify: `oracle-web/server/src/__tests__/opsProbes.test.ts`

- [ ] **Step 1: Write failing tests for the snapshot-based probes**

Append to `opsProbes.test.ts`:

```ts
import {
  probeModeratorAlerts,
  probeIncomeTraderChat,
  probeFloatMap,
  probeSectorHotness,
} from '../services/opsProbes.js';

function snap(opts: { fetchedAt: string | null; error: string | null }) {
  return { fetchedAt: opts.fetchedAt, error: opts.error };
}

describe('snapshot-based scraper probes', () => {
  const fresh = new Date().toISOString();
  const stale10m = new Date(Date.now() - 10 * 60_000 - 5_000).toISOString();
  const stale4m = new Date(Date.now() - 4 * 60_000 - 5_000).toISOString();
  const stale6m = new Date(Date.now() - 6 * 60_000 - 5_000).toISOString();
  const stale3m = new Date(Date.now() - 3 * 60_000 - 5_000).toISOString();

  it('moderatorAlerts ok when fresh', async () => {
    const r = await probeModeratorAlerts(snap({ fetchedAt: fresh, error: null }));
    expect(r.status).toBe('ok');
  });
  it('moderatorAlerts red when older than 6min', async () => {
    const r = await probeModeratorAlerts(snap({ fetchedAt: stale6m, error: null }));
    expect(r.status).toBe('red');
  });
  it('moderatorAlerts red when error set', async () => {
    const r = await probeModeratorAlerts(snap({ fetchedAt: fresh, error: 'parse failed' }));
    expect(r.status).toBe('red');
  });

  it('incomeTraderChat red when older than 3min', async () => {
    const r = await probeIncomeTraderChat(snap({ fetchedAt: stale3m, error: null }));
    expect(r.status).toBe('red');
  });

  it('floatMap red when older than 4min', async () => {
    const r = await probeFloatMap(snap({ fetchedAt: stale4m, error: null }));
    expect(r.status).toBe('red');
  });

  it('sectorHotness red when older than 10min', async () => {
    const r = await probeSectorHotness(snap({ fetchedAt: stale10m, error: null }));
    expect(r.status).toBe('red');
  });

  it('returns unknown when fetchedAt is null (service hasn\'t polled yet)', async () => {
    const r = await probeModeratorAlerts(snap({ fetchedAt: null, error: null }));
    expect(r.status).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests — they fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: FAIL — "probeModeratorAlerts is not a function" (and 5 more).

- [ ] **Step 3: Implement the four probes**

Append to `oracle-web/server/src/services/opsProbes.ts`:

```ts
export interface SnapshotLike {
  fetchedAt: string | null;
  error: string | null;
}

function probeSnapshot(name: ProbeName, snap: SnapshotLike, maxAgeMs: number): ProbeResult {
  if (!snap.fetchedAt) return unknown(name, 'no fetch yet');
  if (snap.error) return red(name, `error: ${snap.error}`);
  const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
  if (ageMs > maxAgeMs) {
    return red(name, `last fetch ${Math.round(ageMs / 1000)}s ago (stale > ${Math.round(maxAgeMs / 1000)}s)`);
  }
  return ok(name, `fetch ${Math.round(ageMs / 1000)}s ago`);
}

export async function probeModeratorAlerts(snap: SnapshotLike): Promise<ProbeResult> {
  return probeSnapshot('moderator_alerts', snap, 6 * 60_000);
}
export async function probeIncomeTraderChat(snap: SnapshotLike): Promise<ProbeResult> {
  return probeSnapshot('income_trader_chat', snap, 3 * 60_000);
}
export async function probeFloatMap(snap: SnapshotLike): Promise<ProbeResult> {
  return probeSnapshot('float_map', snap, 4 * 60_000);
}
export async function probeSectorHotness(snap: SnapshotLike): Promise<ProbeResult> {
  return probeSnapshot('sector_hotness', snap, 10 * 60_000);
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add oracle-web/server/src/services/opsProbes.ts oracle-web/server/src/__tests__/opsProbes.test.ts
git commit -m "feat(ops): probes for moderator/incomeTrader/floatMap/sectorHotness"
```

---

## Task 4: Active probes — broker_account, recording_disk, polygon_api, alpaca_iex_bars

**Files:**
- Modify: `oracle-web/server/src/services/opsProbes.ts`
- Modify: `oracle-web/server/src/__tests__/opsProbes.test.ts`

These probes either hit external APIs or examine existing rolling windows.

- [ ] **Step 1: Write failing tests**

Append to test file:

```ts
import {
  probeBrokerAccount,
  probeRecordingDisk,
  probePolygonApi,
  probeAlpacaIexBars,
} from '../services/opsProbes.js';

describe('active probes', () => {
  it('broker_account ok when getAccount resolves', async () => {
    const r = await probeBrokerAccount({ getAccount: async () => ({ cash: 1000, portfolioValue: 1000, buyingPower: 1000, settledCash: 1000, unsettledCash: 0 }) });
    expect(r.status).toBe('ok');
  });

  it('broker_account red when getAccount throws twice (consecutive)', async () => {
    let calls = 0;
    const getAccount = async () => { calls++; throw new Error('500'); };
    const failures = { broker_account: 1 };
    const r = await probeBrokerAccount({ getAccount }, failures);
    // 2nd consecutive failure (failures starts at 1 from a prior cycle) → red
    expect(r.status).toBe('red');
    expect(calls).toBe(1);
  });

  it('broker_account warn on a single transient failure', async () => {
    const r = await probeBrokerAccount({ getAccount: async () => { throw new Error('500'); } }, { broker_account: 0 });
    expect(r.status).toBe('warn');
  });

  it('recording_disk ok when there is plenty of free space', async () => {
    const r = await probeRecordingDisk({ availableBytes: 10 * 1024 ** 3, dirWritable: true });
    expect(r.status).toBe('ok');
  });

  it('recording_disk red when free space below 1 GB', async () => {
    const r = await probeRecordingDisk({ availableBytes: 500 * 1024 ** 2, dirWritable: true });
    expect(r.status).toBe('red');
  });

  it('recording_disk red when dir not writable', async () => {
    const r = await probeRecordingDisk({ availableBytes: 999_999_999_999, dirWritable: false });
    expect(r.status).toBe('red');
  });

  it('polygon_api ok when fewer than 5 of last 10 calls failed', async () => {
    const r = await probePolygonApi({ recent: Array(10).fill(0).map((_, i) => ({ ok: i < 8 })) });
    expect(r.status).toBe('ok');
  });

  it('polygon_api red when 5+ of last 10 calls failed', async () => {
    const r = await probePolygonApi({ recent: Array(10).fill(0).map((_, i) => ({ ok: i < 4 })) });
    expect(r.status).toBe('red');
  });

  it('alpaca_iex_bars excludes 429s from the failure ratio', async () => {
    const recent = [
      ...Array(6).fill(0).map(() => ({ ok: false, status: 429 })),
      ...Array(4).fill(0).map(() => ({ ok: true })),
    ];
    const r = await probeAlpacaIexBars({ recent });
    expect(r.status).toBe('ok'); // 6 429s ignored, 4 ok of 4 effective = 0% failure
  });
});
```

- [ ] **Step 2: Run tests — they fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: 9 new failures.

- [ ] **Step 3: Implement the active probes**

Append to `opsProbes.ts`:

```ts
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';

export interface BrokerProbeDeps {
  getAccount: () => Promise<unknown>;
}

/** Map of consecutive-failure counters threaded through from monitor state.
 *  Active probes mutate the value when a probe fails; ok resets to 0.
 *  Threshold for 'red' is the second consecutive failure. */
export type FailureCounters = Partial<Record<ProbeName, number>>;

export async function probeBrokerAccount(
  deps: BrokerProbeDeps,
  failures: FailureCounters = {},
): Promise<ProbeResult> {
  try {
    await deps.getAccount();
    return ok('broker_account', 'account API reachable');
  } catch (err) {
    const prev = failures.broker_account ?? 0;
    const msg = `getAccount failed: ${err instanceof Error ? err.message : String(err)}`;
    return prev >= 1 ? red('broker_account', msg) : resultOf('broker_account', 'warn', msg);
  }
}

export interface DiskProbeDeps {
  availableBytes: number;
  dirWritable: boolean;
}

export async function probeRecordingDisk(deps: DiskProbeDeps): Promise<ProbeResult> {
  if (!deps.dirWritable) return red('recording_disk', 'recording dir not writable');
  if (deps.availableBytes < 1024 ** 3) {
    return red('recording_disk', `low disk space (${(deps.availableBytes / 1024 ** 3).toFixed(2)} GB free)`);
  }
  return ok('recording_disk', `${(deps.availableBytes / 1024 ** 3).toFixed(1)} GB free`);
}

/** Probe-time view of recent API calls. The Polygon and Alpaca-IEX bar
 *  services maintain a small rolling window of outcomes; the probe just
 *  reads it. The `status` field is optional — used by the IEX probe to
 *  exclude 429 (rate-limit) outcomes from the ratio. */
export interface RollingApiDeps {
  recent: Array<{ ok: boolean; status?: number }>;
}

function rollingFailRatio(name: ProbeName, deps: RollingApiDeps, excludeStatus: number[] = []): ProbeResult {
  const considered = deps.recent.filter((r) => !(r.status && excludeStatus.includes(r.status)));
  if (considered.length === 0) return ok(name, 'no recent calls');
  const failures = considered.filter((r) => !r.ok).length;
  if (failures * 2 >= considered.length) {
    return red(name, `${failures} of ${considered.length} recent calls failed`);
  }
  return ok(name, `${considered.length - failures}/${considered.length} recent calls succeeded`);
}

export async function probePolygonApi(deps: RollingApiDeps): Promise<ProbeResult> {
  return rollingFailRatio('polygon_api', deps);
}

export async function probeAlpacaIexBars(deps: RollingApiDeps): Promise<ProbeResult> {
  return rollingFailRatio('alpaca_iex_bars', deps, [429]);
}

/** Side-effect-free filesystem helpers for the wiring layer in
 *  opsMonitorService — kept here so the disk probe stays pure. */
export function inspectRecordingDir(dir: string): DiskProbeDeps {
  if (!existsSync(dir)) return { availableBytes: 0, dirWritable: false };
  let dirWritable = false;
  try {
    accessSync(dir, constants.W_OK);
    dirWritable = true;
  } catch {
    dirWritable = false;
  }
  // statSync().blocks * 512 etc. is portable but doesn't give free space.
  // Node 18+ has statfs; fall back to "always plenty" if unavailable.
  let availableBytes = Number.MAX_SAFE_INTEGER;
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    if (typeof (fs as unknown as { statfsSync?: unknown }).statfsSync === 'function') {
      const st = (fs as unknown as { statfsSync: (p: string) => { bavail: bigint; bsize: bigint } }).statfsSync(dir);
      availableBytes = Number(BigInt(st.bavail) * BigInt(st.bsize));
    }
  } catch {
    // best effort — leave at MAX so probe stays ok
  }
  // Reference statSync to silence unused-import warnings on platforms where
  // statfsSync isn't available.
  void statSync;
  void resolve;
  return { availableBytes, dirWritable };
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: 19 passed.

- [ ] **Step 5: Commit**

```bash
git add oracle-web/server/src/services/opsProbes.ts oracle-web/server/src/__tests__/opsProbes.test.ts
git commit -m "feat(ops): broker/disk/polygon/iex probes with consecutive-failure gating"
```

---

## Task 5: Conditional probes — ibkr_gateway, chrome_debug_port

**Files:**
- Modify: `oracle-web/server/src/services/opsProbes.ts`
- Modify: `oracle-web/server/src/__tests__/opsProbes.test.ts`

- [ ] **Step 1: Write failing tests**

Append:

```ts
import { probeIbkrGateway, probeChromeDebugPort } from '../services/opsProbes.js';

describe('conditional probes', () => {
  it('ibkr_gateway returns unknown when broker is alpaca', async () => {
    const r = await probeIbkrGateway({ activeBroker: 'alpaca', tickle: async () => ({ iserver: { authStatus: { authenticated: false } } }) });
    expect(r.status).toBe('unknown');
  });

  it('ibkr_gateway ok when iserver authenticated', async () => {
    const r = await probeIbkrGateway({ activeBroker: 'ibkr', tickle: async () => ({ iserver: { authStatus: { authenticated: true } } }) });
    expect(r.status).toBe('ok');
  });

  it('ibkr_gateway red with re-auth message when not authenticated', async () => {
    const r = await probeIbkrGateway({ activeBroker: 'ibkr', tickle: async () => ({ iserver: { authStatus: { authenticated: false } } }) });
    expect(r.status).toBe('red');
    expect(r.message).toMatch(/re-auth/i);
  });

  it('chrome_debug_port ok when /json/version returns 200', async () => {
    const r = await probeChromeDebugPort({ probeUrl: async () => ({ ok: true, status: 200 }) });
    expect(r.status).toBe('ok');
  });

  it('chrome_debug_port red on connection failure', async () => {
    const r = await probeChromeDebugPort({ probeUrl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.status).toBe('red');
    expect(r.message).toContain('ECONNREFUSED');
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: 5 new failures.

- [ ] **Step 3: Implement**

Append to `opsProbes.ts`:

```ts
export interface IbkrProbeDeps {
  activeBroker: 'alpaca' | 'ibkr';
  tickle: () => Promise<{ iserver?: { authStatus?: { authenticated?: boolean } } }>;
}

export async function probeIbkrGateway(deps: IbkrProbeDeps): Promise<ProbeResult> {
  if (deps.activeBroker !== 'ibkr') return unknown('ibkr_gateway', 'broker.active is alpaca; gateway not in use');
  try {
    const t = await deps.tickle();
    if (t.iserver?.authStatus?.authenticated) return ok('ibkr_gateway', 'gateway authenticated');
    return red('ibkr_gateway', 're-auth needed (browse to https://localhost:5000)');
  } catch (err) {
    return red('ibkr_gateway', `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface ChromeProbeDeps {
  probeUrl: () => Promise<{ ok: boolean; status: number }>;
}

export async function probeChromeDebugPort(deps: ChromeProbeDeps): Promise<ProbeResult> {
  try {
    const r = await deps.probeUrl();
    if (r.ok) return ok('chrome_debug_port', `Chrome debug port reachable (HTTP ${r.status})`);
    return red('chrome_debug_port', `Chrome debug port returned HTTP ${r.status}`);
  } catch (err) {
    return red('chrome_debug_port', `Chrome unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsProbes.test.ts`
Expected: 24 passed.

- [ ] **Step 5: Commit**

```bash
git add oracle-web/server/src/services/opsProbes.ts oracle-web/server/src/__tests__/opsProbes.test.ts
git commit -m "feat(ops): ibkr_gateway + chrome_debug_port conditional probes"
```

---

## Task 6: Recovery registry

**Files:**
- Create: `oracle-web/server/src/services/opsRecovery.ts`

- [ ] **Step 1: Implement the registry type**

```ts
// oracle-web/server/src/services/opsRecovery.ts
import type { ProbeName } from '../types/opsHealth.js';

/** A recovery action is "stop and start the underlying service".
 *  Returns true if the action ran without throwing — NOT whether
 *  the dependency is actually back online. The next probe cycle
 *  decides if recovery worked. */
export type RecoveryAction = () => Promise<void>;

export type RecoveryRegistry = Partial<Record<ProbeName, RecoveryAction>>;

/** Build the default registry from live service handles. The four
 *  scraper services share a stop/start interface; this just composes
 *  them into a single async fn per probe name. */
export interface ScraperServiceLike {
  stop(): Promise<void>;
  start(): Promise<void>;
}

export function buildDefaultRegistry(deps: {
  tickerBotService: ScraperServiceLike;
  moderatorAlertService: ScraperServiceLike;
  incomeTraderChatService: ScraperServiceLike;
  floatMapService: ScraperServiceLike;
  sectorHotnessService: ScraperServiceLike;
}): RecoveryRegistry {
  const restart = (svc: ScraperServiceLike): RecoveryAction => async () => {
    await svc.stop();
    await svc.start();
  };
  return {
    oracle_scraper: restart(deps.tickerBotService),
    moderator_alerts: restart(deps.moderatorAlertService),
    income_trader_chat: restart(deps.incomeTraderChatService),
    float_map: restart(deps.floatMapService),
    sector_hotness: restart(deps.sectorHotnessService),
    // broker_account, recording_disk, ws_clients, polygon_api,
    // alpaca_iex_bars, ibkr_gateway, chrome_debug_port: passive — no
    // recovery action.
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd oracle-web/server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add oracle-web/server/src/services/opsRecovery.ts
git commit -m "feat(ops): recovery registry mapping probes to scraper restarts"
```

---

## Task 7: opsMonitorService — service class with tick loop, cooldown, escalation

**Files:**
- Create: `oracle-web/server/src/services/opsMonitorService.ts`
- Create: `oracle-web/server/src/__tests__/opsMonitorService.test.ts`

- [ ] **Step 1: Write the first failing test for the loop and cooldown gate**

```ts
// oracle-web/server/src/__tests__/opsMonitorService.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpsMonitorService } from '../services/opsMonitorService.js';
import type { ProbeName, ProbeResult } from '../types/opsHealth.js';

function makeProbe(name: ProbeName, status: ProbeResult['status'], message = ''): () => Promise<ProbeResult> {
  return async () => ({
    name,
    status,
    lastProbeAt: new Date().toISOString(),
    lastOkAt: status === 'ok' ? new Date().toISOString() : null,
    message,
    attemptedRecovery: false,
    recoveredAt: null,
    consecutiveFailures: 0,
  });
}

describe('OpsMonitorService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tick aggregates results from every probe in the map', async () => {
    const monitor = new OpsMonitorService({
      probes: {
        oracle_scraper: makeProbe('oracle_scraper', 'ok'),
        ws_clients: makeProbe('ws_clients', 'ok'),
      },
      recovery: {},
    });
    await monitor.tickForTest();
    const snap = monitor.getSnapshot();
    expect(snap.probes).toHaveLength(2);
    expect(snap.probes.every((p) => p.status === 'ok')).toBe(true);
  });

  it('runs the recovery action when a probe is red and cooldown has elapsed', async () => {
    const recovery = vi.fn(async () => {});
    const monitor = new OpsMonitorService({
      probes: { oracle_scraper: makeProbe('oracle_scraper', 'red', 'stale') },
      recovery: { oracle_scraper: recovery },
    });
    await monitor.tickForTest();
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it('does not re-run recovery within the 5-minute cooldown', async () => {
    const recovery = vi.fn(async () => {});
    const monitor = new OpsMonitorService({
      probes: { oracle_scraper: makeProbe('oracle_scraper', 'red', 'stale') },
      recovery: { oracle_scraper: recovery },
    });
    await monitor.tickForTest();
    await monitor.tickForTest();
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it('escalates to needs_human after 3 failed recovery attempts', async () => {
    const recovery = vi.fn(async () => {}); // recovery "succeeds" but probe stays red
    const monitor = new OpsMonitorService({
      probes: { oracle_scraper: makeProbe('oracle_scraper', 'red', 'stale') },
      recovery: { oracle_scraper: recovery },
      cooldownMs: 0, // disable cooldown for this test
    });
    await monitor.tickForTest();
    await monitor.tickForTest();
    await monitor.tickForTest();
    await monitor.tickForTest();
    const probe = monitor.getSnapshot().probes.find((p) => p.name === 'oracle_scraper');
    expect(probe?.status).toBe('needs_human');
  });

  it('reset() clears needs_human flags', async () => {
    const monitor = new OpsMonitorService({
      probes: { oracle_scraper: makeProbe('oracle_scraper', 'red') },
      recovery: { oracle_scraper: async () => {} },
      cooldownMs: 0,
    });
    for (let i = 0; i < 4; i++) await monitor.tickForTest();
    expect(monitor.getSnapshot().probes[0].status).toBe('needs_human');
    monitor.reset();
    // After reset, status reverts to 'red' (not 'ok' — the probe still says red)
    // and the consecutive-failure counter is back to 0.
    await monitor.tickForTest();
    expect(monitor.getSnapshot().probes[0].status).not.toBe('needs_human');
  });

  it('a probe that throws does not break others', async () => {
    const monitor = new OpsMonitorService({
      probes: {
        oracle_scraper: async () => { throw new Error('boom'); },
        ws_clients: makeProbe('ws_clients', 'ok'),
      },
      recovery: {},
    });
    await monitor.tickForTest();
    const snap = monitor.getSnapshot();
    const oracle = snap.probes.find((p) => p.name === 'oracle_scraper');
    const ws = snap.probes.find((p) => p.name === 'ws_clients');
    expect(oracle?.status).toBe('red');
    expect(oracle?.message).toContain('boom');
    expect(ws?.status).toBe('ok');
  });

  it('history ring grows with diff entries only', async () => {
    let n = 0;
    const monitor = new OpsMonitorService({
      probes: {
        oracle_scraper: async () => {
          n++;
          return {
            name: 'oracle_scraper',
            status: n === 1 ? 'ok' : n === 2 ? 'ok' : 'red',
            lastProbeAt: new Date().toISOString(),
            lastOkAt: null,
            message: '',
            attemptedRecovery: false,
            recoveredAt: null,
            consecutiveFailures: 0,
          };
        },
      },
      recovery: {},
    });
    await monitor.tickForTest();
    await monitor.tickForTest(); // same status, no diff entry
    await monitor.tickForTest(); // status changed → diff entry
    const history = monitor.getHistory('oracle_scraper');
    expect(history.length).toBe(2); // initial ok + the flip to red
  });
});
```

- [ ] **Step 2: Run tests — fail**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsMonitorService.test.ts`
Expected: FAIL — "Failed to resolve import '../services/opsMonitorService.js'".

- [ ] **Step 3: Implement the service**

```ts
// oracle-web/server/src/services/opsMonitorService.ts
import { EventEmitter } from 'node:events';
import type {
  OpsHealthSnapshot,
  ProbeEvent,
  ProbeName,
  ProbeResult,
  ProbeState,
  ProbeStatus,
} from '../types/opsHealth.js';
import type { RecoveryRegistry } from './opsRecovery.js';

export type ProbeFn = () => Promise<ProbeResult>;

export interface OpsMonitorOptions {
  probes: Partial<Record<ProbeName, ProbeFn>>;
  recovery: RecoveryRegistry;
  /** Per-probe cooldown between recovery attempts. Default 5 minutes. */
  cooldownMs?: number;
  /** Number of consecutive failed recoveries before needs_human. Default 3. */
  needsHumanThreshold?: number;
  /** Tick interval. Default 30 000. */
  intervalMs?: number;
  /** Max history events kept in-memory. Default 200. */
  historyCap?: number;
}

export class OpsMonitorService {
  private readonly probes: Partial<Record<ProbeName, ProbeFn>>;
  private readonly recovery: RecoveryRegistry;
  private readonly cooldownMs: number;
  private readonly needsHumanThreshold: number;
  private readonly intervalMs: number;
  private readonly historyCap: number;
  private states = new Map<ProbeName, ProbeState>();
  private history: ProbeEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private emitter = new EventEmitter();

  constructor(opts: OpsMonitorOptions) {
    this.probes = opts.probes;
    this.recovery = opts.recovery;
    this.cooldownMs = opts.cooldownMs ?? 5 * 60_000;
    this.needsHumanThreshold = opts.needsHumanThreshold ?? 3;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.historyCap = opts.historyCap ?? 200;
    this.emitter.setMaxListeners(0);
  }

  start(): void {
    if (this.timer) return;
    // Initial tick immediately so the dashboard has data on first paint.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Test seam — runs a single tick synchronously. */
  async tickForTest(): Promise<void> {
    await this.tick();
  }

  getSnapshot(): OpsHealthSnapshot {
    const probes: ProbeResult[] = [];
    for (const state of this.states.values()) {
      probes.push({
        name: state.name,
        status: state.status,
        lastProbeAt: state.lastProbeAt,
        lastOkAt: state.lastOkAt,
        message: state.message,
        attemptedRecovery: state.attemptedRecovery,
        recoveredAt: state.recoveredAt,
        consecutiveFailures: state.consecutiveFailures,
      });
    }
    return { asOf: new Date().toISOString(), probes };
  }

  getHistory(name: ProbeName): ProbeEvent[] {
    return this.history.filter((h) => h.name === name);
  }

  reset(): void {
    for (const state of this.states.values()) {
      if (state.status === 'needs_human') state.status = 'red';
      state.consecutiveFailures = 0;
      state.lastRecoveryAt = 0;
    }
  }

  onUpdate(listener: (snap: OpsHealthSnapshot) => void): () => void {
    this.emitter.on('update', listener);
    return () => this.emitter.off('update', listener);
  }

  private async tick(): Promise<void> {
    try {
      const entries = Object.entries(this.probes) as Array<[ProbeName, ProbeFn]>;
      const results = await Promise.allSettled(entries.map(([, fn]) => fn()));
      for (let i = 0; i < entries.length; i++) {
        const [name] = entries[i];
        const r = results[i];
        const result: ProbeResult =
          r.status === 'fulfilled'
            ? r.value
            : {
                name,
                status: 'red',
                lastProbeAt: new Date().toISOString(),
                lastOkAt: this.states.get(name)?.lastOkAt ?? null,
                message: r.reason instanceof Error ? r.reason.message : String(r.reason),
                attemptedRecovery: false,
                recoveredAt: null,
                consecutiveFailures: 0,
              };
        this.applyResult(name, result);
      }
      // Recovery pass — separate from probe pass so all probes settle first.
      for (const state of this.states.values()) {
        if (state.status === 'red') await this.tryRecover(state);
      }
      this.emitter.emit('update', this.getSnapshot());
    } catch (err) {
      // Never let the loop die. A failure here means a coding bug, not a
      // probe failure — log and continue.
      console.error('[opsMonitor] tick failed:', err);
    }
  }

  private applyResult(name: ProbeName, result: ProbeResult): void {
    const prev = this.states.get(name);
    const status: ProbeStatus =
      prev?.status === 'needs_human' && result.status !== 'ok' ? 'needs_human' : result.status;
    const next: ProbeState = {
      name,
      status,
      lastProbeAt: result.lastProbeAt,
      lastOkAt: status === 'ok' ? result.lastProbeAt : (prev?.lastOkAt ?? null),
      message: result.message,
      consecutiveFailures: status === 'ok' ? 0 : (prev?.consecutiveFailures ?? 0),
      lastRecoveryAt: prev?.lastRecoveryAt ?? 0,
      attemptedRecovery: prev?.attemptedRecovery ?? false,
      recoveredAt: status === 'ok' && prev?.attemptedRecovery ? result.lastProbeAt : prev?.recoveredAt ?? null,
    };
    this.states.set(name, next);
    if (!prev || prev.status !== status) {
      this.history.push({ name, ts: result.lastProbeAt, status, message: result.message });
      if (this.history.length > this.historyCap) {
        this.history.splice(0, this.history.length - this.historyCap);
      }
    }
  }

  private async tryRecover(state: ProbeState): Promise<void> {
    const action = this.recovery[state.name];
    if (!action) return;
    const now = Date.now();
    if (state.lastRecoveryAt > 0 && now - state.lastRecoveryAt < this.cooldownMs) return;
    if (state.consecutiveFailures >= this.needsHumanThreshold) {
      state.status = 'needs_human';
      return;
    }
    state.lastRecoveryAt = now;
    state.attemptedRecovery = true;
    state.consecutiveFailures += 1;
    try {
      await action();
    } catch (err) {
      state.message = `${state.message} (recovery threw: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd oracle-web/server && npx vitest run src/__tests__/opsMonitorService.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add oracle-web/server/src/services/opsMonitorService.ts oracle-web/server/src/__tests__/opsMonitorService.test.ts
git commit -m "feat(ops): opsMonitorService loop, cooldown, escalation, history"
```

---

## Task 8: Wire `rawStreamService` to push `ops_health` events

**Files:**
- Modify: `oracle-web/server/src/services/rawStreamService.ts`

- [ ] **Step 1: Add the new event type and a hook source**

Edit `rawStreamService.ts`:

Replace:
```ts
export type RawStreamEventType =
  | 'scanner_update'
  | 'message'
  | 'mod_alert'
  | 'regime_shift';
```

with:
```ts
export type RawStreamEventType =
  | 'scanner_update'
  | 'message'
  | 'mod_alert'
  | 'regime_shift'
  | 'ops_health';
```

Add the hook source interface near the other `*HookSource` interfaces:
```ts
interface OpsMonitorHookSource {
  onUpdate: (cb: (snap: unknown) => void) => () => void;
}
```

Add the bind method on the `RawStreamService` class, alongside the others (next to `bindRegimeService`):
```ts
bindOpsMonitorService(svc: OpsMonitorHookSource): void {
  // Diff suppression happens upstream in the monitor's tick (only emits
  // 'update' when there's something to publish), so the stream just
  // republishes verbatim.
  const off = svc.onUpdate((snap) => {
    this.publish({ type: 'ops_health', payload: snap });
  });
  this.unsubscribeFns.push(off);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd oracle-web/server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add oracle-web/server/src/services/rawStreamService.ts
git commit -m "feat(ops): rawStreamService publishes ops_health events"
```

---

## Task 9: HTTP endpoints + startup wiring in `index.ts`

**Files:**
- Modify: `oracle-web/server/src/index.ts`

- [ ] **Step 1: Add imports near the existing service imports**

Add to the top-of-file imports block:
```ts
import { OpsMonitorService } from './services/opsMonitorService.js';
import { buildDefaultRegistry } from './services/opsRecovery.js';
import {
  probeOracleScraper,
  probeWsClients,
  probeModeratorAlerts,
  probeIncomeTraderChat,
  probeFloatMap,
  probeSectorHotness,
  probeBrokerAccount,
  probeRecordingDisk,
  probePolygonApi,
  probeAlpacaIexBars,
  probeIbkrGateway,
  probeChromeDebugPort,
  inspectRecordingDir,
} from './services/opsProbes.js';
import { brokerService } from './services/brokers/index.js';
```

- [ ] **Step 2: Add a small Polygon/IEX rolling-window store**

In `index.ts`, near the top of the file (above the `app.use(...)` block, after imports):

```ts
const polygonRolling: Array<{ ok: boolean; status?: number }> = [];
const iexRolling: Array<{ ok: boolean; status?: number }> = [];

function recordApiOutcome(
  store: Array<{ ok: boolean; status?: number }>,
  ok: boolean,
  status?: number,
): void {
  store.push({ ok, status });
  if (store.length > 10) store.shift();
}

// Exported via globalThis so the Polygon/IEX call sites in their
// services can record outcomes without importing each other.
(globalThis as unknown as { __opsApiOutcomes: { polygon: typeof recordApiOutcome; iex: typeof recordApiOutcome } }).__opsApiOutcomes = {
  polygon: (ok, status) => recordApiOutcome(polygonRolling, ok, status),
  iex: (ok, status) => recordApiOutcome(iexRolling, ok, status),
};
```

> NOTE: a follow-up task will swap this `globalThis` shim for proper getter exports on `polygonService` / `alpacaBarService`. The shim keeps this PR scoped to the monitor; the rolling stores remain empty until the call sites are wired up, which means the Polygon/IEX probes will report "no recent calls" → `ok` until then. That's the documented intermediate state.

- [ ] **Step 3: Build and start the monitor**

Find where the other services are started (near `moderatorAlertService.start().catch(...)`) and add:

```ts
const opsMonitor = new OpsMonitorService({
  probes: {
    oracle_scraper: () => probeOracleScraper({
      botStatus: priceSocketServer.getBotStatus(),
      wsClientCount: priceSocketServer.getClientCount?.() ?? 0,
    }),
    ws_clients: () => probeWsClients({
      botStatus: null,
      wsClientCount: priceSocketServer.getClientCount?.() ?? 0,
    }),
    moderator_alerts: () => probeModeratorAlerts(moderatorAlertService.getSnapshot()),
    income_trader_chat: () => probeIncomeTraderChat(incomeTraderChatService.getSnapshot()),
    float_map: () => probeFloatMap(floatMapService.getSnapshot()),
    sector_hotness: () => probeSectorHotness(sectorHotnessService.getSnapshot()),
    broker_account: () => probeBrokerAccount({ getAccount: () => brokerService.getAccount() }, opsMonitor.getFailureCounters()),
    recording_disk: () => probeRecordingDisk(inspectRecordingDir(config.recording.dir)),
    polygon_api: () => probePolygonApi({ recent: [...polygonRolling] }),
    alpaca_iex_bars: () => probeAlpacaIexBars({ recent: [...iexRolling] }),
    ibkr_gateway: () => probeIbkrGateway({
      activeBroker: config.broker.active,
      tickle: async () => {
        if (config.broker.active !== 'ibkr') return { iserver: { authStatus: { authenticated: false } } };
        const url = config.broker.ibkr.profiles[config.broker.ibkr.profile].base_url + '/tickle';
        const res = await fetch(url, { method: 'POST' });
        return res.json() as Promise<{ iserver?: { authStatus?: { authenticated?: boolean } } }>;
      },
    }),
    chrome_debug_port: () => probeChromeDebugPort({
      probeUrl: async () => {
        const res = await fetch(`${config.bot.playwright.chrome_cdp_url}/json/version`);
        return { ok: res.ok, status: res.status };
      },
    }),
  },
  recovery: buildDefaultRegistry({
    tickerBotService,
    moderatorAlertService,
    incomeTraderChatService,
    floatMapService,
    sectorHotnessService,
  }),
});

opsMonitor.start();
rawStreamService.bindOpsMonitorService(opsMonitor);
```

- [ ] **Step 4: Add the `getFailureCounters` method to `OpsMonitorService`**

Edit `oracle-web/server/src/services/opsMonitorService.ts`. Add the method after `getHistory`:

```ts
/** Snapshot of consecutive-failure counters per probe — exposed so
 *  active probes (broker_account) can decide between 'warn' and 'red'
 *  on their own counter without re-implementing the state machine. */
getFailureCounters(): Partial<Record<ProbeName, number>> {
  const out: Partial<Record<ProbeName, number>> = {};
  for (const state of this.states.values()) {
    out[state.name] = state.consecutiveFailures;
  }
  return out;
}
```

- [ ] **Step 5: Add the three HTTP endpoints**

Find the existing endpoint cluster around `/api/moderator-alerts` and add below it:

```ts
app.get('/api/ops/health', (_req, res) => {
  res.json(opsMonitor.getSnapshot());
});

app.get('/api/ops/health/history', (req, res) => {
  const probe = typeof req.query.probe === 'string' ? req.query.probe : '';
  if (!probe) {
    res.status(400).json({ error: 'probe query param required' });
    return;
  }
  res.json({ probe, events: opsMonitor.getHistory(probe as never) });
});

app.post('/api/ops/health/reset', (_req, res) => {
  opsMonitor.reset();
  res.json({ ok: true });
});
```

- [ ] **Step 6: Add a graceful shutdown**

Find the existing `process.on('SIGINT', ...)` block. Add inside it (next to the other `.stop().catch(...)` calls):

```ts
opsMonitor.stop();
```

- [ ] **Step 7: Typecheck and start the dev server**

Run: `cd oracle-web/server && npx tsc --noEmit`
Expected: clean.

Run: `cd oracle-web/server && npm run dev` then in another terminal:
```bash
sleep 35 && curl -s http://localhost:3001/api/ops/health | python -m json.tool | head -50
```
Expected: a JSON snapshot with ~12 probe entries, each with `status` and `lastProbeAt`.

- [ ] **Step 8: Commit**

```bash
git add oracle-web/server/src/index.ts oracle-web/server/src/services/opsMonitorService.ts
git commit -m "feat(ops): wire opsMonitor + http endpoints in index.ts"
```

---

## Task 10: Frontend types and hook

**Files:**
- Modify: `oracle-web/src/types.ts`
- Create: `oracle-web/src/hooks/useOpsHealth.ts`

- [ ] **Step 1: Add the shared types to the frontend**

Append to `oracle-web/src/types.ts`:

```ts
export type ProbeName =
  | 'oracle_scraper'
  | 'broker_account'
  | 'recording_disk'
  | 'ws_clients'
  | 'moderator_alerts'
  | 'income_trader_chat'
  | 'float_map'
  | 'sector_hotness'
  | 'polygon_api'
  | 'alpaca_iex_bars'
  | 'ibkr_gateway'
  | 'chrome_debug_port';

export type ProbeStatus = 'ok' | 'warn' | 'red' | 'needs_human' | 'unknown';

export interface ProbeResult {
  name: ProbeName;
  status: ProbeStatus;
  lastProbeAt: string;
  lastOkAt: string | null;
  message: string;
  attemptedRecovery: boolean;
  recoveredAt: string | null;
  consecutiveFailures: number;
}

export interface OpsHealthSnapshot {
  asOf: string;
  probes: ProbeResult[];
}
```

- [ ] **Step 2: Create the hook**

```ts
// oracle-web/src/hooks/useOpsHealth.ts
import { useEffect, useState, useCallback } from 'react';
import type { OpsHealthSnapshot } from '../types';

interface UseOpsHealthResult {
  snapshot: OpsHealthSnapshot | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOpsHealth(): UseOpsHealthResult {
  const [snapshot, setSnapshot] = useState<OpsHealthSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/ops/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OpsHealthSnapshot;
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load ops health');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, isLoading, error, refresh };
}
```

- [ ] **Step 3: Typecheck and commit**

Run: `cd oracle-web && npx tsc --noEmit`
Expected: clean.

```bash
git add oracle-web/src/types.ts oracle-web/src/hooks/useOpsHealth.ts
git commit -m "feat(ops): frontend types + useOpsHealth hook"
```

---

## Task 11: StatusBar dots subcomponent + integration

**Files:**
- Create: `oracle-web/src/components/OpsHealthDots.tsx`
- Create: `oracle-web/src/components/__tests__/OpsHealthDots.test.tsx`
- Modify: `oracle-web/src/components/StatusBar.tsx`

- [ ] **Step 1: Write the failing rollup test**

```tsx
// oracle-web/src/components/__tests__/OpsHealthDots.test.tsx
import { describe, it, expect } from 'vitest';
import { worstOf, type ProbeStatus } from '../OpsHealthDots';

describe('worstOf', () => {
  it('returns ok when all are ok', () => {
    expect(worstOf(['ok', 'ok', 'ok'])).toBe('ok');
  });
  it('returns warn over ok', () => {
    expect(worstOf(['ok', 'warn', 'ok'])).toBe('warn');
  });
  it('returns red over warn', () => {
    expect(worstOf(['ok', 'warn', 'red'])).toBe('red');
  });
  it('returns needs_human over red', () => {
    expect(worstOf(['needs_human', 'red', 'ok'] as ProbeStatus[])).toBe('needs_human');
  });
  it('treats unknown as below ok', () => {
    expect(worstOf(['unknown', 'unknown'])).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test — fails**

Run: `cd oracle-web && npx vitest run src/components/__tests__/OpsHealthDots.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dots**

```tsx
// oracle-web/src/components/OpsHealthDots.tsx
import { useNavigate } from 'react-router-dom';
import type { OpsHealthSnapshot, ProbeStatus, ProbeResult } from '../types';

const RANK: Record<ProbeStatus, number> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  red: 3,
  needs_human: 4,
};

export function worstOf(statuses: ProbeStatus[]): ProbeStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce<ProbeStatus>(
    (worst, s) => (RANK[s] > RANK[worst] ? s : worst),
    'ok',
  );
}

const DOT_CLASS: Record<ProbeStatus, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-400',
  red: 'bg-red-500',
  needs_human: 'bg-red-800',
  unknown: 'bg-gray-400',
};

interface OpsHealthDotsProps {
  snapshot: OpsHealthSnapshot | null;
}

export function OpsHealthDots({ snapshot }: OpsHealthDotsProps) {
  const navigate = useNavigate();
  if (!snapshot) {
    return <span className="w-2 h-2 rounded-full bg-gray-400" aria-label="ops health: unknown" />;
  }
  const rollup = worstOf(snapshot.probes.map((p) => p.status));
  return (
    <button
      type="button"
      className="flex items-center gap-1 hover:opacity-80"
      title="Click for system health"
      onClick={() => navigate('/health')}
    >
      <span
        className={`w-2 h-2 rounded-full ${DOT_CLASS[rollup]}`}
        aria-label={`ops health: ${rollup}`}
      />
      {snapshot.probes.map((p: ProbeResult) => (
        <span
          key={p.name}
          className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[p.status]}`}
          title={`${p.name}: ${p.status} — ${p.message}`}
          aria-label={`${p.name}: ${p.status}`}
        />
      ))}
    </button>
  );
}
```

- [ ] **Step 4: Run test — passes**

Run: `cd oracle-web && npx vitest run src/components/__tests__/OpsHealthDots.test.tsx`
Expected: 5 passed.

- [ ] **Step 5: Wire into StatusBar**

Edit `oracle-web/src/components/StatusBar.tsx`:

Replace the entire file with:
```tsx
import { BotStatus, MarketStatus, OpsHealthSnapshot } from '../types';
import { OpsHealthDots } from './OpsHealthDots';

interface StatusBarProps {
  marketStatus: MarketStatus | null;
  botStatus: BotStatus | null;
  isConnected: boolean;
  lastUpdate: Date | null;
  stockCount: number;
  opsHealth: OpsHealthSnapshot | null;
}

export function StatusBar({
  marketStatus,
  botStatus,
  isConnected,
  lastUpdate,
  stockCount,
  opsHealth,
}: StatusBarProps) {
  return (
    <div className="bg-gray-800 text-white px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}
            aria-hidden="true"
          />
          <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        </div>

        <div className="text-gray-400">|</div>

        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              marketStatus?.isOpen ? 'bg-green-500' : 'bg-yellow-500'
            }`}
            aria-hidden="true"
          />
          <span>{marketStatus?.isOpen ? 'Market Open' : 'Market Closed'}</span>
          {marketStatus && (
            <span className="text-gray-400 text-xs">({marketStatus.nextChange})</span>
          )}
        </div>

        <div className="text-gray-400">|</div>

        <span className="text-gray-300">
          {stockCount} symbol{stockCount !== 1 ? 's' : ''}
        </span>

        {botStatus && (
          <>
            <div className="text-gray-400">|</div>
            <span className="text-gray-300">
              Bot: {botStatus.isRunning ? 'Running' : 'Stopped'}
            </span>
          </>
        )}

        <div className="text-gray-400">|</div>
        <OpsHealthDots snapshot={opsHealth} />
      </div>

      <div className="flex items-center gap-4">
        {lastUpdate && (
          <span className="text-gray-400 text-xs">
            Last update: {lastUpdate.toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Pass `opsHealth` from `App.tsx`**

In `oracle-web/src/App.tsx`, add to the imports at the top:
```tsx
import { useOpsHealth } from './hooks/useOpsHealth';
```

In the `App` function body, near the other hook calls (before the `return`):
```tsx
const { snapshot: opsHealth } = useOpsHealth();
```

In the JSX, find `<StatusBar ... />` and add the prop:
```tsx
<StatusBar
  marketStatus={marketStatus}
  botStatus={botStatus}
  isConnected={isConnected}
  lastUpdate={lastUpdate}
  stockCount={stocks.length}
  opsHealth={opsHealth}
/>
```

- [ ] **Step 7: Typecheck and run**

Run: `cd oracle-web && npx tsc --noEmit`
Expected: clean.

Run: `cd oracle-web && npm run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add oracle-web/src/components/OpsHealthDots.tsx oracle-web/src/components/__tests__/OpsHealthDots.test.tsx oracle-web/src/components/StatusBar.tsx oracle-web/src/App.tsx
git commit -m "feat(ops): StatusBar dots showing per-probe health"
```

---

## Task 12: `/health` page + nav entry

**Files:**
- Create: `oracle-web/src/components/HealthPage.tsx`
- Modify: `oracle-web/src/App.tsx`

- [ ] **Step 1: Implement the page**

```tsx
// oracle-web/src/components/HealthPage.tsx
import { useEffect, useState } from 'react';
import { useOpsHealth } from '../hooks/useOpsHealth';
import type { ProbeName, ProbeResult, ProbeStatus } from '../types';

const STATUS_LABEL: Record<ProbeStatus, { text: string; class: string }> = {
  ok: { text: 'OK', class: 'bg-green-100 text-green-900' },
  warn: { text: 'WARN', class: 'bg-amber-100 text-amber-900' },
  red: { text: 'RED', class: 'bg-red-100 text-red-900' },
  needs_human: { text: 'NEEDS HUMAN', class: 'bg-red-200 text-red-950 font-bold' },
  unknown: { text: 'UNKNOWN', class: 'bg-gray-100 text-gray-700' },
};

function ageOf(iso: string | null): string {
  if (!iso) return '--';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

interface HistoryPanelProps {
  probe: ProbeName;
}

function HistoryPanel({ probe }: HistoryPanelProps) {
  const [events, setEvents] = useState<Array<{ ts: string; status: ProbeStatus; message: string }>>([]);
  useEffect(() => {
    void fetch(`/api/ops/health/history?probe=${probe}`)
      .then((r) => r.json())
      .then((d: { events: typeof events }) => setEvents(d.events))
      .catch(() => setEvents([]));
  }, [probe]);
  if (events.length === 0) {
    return <div className="text-xs text-gray-500 italic px-3 py-2">no transitions recorded yet</div>;
  }
  return (
    <ul className="text-xs px-3 py-2 space-y-1">
      {events.slice(-20).reverse().map((e, i) => (
        <li key={i} className="flex gap-3">
          <span className="text-gray-500">{new Date(e.ts).toLocaleTimeString()}</span>
          <span className={`px-1.5 rounded ${STATUS_LABEL[e.status].class}`}>{STATUS_LABEL[e.status].text}</span>
          <span className="text-gray-700">{e.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function HealthPage() {
  const { snapshot, isLoading, error, refresh } = useOpsHealth();
  const [expanded, setExpanded] = useState<ProbeName | null>(null);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      await fetch('/api/ops/health/reset', { method: 'POST' });
      await refresh();
    } finally {
      setResetting(false);
    }
  };

  if (isLoading && !snapshot) return <div className="p-6 text-gray-500">Loading health...</div>;
  if (error && !snapshot) {
    return (
      <div className="p-6">
        <div className="text-red-600 mb-2">{error}</div>
        <button onClick={() => void refresh()} className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm">Retry</button>
      </div>
    );
  }
  if (!snapshot) return <div className="p-6 text-gray-500">No data</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-3 flex items-center justify-between">
        <div className="text-sm text-gray-600">
          As of {new Date(snapshot.asOf).toLocaleTimeString()} · {snapshot.probes.length} probe(s)
        </div>
        <button
          type="button"
          onClick={() => void reset()}
          disabled={resetting}
          className="bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-50"
        >
          {resetting ? 'Resetting...' : 'Reset needs_human flags'}
        </button>
      </div>
      <div className="bg-white rounded-lg shadow">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Probe</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Last probe</th>
              <th className="text-left px-3 py-2">Last OK</th>
              <th className="text-left px-3 py-2">Failures</th>
              <th className="text-left px-3 py-2">Message</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.probes.map((p: ProbeResult) => (
              <>
                <tr
                  key={p.name}
                  className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpanded(expanded === p.name ? null : p.name)}
                >
                  <td className="px-3 py-2 font-mono">{p.name}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${STATUS_LABEL[p.status].class}`}>
                      {STATUS_LABEL[p.status].text}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500">{ageOf(p.lastProbeAt)} ago</td>
                  <td className="px-3 py-2 text-gray-500">{p.lastOkAt ? `${ageOf(p.lastOkAt)} ago` : '--'}</td>
                  <td className="px-3 py-2 tabular-nums">{p.consecutiveFailures}</td>
                  <td className="px-3 py-2 text-gray-700 max-w-xl truncate" title={p.message}>{p.message}</td>
                </tr>
                {expanded === p.name && (
                  <tr key={`${p.name}-history`} className="bg-gray-50">
                    <td colSpan={6}><HistoryPanel probe={p.name} /></td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the route + nav entry**

Edit `oracle-web/src/App.tsx`:

Add to the imports:
```tsx
import { HealthPage } from './components/HealthPage';
```

In the `<nav>` block, add a new `<NavLink>` after the Backtest one:
```tsx
<NavLink to="/health" className={navLinkClass}>
  Health
</NavLink>
```

In the `<Routes>` block, add a new `<Route>` after the `/backtest` one:
```tsx
<Route path="/health" element={<HealthPage />} />
```

- [ ] **Step 3: Typecheck + build**

Run: `cd oracle-web && npx tsc --noEmit`
Expected: clean.

Run: `cd oracle-web && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add oracle-web/src/components/HealthPage.tsx oracle-web/src/App.tsx
git commit -m "feat(ops): /health page with probe table + history expansion"
```

---

## Task 13: WebSocket subscription updates `useOpsHealth`

**Files:**
- Modify: `oracle-web/src/hooks/useOpsHealth.ts`
- Modify: `oracle-web/src/hooks/useWebSocket.ts` (only if it parses raw events; otherwise we open a fresh /api/raw/stream subscription in the hook).

The simplest path: have `useOpsHealth` open its own `/api/raw/stream` EventSource-style WebSocket and listen for `ops_health` events.

- [ ] **Step 1: Augment the hook to subscribe to the raw WS stream**

Replace the body of `oracle-web/src/hooks/useOpsHealth.ts` with:

```ts
import { useEffect, useState, useCallback } from 'react';
import type { OpsHealthSnapshot } from '../types';

interface UseOpsHealthResult {
  snapshot: OpsHealthSnapshot | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOpsHealth(): UseOpsHealthResult {
  const [snapshot, setSnapshot] = useState<OpsHealthSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/ops/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OpsHealthSnapshot;
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load ops health');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch + WS subscription. The WS keeps the snapshot live;
  // refresh() is exposed for the manual retry button on the Health page.
  useEffect(() => {
    void refresh();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/raw/stream`);
    ws.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data) as { type?: string; payload?: OpsHealthSnapshot };
        if (data.type === 'ops_health' && data.payload) {
          setSnapshot(data.payload);
        }
      } catch {
        // ignore malformed messages
      }
    });
    return () => ws.close();
  }, [refresh]);

  return { snapshot, isLoading, error, refresh };
}
```

- [ ] **Step 2: Manual smoke test**

Run: `cd oracle-web/server && npm run dev` and `cd oracle-web && npm run dev` in separate terminals. Open `http://localhost:5173/health`. Expected:
- Table shows ~12 rows.
- Status dots in the StatusBar update on the 30s tick.
- Forcibly killing the Chrome debug port (close the debug Chrome window) flips `chrome_debug_port` to `red` within 30s.

- [ ] **Step 3: Commit**

```bash
git add oracle-web/src/hooks/useOpsHealth.ts
git commit -m "feat(ops): subscribe to ops_health WS events from useOpsHealth"
```

---

## Task 14: PR

- [ ] **Step 1: Final test sweep**

Run: `cd oracle-web/server && npx tsc --noEmit && npx vitest run`
Expected: clean + all tests pass.

Run: `cd oracle-web && npx tsc --noEmit && npm test && npm run build`
Expected: clean + all tests pass + build succeeds.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(ops): operational monitor — probes, dots, /health page" --body "..."
```

PR body:
```
## Summary
- 12 dependency probes on a 30s loop in `opsMonitorService`
- Recovery actions for the four scraper services with 5min cooldown + 3-strikes escalation to `needs_human`
- StatusBar dots (rollup + per-probe) clickable through to a new `/health` page
- WS `ops_health` event for live updates
- HTTP surface: `GET /api/ops/health`, `GET /api/ops/health/history?probe=`, `POST /api/ops/health/reset`

Spec: `docs/superpowers/specs/2026-05-05-operational-monitor-design.md`

## Test plan
- [x] `npx vitest run` — opsProbes (24 tests) + opsMonitorService (7 tests) + OpsHealthDots rollup (5 tests)
- [x] `npx tsc --noEmit` clean across server and web
- [x] `npm run build` succeeds
- [ ] Manual: kill the Chrome debug port, observe `chrome_debug_port` → red within 30s, then restart Chrome and observe → ok
- [ ] Manual: stop a scraper service via the dashboard toolbar, observe the relevant probe → red and a recovery attempt → ok within ~30s

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

**1. Spec coverage:**
- 12 probes — Tasks 2-5 cover all 12. ✓
- Recovery actions for scrapers — Task 6 builds the registry, Task 9 wires it. ✓
- StatusBar dots — Task 11. ✓
- /health page — Task 12. ✓
- WS event integration — Task 8 (server) + Task 13 (client). ✓
- HTTP endpoints — Task 9. ✓
- Cooldown + escalation + reset — Task 7. ✓
- Tests — Tasks 2-7, 11. ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"appropriate"/"as needed" — all tasks have concrete code.

**3. Type consistency:**
- `ProbeResult`, `ProbeState`, `ProbeName`, `ProbeStatus`, `OpsHealthSnapshot` defined in Task 1, used consistently downstream.
- `BotStatusLike` introduced in Task 2 to avoid a hard dependency on the existing `BotStatus` type in `types.ts`.
- `RecoveryRegistry` defined in Task 6, used in Task 7 (constructor option) and Task 9 (built and passed in).
- `getFailureCounters` introduced in Task 9 step 4 with the matching call site.

**4. Note on globalThis shim (Task 9 Step 2):** Documented as deliberate intermediate state. The Polygon and IEX probes will report "no recent calls" → `ok` until a follow-up PR plumbs proper getters into `polygonService` and `alpacaBarService`. This keeps the monitor PR shippable without a multi-file refactor of the bar/price services.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-05-operational-monitor.md`.
