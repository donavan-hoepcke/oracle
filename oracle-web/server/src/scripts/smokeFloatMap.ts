import { floatMapService } from '../services/floatMapService.js';
import { config } from '../config.js';

async function main(): Promise<void> {
  if (!config.bot.floatmap.enabled) {
    console.error('floatmap disabled in config — flip bot.floatmap.enabled to true');
    process.exit(1);
  }

  await floatMapService.start();
  // Poll now runs in the background; wait a generous window for it to finish.
  await new Promise((r) => setTimeout(r, 30_000));
  await floatMapService.stop();

  const snap = floatMapService.getSnapshot();
  console.error(`fetchedAt: ${snap.fetchedAt}`);
  console.error(`entries: ${snap.entries.length}`);
  if (snap.error) console.error(`ERROR: ${snap.error}`);
  for (const e of snap.entries.slice(0, 10)) {
    console.error(`  ${e.symbol.padEnd(6)} rot=${e.rotation}x  last=${e.last}  float=${e.floatMillions}M  sup=${e.nextOracleSupport}  res=${e.nextOracleResistance}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
