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

export class RawStreamService {
  private emitter = new EventEmitter();
  private nextId = 1;
  private buffer: RawStreamEvent[] = [];
  private bufferSize: number;

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

  // Exposed for tests; clears buffer and resets ids.
  reset(): void {
    this.buffer = [];
    this.nextId = 1;
    this.emitter.removeAllListeners(EVENT_NAME);
  }
}

export const rawStreamService = new RawStreamService({ bufferSize: 1000 });
