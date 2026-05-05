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
      recoveredAt:
        status === 'ok' && prev?.attemptedRecovery
          ? result.lastProbeAt
          : (prev?.recoveredAt ?? null),
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
