import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { messageService } from './messageService.js';
import { moderatorAlertService, parseChatBodyAsAlert } from './moderatorAlertService.js';

export type TickerSection = 'moderator_pick' | 'community_mention';

export interface IncomeTraderTicker {
  symbol: string;
  changePct: number | null;
  price: number | null;
  section: TickerSection;
}

export interface IncomeTraderChatMessage {
  author: string;
  postedAt: string;
  body: string;
}

export interface IncomeTraderSnapshot {
  fetchedAt: string | null;
  moderatorPicks: IncomeTraderTicker[];
  communityMentions: IncomeTraderTicker[];
  error: string | null;
}

const SECTION_HEADER_PICKS = /^\s*moderator\s+picks\s*$/i;
const SECTION_HEADER_MENTIONS = /^\s*community\s+mentions\s*$/i;
const SECTION_ANCHOR = /^\s*today'?s\s+tickers\s*$/i;
// Chat timestamps come in three flavors observed in innerText:
//   "May 4, 2026 9:43 AM"   (full date, used by some moderators)
//   "May 4, 11:31 AM"       (date with comma, no year)
//   "6:59 am"               (time only — typically pin / system preview)
// The leading-comma variant is what appears for ordinary messages, so the
// chat parser MUST handle it correctly.
const CHAT_TIMESTAMP_RE =
  /^\s*([A-Z][a-z]{2})\s+(\d{1,2})(?:,\s+(\d{4}))?,?\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s*$/i;
// Right-rail rows ALWAYS carry the "$" prefix; the section headers and the
// per-section total integer underneath them do not. Requiring "$" rejects
// stray section totals from being treated as tickers.
const TICKER_RE = /^\$([A-Z][A-Z0-9.-]{0,6})$/;
const COUNT_RE = /^\d+$/;
// Signed percent like "+2.71%" / "-20.08%". "0%" also matches.
const SIGNED_PCT_RE = /^([+\-]?\d+(?:\.\d+)?)\s*%$/;
const PRICE_RE = /^\$([\d,]*\.?[\d]+)$/;
// Author lines are sometimes adorned with a single "·" separator placed on
// its own line between the author and the timestamp. We skip it when
// resolving the author above a timestamp anchor.
const SKIP_AUTHOR_LINE_RE = /^[·•\s]*$/;

function parseNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the right-rail "Today's Tickers" panel as it appears in the chat
 * page's innerText. Each row is laid out across up to four lines:
 *   $SYMBOL          (mandatory, "$" prefix is required)
 *   <count>          (mandatory, integer mention count)
 *   <±X.XX%>         (optional, signed percent change)
 *   $<price>         (optional, dollar price)
 * Section headers ("MODERATOR PICKS" / "COMMUNITY MENTIONS") are followed by
 * a section-total integer that we skip — only the per-symbol entries are
 * captured.
 */
export function parseIncomeTraderTickers(rawText: string): {
  moderatorPicks: IncomeTraderTicker[];
  communityMentions: IncomeTraderTicker[];
} {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Find the "Today's Tickers" anchor and walk forward; otherwise skip the
  // chat transcript above so cashtags in messages don't leak into picks.
  let i = lines.findIndex((l) => SECTION_ANCHOR.test(l));
  if (i < 0) return { moderatorPicks: [], communityMentions: [] };

  let current: TickerSection | null = null;
  const moderatorPicks: IncomeTraderTicker[] = [];
  const communityMentions: IncomeTraderTicker[] = [];
  const seenInScrape = new Set<string>();

  while (i < lines.length) {
    const line = lines[i];
    if (SECTION_HEADER_PICKS.test(line)) {
      current = 'moderator_pick';
      i++;
      // The line directly under a section header is the section total
      // (e.g. "9" under MODERATOR PICKS). Skip if it's a bare integer.
      if (i < lines.length && COUNT_RE.test(lines[i])) i++;
      continue;
    }
    if (SECTION_HEADER_MENTIONS.test(line)) {
      current = 'community_mention';
      i++;
      if (i < lines.length && COUNT_RE.test(lines[i])) i++;
      continue;
    }

    const tickerMatch = line.match(TICKER_RE);
    if (current && tickerMatch) {
      const symbol = tickerMatch[1].toUpperCase();
      let cursor = i + 1;
      // Per-symbol count comes immediately after the ticker.
      if (cursor < lines.length && COUNT_RE.test(lines[cursor])) cursor++;
      // Optional signed percent change.
      const pctMatch = cursor < lines.length ? lines[cursor].match(SIGNED_PCT_RE) : null;
      const changePct = pctMatch ? parseNumber(pctMatch[1]) : null;
      if (pctMatch) cursor++;
      // Optional dollar price.
      const priceMatch = cursor < lines.length ? lines[cursor].match(PRICE_RE) : null;
      const price = priceMatch ? parseNumber(priceMatch[1]) : null;
      if (priceMatch) cursor++;

      const dedupeKey = `${current}:${symbol}`;
      if (!seenInScrape.has(dedupeKey)) {
        seenInScrape.add(dedupeKey);
        const row: IncomeTraderTicker = { symbol, changePct, price, section: current };
        if (current === 'moderator_pick') moderatorPicks.push(row);
        else communityMentions.push(row);
      }
      i = cursor;
      continue;
    }
    i++;
  }

  return { moderatorPicks, communityMentions };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseChatTimestamp(match: RegExpMatchArray, now: Date = new Date()): string {
  const [, monStr, dayStr, yearStr, hourStr, minStr, ampm] = match;
  const month = MONTHS[monStr.toLowerCase()] ?? 0;
  const day = parseInt(dayStr, 10);
  const year = yearStr ? parseInt(yearStr, 10) : now.getFullYear();
  let hour = parseInt(hourStr, 10) % 12;
  if (ampm.toUpperCase() === 'PM') hour += 12;
  const minute = parseInt(minStr, 10);
  // Local-time timestamps from the page; treat as ET (the room's timezone).
  // We render as ISO without TZ shift; bot consumers can re-zone if needed.
  return new Date(Date.UTC(year, month, day, hour, minute)).toISOString();
}

/**
 * Parse the chat transcript out of the page's innerText. We anchor on chat
 * timestamp lines: the line immediately above is the author, and the lines
 * between this timestamp and the next are the message body. Stops at the
 * "Today's Tickers" rail anchor so right-rail content can't masquerade as
 * a chat message.
 */
export function parseIncomeTraderChat(rawText: string): IncomeTraderChatMessage[] {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim());

  // Cap parsing at the rail anchor so the right-side panel doesn't bleed in.
  const railIdx = lines.findIndex((l) => SECTION_ANCHOR.test(l));
  const upper = railIdx >= 0 ? railIdx : lines.length;

  const messages: IncomeTraderChatMessage[] = [];
  const tsIndices: number[] = [];
  for (let i = 0; i < upper; i++) {
    if (CHAT_TIMESTAMP_RE.test(lines[i])) tsIndices.push(i);
  }

  for (let k = 0; k < tsIndices.length; k++) {
    const ts = tsIndices[k];
    const next = k + 1 < tsIndices.length ? tsIndices[k + 1] : upper;

    // Author is the nearest meaningful line above the timestamp. Skip blank
    // lines and the "·" / "•" separators that some moderator messages
    // place between author and timestamp. Stop if we'd walk into the
    // previous message's body — body lines often contain dollar signs or
    // mentions that would otherwise confuse author detection.
    let authorIdx = ts - 1;
    while (authorIdx > 0 && SKIP_AUTHOR_LINE_RE.test(lines[authorIdx])) authorIdx--;
    if (authorIdx < 0) continue;
    const author = lines[authorIdx];
    if (!author || CHAT_TIMESTAMP_RE.test(author)) continue;

    // Body ends at the next message's author line. That line is normally
    // tsIndices[k+1] - 1, but moderator messages can have a "·" separator
    // between author and timestamp, so we walk upward over skip-lines to
    // find the actual author index. The body loop then excludes it.
    let bodyEnd = k + 1 < tsIndices.length ? tsIndices[k + 1] - 1 : next;
    while (bodyEnd > ts && SKIP_AUTHOR_LINE_RE.test(lines[bodyEnd])) bodyEnd--;
    const bodyLines: string[] = [];
    for (let i = ts + 1; i < bodyEnd; i++) {
      if (lines[i] !== '') bodyLines.push(lines[i]);
    }
    if (bodyLines.length === 0) continue;

    const tsMatch = lines[ts].match(CHAT_TIMESTAMP_RE);
    if (!tsMatch) continue;

    messages.push({
      author,
      postedAt: parseChatTimestamp(tsMatch),
      body: bodyLines.join('\n'),
    });
  }

  return messages;
}

function chatMessageHash(m: IncomeTraderChatMessage): string {
  return createHash('sha1')
    .update(`${m.author}|${m.postedAt}|${m.body}`)
    .digest('hex');
}

class IncomeTraderChatService {
  private snapshot: IncomeTraderSnapshot = {
    fetchedAt: null,
    moderatorPicks: [],
    communityMentions: [],
    error: null,
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private emitter = new EventEmitter();
  // Tickers we've already pushed into messageService this session. Keyed by
  // section + symbol so a community mention promoted to a moderator pick
  // re-fires (semantic upgrade), but plain re-observation does not flood.
  private ingestedKeys = new Set<string>();
  // SHA-1 of (author|postedAt|body) for chat messages already re-emitted.
  // The chat transcript is a sliding window so most polls revisit the same
  // tail — without dedup we'd flood messageService.
  private ingestedChatHashes = new Set<string>();
  private readonly chatHashCap = 5_000;
  private lastRawText = '';

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  getSnapshot(): IncomeTraderSnapshot {
    return this.snapshot;
  }

  /** Diagnostic: the last raw page text we scraped, for debugging parsers. */
  getLastRawText(): string {
    return this.lastRawText;
  }

  /** Test seam — push a parsed snapshot directly without touching Playwright. */
  ingestSnapshot(picks: IncomeTraderTicker[], mentions: IncomeTraderTicker[]): void {
    this.applyParsed(picks, mentions);
  }

  /** Test seam — push a parsed chat batch directly. */
  ingestChat(messages: IncomeTraderChatMessage[]): void {
    this.applyChat(messages);
  }

  onUpdate(listener: (snap: IncomeTraderSnapshot) => void): () => void {
    this.emitter.on('update', listener);
    return () => this.emitter.off('update', listener);
  }

  async start(): Promise<void> {
    if (!config.bot.incomeTraderChat.enabled) return;
    if (this.pollTimer) return;
    const intervalMs = config.bot.incomeTraderChat.poll_interval_sec * 1000;
    this.pollOnce().catch((err) => {
      console.warn(
        'income-trader-chat initial poll failed:',
        err instanceof Error ? err.message : err,
      );
    });
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => {
        console.warn(
          'income-trader-chat poll failed:',
          err instanceof Error ? err.message : err,
        );
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
      const text = await this.fetchPageText();
      this.lastRawText = text;
      const { moderatorPicks, communityMentions } = parseIncomeTraderTickers(text);
      this.applyParsed(moderatorPicks, communityMentions);
      const chatMessages = parseIncomeTraderChat(text);
      this.applyChat(chatMessages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = { ...this.snapshot, error: msg };
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchPageText(): Promise<string> {
    const { chromium } = await import('playwright');
    const cfg = config.bot.incomeTraderChat;
    const browser = await chromium.connectOverCDP(config.bot.playwright.chrome_cdp_url);
    try {
      const contexts = browser.contexts();
      if (contexts.length === 0) throw new Error('no Chrome contexts attached');
      const context = contexts[0];
      const existing = context.pages().find((p) => p.url().includes(cfg.url));
      const page = existing ?? (await context.newPage());
      if (!existing) {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(cfg.hydration_wait_ms);
      }
      return (await page.evaluate(
        `((document.body && document.body.innerText) || '')`,
      )) as string;
    } finally {
      await browser.close();
    }
  }

  private applyParsed(
    moderatorPicks: IncomeTraderTicker[],
    communityMentions: IncomeTraderTicker[],
  ): void {
    this.snapshot = {
      fetchedAt: new Date().toISOString(),
      moderatorPicks,
      communityMentions,
      error: null,
    };

    for (const t of moderatorPicks) this.maybeIngest(t);
    for (const t of communityMentions) this.maybeIngest(t);

    this.emitter.emit('update', this.snapshot);
  }

  private maybeIngest(t: IncomeTraderTicker): void {
    const key = `${t.section}:${t.symbol}`;
    if (this.ingestedKeys.has(key)) return;
    this.ingestedKeys.add(key);

    const author = t.section === 'moderator_pick' ? 'moderator_picks' : 'community_mentions';
    const priceText = t.price !== null ? ` $${t.price.toFixed(2)}` : '';
    const pctText = t.changePct !== null ? ` ${t.changePct.toFixed(2)}%` : '';
    messageService.ingest({
      text: `$${t.symbol}${pctText}${priceText}`,
      channel: 'income_trader_chat',
      author,
    });
  }

  private applyChat(messages: IncomeTraderChatMessage[]): void {
    const allowlist = config.bot.moderatorChatAllowlist;
    const liftedPosts: import('./moderatorAlertService.js').ModeratorPost[] = [];
    for (const m of messages) {
      const hash = chatMessageHash(m);
      if (this.ingestedChatHashes.has(hash)) continue;
      this.ingestedChatHashes.add(hash);
      messageService.ingest({
        text: m.body,
        channel: 'income_trader_chat',
        author: m.author,
        timestamp: m.postedAt,
      });
      // Moderators (e.g., STT-Shirley) post Double Down alerts directly in
      // chat rather than to the moderator-alert page. Lift those into the
      // mod_alert event stream so downstream consumers see one normalised
      // alert shape regardless of where the moderator typed it. Same
      // (postedAt, title) dedup at the WS-emit boundary keeps duplicates
      // out of stock_o_bot's journal.
      if (!allowlist.includes(m.author)) continue;
      const post = parseChatBodyAsAlert(m.body, m.author, m.postedAt);
      if (post !== null) liftedPosts.push(post);
    }
    if (liftedPosts.length > 0) {
      moderatorAlertService.ingestPosts(liftedPosts);
    }
    // Bound the dedupe set so it doesn't grow without limit across a long
    // session. The chat tail at any moment is well under this cap, so
    // dropping the oldest entries is safe.
    if (this.ingestedChatHashes.size > this.chatHashCap) {
      const overflow = this.ingestedChatHashes.size - this.chatHashCap;
      const it = this.ingestedChatHashes.values();
      for (let i = 0; i < overflow; i++) {
        const v = it.next().value;
        if (v) this.ingestedChatHashes.delete(v);
      }
    }
  }
}

export const incomeTraderChatService = new IncomeTraderChatService();
