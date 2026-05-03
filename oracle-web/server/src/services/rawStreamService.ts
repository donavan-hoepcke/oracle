import { EventEmitter } from 'node:events';

export type RawStreamEventType =
  | 'scanner_update'
  | 'message'
  | 'mod_alert'
  | 'regime_shift';

export interface RawStreamEventInput {
  type: RawStreamEventType;
  payload: unknown;
}

export interface RawStreamEvent {
  id: number;
  ts: string;
  type: RawStreamEventType;
  payload: unknown;
}

export type RawStreamListener = (evt: RawStreamEvent) => void;

interface RawStreamServiceOptions {
  bufferSize?: number;
}

const EVENT_NAME = 'event';

interface MessageHookSource {
  onIngest: (cb: (event: unknown) => void) => () => void;
}

interface AlertsHookSource {
  onAlerts: (cb: (posts: unknown[]) => void) => () => void;
}

interface SnapshotHookSource {
  onSnapshot: (cb: (snapshot: unknown) => void) => () => void;
}

interface WatchlistHookSource {
  onWatchlistChange: (cb: (items: unknown[]) => void) => void;
}

export class RawStreamService {
  private emitter = new EventEmitter();
  private nextId = 1;
  private buffer: RawStreamEvent[] = [];
  private bufferSize: number;
  private unsubscribeFns: Array<() => void> = [];

  constructor(opts: RawStreamServiceOptions = {}) {
    this.bufferSize = opts.bufferSize ?? 1000;
    this.emitter.setMaxListeners(0);
  }

  publish(input: RawStreamEventInput): RawStreamEvent {
    const evt: RawStreamEvent = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      type: input.type,
      payload: input.payload,
    };
    this.buffer.push(evt);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
    this.emitter.emit(EVENT_NAME, evt);
    return evt;
  }

  subscribe(listener: RawStreamListener): () => void {
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  replaySince(sinceId: number): RawStreamEvent[] {
    return this.buffer.filter((e) => e.id > sinceId);
  }

  bindMessageService(svc: MessageHookSource): void {
    const off = svc.onIngest((event) => {
      this.publish({ type: 'message', payload: event });
    });
    this.unsubscribeFns.push(off);
  }

  bindModeratorAlertService(svc: AlertsHookSource): void {
    const off = svc.onAlerts((posts) => {
      for (const post of posts) {
        this.publish({ type: 'mod_alert', payload: post });
      }
    });
    this.unsubscribeFns.push(off);
  }

  bindRegimeService(svc: SnapshotHookSource): void {
    const off = svc.onSnapshot((snapshot) => {
      this.publish({ type: 'regime_shift', payload: snapshot });
    });
    this.unsubscribeFns.push(off);
  }

  bindTickerBotService(svc: WatchlistHookSource): void {
    // tickerBotService.onWatchlistChange does not return an unsubscribe in the
    // existing codebase; this is acceptable because rawStreamService is
    // process-lifetime and reset() only matters in tests where tickerBot is
    // not in use.
    svc.onWatchlistChange((items) => {
      this.publish({ type: 'scanner_update', payload: { items } });
    });
  }

  unbindAll(): void {
    for (const off of this.unsubscribeFns) off();
    this.unsubscribeFns = [];
  }

  // Exposed for tests; clears buffer, resets ids, and detaches bindings.
  reset(): void {
    this.unbindAll();
    this.buffer = [];
    this.nextId = 1;
    this.emitter.removeAllListeners(EVENT_NAME);
  }
}

export const rawStreamService = new RawStreamService({ bufferSize: 1000 });
