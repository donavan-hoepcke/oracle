import { EventEmitter } from 'node:events';

export type RawStreamEventType =
  | 'scanner_update'
  | 'message'
  | 'mod_alert'
  | 'regime_shift'
  | 'ops_health';

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

interface BotShapedModAlert {
  // Top-level convenience fields the bot uses for routing + summary.
  symbol: string | null;
  signal_price: number | null;
  risk_zone: number | null;
  target_floor: number | null;
  target: string | null;
  // Original post fields, with body excerpted to keep the WS payload small
  // (the bot truncates payload summaries at 240 chars; a full prep post body
  // is ~1500 chars and hides the structured fields from the agent prompt).
  title: string;
  kind: string;
  author: string;
  posted_at: string | null;
  body_excerpt: string;
  backups: unknown[];
}

const BODY_EXCERPT_CHARS = 400;

interface ParsedSignalLike {
  symbol: string;
  signal: number | null;
  riskZone: number | null;
  targetFloor: number | null;
  target: string | null;
}

interface PostLike {
  title?: unknown;
  kind?: unknown;
  author?: unknown;
  postedAt?: unknown;
  body?: unknown;
  signal?: unknown;
  backups?: unknown;
}

function shapeModAlertForBot(post: unknown): BotShapedModAlert {
  const p = (post ?? {}) as PostLike;
  const sig = (p.signal ?? null) as ParsedSignalLike | null;
  const body = typeof p.body === 'string' ? p.body : '';
  const bodyExcerpt =
    body.length <= BODY_EXCERPT_CHARS ? body : body.slice(0, BODY_EXCERPT_CHARS) + '…';
  return {
    symbol: sig?.symbol ?? null,
    signal_price: sig?.signal ?? null,
    risk_zone: sig?.riskZone ?? null,
    target_floor: sig?.targetFloor ?? null,
    target: sig?.target ?? null,
    title: typeof p.title === 'string' ? p.title : '',
    kind: typeof p.kind === 'string' ? p.kind : 'other',
    author: typeof p.author === 'string' ? p.author : '',
    posted_at: typeof p.postedAt === 'string' ? p.postedAt : null,
    body_excerpt: bodyExcerpt,
    backups: Array.isArray(p.backups) ? p.backups : [],
  };
}

interface SnapshotHookSource {
  onSnapshot: (cb: (snapshot: unknown) => void) => () => void;
}

interface WatchlistHookSource {
  onWatchlistChange: (cb: (items: unknown[]) => void) => void;
}

interface OpsMonitorHookSource {
  onUpdate: (cb: (snap: unknown) => void) => () => void;
}

export class RawStreamService {
  private emitter = new EventEmitter();
  private nextId = 1;
  private buffer: RawStreamEvent[] = [];
  private bufferSize: number;
  private unsubscribeFns: Array<() => void> = [];
  // Dedup keys for moderator alerts. moderatorAlertService re-scrapes the
  // DMP page every poll cycle and emits ALL posts each time; without this
  // map, every post is republished as a fresh mod_alert event on every
  // cycle, which spams downstream consumers (~25x duplicate evaluations).
  //
  // Keyed by `${postedAt}|${title}` (posts have no stable id from the
  // upstream page) → first-emit timestamp. Entries older than DEDUP_TTL_MS
  // are pruned on each onAlerts call so the map can't grow unbounded
  // across days, and so a post that's still being re-scraped after a
  // restart can re-emit once per TTL window. The bot-side dedupes on its
  // own (by postedAt, title), so the at-most-once-per-day re-emit is a
  // no-op for unchanged posts. Cleared by reset() for tests.
  private seenModAlertKeys = new Map<string, number>();
  private static readonly MOD_ALERT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
  // Provider for the moderator-alert snapshot, set by bindModeratorAlertService.
  // The WS handler calls emitModeratorSnapshotTo() on each new client connect
  // so a bot connecting mid-afternoon sees today's already-known prep posts
  // even when the ring buffer has rolled past them. Independent from the
  // dedup gate — snapshot pushes are subscriber-scoped, not new global
  // events, so they do NOT enter the buffer or advance nextId.
  private moderatorSnapshotProvider: (() => unknown[]) | null = null;

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

  bindModeratorAlertService(
    svc: AlertsHookSource & { getSnapshot?: () => { posts?: unknown[] } | null | undefined },
  ): void {
    const off = svc.onAlerts((posts) => {
      const now = Date.now();
      // Prune expired keys before checking new ones — TTL is what unblocks
      // the cross-day case where a post that emitted yesterday is still
      // being scraped today (rare; happens when the room hasn't rolled the
      // post off the page) and needs to re-emit so a fresh subscriber's
      // ring-buffer replay sees it.
      for (const [key, t] of this.seenModAlertKeys) {
        if (now - t > RawStreamService.MOD_ALERT_DEDUP_TTL_MS) {
          this.seenModAlertKeys.delete(key);
        }
      }
      for (const post of posts) {
        const p = (post ?? {}) as { postedAt?: unknown; title?: unknown };
        const postedAt = typeof p.postedAt === 'string' ? p.postedAt : '';
        const title = typeof p.title === 'string' ? p.title : '';
        const key = `${postedAt}|${title}`;
        if (this.seenModAlertKeys.has(key)) continue;
        this.seenModAlertKeys.set(key, now);
        this.publish({ type: 'mod_alert', payload: shapeModAlertForBot(post) });
      }
    });
    this.unsubscribeFns.push(off);
    if (typeof svc.getSnapshot === 'function') {
      this.moderatorSnapshotProvider = () => {
        const snap = svc.getSnapshot?.();
        const posts = snap && Array.isArray((snap as { posts?: unknown[] }).posts)
          ? (snap as { posts: unknown[] }).posts
          : [];
        return posts;
      };
    }
  }

  /**
   * Push the moderator service's current snapshot to a single listener as
   * `mod_alert` events. Used by the WS handler at connection time so a
   * fresh client (e.g. the bot starting up mid-afternoon) sees today's
   * already-known prep / alert posts even when the ring buffer has rolled
   * past their original ids.
   *
   * These events are subscriber-scoped: they do NOT call `publish()`, do
   * NOT enter the global ring buffer, and do NOT advance `nextId`. Other
   * connected clients are unaffected. Events use `id: 0` so the client's
   * Last-Event-ID tracker doesn't advance — the next live event still has
   * a higher id. The bot's own (postedAt, title) dedup naturally absorbs
   * any overlap between the snapshot push and a subsequent live emit.
   */
  emitModeratorSnapshotTo(listener: RawStreamListener): void {
    if (!this.moderatorSnapshotProvider) return;
    const ts = new Date().toISOString();
    for (const post of this.moderatorSnapshotProvider()) {
      listener({
        id: 0,
        ts,
        type: 'mod_alert',
        payload: shapeModAlertForBot(post),
      });
    }
  }

  bindRegimeService(svc: SnapshotHookSource): void {
    const off = svc.onSnapshot((snapshot) => {
      this.publish({ type: 'regime_shift', payload: snapshot });
    });
    this.unsubscribeFns.push(off);
  }

  bindOpsMonitorService(svc: OpsMonitorHookSource): void {
    // Diff suppression happens upstream in the monitor's tick (only emits
    // 'update' when state changes), so this just republishes verbatim.
    const off = svc.onUpdate((snap) => {
      this.publish({ type: 'ops_health', payload: snap });
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
    this.seenModAlertKeys.clear();
    this.moderatorSnapshotProvider = null;
    this.emitter.removeAllListeners(EVENT_NAME);
  }
}

export const rawStreamService = new RawStreamService({ bufferSize: 1000 });
