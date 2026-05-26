import { chromium } from 'playwright';

const URL = 'http://localhost:5500/aframe-mesh.html';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('a-scene')?.hasLoaded);
await page.waitForTimeout(1500);

// Initial spawn — prompt should be visible
await page.screenshot({ path: 'scripts/final-spawn.png' });
const promptVisible = await page.evaluate(() => {
  const p = document.getElementById('prompt');
  return p && !p.classList.contains('hidden') && getComputedStyle(p).opacity !== '0';
});
console.log('prompt visible on load:', promptVisible);

// Mouse micro-parallax: move cursor to the far-right, then far-left, screenshot
await page.mouse.move(1200, 400);
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/final-mouse-right.png' });
await page.mouse.move(80, 400);
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/final-mouse-left.png' });

// Walk + look around
await page.evaluate(() => {
  document.querySelector('#rig').setAttribute('position', '0 0 -3');
  document.querySelector('a-camera').setAttribute('rotation', '-5 -15 0');
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/final-walked.png' });

// Strafe to test parallax + backdrop inpaint pass
await page.evaluate(() => {
  document.querySelector('#rig').setAttribute('position', '3.5 0 0');
  document.querySelector('a-camera').setAttribute('rotation', '0 -25 0');
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/final-strafe.png' });

// Backdrop visibility check — confirm both depth-mesh entities loaded
const meshCount = await page.evaluate(() => {
  return document.querySelectorAll('[depth-mesh]').length;
});
console.log('depth-mesh entities:', meshCount);

console.log('errors:', errors.length);
errors.forEach((e) => console.log('  !', e));
await browser.close();
process.exit(errors.length ? 1 : 0);
