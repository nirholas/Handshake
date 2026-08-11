// Drive tour-sdk/examples/shopify-storefront.html exactly as the README says:
// `npx serve tour-sdk`, then open /examples/shopify-storefront.html.
import { chromium } from 'playwright';
const BASE = process.env.TOUR_BASE || 'http://localhost:33301';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const noise = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') noise.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => noise.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => noise.push(`[reqfail] ${r.url().slice(0, 100)} ${r.failure()?.errorText}`));

await page.goto(`${BASE}/examples/shopify-storefront.html`, { waitUntil: 'load' });
console.log('landed on:', new URL(page.url()).pathname);
await page.waitForFunction(() => !!window.__featureTour, null, { timeout: 20000 });
console.log('auto-init: window.__featureTour present, VERSION', await page.evaluate(() => window.ThreeWsTour.VERSION));

await page.click('[data-tour-start]');
await page.waitForSelector('.tws-tour-bar', { timeout: 30000 });
console.log('playback bar mounted');

const first = await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80; i++) {
    const cap = document.querySelector('[class*="tws-tour-cap"], .tws-tour-say, .tws-tour-line');
    if (cap && cap.textContent.trim()) break;
    await wait(250);
  }
  const canvas = document.querySelector('canvas');
  return {
    active: window.__featureTour.isActive(),
    stopIndex: window.__featureTour.director?.index ?? null,
    chapter: document.querySelector('.tws-tour-chapter')?.textContent.trim() ?? null,
    count: document.querySelector('.tws-tour-count')?.textContent.trim() ?? null,
    canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
    spotlit: !!document.querySelector('[class*="tws-tour-ring"], [class*="tws-tour-spot"]'),
    beam: !!document.querySelector('.tws-tour-beam'),
    ui: [...new Set([...document.querySelectorAll('[class*="tws-tour"]')].map((n) => String(n.className).split(' ')[0]))].join(','),
  };
});
console.log('stop 1:', JSON.stringify(first));

await page.click('.tws-tour-btn[aria-label*="Next" i], .tws-tour-btn[title*="Next" i]').catch(() => page.keyboard.press('ArrowRight'));
await page.waitForTimeout(4000);
console.log('after next:', JSON.stringify(await page.evaluate(() => ({
  stopIndex: window.__featureTour.director?.index ?? null,
  count: document.querySelector('.tws-tour-count')?.textContent.trim() ?? null,
}))));

await page.keyboard.press('KeyC');
await page.waitForTimeout(800);
console.log('chapter map open:', await page.evaluate(() => !!document.querySelector('[class*="tws-tour-menu"]')));
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/9ea6f349-baf6-4e23-8684-08d253ead4d5/scratchpad/tour-example.png' });

await page.evaluate(() => window.__featureTour.exit());
await page.waitForTimeout(800);
console.log('after exit, isActive():', await page.evaluate(() => window.__featureTour.isActive()));
console.log('console errors/warnings:', noise.length ? '\n  ' + noise.join('\n  ') : 'none');
await browser.close();
