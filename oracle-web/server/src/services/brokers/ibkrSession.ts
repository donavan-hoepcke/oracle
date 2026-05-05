/**
 * Lightweight session keepalive for IBKR's Client Portal Gateway.
 *
 * The user authenticates the gateway via browser (one-time, with 2FA).
 * Once authenticated the session is sticky for ~24h, but only with a
 * periodic heartbeat: `POST /tickle` every 60s or so. Without the
 * heartbeat IBKR tears the session down silently and every subsequent
 * order call returns 401 — which is unrecoverable from inside the
 * adapter (we cannot re-do the browser flow programmatically).
 *
 * Behavior:
 * - `start()` schedules the tickle interval and fires one immediately
 *   so we know early whether the gateway is reachable.
 * - `stop()` cancels the interval. Idempotent.
 * - `isAlive()` reflects the most recent tickle's success.
 * - `lastError` carries the most recent failure for status pages.
 *
 * Network IO is injected via a `tickle` callback so unit tests can
 * exercise the keepalive logic with a fake clock and a fake fetch.
 */

export type TickleFn = () => Promise<void>;

export interface IbkrSessionOptions {
  /** POST /tickle implementation (mocked in tests). */
  tickle: TickleFn;
  /** Interval between tickles, ms. Default 60s. */
  intervalMs?: number;
  /**
   * setInterval/clearInterval injection point so tests can use fake
   * timers without depending on Node's globals.
   */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  /** Override clock for deterministic tests. */
  now?: () => Date;
}

export class IbkrSession {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private _lastTickleAt: Date | null = null;
  private _lastError: Error | null = null;
  private readonly tickle: TickleFn;
  private readonly intervalMs: number;
  private readonly setIntervalImpl: typeof globalThis.setInterval;
  private readonly clearIntervalImpl: typeof globalThis.clearInterval;
  private readonly now: () => Date;

  constructor(opts: IbkrSessionOptions) {
    this.tickle = opts.tickle;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.setIntervalImpl = opts.setInterval ?? globalThis.setInterval;
    this.clearIntervalImpl = opts.clearInterval ?? globalThis.clearInterval;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Begin the keepalive. Fires one tickle immediately so callers see a
   * fast `isAlive()` answer rather than waiting up to a full interval.
   * Idempotent — calling `start()` twice is a no-op after the first.
   */
  async start(): Promise<void> {
    if (this.timer !== null) return;
    await this.runOne();
    this.timer = this.setIntervalImpl(() => {
      void this.runOne();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  get lastTickleAt(): Date | null {
    return this._lastTickleAt;
  }

  get lastError(): Error | null {
    return this._lastError;
  }

  /** Test seam: run one tickle synchronously. Used by tests; production
   *  code should call start()/stop(). */
  async runOne(): Promise<void> {
    try {
      await this.tickle();
      this.alive = true;
      this._lastError = null;
      this._lastTickleAt = this.now();
    } catch (err) {
      this.alive = false;
      this._lastError = err instanceof Error ? err : new Error(String(err));
      // Do not re-throw — if the gateway is down we want subsequent
      // intervals to keep retrying rather than the timer dying. Status
      // surfaces to the dashboard via isAlive() / lastError.
    }
  }

  /**
   * Diagnostic snapshot for a status page. All fields are read-only and
   * safe to serialize.
   */
  snapshot(): {
    alive: boolean;
    lastTickleAt: string | null;
    lastError: string | null;
    intervalMs: number;
  } {
    return {
      alive: this.alive,
      lastTickleAt: this._lastTickleAt?.toISOString() ?? null,
      lastError: this._lastError?.message ?? null,
      intervalMs: this.intervalMs,
    };
  }
}
