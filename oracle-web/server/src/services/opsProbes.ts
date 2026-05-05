import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
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
  void statSync;
  void resolve;
  return { availableBytes, dirWritable };
}
