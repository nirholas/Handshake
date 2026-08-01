// Real-browser verification of Forge Reel: load /forge, put a real model in the
// result viewer, render an actual reel, and assert the produced files are real
// bytes with the right magic numbers.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/claude-1000/-workspaces-three-ws/54abdcf2-c800-40d7-8c4b-205b55327f21/scratchpad/reel-shots';
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

page.setDefaultTimeout(120000);
await page.goto('http://localhost:3210/forge', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.dispatchEvent(new CustomEvent('forge:open-creation', {
  detail: { creation: { id: 'verify-reel', prompt: 'a brass lantern', glb_url: 'https://three.ws/avatars/default.glb', backend: 'trellis_selfhost' } },
})));
await page.waitForFunction(() => document.getElementById('viewer')?.loaded === true, null, { timeout: 90000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/01-result.png` });

console.log('trigger visible:', await page.isVisible('#reel-open'));
await page.click('#reel-open');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-dialog.png` });
console.log('summary:', await page.textContent('.reel-summary'));

await page.click('.reel-durations .reel-chip[data-id="4"]');
await page.click('.reel-start');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/03-rendering.png` });
console.log('phase:', await page.textContent('.reel-working-title'), '|', await page.textContent('.reel-clock'));

await page.waitForSelector('.reel-done:not([hidden]) .reel-file, .reel-error-panel:not([hidden])', { timeout: 180000 });
if (await page.isVisible('.reel-error-panel')) console.log('ERROR PANEL:', await page.textContent('.reel-error-text'));
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/04-done.png` });

const files = await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('.reel-file')];
  const out = [];
  for (const row of rows) {
    const blob = await (await fetch(row.href)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let b64 = '';
    for (let i = 0; i < buf.length; i += 8192) b64 += String.fromCharCode(...buf.subarray(i, i + 8192));
    out.push({ name: row.download, type: blob.type, size: blob.size, head: [...buf.slice(0, 12)], b64: btoa(b64) });
  }
  return out;
});
for (const f of files) {
  writeFileSync(`${OUT}/${f.name}`, Buffer.from(f.b64, 'base64'));
  console.log(`file ${f.name} type=${f.type} size=${f.size} magic=${f.head.map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
}
console.log('video element has src:', await page.evaluate(() => !!document.querySelector('.reel-video')?.src));

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
console.log('closed after Esc:', !(await page.isVisible('.reel-panel')));
await page.keyboard.press('r');
await page.waitForTimeout(300);
console.log('reopened with R:', await page.isVisible('.reel-panel'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await page.setViewportSize({ width: 320, height: 720 });
await page.waitForTimeout(300);
await page.click('#reel-open');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/05-320.png` });
console.log('320px overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));

console.log('console errors:', JSON.stringify(errors.filter(e => !/WebSocket|vite/i.test(e)), null, 2));
await browser.close();
