import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';

/**
 * One-shot probe: dump every interactive element inside the Oracle tool's
 * iframes so we can identify the "Top 10 only" toggle (or any other UI
 * control we want the scraper to manage automatically).
 */

const URL = 'https://university.stockstotrade.com/page/oracle-tool';
const OUT_DIR = 'F:/oracle_data/stt-recon';

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(config.bot.playwright.chrome_cdp_url);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('No Chrome contexts found.');
    process.exit(1);
  }
  const context = contexts[0];
  const existing = context.pages().find((p) => p.url().includes(URL));
  const page = existing ?? (await context.newPage());
  if (!existing) {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(15_000);
  }

  const frames = page.frames();
  console.error(`frames: ${frames.length}`);
  const out: Array<{ frameUrl: string; controls: unknown[] }> = [];

  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    console.error(`  ${frame.url()}`);
    try {
      const controls = await frame.evaluate(`(function(){
        function describe(el){
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || null;
          const type = el.getAttribute('type') || null;
          const aria = el.getAttribute('aria-label') || null;
          const ariaPressed = el.getAttribute('aria-pressed') || null;
          const dataState = el.getAttribute('data-state') || null;
          const cls = (typeof el.className === 'string' ? el.className : '');
          const text = (el.textContent || '').trim().slice(0, 80);
          const outerHtml = el.outerHTML.slice(0, 400);
          return { tag, role, type, aria, ariaPressed, dataState, cls, text, outerHtml };
        }
        const els = Array.from(document.querySelectorAll(
          'button, [role=switch], [role=checkbox], input[type=checkbox], input[type=radio], select, label'
        ));
        return els.slice(0, 200).map(describe);
      })()`);
      out.push({ frameUrl: frame.url(), controls: controls as unknown[] });
    } catch (err) {
      console.error(`    eval failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeFileSync(resolve(OUT_DIR, 'oracle-iframe-controls.json'), JSON.stringify(out, null, 2), 'utf-8');
  console.error(`wrote ${OUT_DIR}/oracle-iframe-controls.json with ${out.length} frame(s)`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
