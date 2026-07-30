import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3005';
const out = process.env.OUT || '/tmp/claude-1000/-workspaces-three-ws/f216c4ab-6247-4f9c-8f52-1a394cf0f0bc/scratchpad';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
const warnings = [];
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text());
	if (m.type() === 'warning') warnings.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', (r) => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

await page.goto(`${BASE}/docs/world`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);

const state = await page.evaluate(() => ({
	canvas: !!document.querySelector('canvas'),
	title: document.title,
	chips: [...document.querySelectorAll('button,[role=button],a')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 14),
	bodyText: (document.body.innerText || '').slice(0, 260),
}));
console.log('DESKTOP', JSON.stringify(state, null, 1));
await page.screenshot({ path: `${out}/world-desktop.png` });

// Deep link into a section
await page.goto(`${BASE}/docs/world#forge`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: `${out}/world-deeplink.png` });
const deep = await page.evaluate(() => ({ hash: location.hash, text: (document.body.innerText || '').slice(0, 200) }));
console.log('DEEPLINK', JSON.stringify(deep));

// Mobile
const m = await ctx.newPage();
await m.setViewportSize({ width: 390, height: 844 });
await m.goto(`${BASE}/docs/world`, { waitUntil: 'networkidle', timeout: 60000 });
await m.waitForTimeout(5000);
await m.screenshot({ path: `${out}/world-mobile.png` });

console.log('CONSOLE_ERRORS', errors.length, JSON.stringify(errors.slice(0, 8), null, 1));
console.log('CONSOLE_WARNINGS', warnings.length, JSON.stringify(warnings.slice(0, 5), null, 1));
await browser.close();
