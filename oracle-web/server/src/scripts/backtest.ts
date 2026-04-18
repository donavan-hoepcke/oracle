import { resolve } from 'path';
import { existsSync } from 'fs';
import { config } from '../config.js';
import { backtestRunner } from '../services/backtestRunner.js';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    fail('Usage: npm run backtest -- <YYYY-MM-DD> [--starting-cash N]');
  }
  const tradingDay = args[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) {
    fail(`Invalid trading day: ${tradingDay} (expected YYYY-MM-DD)`);
  }

  let startingCash: number | undefined;
  let riskPerTrade: number | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--starting-cash' && args[i + 1]) {
      startingCash = Number(args[i + 1]);
      if (!Number.isFinite(startingCash) || startingCash <= 0) {
        fail(`Invalid --starting-cash: ${args[i + 1]}`);
      }
      i++;
    } else if (args[i] === '--risk-per-trade' && args[i + 1]) {
      riskPerTrade = Number(args[i + 1]);
      if (!Number.isFinite(riskPerTrade) || riskPerTrade <= 0) {
        fail(`Invalid --risk-per-trade: ${args[i + 1]}`);
      }
      i++;
    }
  }

  const filePath = resolve(config.recording.dir, `${tradingDay}.jsonl`);
  if (!existsSync(filePath)) {
    fail(`Recording not found: ${filePath}`);
  }

  const result = backtestRunner.runDay(filePath, { startingCash, riskPerTrade });
  console.log(JSON.stringify(result, null, 2));
  const s = result.summary;
  console.error(
    `\nDay ${result.tradingDay}: ${s.totalTrades} trades, ${s.wins}W/${s.losses}L, ` +
      `winRate=${(s.winRate * 100).toFixed(1)}%, pnl=$${s.totalPnl.toFixed(2)}, avgR=${s.avgR.toFixed(2)}`,
  );
}

main();
