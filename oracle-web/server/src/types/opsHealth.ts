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
