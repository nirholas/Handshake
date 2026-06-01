// Self-contained verification harness for the Walk Companion
// (src/walk-companion.js). Spawns its own Vite dev server on an isolated port,
// waits for it to answer, drives it with headless Chromium (puppeteer), then
// tears the server down. Bounded server lifetime avoids fighting other work in
// this shared workspace. Asserts the companion mounts on a standard nav page
// with ?walk=1, the nav toggle reflects state, the avatar canvas renders, state
// persists across a navigation, and the disable button removes it — with zero
// real console/page errors.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const PORT = Number(process.env.PORT || 3123);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (cond, msg) => {
	console.log(`${cond ? '✓' : '✗'} ${msg}`);
	if (!cond) fails.push(msg);
};

// Dev-only noise absent in production, plus a pre-existing page error (a
// meshopt-compressed avatar element on the marketing pages is loaded by another
// part of the app without a decoder — verified present with the companion OFF,
// so out of scope here; the companion's own loader sets the decoder).
const isDevNoise = (t) =>
	/\[vite\]/i.test(t) ||
	/websocket/i.test(t) ||
	/app\.github\.dev/i.test(t) ||
	/Failed to load resource/i.test(t) ||
	/setMeshoptDecoder must be called/i.test(t);

// ── Boot an isolated dev server ─────────────────────────────────────────────
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
	cwd: process.cwd(),
	stdio: ['ignore', 'pipe', 'pipe'],
	env: process.env,
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitForServer(timeoutMs) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(`${BASE}/nav.js`);
			if (r.ok) return true;
		} catch {
			/* not up yet */
		}
		await sleep(1000);
	}
	return false;
}

function shutdown(code) {
	try {
		server.kill('SIGTERM');
	} catch {
		/* ignore */
	}
	process.exit(code);
}

const up = await waitForServer(90000);
if (!up) {
	console.log('✗ dev server did not become ready in 90s');
	console.log(serverLog.split('\n').slice(-12).join('\n'));
	shutdown(1);
}

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

try {
	// Pre-warm: first load streams three.js unbundled in dev (optimizeDeps is
	// disabled by a pre-existing dep issue), so give the first mount room.
	await page.goto(`${BASE}/features?walk=1`, { waitUntil: 'domcontentloaded' });
	const canvas = await page.waitForSelector('.walk-companion-canvas', { timeout: 60000 }).catch(() => null);
	ok(!!canvas, 'companion canvas mounts with ?walk=1 on /features');

	ok(!!(await page.$('#home-nav-walk')), 'nav Walk toggle button present');
	ok((await attr('#home-nav-walk', 'aria-pressed')) === 'true', 'toggle aria-pressed=true when enabled');

	const dims = canvas ? await canvas.evaluate((c) => ({ w: c.width, h: c.height })) : { w: 0, h: 0 };
	ok(dims.w > 0 && dims.h > 0, `canvas has render dimensions (${dims.w}x${dims.h})`);

	await sleep(2500);
	const bubble = await page.$eval('.walk-companion-bubble', (b) => b.textContent?.trim() || '').catch(() => '');
	ok(bubble.length > 0, `context greeting shown ("${bubble.slice(0, 42)}")`);

	ok(
		await page.evaluate(() => !!(window.__walkCompanion && typeof window.__walkCompanion.toggle === 'function')),
		'window.__walkCompanion API exposed',
	);
	ok(
		(await page.evaluate(() => localStorage.getItem('walk:companion:enabled'))) === '1',
		'enabled flag persisted to localStorage',
	);

	// Persistence across a navigation (three is now cached → fast).
	await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
	ok(
		!!(await page.waitForSelector('.walk-companion-canvas', { timeout: 30000 }).catch(() => null)),
		'companion re-mounts on /pricing without ?walk param — persistence works',
	);

	// Disable button removes it and flips the flag.
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

	ok(consoleErrors.length === 0, `no real console errors (${consoleErrors.length})`);
	consoleErrors.slice(0, 10).forEach((e) => console.log('   →', e));
} finally {
	await browser.close();
}

console.log(fails.length ? `\nFAILED (${fails.length})` : '\nALL PASS');
shutdown(fails.length ? 1 : 0);
