import { config } from '../config.js';
import { excelService, WatchlistItem } from './excelService.js';

export type TickerSourceMode = 'excel' | 'playwright';

export interface BotStatus {
  isRunning: boolean;
  source: TickerSourceMode;
  lastSync: string | null;
  symbolCount: number;
  lastError: string | null;
}

type WatchlistCallback = (items: WatchlistItem[]) => void;

interface BrowserLike {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
}

interface PageLike {
  goto: (url: string, options?: { waitUntil?: string }) => Promise<void>;
  $$eval: <T>(
    selector: string,
    pageFunction: (nodes: Array<{ textContent: string | null }>) => T
  ) => Promise<T>;
}

class PlaywrightTickerSource {
  private browser: BrowserLike | null = null;
  private page: PageLike | null = null;

  async start(): Promise<void> {
    if (this.page) return;

    // Keep Playwright optional until this source is enabled by the user.
    const dynamicImport = new Function('m', 'return import(m)') as (
      moduleName: string
    ) => Promise<{ chromium: { launch: (opts: { headless: boolean }) => Promise<BrowserLike> } }>;
    const playwrightModule = await dynamicImport('playwright');
    const chromium = playwrightModule.chromium;

    this.browser = await chromium.launch({
      headless: config.bot.playwright.headless,
    });

    this.page = await this.browser.newPage();
    const startUrl = config.bot.playwright.start_url;
    if (startUrl) {
      await this.page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    }
  }

  async stop(): Promise<void> {
    this.page = null;
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async fetchTickers(): Promise<WatchlistItem[]> {
    if (!this.page) {
      throw new Error('Playwright source not initialized');
    }

    const selector = config.bot.playwright.symbols_selector;
    const symbols = await this.page.$$eval(selector, (nodes) => {
      const parsed = new Set<string>();
      for (const node of nodes) {
        const text = (node.textContent ?? '').trim().toUpperCase();
        if (!text) continue;

        // Extract ticker-like tokens from mixed text.
        const matches = text.match(/\b[A-Z]{1,5}\b/g) ?? [];
        for (const match of matches) {
          parsed.add(match);
        }
      }
      return Array.from(parsed);
    });

    return symbols.map((symbol: string) => ({
      symbol,
      targetPrice: 0,
      resistance: null,
    }));
  }
}

class TickerBotService {
  private readonly callbacks: WatchlistCallback[] = [];
  private source: TickerSourceMode = config.ticker_source;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastSync: Date | null = null;
  private lastError: string | null = null;
  private currentItems: WatchlistItem[] = [];
  private readonly playwrightSource = new PlaywrightTickerSource();

  constructor() {
    excelService.onWatchlistChange((items) => {
      if (!this.isRunning || this.source !== 'excel') return;
      this.currentItems = items;
      this.lastSync = new Date();
      this.lastError = null;
      this.notify(items);
    });
  }

  onWatchlistChange(callback: WatchlistCallback): void {
    this.callbacks.push(callback);
  }

  getStatus(): BotStatus {
    return {
      isRunning: this.isRunning,
      source: this.source,
      lastSync: this.lastSync ? this.lastSync.toISOString() : null,
      symbolCount: this.currentItems.length,
      lastError: this.lastError,
    };
  }

  async setSource(source: TickerSourceMode): Promise<BotStatus> {
    if (this.source === source) {
      return this.getStatus();
    }

    const wasRunning = this.isRunning;
    if (wasRunning) {
      await this.stop();
    }

    this.source = source;
    this.lastError = null;

    if (wasRunning) {
      await this.start();
    }

    return this.getStatus();
  }

  async start(): Promise<BotStatus> {
    if (this.isRunning) {
      return this.getStatus();
    }

    this.isRunning = true;
    this.lastError = null;

    if (this.source === 'excel') {
      this.currentItems = excelService.loadWatchlist();
      excelService.startWatching();
      this.lastSync = new Date();
      this.notify(this.currentItems);
      return this.getStatus();
    }

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

    if (this.source === 'excel') {
      excelService.stopWatching();
    } else {
      await this.playwrightSource.stop();
    }

    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  private async pullFromPlaywright(): Promise<void> {
    if (!this.isRunning || this.source !== 'playwright') {
      return;
    }

    const items = await this.playwrightSource.fetchTickers();
    this.currentItems = items;
    this.lastSync = new Date();
    this.lastError = null;
    this.notify(items);
  }

  private notify(items: WatchlistItem[]): void {
    for (const callback of this.callbacks) {
      callback(items);
    }
  }
}

export const tickerBotService = new TickerBotService();
