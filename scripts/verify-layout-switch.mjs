// Manual verification harness for the Classic/Next layout switch on /app.
// Drives Chromium, exercises both buttons, asserts localStorage + DOM state,
// then exits non-zero on any failure. Run after `npm run dev` is up.
//
// Usage:  BASE_URL=http://localhost:3001 node scripts/verify-layout-switch.mjs

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL = `${BASE}/app`;

function fail(msg) {
	console.error('FAIL:', msg);
	process.exitCode = 1;
}

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

const browser = await chromium.launch({ args: LAUNCH_ARGS });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('crash', () => { console.error('FAIL: page crashed'); process.exitCode = 1; });

const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForSelector('#layout-switch:not([hidden])', { timeout: 15_000 });

const initialLayout = await page.evaluate(() => document.body.dataset.layout);
if (initialLayout !== 'classic') fail(`initial body[data-layout] expected "classic", got "${initialLayout}"`);

const initialPressed = await page.getAttribute('[data-layout-value="classic"]', 'aria-pressed');
if (initialPressed !== 'true') fail(`classic button should be pressed by default, got aria-pressed="${initialPressed}"`);

// Use evaluate-based clicks to avoid pointer-simulation crashes with software WebGL.
await page.evaluate(() => document.querySelector('[data-layout-value="next"]').click());

const afterNext = await page.evaluate(() => ({
	layout: document.body.dataset.layout,
	stored: localStorage.getItem('3dagent:viewer-layout'),
}));
if (afterNext.layout !== 'next') fail(`after click body[data-layout] expected "next", got "${afterNext.layout}"`);
if (afterNext.stored !== 'next') fail(`localStorage expected "next", got "${afterNext.stored}"`);

const nextPressed = await page.getAttribute('[data-layout-value="next"]', 'aria-pressed');
if (nextPressed !== 'true') fail(`next button should be pressed after click, got aria-pressed="${nextPressed}"`);

// Reload — the choice must persist.
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForSelector('#layout-switch:not([hidden])', { timeout: 15_000 });
const afterReload = await page.evaluate(() => document.body.dataset.layout);
if (afterReload !== 'next') fail(`after reload expected "next", got "${afterReload}"`);

// Flip back to classic and confirm symmetric behavior.
await page.evaluate(() => document.querySelector('[data-layout-value="classic"]').click());
const back = await page.evaluate(() => ({
	layout: document.body.dataset.layout,
	stored: localStorage.getItem('3dagent:viewer-layout'),
}));
if (back.layout !== 'classic') fail(`expected layout "classic", got "${back.layout}"`);
if (back.stored !== 'classic') fail(`localStorage expected "classic", got "${back.stored}"`);

const ignorable = [/wallet/i, /Failed to fetch/i, /Wallet not initialized/i, /GL Driver/i, /ReadPixels/i, /WebGL/i];
const realErrors = consoleErrors.filter((e) => !ignorable.some((rx) => rx.test(e)));
if (realErrors.length) {
	console.error('Console errors during run:');
	for (const e of realErrors) console.error('  ', e);
	process.exitCode = 1;
}

await browser.close();

if (process.exitCode) {
	console.error('verify-layout-switch FAILED');
} else {
	console.log('verify-layout-switch OK');
}
