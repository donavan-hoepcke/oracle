import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlpacaRateLimiter } from '../services/alpacaRateLimiter.js';

describe('AlpacaRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts full and lets burst-many callers through immediately', async () => {
    // 60/min steady, burst=5. Five back-to-back acquires should all
    // resolve without advancing time.
    const limiter = new AlpacaRateLimiter({ ratePerMin: 60, burst: 5 });
    const acquires = Array.from({ length: 5 }, () => limiter.acquire());
    await Promise.all(acquires);
    expect(limiter.getStats().tokens).toBe(0);
  });

  it('parks the (burst+1)th caller until a token refills', async () => {
    // 60/min = 1 token/sec. burst=2 means token #3 must wait 1s.
    const limiter = new AlpacaRateLimiter({ ratePerMin: 60, burst: 2 });
    await limiter.acquire();
    await limiter.acquire();
    let resolved = false;
    const third = limiter.acquire().then(() => {
      resolved = true;
    });
    // Drain the microtask queue without advancing the wall clock.
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(limiter.getStats().pendingWaiters).toBeGreaterThanOrEqual(1);
    // Advance enough wall-clock for one token to refill plus the
    // limiter's internal poll cadence (max(50ms, 1s/refillRate)).
    await vi.advanceTimersByTimeAsync(1100);
    await third;
    expect(resolved).toBe(true);
  });

  it('refills steadily — half a minute returns half the per-minute budget', async () => {
    const limiter = new AlpacaRateLimiter({ ratePerMin: 60, burst: 60 });
    // Drain everything.
    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop
      await limiter.acquire();
    }
    expect(limiter.getStats().tokens).toBe(0);
    // Wait 30 seconds: 30 * (60/60) = 30 tokens should refill.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(limiter.getStats().tokens).toBe(30);
  });

  it('notifyRateLimited empties the bucket and stalls callers for the penalty window', async () => {
    const limiter = new AlpacaRateLimiter({ ratePerMin: 600, burst: 10 });
    // Bucket starts full. Notify a 2s penalty.
    limiter.notifyRateLimited(2_000);
    expect(limiter.getStats().tokens).toBe(0);
    expect(limiter.getStats().penaltyMsRemaining).toBeGreaterThan(1_000);

    // Caller starts during penalty.
    let resolved = false;
    const acquire = limiter.acquire().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance through the penalty + a small buffer for the next refill
    // poll to fire.
    await vi.advanceTimersByTimeAsync(2_500);
    await acquire;
    expect(resolved).toBe(true);
  });

  it('extends an active penalty rather than shortening it on a second 429', async () => {
    const limiter = new AlpacaRateLimiter({ ratePerMin: 600, burst: 5 });
    limiter.notifyRateLimited(5_000);
    const firstWindow = limiter.getStats().penaltyMsRemaining;
    // A subsequent 429 with a shorter retry-after must NOT shorten the
    // existing window — pick the larger of the two.
    limiter.notifyRateLimited(1_000);
    expect(limiter.getStats().penaltyMsRemaining).toBeGreaterThanOrEqual(firstWindow - 100);
  });
});
