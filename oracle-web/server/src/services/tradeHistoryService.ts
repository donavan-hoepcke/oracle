import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';
import type { CycleRecord } from './recordingService.js';
import type { TradeLedgerEntry } from './executionService.js';

export interface TradeHistoryOptions {
  maxTrades?: number;
  maxCalendarDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class TradeHistoryService {
  constructor(private readonly dir: string = config.recording.dir) {}

  async getRecentTrades(
    symbol: string,
    setup: string,
    now: Date,
    options: TradeHistoryOptions = {},
  ): Promise<TradeLedgerEntry[]> {
    const maxTrades = options.maxTrades ?? config.execution.regime.trade_history_max_trades;
    const maxCalendarDays =
      options.maxCalendarDays ?? config.execution.regime.trade_history_max_calendar_days;

    if (!existsSync(this.dir)) return [];

    const nowMs = now.getTime();
    const windowStartMs = nowMs - maxCalendarDays * DAY_MS;
    const nowDay = now.toISOString().slice(0, 10);

    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }

    const eligibleDays = files
      .map((name) => {
        const match = DAY_FILE_RE.exec(name);
        return match ? match[1] : null;
      })
      .filter((d): d is string => {
        if (!d) return false;
        if (d >= nowDay) return false;
        const dayMs = new Date(`${d}T00:00:00Z`).getTime();
        return dayMs >= windowStartMs;
      })
      .sort();

    const collected: TradeLedgerEntry[] = [];
    for (const day of eligibleDays) {
      const filePath = resolve(this.dir, `${day}.jsonl`);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      // Each JSONL file is append-only: every cycle record includes ALL closed
      // trades accumulated so far that day.  The last valid record in the file
      // is therefore the authoritative final snapshot for the day.  We read the
      // last non-empty, parseable line and use its closedTrades list directly.
      // There is no cross-day duplication because each day's file is independent.
      let lastSnapshot: TradeLedgerEntry[] | null = null;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let record: CycleRecord;
        try {
          record = JSON.parse(line) as CycleRecord;
        } catch {
          continue;
        }
        lastSnapshot = record.closedTrades ?? [];
      }
      if (lastSnapshot !== null) {
        for (const trade of lastSnapshot) {
          if (trade.symbol !== symbol) continue;
          if (trade.strategy !== setup) continue;
          collected.push(trade);
        }
      }
    }

    return collected.slice(-maxTrades);
  }
}

export const tradeHistoryService = new TradeHistoryService();
