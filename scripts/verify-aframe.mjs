import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5500/aframe.html';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const errors = [];
const warnings = [];
page.on('console', (m) => {
  const t = m.type();
  const txt = m.text();
  if (t === 'error') errors.push(txt);
  else if (t === 'warning') warnings.push(txt);
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
// Let A-Frame finish loading assets + first paint
await page.waitForFunction(() => {
  const s = document.querySelector('a-scene');
  return s && s.hasLoaded;
}, { timeout: 30000 });
await page.waitForTimeout(1500);

const scene = await page.evaluate(() => {
  const s = document.querySelector('a-scene');
  const imgs = [...document.querySelectorAll('a-image')].map((el) => ({
    src: el.getAttribute('src'),
    pos: el.getAttribute('position'),
    width: el.getAttribute('width'),
    visible: !!el.getObject3D('mesh'),
  }));
  return { hasLoaded: s.hasLoaded, imgs };
});
console.log('scene.hasLoaded =', scene.hasLoaded);
console.log('a-images:');
for (const i of scene.imgs) console.log(' ', i);

await page.screenshot({ path: 'scripts/aframe-shot.png', fullPage: false });
console.log('\nscreenshot: scripts/aframe-shot.png');
console.log('errors:', errors.length);
errors.forEach((e) => console.log('  !', e));
console.log('warnings:', warnings.length);
warnings.slice(0, 5).forEach((w) => console.log('  ?', w.slice(0, 200)));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
