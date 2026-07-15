// Regenerates forge-plant-bubble.png: a real screenshot of https://three.ws/ar
// with a TRELLIS-generated model in the stage, framed for an iMessage photo bubble.
// Run from the repo root: node marketing/imessage-video/capture-forge-bubble.mjs
import { chromium, devices } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT = process.argv[2] || 'A giant healthy green house plant';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

await page.goto('https://three.ws/ar', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.fill('#prompt', PROMPT);
await page.click('#go');

let src = '';
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000);
  src = await page.$eval('#mv', el => el.getAttribute('src') || '').catch(() => '');
  const working = await page.$eval('#working', el => getComputedStyle(el).display !== 'none').catch(() => false);
  const failed = await page.$eval('#failed', el => getComputedStyle(el).display !== 'none').catch(() => false);
  if (failed) throw new Error('forge generation failed');
  if (src && !working) break;
}
if (!src) throw new Error('no model produced within the polling window');

await page.waitForTimeout(8000); // let textures and lighting settle
const stage = page.locator('#stage');
await stage.scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await stage.screenshot({ path: join(HERE, 'forge-plant-bubble.png') });
console.log('saved forge-plant-bubble.png for model', src);
await browser.close();
