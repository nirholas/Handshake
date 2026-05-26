import { chromium } from 'playwright';

const URL = 'http://localhost:5500/aframe-mesh.html';
const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then(c => c.newPage());
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('a-scene')?.hasLoaded);
await page.waitForTimeout(1000);

const positions = [
  ['far',         '0 0 4'],
  ['midway',      '0 0 -2'],
  ['at-surface',  '0 0 -5'],
  ['just-inside', '0 0 -6.5'],
  ['deep-inside', '0 0 -10'],
  ['out-back',    '0 0 -16'],
];
for (const [name, pos] of positions) {
  await page.evaluate((p) => document.querySelector('#rig').setAttribute('position', p), pos);
  await page.waitForTimeout(300);
  // Sample a center-pixel color to detect "blank"
  const px = await page.evaluate(() => {
    const c = document.querySelector('a-scene').canvas;
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    const buf = new Uint8Array(4);
    ctx.readPixels(c.width / 2, c.height / 2, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
    return [...buf];
  });
  await page.screenshot({ path: `scripts/blank-${name}.png` });
  console.log(`${name.padEnd(12)} rig=${pos.padEnd(8)}  center pixel rgba=${JSON.stringify(px)}`);
}

await browser.close();
