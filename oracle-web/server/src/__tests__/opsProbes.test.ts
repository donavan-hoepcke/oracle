import { describe, it, expect } from 'vitest';
import {
  probeOracleScraper,
  probeWsClients,
  probeModeratorAlerts,
  probeIncomeTraderChat,
  probeFloatMap,
  probeSectorHotness,
  probeBrokerAccount,
  probeRecordingDisk,
  probePolygonApi,
  probeAlpacaIexBars,
  probeIbkrGateway,
  probeChromeDebugPort,
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

describe('active probes', () => {
  it('broker_account ok when getAccount resolves', async () => {
    const r = await probeBrokerAccount({ getAccount: async () => ({ cash: 1000, portfolioValue: 1000, buyingPower: 1000, settledCash: 1000, unsettledCash: 0 }) });
    expect(r.status).toBe('ok');
  });

  it('broker_account red when getAccount throws twice (consecutive)', async () => {
    let calls = 0;
    const getAccount = async () => { calls++; throw new Error('500'); };
    const failures = { broker_account: 1 };
    const r = await probeBrokerAccount({ getAccount }, failures);
    expect(r.status).toBe('red');
    expect(calls).toBe(1);
  });

  it('broker_account warn on a single transient failure', async () => {
    const r = await probeBrokerAccount({ getAccount: async () => { throw new Error('500'); } }, { broker_account: 0 });
    expect(r.status).toBe('warn');
  });

  it('recording_disk ok when there is plenty of free space', async () => {
    const r = await probeRecordingDisk({ availableBytes: 10 * 1024 ** 3, dirWritable: true });
    expect(r.status).toBe('ok');
  });

  it('recording_disk red when free space below 1 GB', async () => {
    const r = await probeRecordingDisk({ availableBytes: 500 * 1024 ** 2, dirWritable: true });
    expect(r.status).toBe('red');
  });

  it('recording_disk red when dir not writable', async () => {
    const r = await probeRecordingDisk({ availableBytes: 999_999_999_999, dirWritable: false });
    expect(r.status).toBe('red');
  });

  it('polygon_api ok when fewer than 5 of last 10 calls failed', async () => {
    const r = await probePolygonApi({ recent: Array(10).fill(0).map((_, i) => ({ ok: i < 8 })) });
    expect(r.status).toBe('ok');
  });

  it('polygon_api red when 5+ of last 10 calls failed', async () => {
    const r = await probePolygonApi({ recent: Array(10).fill(0).map((_, i) => ({ ok: i < 4 })) });
    expect(r.status).toBe('red');
  });

  it('alpaca_iex_bars excludes 429s from the failure ratio', async () => {
    const recent = [
      ...Array(6).fill(0).map(() => ({ ok: false, status: 429 })),
      ...Array(4).fill(0).map(() => ({ ok: true })),
    ];
    const r = await probeAlpacaIexBars({ recent });
    expect(r.status).toBe('ok');
  });
});

describe('conditional probes', () => {
  it('ibkr_gateway returns unknown when broker is alpaca', async () => {
    const r = await probeIbkrGateway({ activeBroker: 'alpaca', tickle: async () => ({ iserver: { authStatus: { authenticated: false } } }) });
    expect(r.status).toBe('unknown');
  });

  it('ibkr_gateway ok when iserver authenticated', async () => {
    const r = await probeIbkrGateway({ activeBroker: 'ibkr', tickle: async () => ({ iserver: { authStatus: { authenticated: true } } }) });
    expect(r.status).toBe('ok');
  });

  it('ibkr_gateway red with re-auth message when not authenticated', async () => {
    const r = await probeIbkrGateway({ activeBroker: 'ibkr', tickle: async () => ({ iserver: { authStatus: { authenticated: false } } }) });
    expect(r.status).toBe('red');
    expect(r.message).toMatch(/re-auth/i);
  });

  it('chrome_debug_port ok when /json/version returns 200', async () => {
    const r = await probeChromeDebugPort({ probeUrl: async () => ({ ok: true, status: 200 }) });
    expect(r.status).toBe('ok');
  });

  it('chrome_debug_port red on connection failure', async () => {
    const r = await probeChromeDebugPort({ probeUrl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.status).toBe('red');
    expect(r.message).toContain('ECONNREFUSED');
  });
});
