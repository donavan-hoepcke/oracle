import { describe, it, expect } from 'vitest';
import {
  probeOracleScraper,
  probeWsClients,
  probeModeratorAlerts,
  probeIncomeTraderChat,
  probeFloatMap,
  probeSectorHotness,
  type ProbeDeps,
} from '../services/opsProbes.js';

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
