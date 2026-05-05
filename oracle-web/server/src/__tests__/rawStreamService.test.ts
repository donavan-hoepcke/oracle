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

  it('bindModeratorAlertService hoists symbol/signal_price to top-level payload', () => {
    // Regression: the bot's RawEvent.symbol field is read from payload.symbol
    // at the top level. Without hoisting, the bot saw symbol=None and treated
    // every signal-bearing alert as editorial commentary.
    const captured: unknown[] = [];
    rawStreamService.subscribe((e) => {
      if (e.type === 'mod_alert') captured.push(e.payload);
    });
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const post: ModeratorPost = {
      title: 'Pre-Market Prep',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-04T10:43:00.000Z',
      body: 'long body content with the alert embedded inside the prep post...',
      signal: {
        symbol: 'PN',
        signal: 6.01,
        riskZone: 5.7,
        target: "Mid to high $6's",
        targetFloor: 6,
      },
      backups: [{ symbol: 'CNSP', price: 10.65, note: null }],
      symbols: [],
    };
    moderatorAlertService.ingestPosts([post]);
    rawStreamService.unbindAll();

    expect(captured).toHaveLength(1);
    const payload = captured[0] as Record<string, unknown>;
    expect(payload.symbol).toBe('PN');
    expect(payload.signal_price).toBeCloseTo(6.01);
    expect(payload.risk_zone).toBeCloseTo(5.7);
    expect(payload.target_floor).toBeCloseTo(6);
    expect(payload.target).toBe("Mid to high $6's");
    expect(payload.title).toBe('Pre-Market Prep');
    expect(payload.kind).toBe('pre_market_prep');
    expect(payload.posted_at).toBe('2026-05-04T10:43:00.000Z');
    expect(payload.backups).toEqual([{ symbol: 'CNSP', price: 10.65, note: null }]);
  });

  it('bindModeratorAlertService excerpts long bodies to keep payload small', () => {
    const captured: unknown[] = [];
    rawStreamService.subscribe((e) => {
      if (e.type === 'mod_alert') captured.push(e.payload);
    });
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const longBody = 'x'.repeat(2000);
    const post: ModeratorPost = {
      title: 'Pre-Market Prep',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: null,
      body: longBody,
      signal: null,
      backups: [],
      symbols: [],
    };
    moderatorAlertService.ingestPosts([post]);
    rawStreamService.unbindAll();

    const payload = captured[0] as Record<string, unknown>;
    const excerpt = payload.body_excerpt as string;
    expect(excerpt.length).toBeLessThanOrEqual(401); // 400 + 1 ellipsis char
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('bindModeratorAlertService leaves symbol null when no signal was parsed', () => {
    const captured: unknown[] = [];
    rawStreamService.subscribe((e) => {
      if (e.type === 'mod_alert') captured.push(e.payload);
    });
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const post: ModeratorPost = {
      title: 'Pre-Market Prep',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: null,
      body: 'just commentary, no signal block today',
      signal: null,
      backups: [],
      symbols: [],
    };
    moderatorAlertService.ingestPosts([post]);
    rawStreamService.unbindAll();

    const payload = captured[0] as Record<string, unknown>;
    expect(payload.symbol).toBeNull();
    expect(payload.signal_price).toBeNull();
  });

  it('bindModeratorAlertService publishes one mod_alert event per DISTINCT post', () => {
    const types: string[] = [];
    rawStreamService.subscribe((e) => types.push(e.type));
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const a: ModeratorPost = {
      title: 'alert A',
      kind: 'alert',
      author: 'mod',
      postedAt: '2026-05-02T13:00:00.000Z',
      body: '',
      signal: null,
      backups: [],
      symbols: [],
    };
    const b: ModeratorPost = { ...a, title: 'alert B' };
    moderatorAlertService.ingestPosts([a, b]);
    rawStreamService.unbindAll();
    moderatorAlertService.ingestPosts([a]); // no listener now
    expect(types.filter((t) => t === 'mod_alert')).toHaveLength(2);
  });

  it('bindModeratorAlertService dedupes repeated posts across poll cycles', () => {
    // Regression: moderatorAlertService re-scrapes the page on every poll
    // and re-emits ALL cached posts each time, even ones already announced.
    // The bridge must dedup by (postedAt, title) so downstream sees each
    // post once. Without this, the soak burns ~25x the necessary tokens.
    const types: string[] = [];
    rawStreamService.subscribe((e) => types.push(e.type));
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const post: ModeratorPost = {
      title: 'PN signal',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-04T06:43:00.000Z',
      body: 'Signal: $6.01',
      signal: { symbol: 'PN', signal: 6.01, riskZone: 5.7, target: null, targetFloor: null },
      backups: [],
      symbols: [],
    };
    // Three poll cycles, same post each time (mirrors real upstream behavior).
    moderatorAlertService.ingestPosts([post]);
    moderatorAlertService.ingestPosts([post]);
    moderatorAlertService.ingestPosts([post]);
    expect(types.filter((t) => t === 'mod_alert')).toHaveLength(1);
  });

  it('bindModeratorAlertService treats a post with new postedAt as new', () => {
    const types: string[] = [];
    rawStreamService.subscribe((e) => types.push(e.type));
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const base: ModeratorPost = {
      title: 'PN signal',
      kind: 'pre_market_prep',
      author: 'Tim Bohen',
      postedAt: '2026-05-04T06:43:00.000Z',
      body: '',
      signal: null,
      backups: [],
      symbols: [],
    };
    moderatorAlertService.ingestPosts([base]);
    moderatorAlertService.ingestPosts([{ ...base, postedAt: '2026-05-05T06:43:00.000Z' }]);
    expect(types.filter((t) => t === 'mod_alert')).toHaveLength(2);
  });

  it('reset clears the mod_alert dedup cache', () => {
    const types: string[] = [];
    rawStreamService.subscribe((e) => types.push(e.type));
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    const post: ModeratorPost = {
      title: 'x',
      kind: 'alert',
      author: 'mod',
      postedAt: '2026-05-02T13:00:00.000Z',
      body: '',
      signal: null,
      backups: [],
      symbols: [],
    };
    moderatorAlertService.ingestPosts([post]);
    rawStreamService.reset();
    // Re-bind after reset because reset() detaches subscribers too.
    const types2: string[] = [];
    rawStreamService.subscribe((e) => types2.push(e.type));
    rawStreamService.bindModeratorAlertService(moderatorAlertService);
    moderatorAlertService.ingestPosts([post]);
    expect(types2.filter((t) => t === 'mod_alert')).toHaveLength(1);
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
