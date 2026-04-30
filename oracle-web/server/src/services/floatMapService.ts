import { config } from '../config.js';

export interface FloatMapEntry {
  symbol: string;
  rotation: number | null;
  last: number | null;
  floatMillions: number | null;
  nextOracleSupport: number | null;
  nextOracleResistance: number | null;
}

export interface FloatMapSnapshot {
  fetchedAt: string | null;
  entries: FloatMapEntry[];
  error: string | null;
}

const HEADER_ROWS = ['SYMBOL', 'ROTATION', 'LAST', 'FLOAT', 'NEXT ORACLE SUPPORT', 'NEXT ORACLE RESISTANCE'];
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,6}$/;
const ROTATION_RE = /^\d+(?:\.\d+)?x$/;
const FLOAT_RE = /^\d+(?:\.\d+)?[kKmMbB]$/;

function parseRotation(raw: string): number | null {
  const match = raw.match(/^(\d+(?:\.\d+)?)x$/);
  return match ? Number(match[1]) : null;
}

function parseFloatShares(raw: string): number | null {
  // Returns float in millions, matching existing StockState.floatMillions.
  const match = raw.match(/^(\d+(?:\.\d+)?)([kKmMbB])$/);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'k') return n / 1000;
  if (unit === 'm') return n;
  if (unit === 'b') return n * 1000;
  return null;
}

function parseNumeric(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the FloatMAP iframe's rendered innerText. The text is a sequence of
 * non-empty lines: a 6-row header (SYMBOL, ROTATION, LAST, FLOAT, NEXT ORACLE
 * SUPPORT, NEXT ORACLE RESISTANCE), then each ticker is six consecutive data
 * lines. Below the table the page appends a per-symbol volume-at-price block
 * (e.g. "ALBT - LEVELS" followed by number pairs) — we stop as soon as a
 * six-line group fails schema validation, which cuts that block off cleanly.
 */
export function parseFloatMapText(raw: string): FloatMapEntry[] {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const headerStart = lines.findIndex((line) => line === HEADER_ROWS[0]);
  if (headerStart === -1) return [];
  for (let i = 0; i < HEADER_ROWS.length; i++) {
    if (lines[headerStart + i] !== HEADER_ROWS[i]) return [];
  }

  const entries: FloatMapEntry[] = [];
  for (let i = headerStart + HEADER_ROWS.length; i + 5 < lines.length; i += 6) {
    const [symbol, rotation, last, float, support, resistance] = lines.slice(i, i + 6);
    if (!SYMBOL_RE.test(symbol) || !ROTATION_RE.test(rotation) || !FLOAT_RE.test(float)) {
      break;
    }
    entries.push({
      symbol,
      rotation: parseRotation(rotation),
      last: parseNumeric(last),
      floatMillions: parseFloatShares(float),
      nextOracleSupport: parseNumeric(support),
      nextOracleResistance: parseNumeric(resistance),
    });
  }
  return entries;
}

export class FloatMapService {
  private snapshot: FloatMapSnapshot = { fetchedAt: null, entries: [], error: null };
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlight = false;

  getSnapshot(): FloatMapSnapshot {
    return this.snapshot;
  }

  /**
   * Lookup a single ticker. Returns null when the symbol is absent OR the
   * snapshot is older than max_age_seconds — callers must treat absent and
   * stale identically so a silent scraper outage doesn't leak yesterday's
   * rotation into today's decisions.
   */
  getEntryForSymbol(symbol: string, maxAgeSeconds: number): FloatMapEntry | null {
    if (this.isStale(maxAgeSeconds)) return null;
    return this.snapshot.entries.find((e) => e.symbol === symbol) ?? null;
  }

  isStale(maxAgeSeconds: number): boolean {
    if (!this.snapshot.fetchedAt) return true;
    const ageMs = Date.now() - new Date(this.snapshot.fetchedAt).getTime();
    return ageMs > maxAgeSeconds * 1000;
  }

  async start(): Promise<void> {
    if (!config.bot.floatmap.enabled) return;
    if (this.pollTimer) return;
    const intervalMs = config.bot.floatmap.poll_interval_sec * 1000;
    // Fire-and-forget the first poll — a slow goto/hydration should not block
    // server boot. The recurring timer keeps running regardless of failures.
    this.pollOnce().catch((err) => {
      console.warn('floatmap initial poll failed:', err instanceof Error ? err.message : err);
    });
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => {
        console.warn('floatmap poll failed:', err instanceof Error ? err.message : err);
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
      const text = await this.fetchFrameText();
      const entries = parseFloatMapText(text);
      this.snapshot = { fetchedAt: new Date().toISOString(), entries, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = { ...this.snapshot, error: msg };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Attach to the debug Chrome and grab the FloatMAP iframe's rendered text.
   * Reuses an existing tab at the FloatMAP URL when present so repeated polls
   * don't flash a new tab open-and-closed in the user's Chrome window.
   */
  private async fetchFrameText(): Promise<string> {
    const { chromium } = await import('playwright');
    const fm = config.bot.floatmap;
    const browser = await chromium.connectOverCDP(config.bot.playwright.chrome_cdp_url);
    try {
      const contexts = browser.contexts();
      if (contexts.length === 0) throw new Error('no Chrome contexts attached');
      const context = contexts[0];
      const existing = context.pages().find((p) => p.url().includes(fm.url));
      const page = existing ?? (await context.newPage());
      if (!existing) {
        await page.goto(fm.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      // Poll for the iframe instead of a fixed sleep — the Amplify app's
      // hydration time varies (5-15+ s observed). Bail out at frame_max_wait_ms.
      const deadline = Date.now() + fm.frame_max_wait_ms;
      let frame = page.frames().find((f) => f.url().includes(fm.frame_url_contains));
      while (!frame && Date.now() < deadline) {
        await page.waitForTimeout(500);
        frame = page.frames().find((f) => f.url().includes(fm.frame_url_contains));
      }
      if (!frame) throw new Error(`no frame matching "${fm.frame_url_contains}" within ${fm.frame_max_wait_ms} ms`);
      // Once the frame is attached, give it a beat to render the table body
      // before pulling innerText — frame existence != content rendered.
      await page.waitForTimeout(fm.hydration_wait_ms);
      return (await frame.evaluate(`((document.body && document.body.innerText) || '')`)) as string;
    } finally {
      await browser.close();
    }
  }
}

export const floatMapService = new FloatMapService();
