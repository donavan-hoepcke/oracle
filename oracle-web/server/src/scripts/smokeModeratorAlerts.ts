import { moderatorAlertService } from '../services/moderatorAlertService.js';
import { config } from '../config.js';

async function main(): Promise<void> {
  if (!config.bot.moderatorAlerts.enabled) {
    console.error('moderatorAlerts disabled in config — flip bot.moderatorAlerts.enabled to true');
    process.exit(1);
  }

  await moderatorAlertService.start();
  await new Promise((r) => setTimeout(r, 20_000));
  await moderatorAlertService.stop();

  const snap = moderatorAlertService.getSnapshot();
  console.error(`fetchedAt: ${snap.fetchedAt}`);
  console.error(`posts: ${snap.posts.length}`);
  if (snap.error) console.error(`ERROR: ${snap.error}`);
  for (const post of snap.posts.slice(0, 8)) {
    console.error(`  [${post.kind.padEnd(18)}] ${post.postedAt ?? '-'}  ${post.title.slice(0, 60)}`);
    if (post.signal) {
      console.error(
        `      signal: ${post.signal.symbol}  s=${post.signal.signal}  rz=${post.signal.riskZone}  tgt=${post.signal.target ?? '-'}`,
      );
    }
    if (post.backups.length > 0) {
      const preview = post.backups.slice(0, 4).map((b) => `${b.symbol}@${b.price ?? '?'}`).join(' ');
      console.error(`      backups(${post.backups.length}): ${preview}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
