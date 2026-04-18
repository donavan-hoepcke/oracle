import { synthesizeDay, DEFAULT_SYNTH_TICKERS } from '../services/recordingSynthService.js';

interface SynthArgs {
  day: string;
  tickers: string[];
  seed: number;
}

function parseArgs(): SynthArgs {
  const args = process.argv.slice(2);
  let day = new Date().toISOString().slice(0, 10);
  let tickers = DEFAULT_SYNTH_TICKERS;
  let seed = 42;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--day' && args[i + 1]) {
      day = args[i + 1];
      i++;
    } else if (args[i] === '--tickers' && args[i + 1]) {
      tickers = args[i + 1].split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      i++;
    } else if (args[i] === '--seed' && args[i + 1]) {
      seed = Number(args[i + 1]);
      i++;
    }
  }
  return { day, tickers, seed };
}

function main(): void {
  const { day, tickers, seed } = parseArgs();
  const result = synthesizeDay({ day, tickers, seed });
  console.log(`Wrote ${result.cyclesWritten} cycles for ${result.tickers.length} tickers to ${result.filePath}`);
  console.log(
    `Planned outcomes: ${result.outcomes.win} win, ${result.outcomes.loss} loss, ` +
      `${result.outcomes.chop} chop (seed=${result.seed})`,
  );
}

main();
