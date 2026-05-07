import { config } from '../config.js';

export interface EvernoteNote {
  url: string;
  title: string;
  body: string;
  fetchedAt: string;
}

// Evernote share URLs come in two forms: the canonical
// "https://www.evernote.com/note/<uuid>" and the "lite" preview at
// "https://lite.evernote.com/note/<uuid>". Bohen pastes the lite form. The
// regex accepts either; the resolved page does the real authentication
// check (and returns the same content for both forms when share is public).
const EVERNOTE_URL_RE = /https:\/\/(?:lite\.|www\.)?evernote\.com\/note\/[a-f0-9-]+/gi;

// Selector cascade tried in order. Evernote rebrands their editor periodically;
// the fallback to `document.body.innerText` is the last-resort capture.
//
// As of 2026-05-07 the Lite share viewer (`lite.evernote.com/note/<uuid>`)
// renders content into a generic content-editable region rather than the
// older `.NoteEditor` / `.ReadOnlyEditor` classes; the additions below are
// best-effort matches that should catch the current DOM without coupling
// us to a specific class name. If Evernote rev's their markup again, the
// fallback to body innerText still recovers something.
const NOTE_SELECTORS = [
  '.NoteEditor',
  '.ReadOnlyEditor',
  '[data-test-id="note-content"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  'main article',
  'main',
];

// How often we poll body text while waiting for the share viewer to hydrate.
// 500ms gives a smooth ramp without being chatty.
const HYDRATION_POLL_MS = 500;
// Body text shorter than this is almost certainly the chrome+title stub
// before the actual note paints (live captures from the bug were ~86 chars).
// Use as a "is this hydrated" heuristic alongside the placeholder strings.
const HYDRATED_BODY_MIN_CHARS = 300;

export class EvernoteService {
  private cache = new Map<string, EvernoteNote>();
  private inFlight = new Map<string, Promise<EvernoteNote | null>>();

  async fetchNote(url: string): Promise<EvernoteNote | null> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const existing = this.inFlight.get(url);
    if (existing) return existing;

    const promise = this.doFetch(url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, promise);
    const note = await promise;
    if (note) this.cache.set(url, note);
    return note;
  }

  /** Test seam — bypass network, seed the cache. */
  primeCache(url: string, note: EvernoteNote): void {
    this.cache.set(url, note);
  }

  /** Test seam — drop all cached entries. */
  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /** Test seam — count cached entries. Used by `evernoteService.test.ts` to
   *  assert that failed fetches do NOT poison the cache. */
  cacheSize(): number {
    return this.cache.size;
  }

  private async doFetch(url: string): Promise<EvernoteNote | null> {
    const cfg = config.bot.moderatorAlerts.evernote;
    if (!cfg.enabled) return null;
    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.connectOverCDP(config.bot.playwright.chrome_cdp_url);
    } catch (err) {
      console.warn(
        `evernote: CDP connect failed for ${url}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    try {
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        console.warn(`evernote: no Chrome contexts attached for ${url}`);
        return null;
      }
      const context = contexts[0];
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        // Lite share viewer hydrates the note body via JS after first paint.
        // A fixed `waitForTimeout` either over-waits (polls too late and
        // returns the placeholder) or under-waits. Poll until the body has
        // grown past the placeholder and the explicit "Loading note"
        // string is gone, then proceed. If we hit the budget without
        // hydrating, fall through and let the placeholder check below
        // reject the result so we don't cache a stub for the day.
        await waitForHydration(page, cfg.hydration_wait_ms);
        const extracted = (await page.evaluate(`(() => {
          const selectors = ${JSON.stringify(NOTE_SELECTORS)};
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            const text = el && el.innerText ? el.innerText.trim() : '';
            if (text.length > 0) {
              const titleEl = el.querySelector('h1');
              return {
                title: (titleEl && titleEl.innerText ? titleEl.innerText.trim() : ''),
                body: el.innerText,
              };
            }
          }
          return {
            title: document.title || '',
            body: (document.body && document.body.innerText) || '',
          };
        })()`)) as { title: string; body: string };
        const body = (extracted.body ?? '').trim();
        if (!body) {
          console.warn(`evernote: empty body extracted from ${url}`);
          return null;
        }
        if (looksLikePlaceholder(body)) {
          console.warn(
            `evernote: hydration placeholder still present at ${url} ` +
              `(body=${body.length} chars) — not caching, will retry next poll`,
          );
          return null;
        }
        if (looksLikeSignInWall(body)) {
          console.warn(`evernote: sign-in wall detected at ${url}`);
          return null;
        }
        return {
          url,
          title: extracted.title ?? '',
          body,
          fetchedAt: new Date().toISOString(),
        };
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      console.warn(
        `evernote: fetch failed for ${url}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Heuristic: when share permissions are wrong (or the link is to a private
 * note), Evernote serves a sign-in interstitial instead of the note. The
 * page text will be dominated by login chrome rather than note content.
 * Detect with a generous OR — false positives just mean we don't cache
 * (next poll retries), so erring on the side of "treat as outage" is fine.
 */
function looksLikeSignInWall(body: string): boolean {
  const t = body.toLowerCase();
  if (t.includes('sign in to evernote')) return true;
  if (t.includes('log in to evernote')) return true;
  // Public-share notes never include both 'password' and 'create account'
  // adjacent. Login pages do.
  if (t.includes('password') && t.includes('create account')) return true;
  return false;
}

/**
 * Heuristic: the Lite share viewer's pre-hydration paint contains:
 *   "Welcome to Evernote Lite editor!"
 *   "Loading note..."
 *   "<title>"
 *   "Sign in"
 * — total ~80–100 chars. If we capture that, we get a misleadingly
 * specific 86-char "body" with the chat-room title in it but no real
 * note content. Caching that locks today's prep into a stub for the
 * entire process lifetime. Treat it as an outage and let the next poll
 * retry. False positives here are also harmless (just one more poll).
 */
export function looksLikePlaceholder(body: string): boolean {
  if (body.includes('Loading note')) return true;
  // Lite editor chrome with no real content yet — short body + the
  // welcome banner is the giveaway.
  if (
    body.includes('Welcome to Evernote Lite editor') &&
    body.length < HYDRATED_BODY_MIN_CHARS
  ) {
    return true;
  }
  return false;
}

/**
 * Poll the page's body innerText until it looks hydrated (long enough,
 * "Loading note" gone) or the budget elapses. Returning early shaves
 * latency on fast-hydrating notes; returning at the deadline lets the
 * caller's placeholder check reject what we got.
 */
async function waitForHydration(
  page: { evaluate: (script: string) => Promise<unknown>; waitForTimeout: (ms: number) => Promise<void> },
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const probe = (await page.evaluate(`((document.body && document.body.innerText) || '')`)) as string;
    if (
      typeof probe === 'string' &&
      probe.length >= HYDRATED_BODY_MIN_CHARS &&
      !probe.includes('Loading note')
    ) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await page.waitForTimeout(Math.min(HYDRATION_POLL_MS, remaining));
  }
}

/**
 * Return all Evernote share URLs found in the given text, in order of
 * appearance. Used by the moderator-alert pipeline to discover candidate
 * URLs in the raw chat-room innerText dump.
 */
export function findEvernoteUrls(text: string): string[] {
  return Array.from(text.matchAll(EVERNOTE_URL_RE)).map((m) => m[0]);
}

/**
 * Pick the Evernote URL most likely to belong to a given post. Strategy:
 *   1. Find the line in rawText that contains the post's title.
 *   2. Of all Evernote URLs in rawText, return the one closest to that line.
 *   3. If the title isn't found, return the LAST URL (chat is reverse-
 *      chronological — the most recently posted prep is at the bottom).
 *   4. Returns null when no Evernote URL exists in the rawText at all.
 */
export function findEvernoteUrlForTitle(
  title: string,
  rawText: string,
): string | null {
  const lines = rawText.split('\n');
  const titleIdx = lines.findIndex((l) => l.includes(title));
  const candidates: { url: string; lineIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(EVERNOTE_URL_RE)) {
      candidates.push({ url: m[0], lineIdx: i });
    }
  }
  if (candidates.length === 0) return null;
  if (titleIdx < 0) return candidates[candidates.length - 1].url;
  candidates.sort(
    (a, b) => Math.abs(a.lineIdx - titleIdx) - Math.abs(b.lineIdx - titleIdx),
  );
  return candidates[0].url;
}

export const evernoteService = new EvernoteService();
