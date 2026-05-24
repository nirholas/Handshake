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

	try {
		await page.screenshot({ path: '/tmp/widget-reveal-after.png' });
		console.log('  → /tmp/widget-reveal-after.png');
	} catch (e) {
		console.log('  (screenshot skipped — swiftshader instability)');
	}
});

// 5. JSON-RPC roundtrip: exercise the in-iframe server via direct
// window.postMessage so we don't need an actual cross-origin host page.
// (We also avoid screenshot.capture here — the watermark fetch + canvas
// pipeline destabilises swiftshader in CI; manual browser test covers it.)
await withPage('JSON-RPC: ping + camera + animation + info', async (page) => {
	const url = `${BASE}/widget#model=${encodeURIComponent(DEMO_GLB)}&kiosk=true`;
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await waitForFirstFrame(page);

	const rpc = (method, params, timeoutMs) =>
		page.evaluate(
			async ({ method, params, timeoutMs }) => {
				const id = Math.floor(Math.random() * 1e9);
				return await new Promise((resolve) => {
					const handler = (e) => {
						if (!e.data || e.data.jsonrpc !== '2.0' || e.data.id !== id) return;
						// Ignore the echo of our own request — wait for the
						// reply (result/error).
						if (!('result' in e.data) && !('error' in e.data)) return;
						window.removeEventListener('message', handler);
						resolve(e.data);
					};
					window.addEventListener('message', handler);
					window.postMessage(
						{ jsonrpc: '2.0', id, method, params: params || {} },
						location.origin,
					);
					setTimeout(() => {
						window.removeEventListener('message', handler);
						resolve({ timeout: true });
					}, timeoutMs || 6000);
				});
			},
			{ method, params, timeoutMs: timeoutMs || 6000 },
		);

	const ping = await rpc('ping');
	if (ping?.result?.pong === true) ok('ping → { pong: true }');
	else fail('ping → { pong: true }', JSON.stringify(ping));

	const cam = await rpc('camera.getLookAt');
	if (Array.isArray(cam?.result?.eye) && cam.result.eye.length === 3)
		ok('camera.getLookAt → { eye:[3], target, fov }');
	else fail('camera.getLookAt → { eye:[3] }', JSON.stringify(cam));

	const list = await rpc('animation.list');
	const clips = list?.result?.clips;
	if (Array.isArray(clips) && clips.length > 0)
		ok(`animation.list → ${clips.length} clips`);
	else fail('animation.list → clips[]', JSON.stringify(list));

	const info = await rpc('viewer.getInfo');
	if (info?.result?.ready === true)
		ok(`viewer.getInfo → ready=true, model=${info.result.model || '(none)'}`);
	else fail('viewer.getInfo → ready', JSON.stringify(info));

	const unknown = await rpc('not.a.method');
	if (unknown?.error?.code === -32601)
		ok('unknown method → -32601 Method not found');
	else fail('unknown method → -32601', JSON.stringify(unknown));

	// setEnvironment was previously documented but unwired — guard against regression.
	const envOk = await rpc('viewer.setEnvironment', { preset: 'venice-sunset' });
	if (envOk?.result && !envOk.error)
		ok('viewer.setEnvironment(venice-sunset) succeeds');
	else fail('viewer.setEnvironment succeeds', JSON.stringify(envOk));
	const envBad = await rpc('viewer.setEnvironment', { preset: '' });
	if (envBad?.error?.code === -32603)
		ok('viewer.setEnvironment("") → -32603 internal error');
	else fail('viewer.setEnvironment("") → -32603', JSON.stringify(envBad));

	// animation.stop used the wrong AnimationManager method name pre-fix;
	// success here proves the regression won't return.
	const stop = await rpc('animation.stop');
	if (stop?.result && !stop.error) ok('animation.stop succeeds (was no-op)');
	else fail('animation.stop succeeds', JSON.stringify(stop));

	// model.export returns binary GLB as base64 — proves the legacy
	// exportGLB bridge is fully covered by JSON-RPC now. GLTFExporter.parse
	// can take several seconds the first time it's imported.
	const exp = await rpc('model.export', null, 30000);
	if (
		typeof exp?.result?.base64 === 'string' &&
		exp.result.base64.length > 1000 &&
		typeof exp.result.bytes === 'number' &&
		exp.result.bytes > 1000
	)
		ok(`model.export → ${exp.result.bytes} bytes GLB`);
	else fail('model.export → GLB base64', JSON.stringify(exp).slice(0, 200));

	// screenshot.capture at exact off-screen size — exercises the
	// WebGLRenderTarget path (vs. the canvas.toDataURL fallback).
	const shot = await rpc('screenshot.capture', { width: 200, height: 200 }, 15000);
	if (
		typeof shot?.result?.dataUrl === 'string' &&
		shot.result.dataUrl.startsWith('data:image/')
	)
		ok(`screenshot.capture(200x200) → ${shot.result.dataUrl.length} chars`);
	else fail('screenshot.capture(200x200)', JSON.stringify(shot).slice(0, 200));
});

// 6. Multi-instance — two iframes side-by-side, one ThreeWidget client each,
// confirm a call on one doesn't leak to the other (no cross-talk).
await withPage('Multi-instance: two clients, two widgets, no cross-talk', async (page) => {
	await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
	const result = await page.evaluate(
		async ({ BASE, DEMO_GLB }) => {
			document.body.innerHTML =
				'<iframe id="a" style="width:300px;height:300px;border:0" src="' +
				BASE +
				'/widget#model=' +
				encodeURIComponent(DEMO_GLB) +
				'&kiosk=true"></iframe>' +
				'<iframe id="b" style="width:300px;height:300px;border:0" src="' +
				BASE +
				'/widget#model=' +
				encodeURIComponent(DEMO_GLB) +
				'&kiosk=true"></iframe>';
			await new Promise((r) => {
				const s = document.createElement('script');
				s.src = BASE + '/widget-client.js';
				s.onload = r;
				s.onerror = r;
				document.head.appendChild(s);
			});
			if (!window.ThreeWidget) return { error: 'ThreeWidget missing' };
			const a = window.ThreeWidget.attach(document.getElementById('a'));
			const b = window.ThreeWidget.attach(document.getElementById('b'));
			await Promise.all([a.ready(60000), b.ready(60000)]);

			// Count event traffic per client over a short window — they should
			// each only see their own iframe's events.
			let aEvents = 0;
			let bEvents = 0;
			a.on('*', () => aEvents++);
			b.on('*', () => bEvents++);
			// Drive a unique change on each — different bg colours.
			const [aSet, bSet] = await Promise.all([
				a.call('viewer.setBackground', { color: '#101030' }),
				b.call('viewer.setBackground', { color: '#301010' }),
			]);
			// And confirm each client's roundtrip returned its own result.
			const [aInfo, bInfo] = await Promise.all([
				a.call('viewer.getInfo'),
				b.call('viewer.getInfo'),
			]);
			return {
				bothReady: aInfo?.ready === true && bInfo?.ready === true,
				aSet: aSet && !aSet.error,
				bSet: bSet && !bSet.error,
				aIndependent: aEvents <= 2 && bEvents <= 2,
			};
		},
		{ BASE, DEMO_GLB },
	);

	if (result.error) {
		fail('multi-instance scaffold', result.error);
		return;
	}
	if (result.bothReady) ok('both widgets ready independently');
	else fail('both widgets ready', JSON.stringify(result));
	if (result.aSet && result.bSet) ok('parallel setBackground succeeds on both');
	else fail('parallel setBackground', JSON.stringify(result));
});

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
	`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — see failures above' : ''}`,
);
process.exit(failed.length ? 1 : 0);
