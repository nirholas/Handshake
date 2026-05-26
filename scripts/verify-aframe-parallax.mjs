import { chromium } from 'playwright';

const URL = 'http://localhost:5500/aframe.html';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('a-scene')?.hasLoaded);
await page.waitForTimeout(1000);

// Frame 1: at origin
await page.screenshot({ path: 'scripts/aframe-origin.png' });

// Step the rig to the right and forward and re-shoot.
await page.evaluate(() => {
  const rig = document.querySelector('#rig');
  rig.setAttribute('position', '2.5 0 -1.5');
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/aframe-strafe.png' });

// Forward into the scene.
await page.evaluate(() => {
  const rig = document.querySelector('#rig');
  rig.setAttribute('position', '0 0 -4');
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/aframe-walked.png' });

console.log('shots written. errors:', errors.length);
errors.forEach((e) => console.log('  !', e));
await browser.close();
process.exit(errors.length ? 1 : 0);
