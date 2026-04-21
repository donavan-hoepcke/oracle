import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';

const TARGETS = [
  { slug: 'oracle-floatmap', url: 'https://university.stockstotrade.com/page/Oracle-FloatMAP' },
  { slug: 'daily-market-profits', url: 'https://university.stockstotrade.com/room/daily-market-profits' },
  { slug: 'daily-income-trader-chat', url: 'https://university.stockstotrade.com/room/daily-income-trader-chat' },
];

const OUT_DIR = 'F:/oracle_data/stt-recon';

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const { chromium } = await import('playwright');
  const cdpUrl = config.bot.playwright.chrome_cdp_url;
  const browser = await chromium.connectOverCDP(cdpUrl);

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('No Chrome contexts found. Is debug Chrome running and logged in?');
    process.exit(1);
  }
  const context = contexts[0];
  const page = await context.newPage();

  for (const target of TARGETS) {
    console.error(`\n=== ${target.slug} — ${target.url}`);
    try {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Let client-side rendering settle — chat rooms and Oracle pages hydrate after load.
      await page.waitForTimeout(5_000);

      const html = await page.content();
      writeFileSync(resolve(OUT_DIR, `${target.slug}.html`), html, 'utf-8');

      const text = await page.evaluate(() => document.body?.innerText ?? '');
      writeFileSync(resolve(OUT_DIR, `${target.slug}.txt`), text, 'utf-8');

      await page.screenshot({ path: resolve(OUT_DIR, `${target.slug}.png`), fullPage: true });

      const structure = await page.evaluate(() => {
        const pick = (el: Element) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : null,
          childCount: el.children.length,
          textPreview: (el.textContent ?? '').trim().slice(0, 120),
        });
        return {
          title: document.title,
          href: location.href,
          tables: Array.from(document.querySelectorAll('table')).map(pick),
          iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
            src: (f as HTMLIFrameElement).src,
            id: f.id || null,
            classes: typeof f.className === 'string' ? f.className.slice(0, 120) : null,
          })),
          lists: Array.from(document.querySelectorAll('ul, ol')).slice(0, 20).map(pick),
          mainContainers: Array.from(
            document.querySelectorAll('[class*="chat"], [class*="message"], [class*="room"], [class*="float"], main, article, section'),
          )
            .slice(0, 40)
            .map(pick),
          bodyLength: document.body?.innerText?.length ?? 0,
        };
      });
      writeFileSync(resolve(OUT_DIR, `${target.slug}.structure.json`), JSON.stringify(structure, null, 2), 'utf-8');

      console.error(`  title: ${structure.title}`);
      console.error(`  bodyLen: ${structure.bodyLength}`);
      console.error(`  tables: ${structure.tables.length}  iframes: ${structure.iframes.length}  lists: ${structure.lists.length}  mainContainers: ${structure.mainContainers.length}`);
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
    }
  }

  await page.close();
  console.error(`\nWrote recon artifacts to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
