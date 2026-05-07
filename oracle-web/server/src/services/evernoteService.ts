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
// How long we suppress retries for a URL that returned null (placeholder,
// sign-in wall, timeout, CDP failure). Without this the moderator-alert
// poll cycle (every 180s) re-fires fetches against URLs that won't
// hydrate, opening a fresh Chrome tab each time. 90s lets us recover
// quickly when an outage clears while preventing per-cycle thrash.
const FAILURE_TTL_MS = 90_000;

export class EvernoteService {
  private cache = new Map<string, EvernoteNote>();
  private inFlight = new Map<string, Promise<EvernoteNote | null>>();
  // URL → unix-ms when the most recent fetch returned null. Looked up
  // before doFetch and short-circuits to null until the entry expires.
  private failureCache = new Map<string, number>();

  async fetchNote(url: string): Promise<EvernoteNote | null> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const existing = this.inFlight.get(url);
    if (existing) return existing;
    // Short-circuit recent failures so 9 stale-prep enrichments don't
    // each burn a Chrome tab + 12s hydration budget every 180s.
    const failedAt = this.failureCache.get(url);
    if (failedAt !== undefined && Date.now() - failedAt < FAILURE_TTL_MS) {
      return null;
    }
    if (failedAt !== undefined) this.failureCache.delete(url);

    const promise = this.doFetch(url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, promise);
    const note = await promise;
    if (note) {
      this.cache.set(url, note);
      this.failureCache.delete(url);
    } else {
      this.failureCache.set(url, Date.now());
    }
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
    this.failureCache.clear();
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
      // Reuse an already-open tab when Chrome has one for this URL. The
      // Lite share is a React SPA — by the time the user (or a prior
      // moderator-alert poll cycle) has the note open, the bundle has
      // fetched, the SPA has hydrated, and the rendered DOM is sitting
      // there ready to read. Skipping goto + hydration polling on this
      // path is both faster and more reliable than opening a fresh tab
      // and racing the bundle.
      //
      // Multiple-tab handling: Chrome can hold several tabs pointing at
      // the same URL (e.g., user opened the note twice while debugging).
      // Some may still be on chrome / stale; one will have the rendered
      // note. Probe each candidate's body length and pick the richest.
      // This was the live failure on 2026-05-07 — `find()` returned the
      // first match (stale chrome) while the user's other tab had the
      // prep fully rendered.
      // Helper: probe the maximum textContent length across the page's
      // main frame AND any iframes / sub-frames. Lite share viewer renders
      // the actual note body inside an embedded frame on some flows, so
      // page.evaluate() against the main frame alone can return only the
      // host page's chrome (~84 chars on 2026-05-07) while the rendered
      // note sits in a child frame.
      const measureRichness = async (p: import('playwright').Page): Promise<number> => {
        let max = 0;
        for (const frame of p.frames()) {
          try {
            const len = (await frame.evaluate(
              `((document.body && document.body.textContent) || '').length`,
            )) as number;
            if (typeof len === 'number' && len > max) max = len;
          } catch {
            // detached/cross-origin frames throw — ignore and continue.
          }
        }
        return max;
      };

      const matches = context.pages().filter((p) => p.url() === url);
      let page;
      let isExisting = false;
      if (matches.length > 0) {
        let best = matches[0];
        let bestLen = -1;
        for (const candidate of matches) {
          const len = await measureRichness(candidate).catch(() => 0);
          if (len > bestLen) {
            bestLen = len;
            best = candidate;
          }
        }
        page = best;
        isExisting = true;
      } else {
        page = await context.newPage();
      }
      try {
        if (!isExisting) {
          // 'networkidle' waits for the network to stay quiet for 500ms,
          // which on a React SPA means the bundle has finished loading
          // and the initial data fetches have settled. Far more reliable
          // than 'domcontentloaded' for SPAs. Capped at the hydration
          // budget so we don't block forever if the page never quiesces.
          await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: cfg.hydration_wait_ms,
          }).catch(async () => {
            // If 'networkidle' times out, fall back to 'domcontentloaded'
            // and let the polling loop below decide whether the body
            // hydrated. Better to capture something than to fail outright.
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          });
        }
        // Polling loop: returns early when the body grows past the
        // hydrated threshold and "Loading note" is gone. For an existing
        // tab this typically returns on the first probe.
        await waitForHydration(page, cfg.hydration_wait_ms);

        // Walk every frame on the page (main + iframes) and pick the one
        // with the longest textContent. Lite share renders the rendered
        // note inside a sub-frame on some flows; the main frame holds
        // only host chrome. Without this walk, page.evaluate against the
        // main frame would return ~84 chars while the rendered note sat
        // in a child frame the user could see.
        const frames = page.frames();
        let bestFrame = frames[0];
        let bestFrameLen = -1;
        for (const frame of frames) {
          try {
            const len = (await frame.evaluate(
              `((document.body && document.body.textContent) || '').length`,
            )) as number;
            if (typeof len === 'number' && len > bestFrameLen) {
              bestFrameLen = len;
              bestFrame = frame;
            }
          } catch {
            // detached/cross-origin/closed frames throw; skip.
          }
        }

        // textContent reads ALL DOM text regardless of CSS visibility,
        // including content that innerText filters out via display:none /
        // visibility:hidden / overlay tricks. Combined with the iframe
        // walk above, this picks up Lite share's rendered note.
        const extracted = (await bestFrame.evaluate(`(() => {
          const selectors = ${JSON.stringify(NOTE_SELECTORS)};
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            const text = el && el.textContent ? el.textContent.trim() : '';
            if (text.length > 0) {
              const titleEl = el.querySelector('h1');
              return {
                title: (titleEl && titleEl.textContent ? titleEl.textContent.trim() : ''),
                body: el.textContent,
              };
            }
          }
          return {
            title: document.title || '',
            body: (document.body && document.body.textContent) || '',
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
        // Only close pages WE opened. Closing the user's tab would be
        // hostile (they'd lose their place every poll cycle) and would
        // also defeat the existing-tab reuse path on the next poll.
        if (!isExisting) {
          await page.close().catch(() => {});
        }
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
  if (body.length < HYDRATED_BODY_MIN_CHARS) {
    // Any body shorter than the hydration threshold IS the placeholder
    // when it also contains chrome strings the Lite share renders before
    // the actual note paints. Real Bohen prep notes are several hundred
    // to several thousand chars, so this is conservatively safe — a
    // legitimate note that happens to be short can still be authored,
    // just not via the lite share path.
    //
    // Strings observed across the 2026-05-07 / 2026-05-05 captures:
    //   - "Welcome to Evernote Lite editor!"  (initial paint)
    //   - "Loading note..."                   (handled above)
    //   - "Sign in"                           (login chrome)
    //   - "Open in app"                       (app-promo chrome)
    //   - "Last sync"                         (sync banner)
    //   - "Reload page"                       (offline / stale chrome)
    if (
      body.includes('Welcome to Evernote Lite editor') ||
      body.includes('Sign in') ||
      body.includes('Open in app') ||
      body.includes('Last sync') ||
      body.includes('Reload page')
    ) {
      return true;
    }
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
    // textContent vs innerText: see doFetch comment for why textContent —
    // CSS overlays in the Lite share viewer can hide rendered note text
    // from innerText while leaving it in the DOM. Polling against
    // textContent makes the "is it hydrated yet?" check honest.
    const probe = (await page.evaluate(`((document.body && document.body.textContent) || '')`)) as string;
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
