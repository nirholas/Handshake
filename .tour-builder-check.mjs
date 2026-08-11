// Verify /tour-builder still drives a real tour from the refreshed
// public/tour-builder/tour.global.js bundle.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const noise = [];
page.on('console', (m) => { if (m.type() === 'error') noise.push(`[error] ${m.text()}`); });
page.on('pageerror', (e) => noise.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => noise.push(`[reqfail] ${r.url().slice(0, 110)} ${r.failure()?.errorText}`));
await page.goto('http://localhost:3101/tour-builder', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.ThreeWsTour, null, { timeout: 30000 });
console.log('ThreeWsTour global present, VERSION', await page.evaluate(() => window.ThreeWsTour.VERSION));
console.log('createFeatureTour exposed:', await page.evaluate(() => typeof window.createFeatureTour));
await page.waitForTimeout(4000);
console.log('console errors:', noise.length ? '\n  ' + noise.join('\n  ') : 'none');
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/9ea6f349-baf6-4e23-8684-08d253ead4d5/scratchpad/tour-builder.png' });
await browser.close();
