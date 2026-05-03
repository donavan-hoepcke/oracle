import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RawStreamService, rawStreamService } from '../services/rawStreamService.js';
import { messageService } from '../services/messageService.js';
import { moderatorAlertService, type ModeratorPost } from '../services/moderatorAlertService.js';
import { RegimeService, type RegimeSnapshot } from '../services/regimeService.js';

describe('RawStreamService', () => {
  let svc: RawStreamService;

  beforeEach(() => {
    svc = new RawStreamService({ bufferSize: 4 });
  });

  it('assigns monotonically increasing event ids starting at 1', () => {
    const ids: number[] = [];
    svc.subscribe((evt) => ids.push(evt.id));
    svc.publish({ type: 'regime_shift', payload: { snapshot: { x: 1 } } });
    svc.publish({ type: 'regime_shift', payload: { snapshot: { x: 2 } } });
    svc.publish({ type: 'regime_shift', payload: { snapshot: { x: 3 } } });
    expect(ids).toEqual([1, 2, 3]);
  });

  it('stamps each event with type, id, and ts', () => {
    let captured: { id: number; ts: string; type: string } | null = null;
    svc.subscribe((evt) => { captured = evt; });
    svc.publish({ type: 'message', payload: { text: 'AAPL' } });
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe('message');
    expect(captured!.id).toBe(1);
    expect(typeof captured!.ts).toBe('string');
    expect(new Date(captured!.ts).toString()).not.toBe('Invalid Date');
  });

  it('replays buffered events with id > sinceId', () => {
    svc.publish({ type: 'message', payload: { i: 1 } });
    svc.publish({ type: 'message', payload: { i: 2 } });
    svc.publish({ type: 'message', payload: { i: 3 } });
    const replay = svc.replaySince(1);
    expect(replay.map((e) => e.id)).toEqual([2, 3]);
  });

  it('replays empty array when sinceId equals latest', () => {
    svc.publish({ type: 'message', payload: { i: 1 } });
    expect(svc.replaySince(1)).toEqual([]);
  });

  it('honors bufferSize limit, dropping oldest', () => {
    for (let i = 0; i < 6; i++) {
      svc.publish({ type: 'message', payload: { i } });
    }
    // Buffer holds last 4: ids 3,4,5,6
    const replay = svc.replaySince(0);
    expect(replay.map((e) => e.id)).toEqual([3, 4, 5, 6]);
  });

  it('unsubscribe removes the listener', () => {
    const events: number[] = [];
    const unsubscribe = svc.subscribe((e) => events.push(e.id));
    svc.publish({ type: 'message', payload: {} });
    unsubscribe();
    svc.publish({ type: 'message', payload: {} });
    expect(events).toEqual([1]);
  });
});

describe('RawStreamService.bind() integration', () => {
  beforeEach(() => {
    rawStreamService.reset();
  });

  it('bindMessageService forwards messageService events as message events', () => {
    const seen: { type: string; payload: unknown }[] = [];
    const unsub = rawStreamService.subscribe((e) => seen.push({ type: e.type, payload: e.payload }));
    rawStreamService.bindMessageService(messageService);
    messageService.ingest({ text: 'AAPL bind test' });
    unsub();
    rawStreamService.unbindAll();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.some((e) => e.type === 'message')).toBe(true);
  });

  it('bindModeratorAlertService publishes one mod_alert event per post', () => {
    const types: string[] = [];
    rawStreamService.subscribe((e) => types.push(e.type));
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const post: ModeratorPost = {
      title: 'test',
      kind: 'alert',
      author: 'mod',
      postedAt: '2026-05-02T13:00:00.000Z',
      body: '',
      signal: null,
      backups: [],
    };
    moderatorAlertService.ingestPosts([post, post]);
    rawStreamService.unbindAll();
    moderatorAlertService.ingestPosts([post]);
    expect(types.filter((t) => t === 'mod_alert')).toHaveLength(2);
  });

  it('bindRegimeService publishes regime_shift events', () => {
    const captured: RegimeSnapshot[] = [];
    rawStreamService.subscribe((e) => {
      if (e.type === 'regime_shift') captured.push(e.payload as RegimeSnapshot);
    });
    const fakeRegime = new RegimeService({
      fetchBars: vi.fn(async () => []),
      fetchTodayBars: vi.fn(async () => []),
      sectorMap: { getSectorFor: vi.fn(async () => 'unknown'), getEtfFor: () => 'SPY' },
      tradeHistory: { getRecentTrades: vi.fn(async () => []) },
    });
    rawStreamService.bindRegimeService(fakeRegime);
    const snap: RegimeSnapshot = {
      ts: '2026-05-02T13:00:00.000Z',
      market: { score: 0, spyTrendPct: null, vxxRocPct: null, status: 'ok' },
      sectors: {},
      tickers: {},
    };
    fakeRegime.recordSnapshot(snap);
    rawStreamService.unbindAll();
    fakeRegime.recordSnapshot(snap);
    expect(captured).toHaveLength(1);
    expect(captured[0].ts).toBe('2026-05-02T13:00:00.000Z');
  });

  it('reset detaches all bindings and clears buffer + listeners', () => {
    rawStreamService.bindMessageService(messageService);
    rawStreamService.publish({ type: 'message', payload: { x: 1 } });
    expect(rawStreamService.replaySince(0).length).toBe(1);
    rawStreamService.reset();
    expect(rawStreamService.replaySince(0)).toEqual([]);
    // After reset, ingesting through messageService must not produce events because reset unbinds.
    const seen: number[] = [];
    rawStreamService.subscribe((e) => seen.push(e.id));
    messageService.ingest({ text: 'AAPL after reset' });
    expect(seen).toEqual([]);
  });
});
