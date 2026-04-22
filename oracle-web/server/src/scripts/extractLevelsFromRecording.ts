import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { config } from '../config.js';
import type { CycleRecord } from '../services/recordingService.js';

const LEVELS_DIR = 'F:/oracle_data/levels';

interface LevelEntry {
  stopPrice: number | null;
  buyZonePrice: number | null;
  sellZonePrice: number | null;
  lastPrice: number | null;
  floatMillions: number | null;
}

function parseArgs(): { day: string } {
  const args = process.argv.slice(2);
  const dayIdx = args.indexOf('--day');
  if (dayIdx === -1 || !args[dayIdx + 1]) {
    console.error('Usage: tsx extractLevelsFromRecording.ts --day YYYY-MM-DD');
    process.exit(1);
  }
  const day = args[dayIdx + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error(`Invalid --day: ${day}`);
    process.exit(1);
  }
  return { day };
}

function main(): void {
  const { day } = parseArgs();
  const recordingPath = resolve(config.recording.dir, `${day}.jsonl`);
  const raw = readFileSync(recordingPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  const symbolPattern = /^[A-Z]{1,5}(\.[A-Z])?$/;
  const tickers: Record<string, LevelEntry> = {};
  for (const line of lines) {
    const cycle = JSON.parse(line) as CycleRecord;
    for (const item of cycle.items) {
      if (!symbolPattern.test(item.symbol)) continue;
      const existing = tickers[item.symbol];
      const next: LevelEntry = {
        stopPrice: item.stopPrice,
        buyZonePrice: item.buyZonePrice,
        sellZonePrice: item.sellZonePrice,
        lastPrice: item.lastPrice,
        floatMillions: item.floatMillions,
      };
      // Prefer the first cycle's levels but fill in any nulls from later cycles.
      if (!existing) {
        tickers[item.symbol] = next;
      } else {
        tickers[item.symbol] = {
          stopPrice: existing.stopPrice ?? next.stopPrice,
          buyZonePrice: existing.buyZonePrice ?? next.buyZonePrice,
          sellZonePrice: existing.sellZonePrice ?? next.sellZonePrice,
          lastPrice: existing.lastPrice ?? next.lastPrice,
          floatMillions: existing.floatMillions ?? next.floatMillions,
        };
      }
    }
  }

  const outPath = resolve(LEVELS_DIR, `${day}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ day, tickers }, null, 2), 'utf-8');
  console.error(`wrote ${Object.keys(tickers).length} tickers to ${outPath}`);
}

main();
