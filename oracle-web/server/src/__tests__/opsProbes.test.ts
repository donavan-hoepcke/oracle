import { describe, it, expect } from 'vitest';
import { probeOracleScraper, probeWsClients, type ProbeDeps } from '../services/opsProbes.js';

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
