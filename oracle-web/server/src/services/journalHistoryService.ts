import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { formatInTimeZone } from 'date-fns-tz';
import { config } from '../config.js';
import { CycleRecord } from './recordingService.js';
import { TradeLedgerEntry } from './executionService.js';

export interface HistoricalJournalDay {
  date: string;
  closed: TradeLedgerEntry[];
  lastCycleAt: string | null;
}

function readLastNonEmptyLine(filePath: string): string | null {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0) return line;
  }
  return null;
}

export class JournalHistoryService {
  listDays(): string[] {
    const dir = config.recording.dir;
    const today = formatInTimeZone(new Date(), config.market_hours.timezone, 'yyyy-MM-dd');
    const days = new Set<string>([today]);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (m) days.add(m[1]);
      }
    }
    return [...days].sort((a, b) => b.localeCompare(a));
  }

  getDay(date: string): HistoricalJournalDay | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const filePath = resolve(config.recording.dir, `${date}.jsonl`);
    if (!existsSync(filePath)) return null;
    const lastLine = readLastNonEmptyLine(filePath);
    if (!lastLine) return { date, closed: [], lastCycleAt: null };
    const cycle: CycleRecord = JSON.parse(lastLine);
    return {
      date,
      closed: cycle.closedTrades,
      lastCycleAt: cycle.ts,
    };
  }
}

export const journalHistoryService = new JournalHistoryService();
