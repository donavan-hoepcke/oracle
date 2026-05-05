import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import type { TradeLedgerEntry } from './executionService.js';

/**
 * Eagerly-persisted, append-only ledger file for the current trading day.
 *
 * The bot also persists closed trades inside the per-cycle JSONL via
 * `recordingService.writeCycle`, which runs on the 30s polling tick. That's
 * fine for normal operation but leaves a 30-second window where a close
 * exists in memory and not on disk; if the process dies or tsx-watch
 * reloads inside that window, the close is silently lost on restart.
 *
 * This module closes that window by writing every ledger entry to disk
 * the moment it's pushed in-memory. Per-day filename keeps the file small
 * (typical: ≤ 8 trades/day × ~400 bytes ≈ 4 KB), and an append-only format
 * means concurrent writes from multiple polling cycles can't corrupt
 * earlier entries.
 *
 * Hydration on startup reads this file before the cycle JSONL so the
 * eager log is the source of truth for today; the cycle JSONL is the
 * fallback for older days written before this module existed.
 */

function ledgerPath(date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return resolve(config.recording.dir, `ledger-${day}.jsonl`);
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Append one ledger entry to today's eager-write file.
 * `Date` fields are serialized as ISO strings so the JSONL is human-readable
 * and matches the shape produced by the cycle recorder.
 */
export function appendLedgerEntry(entry: TradeLedgerEntry, now: Date = new Date()): void {
  const path = ledgerPath(now);
  ensureDir(path);
  const serialized = {
    ...entry,
    entryTime:
      entry.entryTime instanceof Date ? entry.entryTime.toISOString() : entry.entryTime,
    exitTime: entry.exitTime instanceof Date ? entry.exitTime.toISOString() : entry.exitTime,
  };
  appendFileSync(path, JSON.stringify(serialized) + '\n', 'utf-8');
}

/**
 * Read all ledger entries persisted for the given date (defaults to today).
 * Returns an empty array if the file is missing or empty. Malformed lines
 * are skipped with a warn — better to lose one entry than to fail the
 * entire startup hydration.
 */
export function readLedgerForDay(date: Date = new Date()): TradeLedgerEntry[] {
  const path = ledgerPath(date);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const entries: TradeLedgerEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TradeLedgerEntry);
    } catch (err) {
      console.warn(
        `ledgerStore: skipping malformed line in ${path}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return entries;
}

// Exported for tests that need to assert on / clean up the on-disk file.
export const __testing = { ledgerPath };
