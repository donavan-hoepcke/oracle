import { resolve } from 'path';
import { existsSync } from 'fs';
import { config } from '../config.js';
import { backtestRunner } from '../services/backtestRunner.js';
import type { BacktestTrade } from '../services/backtestRunner.js';

function summarize(trades: BacktestTrade[]) {
  const closed = trades.filter((t) => t.exitReason);
  if (closed.length === 0) return { n: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgR: 0 };
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.length - wins;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const avgR = closed.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / closed.length;
  return { n: closed.length, wins, losses, winRate: wins / closed.length, totalPnl, avgR };
}

function fmtRow(label: string, s: ReturnType<typeof summarize>): string {
  return `  ${label.padEnd(24)}  n=${String(s.n).padStart(3)}  ${s.wins}W/${s.losses}L  winRate=${(s.winRate * 100).toFixed(0).padStart(3)}%  pnl=$${s.totalPnl.toFixed(2).padStart(8)}  avgR=${s.avgR.toFixed(2).padStart(5)}`;
}

const days = process.argv.slice(2);
if (days.length === 0) {
  console.error('Usage: tsx backtestBreakdown.ts <YYYY-MM-DD> [YYYY-MM-DD...]');
  process.exit(1);
}

const all: BacktestTrade[] = [];
for (const day of days) {
  const path = resolve(config.recording.dir, `${day}.jsonl`);
  if (!existsSync(path)) {
    console.error(`skipping ${day}: not found`);
    continue;
  }
  const r = backtestRunner.runDay(path);
  all.push(...r.trades);

  const dayAll = summarize(r.trades);
  const dayOrb = summarize(r.trades.filter((t) => t.strategy === 'orb_breakout'));
  const dayMom = summarize(r.trades.filter((t) => t.strategy === 'momentum_continuation'));
  console.log(`\n${day}:`);
  console.log(fmtRow('  all setups', dayAll));
  if (dayOrb.n > 0) console.log(fmtRow('  orb_breakout', dayOrb));
  if (dayMom.n > 0) console.log(fmtRow('  momentum_continuation', dayMom));
}

const totAll = summarize(all);
const totOrb = summarize(all.filter((t) => t.strategy === 'orb_breakout'));
const totMom = summarize(all.filter((t) => t.strategy === 'momentum_continuation'));
console.log(`\nAggregate over ${days.length} day(s):`);
console.log(fmtRow('  all setups', totAll));
if (totOrb.n > 0) console.log(fmtRow('  orb_breakout', totOrb));
if (totMom.n > 0) console.log(fmtRow('  momentum_continuation', totMom));

console.log('\nORB trades detail:');
for (const t of all.filter((x) => x.strategy === 'orb_breakout')) {
  const r = t.rMultiple?.toFixed(2) ?? 'n/a';
  const pnl = t.pnl?.toFixed(2) ?? 'n/a';
  console.log(
    `  ${t.symbol.padEnd(6)} entry=$${t.entryPrice.toFixed(3).padStart(7)} stop=$${t.initialStop.toFixed(3).padStart(7)} target=$${t.target.toFixed(3).padStart(7)}  exit=${t.exitReason?.padEnd(14)}  pnl=$${pnl.padStart(7)}  R=${r.padStart(6)}`,
  );
}
