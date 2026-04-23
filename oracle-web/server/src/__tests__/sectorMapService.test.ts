import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SectorMapService } from '../services/sectorMapService.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

describe('SectorMapService', () => {
  let service: SectorMapService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps known sector strings to SPDR ETFs', () => {
    service = new SectorMapService({ overrides: {}, cache: {}, cachePath: '', finnhubKey: '' });
    expect(service.getEtfFor('biotechnology')).toBe('XBI');
    expect(service.getEtfFor('energy')).toBe('XLE');
    expect(service.getEtfFor('technology')).toBe('XLK');
    expect(service.getEtfFor('unknown')).toBe('SPY');
  });

  it('override wins over cache wins over finnhub', async () => {
    service = new SectorMapService({
      overrides: { ABCD: 'energy' },
      cache: { ABCD: 'technology' },
      cachePath: '',
      finnhubKey: 'fake',
    });
    expect(await service.getSectorFor('ABCD')).toBe('energy');
  });

  it('returns cache when no override', async () => {
    service = new SectorMapService({
      overrides: {},
      cache: { WXYZ: 'healthcare' },
      cachePath: '',
      finnhubKey: 'fake',
    });
    expect(await service.getSectorFor('WXYZ')).toBe('healthcare');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls finnhub when no override and no cache hit, then caches the result', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ finnhubIndustry: 'Biotechnology' }),
    });
    service = new SectorMapService({
      overrides: {},
      cache: {},
      cachePath: '',
      finnhubKey: 'fake',
    });
    const sector = await service.getSectorFor('NEW');
    expect(sector).toBe('biotechnology');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await service.getSectorFor('NEW');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns unknown on finnhub failure and does not cache', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'));
    service = new SectorMapService({
      overrides: {},
      cache: {},
      cachePath: '',
      finnhubKey: 'fake',
    });
    expect(await service.getSectorFor('FAIL')).toBe('unknown');
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ finnhubIndustry: 'Energy' }) });
    expect(await service.getSectorFor('FAIL')).toBe('energy');
  });

  it('returns unknown when finnhub key is missing', async () => {
    service = new SectorMapService({
      overrides: {},
      cache: {},
      cachePath: '',
      finnhubKey: '',
    });
    expect(await service.getSectorFor('NOKEY')).toBe('unknown');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
