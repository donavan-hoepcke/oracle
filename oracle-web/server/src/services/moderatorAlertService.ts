import { EventEmitter } from 'node:events';
import { config } from '../config.js';

export interface ModeratorSignal {
  symbol: string;
  signal: number | null;
  riskZone: number | null;
  // Target is often descriptive ("Mid to high $4's", "$1.50+") so we keep raw
  // text and expose a best-effort numeric floor separately.
  target: string | null;
  targetFloor: number | null;
}

export interface ModeratorBackup {
  symbol: string;
  price: number | null;
  note: string | null;
}

export type ModeratorPostKind =
  | 'alert'
  | 'double_down'
  | 'backups'
  | 'pre_market_prep'
  | 'weekend_resources'
  | 'comment'
  | 'announcement'
  | 'other';

export interface ModeratorPost {
  title: string;
  kind: ModeratorPostKind;
  author: string;
  postedAt: string | null;
  body: string;
  signal: ModeratorSignal | null;
  backups: ModeratorBackup[];
  // Every $TICKER mentioned anywhere in title or body (deduped, in order of
  // first appearance). Distinct from `signal.symbol` (the post's *primary*
  // actionable ticker, only set when a Signal:/Risk Zone:/Target: block is
  // present) and from `backups` (structured backup-idea entries with prices).
  // Useful for posts like Double Down notes where a ticker is mentioned but
  // no fresh signal block exists — consumers can correlate by ticker without
  // overloading the `signal` slot, which downstream code treats as
  // "actionable primary signal" via `if (post.signal)` checks.
  symbols: string[];
}

export interface ModeratorAlertSnapshot {
  fetchedAt: string | null;
  posts: ModeratorPost[];
  error: string | null;
}

// "Apr 20, 2026 6:36 AM" — the 4-line footer's last line that delimits posts.
const TIMESTAMP_RE = /^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} (AM|PM)$/;
const SIGNAL_LINE_RE = /^Signal:\s*\$?([\d.]+)/i;
const RISK_LINE_RE = /^Risk\s*Zone:.*?\$+([\d.]+)/i;
const TARGET_LINE_RE = /^Target:\s*(.+)$/i;
const TICKER_RE = /^\$([A-Z][A-Z0-9.-]{0,6})(?:\s|$)/;
// Loose ticker scan for posts that don't follow the Signal/Risk/Target format
// (e.g. Double Down notes). Matches a $TICKER anywhere on a line.
const LOOSE_TICKER_RE = /\$([A-Z][A-Z0-9.-]{0,6})\b/;
// Backup lines always price the ticker with a "$" prefix (e.g., "$TOVX $0.45"
// or "$RMSG Double tap on $1.18"). Requiring the $ rejects narrative mentions
// like "$EFOI to fast to alert, but plenty of time ... 30 minutes in advance".
const BACKUP_LINE_RE = /^\$([A-Z][A-Z0-9.-]{0,6})\s+(?:(.*?)\s+)?\$([\d.]+)(.*)?$/;

function classify(title: string): ModeratorPostKind {
  const t = title.toLowerCase();
  if (t.startsWith('daily market profits alert')) return 'alert';
  // Double Down posts re-confirm an existing signal. Two formats observed in
  // the room: "Double Down Alert 5-4-2026 $CLNN" (with ticker in title) and
  // "Double Down Note 4-23-2026" (general note). Both classify as double_down
  // so downstream consumers can match the bot's mod_double_down_long rule.
  if (t.startsWith('double down') || t.startsWith('double-down')) return 'double_down';
  if (t.startsWith('backup ideas') || t.startsWith('backup idea')) return 'backups';
  if (t.startsWith('pre market prep') || t.startsWith('pre-market prep')) return 'pre_market_prep';
  if (t.startsWith('weekend resources')) return 'weekend_resources';
  return 'other';
}

function extractAllTickers(lines: string[]): string[] {
  // De-dupe while preserving order of first appearance — readers care about
  // "what tickers are mentioned in this post", not how many times each one is.
  const seen = new Set<string>();
  const out: string[] = [];
  const globalRe = new RegExp(LOOSE_TICKER_RE.source, 'g');
  for (const line of lines) {
    for (const match of line.matchAll(globalRe)) {
      const sym = match[1];
      if (!seen.has(sym)) {
        seen.add(sym);
        out.push(sym);
      }
    }
  }
  return out;
}

function findTitleIndex(bodyLines: string[]): number {
  // Prefer the first known post-type line, which lets us skip page-chrome
  // preamble like "Announcements" above the earliest post.
  for (let i = 0; i < bodyLines.length; i++) {
    if (classify(bodyLines[i]) !== 'other') return i;
  }
  return 0;
}

function parseNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(raw: string): string | null {
  const d = new Date(raw + ' UTC');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractSignal(bodyLines: string[]): ModeratorSignal | null {
  let signalIdx = -1;
  let signal: number | null = null;
  let riskZone: number | null = null;
  let target: string | null = null;
  let targetFloor: number | null = null;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const sig = line.match(SIGNAL_LINE_RE);
    if (sig) {
      signal = parseNumber(sig[1]);
      signalIdx = i;
      continue;
    }
    const risk = line.match(RISK_LINE_RE);
    if (risk) riskZone = parseNumber(risk[1]);
    const tgt = line.match(TARGET_LINE_RE);
    if (tgt) {
      target = tgt[1].trim();
      const floorMatch = target.match(/\$?([\d.]+)/);
      targetFloor = floorMatch ? parseNumber(floorMatch[1]) : null;
    }
  }

  if (signalIdx < 0) return null;

  // Walk back from Signal: line to find the nearest $TICKER on its own line
  // — that's the post's primary subject. Narrative mentions of other tickers
  // earlier in the body are ignored by taking the closest preceding ticker.
  let symbol: string | null = null;
  for (let j = signalIdx - 1; j >= 0; j--) {
    const m = bodyLines[j].match(TICKER_RE);
    if (m) {
      symbol = m[1];
      break;
    }
  }
  // Fallback: some posts embed the ticker inline in a title like "Double Down
  // Alert 5-4-2026 $CLNN" rather than on its own line. If TICKER_RE found
  // nothing, scan the same backward range with a looser regex that matches
  // a $TICKER anywhere on a line.
  if (!symbol) {
    for (let j = signalIdx - 1; j >= 0; j--) {
      const m = bodyLines[j].match(LOOSE_TICKER_RE);
      if (m) {
        symbol = m[1];
        break;
      }
    }
  }
  if (!symbol) return null;

  return { symbol, signal, riskZone, target, targetFloor };
}

function extractBackups(bodyLines: string[]): ModeratorBackup[] {
  const backups: ModeratorBackup[] = [];
  for (const line of bodyLines) {
    const m = line.match(BACKUP_LINE_RE);
    if (!m) continue;
    const symbol = m[1];
    const noteBefore = (m[2] ?? '').trim();
    const priceStr = m[3];
    const noteAfter = (m[4] ?? '').trim();
    const note = [noteBefore, noteAfter].filter((s) => s.length > 0).join(' ').trim() || null;
    const price = parseNumber(priceStr);
    backups.push({ symbol, price, note });
  }
  return backups;
}

/**
 * Parse the Daily Market Profits room's rendered innerText into posts.
 *
 * Each post ends with a 4-line footer: type label, room list, author, and a
 * timestamp like "Apr 20, 2026 6:36 AM". We slice on the timestamp, peel off
 * the 3 footer lines above it, and treat the remainder back to the previous
 * post boundary as the post body. The first body line is the title, which we
 * classify to decide whether to extract a Signal/Risk Zone/Target triplet or
 * a backup ticker list.
 */
export function parseModeratorAlertText(raw: string): ModeratorPost[] {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const timestampIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TIMESTAMP_RE.test(lines[i])) timestampIdxs.push(i);
  }

  const posts: ModeratorPost[] = [];
  let cursor = 0;
  for (const tsIdx of timestampIdxs) {
    // Footer is the 3 lines above the timestamp: [type, rooms, author].
    if (tsIdx - cursor < 4) {
      cursor = tsIdx + 1;
      continue;
    }
    const bodyLines = lines.slice(cursor, tsIdx - 3);
    const author = lines[tsIdx - 1];
    const postedAt = parseTimestamp(lines[tsIdx]);
    if (bodyLines.length === 0) {
      cursor = tsIdx + 1;
      continue;
    }
    const titleIdx = findTitleIndex(bodyLines);
    const postLines = bodyLines.slice(titleIdx);
    const title = postLines[0];
    const kind = classify(title);
    // Signals and backups can appear in ANY post kind. Tim Bohen often publishes
    // the day's actionable trade as a "Pre-Market Prep" post that embeds a full
    // "Signal: $X.XX / Risk Zone: $Y.YY / Target: ..." block. Restricting
    // extraction to kind==='alert' missed these. We always run the extractors;
    // they return null/empty when no Signal: line is present.
    //
    // For double_down posts specifically: the post usually re-confirms the
    // *original* signal (so signal stays null and consumers look up the
    // original alert by ticker). But moderators sometimes attach a fresh
    // Signal: block when they identify a *new level to watch* — in that case
    // extractSignal picks it up like any other post and `signal` is populated
    // as a standalone actionable signal. The kind label `double_down` lets
    // consumers tell the two apart from a regular `alert`.
    const signal = extractSignal(postLines);
    const backups = extractBackups(postLines);
    // Loose ticker scan over title+body for any post kind. This is what
    // surfaces the symbol on Double Down notes (which lack a Signal: block)
    // without overloading the `signal` slot — `if (post.signal)` consumers
    // (signalsService, symbolDetailService) keep treating only real signal
    // blocks as primary actionable alerts.
    const symbols = extractAllTickers(postLines);

    posts.push({
      title,
      kind,
      author,
      postedAt,
      body: postLines.slice(1).join('\n'),
      signal,
      backups,
      symbols,
    });
    cursor = tsIdx + 1;
  }
  return posts;
}

export class ModeratorAlertService {
  private snapshot: ModeratorAlertSnapshot = { fetchedAt: null, posts: [], error: null };
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  getSnapshot(): ModeratorAlertSnapshot {
    return this.snapshot;
  }

  ingestPosts(posts: ModeratorPost[]): void {
    this.snapshot = { fetchedAt: new Date().toISOString(), posts, error: null };
    this.emitter.emit('alerts', posts);
  }

  onAlerts(listener: (posts: ModeratorPost[]) => void): () => void {
    this.emitter.on('alerts', listener);
    return () => this.emitter.off('alerts', listener);
  }

  async start(): Promise<void> {
    if (!config.bot.moderatorAlerts.enabled) return;
    if (this.pollTimer) return;
    const intervalMs = config.bot.moderatorAlerts.poll_interval_sec * 1000;
    this.pollOnce().catch((err) => {
      console.warn('moderator-alerts initial poll failed:', err instanceof Error ? err.message : err);
    });
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => {
        console.warn('moderator-alerts poll failed:', err instanceof Error ? err.message : err);
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const urls = config.bot.moderatorAlerts.urls;
      // Fetch all configured rooms in parallel. One slow/failing room must not
      // block posts from the others, so we collect partial results: any URL
      // that throws contributes zero posts but is logged via the per-URL
      // wrapper below. If every URL fails we surface the last error on the
      // snapshot.
      const results = await Promise.all(
        urls.map(async (url) => {
          try {
            const text = await this.fetchPageText(url);
            return { url, posts: parseModeratorAlertText(text), error: null as string | null };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`moderator-alerts poll failed for ${url}:`, msg);
            return { url, posts: [] as ModeratorPost[], error: msg };
          }
        }),
      );
      const merged = mergeAndDedupe(results.flatMap((r) => r.posts));
      const errors = results.filter((r) => r.error).map((r) => `${r.url}: ${r.error}`);
      const snapshotError = errors.length === results.length && results.length > 0
        ? errors.join(' | ')
        : null;
      this.snapshot = { fetchedAt: new Date().toISOString(), posts: merged, error: snapshotError };
      this.emitter.emit('alerts', merged);
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchPageText(url: string): Promise<string> {
    const { chromium } = await import('playwright');
    const cfg = config.bot.moderatorAlerts;
    const browser = await chromium.connectOverCDP(config.bot.playwright.chrome_cdp_url);
    try {
      const contexts = browser.contexts();
      if (contexts.length === 0) throw new Error('no Chrome contexts attached');
      const context = contexts[0];
      const existing = context.pages().find((p) => p.url().includes(url));
      const page = existing ?? (await context.newPage());
      if (!existing) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(cfg.hydration_wait_ms);
      }
      return (await page.evaluate(`((document.body && document.body.innerText) || '')`)) as string;
    } finally {
      await browser.close();
    }
  }
}

/**
 * Merge posts from multiple rooms, dropping duplicates by (postedAt, title).
 * Same key as `rawStreamService.bindModeratorAlertService` so a post appearing
 * in both pre-market-prep and daily-market-profits is collapsed identically
 * at the snapshot and at the WS-event boundary.
 */
export function mergeAndDedupe(posts: ModeratorPost[]): ModeratorPost[] {
  const seen = new Set<string>();
  const out: ModeratorPost[] = [];
  for (const post of posts) {
    const key = `${post.postedAt ?? ''}|${post.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(post);
  }
  return out;
}

export const moderatorAlertService = new ModeratorAlertService();
