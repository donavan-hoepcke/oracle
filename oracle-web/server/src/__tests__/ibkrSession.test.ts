import { describe, it, expect, vi } from 'vitest';
import { IbkrSession } from '../services/brokers/ibkrSession.js';

function makeFakeTimers() {
  let cb: (() => void) | null = null;
  const setIntervalImpl = ((fn: () => void) => {
    cb = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  const clearIntervalImpl = (() => {
    cb = null;
  }) as typeof globalThis.clearInterval;
  return {
    setIntervalImpl,
    clearIntervalImpl,
    fire: () => {
      if (cb) cb();
    },
    isScheduled: () => cb !== null,
  };
}

describe('IbkrSession', () => {
  it('runs one tickle on start() and marks itself alive on success', async () => {
    const tickle = vi.fn().mockResolvedValue(undefined);
    const t = makeFakeTimers();
    const session = new IbkrSession({
      tickle,
      setInterval: t.setIntervalImpl,
      clearInterval: t.clearIntervalImpl,
    });
    await session.start();
    expect(tickle).toHaveBeenCalledTimes(1);
    expect(session.isAlive()).toBe(true);
    expect(session.lastError).toBeNull();
    expect(t.isScheduled()).toBe(true);
    session.stop();
  });

  it('marks itself not-alive on failure but does not throw', async () => {
    const err = new Error('boom');
    const tickle = vi.fn().mockRejectedValueOnce(err);
    const t = makeFakeTimers();
    const session = new IbkrSession({
      tickle,
      setInterval: t.setIntervalImpl,
      clearInterval: t.clearIntervalImpl,
    });
    await session.start();
    expect(session.isAlive()).toBe(false);
    expect(session.lastError).toBe(err);
    session.stop();
  });

  it('recovers when a later tickle succeeds after a failure', async () => {
    const tickle = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce(undefined);
    const t = makeFakeTimers();
    const session = new IbkrSession({
      tickle,
      setInterval: t.setIntervalImpl,
      clearInterval: t.clearIntervalImpl,
    });
    await session.start();
    expect(session.isAlive()).toBe(false);
    // Simulate the interval firing.
    await session.runOne();
    expect(session.isAlive()).toBe(true);
    expect(session.lastError).toBeNull();
    session.stop();
  });

  it('start() is idempotent — second call does not duplicate the timer', async () => {
    const tickle = vi.fn().mockResolvedValue(undefined);
    const t = makeFakeTimers();
    const session = new IbkrSession({
      tickle,
      setInterval: t.setIntervalImpl,
      clearInterval: t.clearIntervalImpl,
    });
    await session.start();
    await session.start();
    // First call ran tickle once + scheduled timer; second call should
    // see the existing timer and bail out (no second tickle).
    expect(tickle).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('stop() is idempotent — safe to call without start()', () => {
    const session = new IbkrSession({ tickle: () => Promise.resolve() });
    expect(() => session.stop()).not.toThrow();
    expect(() => session.stop()).not.toThrow();
  });

  it('snapshot() reflects current session state', async () => {
    const tickle = vi.fn().mockResolvedValue(undefined);
    const session = new IbkrSession({
      tickle,
      now: () => new Date('2026-05-04T20:00:00Z'),
    });
    await session.runOne();
    const snap = session.snapshot();
    expect(snap.alive).toBe(true);
    expect(snap.lastTickleAt).toBe('2026-05-04T20:00:00.000Z');
    expect(snap.lastError).toBeNull();
    expect(snap.intervalMs).toBe(60_000);
  });
});
