import { chromium } from 'playwright';
const BASE = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(BASE + '/pricing', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.keyboard.press('Control+k');
await p.waitForSelector('.tws-atlas[data-open]');
await p.waitForTimeout(50);
console.log('t+50ms  intents:', await p.locator('.tws-atlas-row[data-kind="intent"]').count(),
            'skeletons:', await p.locator('.tws-atlas-skel').count());
await p.waitForTimeout(700);
console.log('t+750ms intents:', await p.locator('.tws-atlas-row[data-kind="intent"]').count());
await p.fill('.tws-atlas-input', '/status');
await p.waitForTimeout(300);
console.log('rows:', JSON.stringify(await p.evaluate(() =>
  [...document.querySelectorAll('.tws-atlas-row')].slice(0,3).map(r => ({k:r.dataset.kind,h:r.dataset.href,s:r.getAttribute('aria-selected')})))));
await b.close();
