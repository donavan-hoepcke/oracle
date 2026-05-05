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
