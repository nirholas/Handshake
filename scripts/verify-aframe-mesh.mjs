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

await page.screenshot({ path: 'scripts/mesh-spawn.png' });

// strafe right
await page.evaluate(() => {
  document.querySelector('#rig').setAttribute('position', '3 0 2');
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/mesh-strafe.png' });

// walk forward into the scene
await page.evaluate(() => {
  document.querySelector('#rig').setAttribute('position', '0 0 -3');
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/mesh-walk.png' });

// crouch / look from low angle
await page.evaluate(() => {
  document.querySelector('#rig').setAttribute('position', '-2 0 -2');
  const cam = document.querySelector('a-camera');
  cam.setAttribute('rotation', '-10 30 0');
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/mesh-angle.png' });

console.log('errors:', errors.length);
errors.forEach((e) => console.log('  !', e));
await browser.close();
process.exit(errors.length ? 1 : 0);
