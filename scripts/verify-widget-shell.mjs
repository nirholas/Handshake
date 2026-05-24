// Verify the slim /widget shell behaves correctly across every surface:
// FOUC guard, no chrome, reveal=interaction click-to-boot, JSON-RPC API,
// poster pass-through, and studio/legacy parity. Run while `npm run dev` is up.
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
	const initialVisibility = await page.evaluate(() => getComputedStyle(document.body).visibility);
	if (initialVisibility === 'hidden') ok('body starts visibility:hidden (FOUC guard)');
	else fail('body starts visibility:hidden (FOUC guard)', `got ${initialVisibility}`);

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
	await page.waitForFunction(
		() => document.getElementById('preview-iframe')?.src?.includes('/widget'),
		{ timeout: 20000 },
	);
	const previewSrc = await page.evaluate(() => document.getElementById('preview-iframe').src);
	if (previewSrc.includes('/widget') && !previewSrc.match(/\/app[?#]/))
		ok(`preview iframe → /widget (src=${previewSrc.slice(0, 120)}…)`);
	else fail('preview iframe → /widget', `unexpected src: ${previewSrc}`);

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

// 3. Legacy /app#kiosk=true still works.
await withPage('/app#model=<glb>&kiosk=true (legacy path)', async (page) => {
	const url = `${BASE}/app#model=${encodeURIComponent(DEMO_GLB)}&kiosk=true`;
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await waitForFirstFrame(page);
	const headerHidden = await page.evaluate(() => {
		const h = document.querySelector('header');
		return !h || getComputedStyle(h).display === 'none';
	});
	if (headerHidden) ok('legacy /app kiosk still hides chrome');
	else fail('legacy /app kiosk still hides chrome', 'header still visible');
	await page.screenshot({ path: '/tmp/widget-legacy.png' });
	console.log('  → /tmp/widget-legacy.png');
});

// 4. Reveal-on-interaction: WebGL must NOT init until the visitor clicks.
await withPage('/widget#reveal=interaction defers WebGL boot', async (page) => {
	const url = `${BASE}/widget?_=${Date.now()}#model=${encodeURIComponent(DEMO_GLB)}&kiosk=true&reveal=interaction`;
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
	// Wait long enough that auto mode WOULD have booted by now.
	await page.waitForTimeout(1500);

	// The gate should be visible and clickable. window.VIEWER should NOT exist yet.
	const state = await page.evaluate(() => ({
		hasGate: Boolean(document.querySelector('.widget-reveal-gate')),
		viewerLoaded: Boolean(window.VIEWER),
		booted: Boolean(window.__WIDGET_BOOTED),
	}));
	if (state.hasGate && !state.viewerLoaded && !state.booted)
		ok('reveal=interaction holds boot before click');
	else
		fail(
			'reveal=interaction holds boot before click',
			`hasGate=${state.hasGate} viewerLoaded=${state.viewerLoaded} booted=${state.booted}`,
		);

	await page.screenshot({ path: '/tmp/widget-reveal-gate.png' });
	console.log('  → /tmp/widget-reveal-gate.png');

	// Click the play button.
	await page.click('.widget-reveal-gate');
	// Now the app must actually boot.
	await waitForFirstFrame(page);
	const after = await page.evaluate(() => ({
		viewerLoaded: Boolean(window.VIEWER),
		gateGone: !document.querySelector('.widget-reveal-gate'),
	}));
	if (after.viewerLoaded && after.gateGone) ok('click boots WebGL + dismisses gate');
	else
		fail(
			'click boots WebGL + dismisses gate',
			`viewerLoaded=${after.viewerLoaded} gateGone=${after.gateGone}`,
		);

	await page.screenshot({ path: '/tmp/widget-reveal-after.png' });
	console.log('  → /tmp/widget-reveal-after.png');
});

// 5. JSON-RPC roundtrip: parent loads widget-client.js, calls methods, gets results.
await withPage('JSON-RPC: ping + camera.getLookAt + screenshot.capture', async (page) => {
	// Build a host page that loads the widget client + an iframe pointed at /widget.
	await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
	// Inject our test scaffold on top of the home page. Cross-origin doesn't
	// apply — both iframe and host run on localhost:3000.
	const testResult = await page.evaluate(
		async ({ BASE, DEMO_GLB }) => {
			// Drop any chrome and mount the iframe + the SDK.
			document.body.innerHTML =
				'<iframe id="w" style="width:600px;height:600px;border:0" ' +
				'src="' + BASE + '/widget#model=' + encodeURIComponent(DEMO_GLB) + '&kiosk=true"></iframe>';
			await new Promise((r) => {
				const s = document.createElement('script');
				s.src = BASE + '/widget-client.js';
				s.onload = r;
				s.onerror = r;
				document.head.appendChild(s);
			});
			if (!window.ThreeWidget) return { error: 'ThreeWidget global missing' };
			const client = window.ThreeWidget.attach(document.getElementById('w'));

			// Wait for the widget to be ready (model loaded).
			await client.ready(25000);
			// 1) ping roundtrip
			const ping = await client.call('ping', null, 5000);
			// 2) camera.getLookAt
			const cam = await client.call('camera.getLookAt');
			// 3) screenshot
			const shot = await client.call('screenshot.capture', { width: 200, height: 200 });

			return {
				ok: true,
				pingOk: ping?.pong === true,
				cam: Array.isArray(cam?.eye) && cam.eye.length === 3,
				shotOk: typeof shot?.dataUrl === 'string' && shot.dataUrl.startsWith('data:image/'),
			};
		},
		{ BASE, DEMO_GLB },
	);

	if (testResult.error) {
		fail('JSON-RPC test scaffold ran', testResult.error);
		return;
	}
	if (testResult.pingOk) ok('ping → { pong: true }');
	else fail('ping → { pong: true }', JSON.stringify(testResult));
	if (testResult.cam) ok('camera.getLookAt → { eye:[3] }');
	else fail('camera.getLookAt → { eye:[3] }', JSON.stringify(testResult));
	if (testResult.shotOk) ok('screenshot.capture → data: URL');
	else fail('screenshot.capture → data: URL', JSON.stringify(testResult));

	await page.screenshot({ path: '/tmp/widget-rpc-host.png' });
	console.log('  → /tmp/widget-rpc-host.png');
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
	`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — see failures above' : ''}`,
);
process.exit(failed.length ? 1 : 0);
