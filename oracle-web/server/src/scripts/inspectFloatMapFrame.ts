import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';

const URL = 'https://university.stockstotrade.com/page/Oracle-FloatMAP';
const OUT_DIR = 'F:/oracle_data/stt-recon';

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(config.bot.playwright.chrome_cdp_url);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  console.error(`goto ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Amplify iframe app hydrates + fetches data; give it real time.
  await page.waitForTimeout(15_000);

  const frames = page.frames();
  console.error(`frames: ${frames.length}`);
  for (const [i, f] of frames.entries()) {
    console.error(`  [${i}] url=${f.url()} name=${f.name()}`);
  }

  const dataFrame = frames.find((f) => f.url().includes('amplifyapp.com'));
  if (!dataFrame) {
    console.error('no amplifyapp frame found');
    await page.close();
    process.exit(1);
  }

  const html = await dataFrame.content();
  writeFileSync(resolve(OUT_DIR, 'floatmap-frame.html'), html, 'utf-8');

  const text = await dataFrame.evaluate(`((document.body && document.body.innerText) || '')`) as string;
  writeFileSync(resolve(OUT_DIR, 'floatmap-frame.txt'), text, 'utf-8');

  const structure: any = await dataFrame.evaluate(`(function(){
    function pick(el){
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: typeof el.className === 'string' ? el.className.slice(0, 160) : null,
        textPreview: (el.textContent || '').trim().slice(0, 200),
        childCount: el.children.length,
      };
    }
    return {
      href: location.href,
      title: document.title,
      bodyLength: (document.body && document.body.innerText) ? document.body.innerText.length : 0,
      tables: Array.from(document.querySelectorAll('table')).map(pick),
      headers: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 20).map(pick),
      tabs: Array.from(document.querySelectorAll('[role="tab"], [class*="tab-"], [class*="Tab"]')).slice(0, 30).map(pick),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 40).map(pick),
      selects: Array.from(document.querySelectorAll('select, [role="combobox"]')).slice(0, 20).map(pick),
      rowCandidates: Array.from(document.querySelectorAll('[role="row"], tr')).length,
    };
  })()`);
  writeFileSync(resolve(OUT_DIR, 'floatmap-frame.structure.json'), JSON.stringify(structure, null, 2), 'utf-8');

  // Try to screenshot just the frame's bounding box via its element handle on parent.
  const iframeEl = await page.$('iframe[src*="amplifyapp"]');
  if (iframeEl) {
    await iframeEl.screenshot({ path: resolve(OUT_DIR, 'floatmap-frame.png') });
  }

  console.error(`title: ${structure.title}`);
  console.error(`bodyLen: ${structure.bodyLength}`);
  console.error(`tables=${structure.tables.length} headers=${structure.headers.length} tabs=${structure.tabs.length} buttons=${structure.buttons.length} selects=${structure.selects.length} rows=${structure.rowCandidates}`);

  await page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
