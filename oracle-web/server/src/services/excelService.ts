import { watch, FSWatcher } from 'chokidar';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { format, parse } from 'date-fns';
import * as XLSX from 'xlsx';
import { config } from '../config.js';
import { alertService } from './alertService.js';

export interface WatchlistItem {
  symbol: string;
  targetPrice: number;
  resistance: number | null;
}

export type WatchlistChangeCallback = (items: WatchlistItem[]) => void;

class ExcelService {
  private watcher: FSWatcher | null = null;
  private currentWatchlist: WatchlistItem[] = [];
  private changeCallbacks: WatchlistChangeCallback[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;

  getTodayFilename(): string {
    const today = new Date();
    return format(today, 'dd-MMM-yyyy') + '.xlsx';
  }

  getTodayFilePath(): string {
    return join(config.watchlist_dir, this.getTodayFilename());
  }

  findLatestExcelFile(): string | null {
    if (!existsSync(config.watchlist_dir)) {
      console.warn(`Watchlist directory does not exist: ${config.watchlist_dir}`);
      return null;
    }

    const files = readdirSync(config.watchlist_dir)
      .filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'))
      .sort()
      .reverse();

    if (files.length === 0) {
      return null;
    }

    // Try today's file first
    const todayFile = this.getTodayFilename();
    if (files.includes(todayFile)) {
      return join(config.watchlist_dir, todayFile);
    }

    // Fall back to most recent file
    return join(config.watchlist_dir, files[0]);
  }

  parseExcelFile(filePath: string): WatchlistItem[] {
    if (!existsSync(filePath)) {
      console.warn(`Excel file not found: ${filePath}`);
      return [];
    }

    try {
      const buffer = readFileSync(filePath);
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      // Convert to array of arrays
      const data: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: undefined,
      });

      const items: WatchlistItem[] = [];

      // Skip header row, start from row 1
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (!row) continue;

        // Column E (index 4) = Symbol, Column F (index 5) = Long Signal (target price), Column H (index 7) = Resistance
        const symbol = row[4];
        const targetPrice = row[5];
        const resistance = row[7];

        if (
          typeof symbol === 'string' &&
          symbol.trim() &&
          typeof targetPrice === 'number' &&
          !isNaN(targetPrice)
        ) {
          items.push({
            symbol: symbol.trim().toUpperCase(),
            targetPrice,
            resistance: typeof resistance === 'number' && !isNaN(resistance) ? resistance : null,
          });
        }
      }

      console.log(`Parsed ${items.length} items from ${filePath}`);
      return items;
    } catch (err) {
      console.error(`Error parsing Excel file: ${err}`);
      return [];
    }
  }

  loadWatchlist(): WatchlistItem[] {
    const filePath = this.findLatestExcelFile();
    if (!filePath) {
      console.warn('No Excel files found in watchlist directory');
      this.currentWatchlist = [];
      return [];
    }

    this.currentWatchlist = this.parseExcelFile(filePath);
    return this.currentWatchlist;
  }

  getWatchlist(): WatchlistItem[] {
    return this.currentWatchlist;
  }

  onWatchlistChange(callback: WatchlistChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  private notifyChange(): void {
    for (const callback of this.changeCallbacks) {
      callback(this.currentWatchlist);
    }
  }

  startWatching(): void {
    if (this.watcher) {
      return;
    }

    if (!existsSync(config.watchlist_dir)) {
      console.warn(`Cannot watch non-existent directory: ${config.watchlist_dir}`);
      return;
    }

    const pattern = join(config.watchlist_dir, '*.xlsx');

    this.watcher = watch(pattern, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    const handleChange = (filePath: string) => {
      // Ignore temp files
      if (filePath.includes('~$')) {
        return;
      }

      // Debounce rapid changes
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        console.log(`Detected change in: ${filePath}`);
        this.loadWatchlist();
        alertService.resetAlerts();
        this.notifyChange();
      }, 1000);
    };

    this.watcher.on('add', handleChange);
    this.watcher.on('change', handleChange);
    this.watcher.on('unlink', handleChange);

    console.log(`Watching for Excel changes in: ${config.watchlist_dir}`);
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

export const excelService = new ExcelService();
