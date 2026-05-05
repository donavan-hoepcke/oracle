import { describe, it, expect, vi } from 'vitest';
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
    await monitor.tickForTest();
    expect(monitor.getSnapshot().probes[0].status).toBe('red');
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

  it('history ring caps at historyCap, dropping oldest entries first', async () => {
    // Build a probe that flips status every call so each tick produces a
    // new history entry, then advance enough ticks to overflow the cap.
    let flips = 0;
    const monitor = new OpsMonitorService({
      probes: {
        oracle_scraper: async () => {
          flips++;
          return {
            name: 'oracle_scraper',
            status: flips % 2 === 0 ? 'ok' : 'red',
            lastProbeAt: new Date(Date.now() + flips).toISOString(),
            lastOkAt: null,
            message: `flip ${flips}`,
            attemptedRecovery: false,
            recoveredAt: null,
            consecutiveFailures: 0,
          };
        },
      },
      recovery: {},
      historyCap: 5,
      cooldownMs: 0,
    });
    for (let i = 0; i < 12; i++) await monitor.tickForTest();
    const history = monitor.getHistory('oracle_scraper');
    expect(history.length).toBeLessThanOrEqual(5);
    // Oldest dropped — earliest remaining entry is from a later tick than the very first.
    expect(history[0].message).not.toBe('flip 1');
  });

  it('populates recoveredAt when recovery succeeds and probe goes ok next tick', async () => {
    const probeStates: Array<ReturnType<typeof makeProbe>> = [
      makeProbe('oracle_scraper', 'red', 'stale'),
      makeProbe('oracle_scraper', 'ok', 'recovered'),
    ];
    let call = 0;
    const monitor = new OpsMonitorService({
      probes: { oracle_scraper: () => probeStates[Math.min(call++, 1)]() },
      recovery: { oracle_scraper: async () => {} },
      cooldownMs: 0,
    });
    await monitor.tickForTest(); // red, recovery runs, attemptedRecovery=true
    await monitor.tickForTest(); // ok, recoveredAt should populate
    const probe = monitor.getSnapshot().probes.find((p) => p.name === 'oracle_scraper');
    expect(probe?.status).toBe('ok');
    expect(probe?.recoveredAt).not.toBeNull();
  });
});
