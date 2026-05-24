// Verify the slim /widget shell renders a 3D avatar without flashing site
// chrome — and that the parent surfaces (studio preview, public embed URL,
// legacy /app#kiosk=true) all behave correctly. Run while `npm run dev` is up.
//
//   node scripts/verify-widget-shell.mjs
//
// Writes screenshots to /tmp/widget-*.png and prints a pass/fail summary.

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3000';
const DEMO_GLB = '/avatars/cz.glb';

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

const results = [];
function ok(label) {
	results.push({ label, ok: true });
	console.log(`  ✓ ${label}`);
}
function fail(label, err) {
	results.push({ label, ok: false, err: String(err) });
	console.log(`  ✗ ${label} — ${err}`);
}

async function withPage(name, fn) {
	console.log(`\n→ ${name}`);
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message.slice(0, 200)));
	page.on('console', (m) => {
		if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 200));
	});
	try {
		await fn(page);
	} catch (e) {
		fail(name, e.message || e);
	} finally {
		await page.close();
	}
}

async function waitForFirstFrame(page) {
	await page.waitForFunction(() => window.VIEWER?.viewer?.content, { timeout: 25000 });
}

// 1. /widget direct: model in hash, kiosk on, no chrome ever visible.
await withPage('/widget#model=<glb>&kiosk=true (direct embed)', async (page) => {
	const url = `${BASE}/widget?_=${Date.now()}#model=${encodeURIComponent(DEMO_GLB)}&kiosk=true`;
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
	// Body should be invisible until first-frame event fires.
	const initialVisibility = await page.evaluate(() => getComputedStyle(document.body).visibility);
	if (initialVisibility === 'hidden') ok('body starts visibility:hidden (FOUC guard)');
	else fail('body starts visibility:hidden (FOUC guard)', `got ${initialVisibility}`);

	// Confirm no <header>/<footer> ever exists in the DOM.
	const chromeCount = await page.evaluate(
		() =>
			document.querySelectorAll(
				'header, footer, .agent-presence-sidebar, .dropzone, .auth-gate',
			).length,
	);
	if (chromeCount === 0) ok('no site chrome in the DOM');
	else fail('no site chrome in the DOM', `found ${chromeCount} chrome elements`);

	await waitForFirstFrame(page);

	const readyVisibility = await page.evaluate(() => getComputedStyle(document.body).visibility);
	if (readyVisibility === 'visible') ok('body flips visible after first frame');
	else fail('body flips visible after first frame', `still ${readyVisibility}`);

	await page.screenshot({ path: '/tmp/widget-direct.png' });
	console.log('  → /tmp/widget-direct.png');
});

// 2. /studio preview iframe: hit the studio, confirm the preview iframe
//    targets /widget (not /app) and renders the model.
await withPage('/studio preview iframe targets /widget', async (page) => {
	await page.goto(`${BASE}/studio/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
	// Wait for the preview iframe to receive a src.
	await page.waitForFunction(
		() => document.getElementById('preview-iframe')?.src?.includes('/widget'),
		{ timeout: 20000 },
	);
	const previewSrc = await page.evaluate(() => document.getElementById('preview-iframe').src);
	if (previewSrc.includes('/widget') && !previewSrc.match(/\/app[?#]/))
		ok(`preview iframe → /widget (src=${previewSrc.slice(0, 120)}…)`);
	else fail('preview iframe → /widget', `unexpected src: ${previewSrc}`);

	// Drop into the iframe and confirm chrome isn't there either.
	const frame = page.frame({ url: /\/widget/ });
	if (!frame) {
		fail('studio iframe accessible', 'no /widget frame found');
		return;
	}
	const chromeCount = await frame.evaluate(
		() => document.querySelectorAll('header, footer').length,
	);
	if (chromeCount === 0) ok('studio preview iframe has no chrome');
	else fail('studio preview iframe has no chrome', `found ${chromeCount}`);

	await page.screenshot({ path: '/tmp/widget-studio.png', fullPage: false });
	console.log('  → /tmp/widget-studio.png');
});

// 3. Legacy /app#kiosk=true still works (no chrome eventually, model renders).
await withPage('/app#model=<glb>&kiosk=true (legacy path)', async (page) => {
	const url = `${BASE}/app#model=${encodeURIComponent(DEMO_GLB)}&kiosk=true`;
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await waitForFirstFrame(page);
	// In kiosk mode, header should now be display:none.
	const headerHidden = await page.evaluate(() => {
		const h = document.querySelector('header');
		return !h || getComputedStyle(h).display === 'none';
	});
	if (headerHidden) ok('legacy /app kiosk still hides chrome');
	else fail('legacy /app kiosk still hides chrome', 'header still visible');
	await page.screenshot({ path: '/tmp/widget-legacy.png' });
	console.log('  → /tmp/widget-legacy.png');
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
	`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — see failures above' : ''}`,
);
process.exit(failed.length ? 1 : 0);
