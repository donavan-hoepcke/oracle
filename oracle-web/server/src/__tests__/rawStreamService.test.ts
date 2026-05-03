import { describe, it, expect, beforeEach } from 'vitest';
import { RawStreamService } from '../services/rawStreamService.js';

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
