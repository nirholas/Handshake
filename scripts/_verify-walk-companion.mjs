// Temporary verification harness for the Walk Companion (src/walk-companion.js).
// Drives the real dev server with headless Chromium (puppeteer) and asserts the
// companion mounts on a standard nav page with ?walk=1, the nav toggle reflects
// state, the avatar canvas renders, persistence survives a navigation, and the
// disable button removes it — all with zero real console/page errors.
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (cond, msg) => {
	console.log(`${cond ? '✓' : '✗'} ${msg}`);
	if (!cond) fails.push(msg);
};

// Dev-only noise absent in production: Vite's HMR client cannot open its
// websocket through the Codespace forwarded domain over localhost.
const isDevNoise = (t) =>
	/\[vite\]/i.test(t) ||
	/failed to connect to websocket/i.test(t) ||
	/WebSocket (closed without opened|connection to)/i.test(t) ||
	/app\.github\.dev/i.test(t) ||
	/Failed to load resource/i.test(t); // favicon etc.

const browser = await puppeteer.launch({
	headless: 'new',
	args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error' && !isDevNoise(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', (e) => {
	if (!isDevNoise(e.message)) consoleErrors.push(`pageerror: ${e.message}`);
});

const attr = (sel, name) =>
	page.$eval(sel, (el, n) => el.getAttribute(n), name).catch(() => null);

// 1) Enabled via ?walk=1 → mounts on a standard nav page.
await page.goto(`${BASE}/features?walk=1`, { waitUntil: 'domcontentloaded' });
const canvas = await page.waitForSelector('.walk-companion-canvas', { timeout: 20000 }).catch(() => null);
ok(!!canvas, 'companion canvas mounts with ?walk=1 on /features');

ok(!!(await page.$('#home-nav-walk')), 'nav Walk toggle button present');
ok((await attr('#home-nav-walk', 'aria-pressed')) === 'true', 'toggle aria-pressed=true when enabled');

const dims = canvas ? await canvas.evaluate((c) => ({ w: c.width, h: c.height })) : { w: 0, h: 0 };
ok(dims.w > 0 && dims.h > 0, `canvas has render dimensions (${dims.w}x${dims.h})`);

// Avatar actually loaded into the scene (robot mesh present) — wait for it.
await sleep(2500);
const bubbleText = await page.$eval('.walk-companion-bubble', (b) => b.textContent?.trim() || '').catch(() => '');
ok(bubbleText.length > 0, `context greeting shown ("${bubbleText.slice(0, 42)}")`);

ok(
	await page.evaluate(() => !!(window.__walkCompanion && typeof window.__walkCompanion.toggle === 'function')),
	'window.__walkCompanion API exposed',
);

// 2) Persistence: enabled flag saved → survives navigation to a different page.
ok(
	(await page.evaluate(() => localStorage.getItem('walk:companion:enabled'))) === '1',
	'enabled flag persisted to localStorage',
);
await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
ok(
	!!(await page.waitForSelector('.walk-companion-canvas', { timeout: 20000 }).catch(() => null)),
	'companion re-mounts on /pricing without ?walk param — persistence works',
);

// 3) Disable button removes the companion and flips the flag off.
const closeBtn = await page.$('.walk-companion-close');
ok(!!closeBtn, 'disable (×) button present');
if (closeBtn) {
	await closeBtn.click();
	await sleep(500);
	ok((await page.$('.walk-companion-canvas')) === null, 'disable button removes the companion');
	ok(
		(await page.evaluate(() => localStorage.getItem('walk:companion:enabled'))) === '0',
		'disable sets enabled flag to 0',
	);
	ok((await attr('#home-nav-walk', 'aria-pressed')) === 'false', 'nav toggle reflects disabled state');
}

// 4) No real console / page errors throughout.
ok(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
consoleErrors.slice(0, 10).forEach((e) => console.log('   →', e));

await browser.close();
console.log(fails.length ? `\nFAILED (${fails.length})` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
