import { existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WatchlistItem {
  symbol: string;
  targetPrice: number;
  resistance: number | null;
  oracleFields?: Record<string, string>;
  scannerPrice?: number | null;
  stockDataValue?: number | null;
  stopLossPct?: number | null;
  stopPrice?: number | null;
  longPrice?: number | null;
  buyZonePrice?: number | null;
  sellZonePrice?: number | null;
  profitDeltaPct?: number | null;
  maxVolume?: number | null;
  lastVolume?: number | null;
  lastPrice?: number | null;
  premarketVolume?: number | null;
  relativeVolume?: number | null;
  floatMillions?: number | null;
  gapPercent?: number | null;
}

export interface BotStatus {
  isRunning: boolean;
  lastSync: string | null;
  symbolCount: number;
  lastError: string | null;
}

export interface PlaywrightDebugReport {
  href: string;
  title: string;
  bodySnippet: string;
  counts: Record<string, number>;
}

const REQUIRED_TICKER_COUNT = 20;
const TICKER_SYMBOL_RE = /^[A-Z]{1,5}$/;

type WatchlistCallback = (items: WatchlistItem[]) => void;

interface BrowserLike {
  newContext: (options?: { storageState?: string }) => Promise<BrowserContextLike>;
  contexts: () => BrowserContextLike[];
  close: () => Promise<void>;
}

interface BrowserContextLike {
  newPage: () => Promise<PageLike>;
  pages: () => PageLike[];
  storageState: (options?: { path?: string }) => Promise<unknown>;
  close: () => Promise<void>;
}

interface PageLike {
  goto: (url: string, options?: { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }) => Promise<void>;
  waitForSelector: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
  fill: (selector: string, value: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  url: () => string;
  bringToFront: () => Promise<void>;
  frames: () => FrameLike[];
  $$eval: <T, A = undefined>(
    selector: string,
    pageFunction: (
      nodes: Array<{
        textContent: string | null;
        getAttribute: (name: string) => string | null;
        querySelector: (selector: string) => { textContent: string | null } | null;
      }>,
      arg: A
    ) => T,
    arg?: A
  ) => Promise<T>;
}

interface FrameLike {
  url: () => string;
  $$eval: <T, A = undefined>(
    selector: string,
    pageFunction: (
      nodes: Array<{
        textContent: string | null;
        getAttribute: (name: string) => string | null;
        querySelector: (selector: string) => { textContent: string | null } | null;
      }>,
      arg: A
    ) => T,
    arg?: A
  ) => Promise<T>;
}

interface EvalScopeLike {
  $$eval: <T, A = undefined>(
    selector: string,
    pageFunction: (
      nodes: Array<{
        textContent: string | null;
        getAttribute: (name: string) => string | null;
        querySelector: (selector: string) => { textContent: string | null } | null;
      }>,
      arg: A
    ) => T,
    arg?: A
  ) => Promise<T>;
}

interface ScrapedRow {
  symbol: string;
  rawTargetPrice: string;
  rawResistance: string;
  oracleFields: Record<string, string>;
}

function isLikelyTickerSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return TICKER_SYMBOL_RE.test(symbol.trim().toUpperCase());
}

function hasInvalidZoneOrdering(item: WatchlistItem): boolean {
  return (
    item.stopPrice !== null &&
    item.stopPrice !== undefined &&
    item.buyZonePrice !== null &&
    item.buyZonePrice !== undefined &&
    item.sellZonePrice !== null &&
    item.sellZonePrice !== undefined &&
    !(item.stopPrice < item.buyZonePrice && item.buyZonePrice < item.sellZonePrice)
  );
}

export function sanitizeWatchlistItems(items: WatchlistItem[]): WatchlistItem[] {
  return items.filter((item) => {
    const symbol = item.symbol?.trim().toUpperCase();
    if (!isLikelyTickerSymbol(symbol)) {
      return false;
    }

    if (hasInvalidZoneOrdering(item)) {
      console.warn(
        `Dropping ${symbol}: invalid zone ordering stop=${item.stopPrice} buy=${item.buyZonePrice} sell=${item.sellZonePrice}`,
      );
      return false;
    }

    return true;
  });
}

class PlaywrightTickerSource {
  private browser: BrowserLike | null = null;
  private context: BrowserContextLike | null = null;
  private page: PageLike | null = null;
  private attachedToExistingChrome = false;
  private lastSchemaSignature: string | null = null;

  async start(): Promise<void> {
    if (this.page) return;

    // Playwright is lazily loaded so the dependency remains optional.
    const { chromium } = await import('playwright');

    const useExistingChrome = config.bot.playwright.use_existing_chrome;

    if (useExistingChrome) {
      const cdpUrl = config.bot.playwright.chrome_cdp_url;
      try {
        this.browser = await chromium.connectOverCDP(cdpUrl);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Unable to attach to existing Chrome at ${cdpUrl}. Start Chrome with remote debugging enabled (for example: chrome.exe --remote-debugging-port=9222), then retry. Details: ${detail}`
        );
      }
      this.attachedToExistingChrome = true;

      const existingContexts = this.browser.contexts();
      this.context = existingContexts[0] ?? (await this.browser.newContext());
      this.page = this.findExistingOraclePage(this.context) ?? (await this.context.newPage());

      await this.bootstrapPage(this.page);

      if (config.bot.playwright.persist_session) {
        await this.saveStorageState();
      }

      return;
    }

    this.attachedToExistingChrome = false;

    this.browser = await chromium.launch({
      headless: config.bot.playwright.headless,
    });

    const sessionStatePath = this.getSessionStatePath();
    const usePersistedState = config.bot.playwright.persist_session && existsSync(sessionStatePath);
    this.context = await this.browser.newContext(usePersistedState ? { storageState: sessionStatePath } : undefined);
    this.page = await this.context.newPage();
    await this.bootstrapPage(this.page);

    if (config.bot.playwright.persist_session) {
      await this.saveStorageState();
    }
  }

  async stop(): Promise<void> {
    this.page = null;
    if (this.context && !this.attachedToExistingChrome) {
      await this.context.close();
      this.context = null;
    } else {
      this.context = null;
    }

    if (this.browser && !this.attachedToExistingChrome) {
      await this.browser.close();
      this.browser = null;
    } else {
      this.browser = null;
    }

    this.attachedToExistingChrome = false;
  }

  async fetchTickers(): Promise<WatchlistItem[]> {
    if (!this.page) {
      throw new Error('Playwright source not initialized');
    }

    const playwrightConfig = config.bot.playwright;

    const scopes: EvalScopeLike[] = [this.page, ...this.page.frames()];
    const deduped = new Map<string, WatchlistItem>();

    for (const scope of scopes) {
      if (playwrightConfig.row_selector) {
        const rows = await this.extractRows(scope, playwrightConfig.row_selector, {
          symbol_selector: playwrightConfig.symbol_selector,
          target_selector: playwrightConfig.target_selector,
          resistance_selector: playwrightConfig.resistance_selector,
        });

        for (const row of rows) {
          const normalizedFields = this.normalizeOracleFields(row.oracleFields);
          this.validateOracleSchema(normalizedFields);

          // Column mapping (detail header row from Oracle tool):
          //   Symbol | Stop Loss | Buy Zone | Profit Delta | Sell Zone | Max | Last | % Chg | Volume | Float | Mk. Cap.
          const stopPrice = this.pickMetric(normalizedFields, ['stop_loss', 'stop']);
          const buyZonePrice = this.pickMetric(normalizedFields, ['buy_zone', 'buy zone']);
          const sellZonePrice = this.pickMetric(normalizedFields, ['sell_zone', 'sell zone']);
          const lastPrice = this.pickMetric(normalizedFields, ['last', 'last_price', 'last price', 'price', 'close']);
          const profitDeltaPct = this.pickMetric(normalizedFields, ['profit_delta', 'profit delta']);
          const maxVolume = this.pickMetric(normalizedFields, ['max_volume', 'max volume', 'max']);
          const premarketVolume = this.pickMetric(normalizedFields, ['volume', 'premarket_volume', 'premarket volume']);
          const floatMillions = this.pickMetric(normalizedFields, ['float', 'float_m', 'float m']);
          const gapPercent = this.pickMetric(normalizedFields, ['chg', 'gap', 'gap_pct', 'pct_change']);

          // Derived fields (not from Oracle columns directly)
          const scannerPrice = lastPrice;
          const stockDataValue: number | null = null;
          const stopLossPct: number | null = null;
          const lastVolume: number | null = null;
          const longPrice = buyZonePrice;
          const relativeVolume: number | null = null;

          const explicitTarget = this.parseNumericValue(row.rawTargetPrice);
          const explicitResistance = this.parseNumericValue(row.rawResistance);
          const targetPrice = explicitTarget ?? buyZonePrice ?? 0;
          const resistance = explicitResistance ?? sellZonePrice ?? null;

          const item: WatchlistItem = {
            symbol: row.symbol,
            targetPrice,
            resistance,
            oracleFields: normalizedFields,
            scannerPrice,
            stockDataValue,
            stopLossPct,
            stopPrice,
            longPrice,
            buyZonePrice,
            sellZonePrice,
            profitDeltaPct,
            maxVolume,
            lastVolume,
            lastPrice,
            premarketVolume: premarketVolume ?? lastVolume,
            relativeVolume,
            floatMillions,
            gapPercent,
          };

          if (!isLikelyTickerSymbol(item.symbol)) {
            continue;
          }
          if (hasInvalidZoneOrdering(item)) {
            console.warn(
              `Dropping ${item.symbol}: invalid zone ordering stop=${item.stopPrice} buy=${item.buyZonePrice} sell=${item.sellZonePrice}`,
            );
            continue;
          }

          deduped.set(item.symbol, item);
        }
      }

      const symbols = await this.extractSymbols(scope, playwrightConfig.symbols_selector);
      for (const symbol of symbols) {
        if (!deduped.has(symbol)) {
          deduped.set(symbol, {
            symbol,
            targetPrice: 0,
            resistance: null,
          });
        }
      }
    }

    return Array.from(deduped.values());
  }

  private async extractRows(
    scope: EvalScopeLike,
    rowSelector: string,
    selectors: { symbol_selector: string; target_selector: string; resistance_selector: string }
  ): Promise<ScrapedRow[]> {
    if (!rowSelector) return [];

    return scope.$$eval(
      rowSelector,
      (nodes, cfgArg) => {
        const cfg = cfgArg as {
          symbol_selector: string;
          target_selector: string;
          resistance_selector: string;
        };

        const rowsResult: ScrapedRow[] = [];
        for (const node of nodes) {
          const table = (node as Element).closest('table');
          // Oracle tables may have a grouped top header row plus a detail row.
          // Only the last thead row matches the data columns 1:1.
          const headerRows = table ? Array.from(table.querySelectorAll('thead tr')) : [];
          const lastHeaderRow = headerRows.length > 0 ? headerRows[headerRows.length - 1] : null;
          const headerNodes = lastHeaderRow
            ? Array.from(lastHeaderRow.querySelectorAll('th, [role="columnheader"]')).map((th) => (th.textContent ?? '').trim())
            : [];

          const rowCells = Array.from((node as Element).querySelectorAll('td, th, [role="cell"], [role="gridcell"]'));
          const cellTexts = rowCells.map((cell) => (cell.textContent ?? '').trim());

          const fields: Record<string, string> = {};
          for (let i = 0; i < cellTexts.length; i++) {
            const key = (headerNodes[i] && headerNodes[i].length > 0 ? headerNodes[i] : `col_${i + 1}`).toLowerCase();
            fields[key] = cellTexts[i] ?? '';
          }

          let symbolText = '';
          if (cfg.symbol_selector) {
            const symbolEl = node.querySelector(cfg.symbol_selector);
            symbolText = (symbolEl?.textContent ?? '').trim();
          }

          if (!symbolText) {
            for (const value of cellTexts) {
              const match = (value ?? '').toUpperCase().match(/\b[A-Z]{1,5}\b/);
              if (match) {
                symbolText = match[0];
                break;
              }
            }
          }

          const symbol = symbolText.toUpperCase();
          if (!symbol) continue;

          let rawTargetPrice = '';
          if (cfg.target_selector) {
            const targetEl = node.querySelector(cfg.target_selector);
            rawTargetPrice = (targetEl?.textContent ?? '').trim();
          }

          let rawResistance = '';
          if (cfg.resistance_selector) {
            const resistanceEl = node.querySelector(cfg.resistance_selector);
            rawResistance = (resistanceEl?.textContent ?? '').trim();
          }

          rowsResult.push({
            symbol,
            rawTargetPrice,
            rawResistance,
            oracleFields: fields,
          });
        }

        return rowsResult;
      },
      selectors
    );
  }

  private async extractSymbols(scope: EvalScopeLike, selector: string): Promise<string[]> {
    if (!selector) return [];

    return scope.$$eval(selector, (nodes) => {
      const parsed = new Set<string>();
      for (const node of nodes) {
        const text = (node.textContent ?? '').trim().toUpperCase();
        if (!text) continue;

        const matches = text.match(/\b[A-Z]{1,5}\b/g) ?? [];
        for (const match of matches) {
          parsed.add(match);
        }
      }
      return Array.from(parsed);
    });
  }

  private normalizeOracleFields(fields: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    const keyCounts = new Map<string, number>();

    for (const [key, value] of Object.entries(fields)) {
      const baseKey = key
        .toLowerCase()
        .replace(/[\u2191\u2193]/g, '')
        .replace(/[^a-z0-9\s_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s/g, '_');

      if (!baseKey) continue;

      const seenCount = keyCounts.get(baseKey) ?? 0;
      keyCounts.set(baseKey, seenCount + 1);
      const cleanKey = seenCount === 0 ? baseKey : `${baseKey}_${seenCount + 1}`;
      normalized[cleanKey] = (value ?? '').trim();
    }

    // Semantic aliases for ambiguous scanner columns.
    if (!normalized.scanner_price) {
      const candidate = normalized.symbol_2;
      if (this.parseNumericValue(candidate) !== null) {
        normalized.scanner_price = candidate;
      }
    }

    if (!normalized.entry_price) {
      const candidate = normalized.buy_zone ?? normalized.long;
      if (candidate) {
        normalized.entry_price = candidate;
      }
    }

    return normalized;
  }

  private parseNumericValue(raw: string | null | undefined): number | null {
    if (!raw) return null;

    const text = raw.trim();
    if (!text || text === '-') return null;

    let scale = 1;
    const upper = text.toUpperCase();
    if (upper.endsWith('K')) scale = 1_000;
    if (upper.endsWith('M')) scale = 1_000_000;
    if (upper.endsWith('B')) scale = 1_000_000_000;

    const stripped = text
      .replace(/[,$\s]/g, '')
      .replace(/%/g, '')
      .replace(/[KMBkmb]$/, '');

    const parsed = Number.parseFloat(stripped);
    if (!Number.isFinite(parsed)) return null;
    return parsed * scale;
  }

  private pickMetric(fields: Record<string, string>, aliases: string[]): number | null {
    const entries = Object.entries(fields);
    const normalizedAliases = aliases.map((alias) => alias.toLowerCase().replace(/\s+/g, '_'));

    for (const [key, value] of entries) {
      const keyNormalized = key.toLowerCase();
      if (normalizedAliases.some((alias) => keyNormalized.includes(alias))) {
        const parsed = this.parseNumericValue(value);
        if (parsed !== null) return parsed;
      }
    }

    return null;
  }

  async debugPage(): Promise<PlaywrightDebugReport> {
    if (!this.page) {
      throw new Error('Playwright source not initialized');
    }

    return this.page.$$eval('body', () => {
      const selectorList = [
        'table',
        'table tbody tr',
        '[role="row"]',
        '[data-symbol]',
        '.symbol',
        '.ticker',
        '[class*="oracle"]',
        'iframe',
      ];

      const counts: Record<string, number> = {};
      for (const selector of selectorList) {
        counts[selector] = document.querySelectorAll(selector).length;
      }

      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();

      return {
        href: window.location.href,
        title: document.title,
        bodySnippet: bodyText.slice(0, 500),
        counts,
      };
    });
  }

  private async bootstrapPage(page: PageLike): Promise<void> {
    const playwrightConfig = config.bot.playwright;
    const currentUrl = page.url();

    const isOracleTab = !!playwrightConfig.data_page_url && currentUrl.includes(playwrightConfig.data_page_url);
    const isLoginTab = !!playwrightConfig.login_url && currentUrl.includes(playwrightConfig.login_url);

    if (!isOracleTab && !isLoginTab && playwrightConfig.start_url) {
      await page.goto(playwrightConfig.start_url, { waitUntil: 'domcontentloaded' });
    }

    await page.bringToFront();

    if (playwrightConfig.login_required) {
      await this.performLogin(page);
    }

    if (playwrightConfig.data_page_url && !page.url().includes(playwrightConfig.data_page_url)) {
      await page.goto(playwrightConfig.data_page_url, { waitUntil: 'domcontentloaded' });
    }

    const readySelector = playwrightConfig.wait_for_selector || playwrightConfig.row_selector || playwrightConfig.symbols_selector;
    if (readySelector) {
      try {
        await page.waitForSelector(readySelector, { timeout: 30000 });
      } catch (waitError) {
        // Some Oracle layouts render rows inside iframes, so the selector is never visible on the top-level page.
        // In that case, verify readiness by attempting a frame-aware extraction before failing startup.
        const fallbackItems = await this.fetchTickers().catch(() => [] as WatchlistItem[]);
        if (fallbackItems.length === 0) {
          throw waitError;
        }
      }
    }
  }

  private async performLogin(page: PageLike): Promise<void> {
    const playwrightConfig = config.bot.playwright;

    if (playwrightConfig.data_page_url && page.url().includes(playwrightConfig.data_page_url)) {
      // Already on Oracle page; session appears authenticated.
      return;
    }

    if (playwrightConfig.login_url && !page.url().includes(playwrightConfig.login_url)) {
      await page.goto(playwrightConfig.login_url, { waitUntil: 'domcontentloaded' });
    }

    if (playwrightConfig.manual_login) {
      const waitSelector = playwrightConfig.post_login_wait_selector || playwrightConfig.wait_for_selector || 'body';
      const timeoutMs = playwrightConfig.manual_login_timeout_sec * 1000;

      console.log(
        `Manual Playwright login enabled: use your existing Chrome tab to sign in, then open Oracle page within ${playwrightConfig.manual_login_timeout_sec}s.`
      );

      await page.waitForSelector(waitSelector, { timeout: timeoutMs });

      if (playwrightConfig.persist_session) {
        await this.saveStorageState();
      }

      return;
    }

    const username = process.env[playwrightConfig.username_env] ?? '';
    const password = process.env[playwrightConfig.password_env] ?? '';

    if (!username || !password) {
      throw new Error(
        `Playwright login is enabled but credentials are missing. Set ${playwrightConfig.username_env} and ${playwrightConfig.password_env}.`
      );
    }

    await page.waitForSelector(playwrightConfig.username_selector, { timeout: 30000 });
    await page.fill(playwrightConfig.username_selector, username);
    await page.fill(playwrightConfig.password_selector, password);
    await page.click(playwrightConfig.submit_selector);

    if (playwrightConfig.post_login_wait_selector) {
      await page.waitForSelector(playwrightConfig.post_login_wait_selector, { timeout: 30000 });
    }

    if (playwrightConfig.persist_session) {
      await this.saveStorageState();
    }
  }

  private getSessionStatePath(): string {
    const configuredPath = config.bot.playwright.session_state_path;
    if (isAbsolute(configuredPath)) {
      return configuredPath;
    }

    return resolve(__dirname, '../../', configuredPath);
  }

  private async saveStorageState(): Promise<void> {
    if (!this.context) return;

    const sessionStatePath = this.getSessionStatePath();
    mkdirSync(dirname(sessionStatePath), { recursive: true });
    await this.context.storageState({ path: sessionStatePath });
  }

  private findExistingOraclePage(context: BrowserContextLike): PageLike | null {
    const playwrightConfig = config.bot.playwright;
    const pages = context.pages();

    for (const page of pages) {
      const url = page.url();
      if (playwrightConfig.data_page_url && url.includes(playwrightConfig.data_page_url)) {
        return page;
      }
      if (playwrightConfig.login_url && url.includes(playwrightConfig.login_url)) {
        return page;
      }
      if (playwrightConfig.start_url && url.includes(playwrightConfig.start_url)) {
        return page;
      }
    }

    return null;
  }

  private validateOracleSchema(fields: Record<string, string>): void {
    const expected = config.bot.playwright.oracle_expected_columns.map((c) => c.toLowerCase());
    const observed = Object.keys(fields)
      .map((k) => k.toLowerCase())
      .filter((k) => k !== 'scanner_price' && k !== 'entry_price');

    const missing = expected.filter((k) => !observed.includes(k));
    const unexpected = observed.filter((k) => !expected.includes(k));

    const signature = JSON.stringify({ missing: [...missing].sort(), unexpected: [...unexpected].sort() });
    if (signature === this.lastSchemaSignature) {
      return;
    }

    this.lastSchemaSignature = signature;
    if (missing.length === 0 && unexpected.length === 0) {
      return;
    }

    const message =
      `Oracle schema drift detected. Missing: [${missing.join(', ') || 'none'}], ` +
      `Unexpected: [${unexpected.join(', ') || 'none'}].`;

    if (config.bot.playwright.oracle_schema_strict) {
      throw new Error(`${message} Strict mode is enabled.`);
    }

    console.warn(message);
  }
}

class TickerBotService {
  private readonly callbacks: WatchlistCallback[] = [];
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastSync: Date | null = null;
  private lastError: string | null = null;
  private currentItems: WatchlistItem[] = [];
  private readonly playwrightSource = new PlaywrightTickerSource();

  private normalizeToTwenty(items: WatchlistItem[]): WatchlistItem[] {
    const deduped = new Map<string, WatchlistItem>();

    for (const item of sanitizeWatchlistItems(items)) {
      const symbol = item.symbol?.trim().toUpperCase();
      if (!symbol) continue;
      if (!deduped.has(symbol)) {
        deduped.set(symbol, {
          ...item,
          symbol,
        });
      }
    }

    let normalized = Array.from(deduped.values());

    if (normalized.length > REQUIRED_TICKER_COUNT) {
      this.lastError =
        `Received ${normalized.length} symbols; using first ${REQUIRED_TICKER_COUNT}.`;
      normalized = normalized.slice(0, REQUIRED_TICKER_COUNT);
      return normalized;
    }

    if (normalized.length < REQUIRED_TICKER_COUNT) {
      this.lastError =
        `Expected ${REQUIRED_TICKER_COUNT} symbols, received ${normalized.length}.`;
    }

    return normalized;
  }

  onWatchlistChange(callback: WatchlistCallback): void {
    this.callbacks.push(callback);
  }

  getStatus(): BotStatus {
    return {
      isRunning: this.isRunning,
      lastSync: this.lastSync ? this.lastSync.toISOString() : null,
      symbolCount: this.currentItems.length,
      lastError: this.lastError,
    };
  }

  async start(): Promise<BotStatus> {
    if (this.isRunning) {
      return this.getStatus();
    }

    this.isRunning = true;
    this.lastError = null;

    await this.playwrightSource.start();
    await this.pullFromPlaywright();

    this.pollTimer = setInterval(() => {
      this.pullFromPlaywright().catch((err) => {
        this.lastError = err instanceof Error ? err.message : 'Unknown playwright polling error';
      });
    }, config.bot.poll_interval_sec * 1000);

    return this.getStatus();
  }

  async stop(): Promise<BotStatus> {
    if (!this.isRunning) {
      return this.getStatus();
    }

    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await this.playwrightSource.stop();

    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  async previewPlaywrightTickers(): Promise<WatchlistItem[]> {
    return this.withPlaywright(() => this.playwrightSource.fetchTickers());
  }

  async previewPlaywrightDebug(): Promise<PlaywrightDebugReport> {
    return this.withPlaywright(() => this.playwrightSource.debugPage());
  }

  private async withPlaywright<T>(action: () => Promise<T>): Promise<T> {
    const canReuse = this.isRunning;
    if (!canReuse) {
      await this.playwrightSource.start();
    }
    try {
      return await action();
    } finally {
      if (!canReuse) {
        await this.playwrightSource.stop();
      }
    }
  }

  private async pullFromPlaywright(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const items = await this.playwrightSource.fetchTickers();
    this.currentItems = this.normalizeToTwenty(items);
    this.lastSync = new Date();
    if (this.currentItems.length === REQUIRED_TICKER_COUNT) {
      this.lastError = null;
    }
    this.notify(this.currentItems);
  }

  private notify(items: WatchlistItem[]): void {
    for (const callback of this.callbacks) {
      callback(items);
    }
  }
}

export const tickerBotService = new TickerBotService();
