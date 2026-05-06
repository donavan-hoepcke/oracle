/**
 * Token-bucket rate limiter for Alpaca's bar API.
 *
 * Why: Alpaca's free-tier IEX feed caps at ~200 requests per rolling
 * minute. The bot's bar fetches (stair-step 1m+5m, sector ETFs, regime,
 * Red-Candle-Theory lookups) routinely burst above that on a price-poll
 * cycle, especially right after a restart when caches are cold. The
 * symptom is HTTP 429 spam, no current prices, no trend30m, no
 * candidates, no trades (the chain we walked through 2026-05-06).
 *
 * The bucket smooths bursts under a configured per-minute budget. When
 * the broker still returns 429 (someone outside the bucket beat us, or
 * the budget is set too high), `notifyRateLimited()` empties the bucket
 * and sets a penalty window so callers don't re-fire immediately.
 */

interface RateLimiterOptions {
  /** Sustained budget. Free-tier IEX is 200/min; we default to 180 for headroom. */
  ratePerMin: number;
  /**
   * Burst capacity (max tokens). A short burst above the steady rate
   * is fine — we just refill at `ratePerMin / 60` tokens per second.
   * Defaults to 1/6 of the per-minute rate (~10 seconds of fast fires).
   */
  burst?: number;
}

export class AlpacaRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillTokensPerSec: number;
  private lastRefillMs: number;
  private penaltyUntilMs = 0;
  /**
   * Number of waiters parked in `acquire()`. Useful for the ops monitor
   * to surface "X bar fetches stalled on rate limit" without depending on
   * call-site instrumentation.
   */
  private pendingWaiters = 0;

  constructor(opts: RateLimiterOptions) {
    this.maxTokens = opts.burst ?? Math.max(5, Math.ceil(opts.ratePerMin / 6));
    this.tokens = this.maxTokens;
    this.refillTokensPerSec = opts.ratePerMin / 60;
    this.lastRefillMs = Date.now();
  }

  /** Wait until at least one token is available, then consume it. */
  async acquire(): Promise<void> {
    this.pendingWaiters++;
    try {
      // Honor any active penalty window first. notifyRateLimited extends
      // this on subsequent 429s, so a sustained outage just keeps callers
      // parked rather than hammering the broker.
      while (Date.now() < this.penaltyUntilMs) {
        await sleep(this.penaltyUntilMs - Date.now());
      }
      // Standard token-bucket loop. We refill, check, decrement-or-wait.
      // The wait duration is exactly enough for the next token to refill,
      // so we don't busy-loop and we don't oversleep.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.max(50, Math.ceil(1000 / this.refillTokensPerSec));
        await sleep(waitMs);
      }
    } finally {
      this.pendingWaiters--;
    }
  }

  /**
   * Called by the bar service when the broker returned 429. Empties the
   * bucket and sets a penalty window — defaults to 5 seconds, which lets
   * the rolling-minute window tick down without us re-firing into it.
   */
  notifyRateLimited(retryAfterMs = 5000): void {
    this.tokens = 0;
    const target = Date.now() + retryAfterMs;
    if (target > this.penaltyUntilMs) this.penaltyUntilMs = target;
  }

  /** Diagnostic snapshot — used by tests and (eventually) an ops probe. */
  getStats(): {
    tokens: number;
    maxTokens: number;
    pendingWaiters: number;
    penaltyMsRemaining: number;
  } {
    this.refill();
    return {
      tokens: Math.floor(this.tokens),
      maxTokens: this.maxTokens,
      pendingWaiters: this.pendingWaiters,
      penaltyMsRemaining: Math.max(0, this.penaltyUntilMs - Date.now()),
    };
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    const add = (elapsedMs / 1000) * this.refillTokensPerSec;
    this.tokens = Math.min(this.maxTokens, this.tokens + add);
    this.lastRefillMs = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
