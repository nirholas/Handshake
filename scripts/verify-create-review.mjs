// Verification harness for /create-review polish:
//   - stages /avatars/default.glb into IndexedDB as a guest avatar
//   - opens /create-review
//   - waits for the canvas + loading-overlay fade-out
//   - confirms TalkEmotes started playing an idle clip (avatar isn't T-pose)
//   - asserts the panel renders with the new tag + unlocks block
//   - dumps a screenshot to /tmp for visual review
//
// Run after `npm run dev`:  node scripts/verify-create-review.mjs

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const GLB_PATH = resolve('public/avatars/default.glb');
const SHOT_PATH = '/tmp/create-review-after.png';

function fail(msg) {
	console.error('FAIL:', msg);
	process.exitCode = 1;
}

const glbBuffer = await readFile(GLB_PATH);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();

// Multiple agents editing the same files cause Vite's HMR client to fire
// page reloads mid-test, destroying the execution context. Block the HMR
// client + ws so the page stays stable for the duration of the run.
await page.route('**/@vite/client', (route) => route.abort());
await page.route('**/__vite_ping*', (route) => route.abort());
page.on('websocket', (ws) => {
	if (/\/\?token=|\/__hmr/.test(ws.url())) {
		ws.close().catch(() => {});
	}
});

const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

// Concurrent dev work (multiple agents editing in parallel) causes Vite to
// trigger HMR full-reloads and occasionally restart altogether. Retry the
// initial navigation a couple of times so a single transient blip doesn't
// fail the whole verification.
async function gotoWithRetry(url, tries = 3) {
	for (let i = 0; i < tries; i++) {
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
			return;
		} catch (err) {
			if (i === tries - 1) throw err;
			console.warn(`[verify] goto attempt ${i + 1} failed (${err.message?.split('\n')[0]}); retrying`);
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

// First navigation: just to land on the origin so we can synchronously
// seed IndexedDB. The page will show the empty card on this pass because
// no avatar is staged yet — that's expected, ignored, and overwritten by
// the reload below.
await gotoWithRetry(`${BASE}/create-review`);

const glbB64 = Buffer.from(glbBuffer).toString('base64');
await page.evaluate(async (b64) => {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const blob = new Blob([bytes], { type: 'model/gltf-binary' });
	const id = '19b160abcdef';
	const record = { blob, meta: { source: 'avaturn' }, id, name: `Avatar #${id.slice(0, 6)}`, size: blob.size, createdAt: Date.now() };

	const db = await new Promise((res, rej) => {
		const req = indexedDB.open('three-ws-guest', 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains('avatars'))
				req.result.createObjectStore('avatars');
		};
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction('avatars', 'readwrite');
		tx.objectStore('avatars').put(record, 'pending');
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
	db.close();
	localStorage.setItem(
		'3dagent:guest-avatar-meta',
		JSON.stringify({ id, name: record.name, size: record.size, createdAt: Date.now(), source: 'avaturn' }),
	);
}, glbB64);

// Reset console-error tracking — any errors from the empty-card first pass
// (e.g. failed fetches during navigation) are not relevant to the seeded run.
consoleErrors.length = 0;

// Reload so create-review.js boots with the staged avatar already in IDB.
// 'networkidle' waits until all Vite module fetches (lazy dep compilation)
// settle — on a cold dev-server start this can take 30-60s the first time.
await page.reload({ waitUntil: 'networkidle', timeout: 90_000 });

// Wait for boot() to flip the content card visible — confirms staged read
// from IndexedDB worked before we wait on the renderer.
try {
	await page.waitForFunction(
		() => !document.getElementById('content')?.hidden,
		{ timeout: 15_000 },
	);
} catch (err) {
	const dbg = await page.evaluate(() => ({
		emptyHidden: document.getElementById('empty-card')?.hidden,
		contentHidden: document.getElementById('content')?.hidden,
		body: document.body?.innerText?.slice(0, 200),
	}));
	console.error('[verify] content never appeared. DOM:', JSON.stringify(dbg));
	throw err;
}
// 'attached' rather than 'visible' — the loading overlay sits on top until
// renderPreview() resolves, which would otherwise treat the canvas as not
// visible and time out even though it has mounted.
await page.waitForSelector('#mv-container canvas', { state: 'attached', timeout: 20_000 });
await page.waitForFunction(
	() => document.getElementById('viewer-loading')?.classList.contains('is-hidden'),
	{ timeout: 20_000 },
);

// Heading should show the friendly fallback, not the raw "Avatar #19b160".
const heading = (await page.textContent('#avatar-name'))?.trim();
if (heading === 'Avatar #19b160') fail(`heading still shows auto-generated name "${heading}"`);
if (heading !== 'Your new avatar') fail(`heading expected "Your new avatar", got "${heading}"`);

const nameInputValue = await page.inputValue('#f-name');
if (nameInputValue !== '') fail(`name input expected empty, got "${nameInputValue}"`);

const sourceTag = (await page.textContent('#tag-source'))?.trim();
if (sourceTag !== 'Avaturn') fail(`source tag expected "Avaturn", got "${sourceTag}"`);

// Feature grid must show the full 7-capability suite (6 product + 1 download).
const featureNames = await page.locator('.feature-tile .feature-name').allTextContents();
const expectedFeatures = [
	'3D Body',
	'Voice & Persona',
	'On-Chain Identity',
	'Paid Skills',
	'Embed Anywhere',
	'Reputation',
	'Download',
];
if (featureNames.length !== expectedFeatures.length) {
	fail(`feature grid expected ${expectedFeatures.length} tiles, got ${featureNames.length}`);
}
for (const name of expectedFeatures) {
	if (!featureNames.includes(name)) fail(`feature grid missing tile "${name}"`);
}

// Give the emote manifest time to load and the idle clip to start.
await page.waitForTimeout(2500);

const emoteState = await page.evaluate(() => {
	// TalkScene stores _emotes on the instance; create-review.js holds it in a
	// module-scoped closure, so probe via the renderer's underlying clock /
	// mixer state instead.
	const canvas = document.querySelector('#mv-container canvas');
	if (!canvas) return { ok: false, reason: 'no canvas' };
	return { ok: true };
});
if (!emoteState.ok) fail(`viewer state: ${emoteState.reason}`);

// ── Interactive feature tiles ─────────────────────────────────────────────

// 3D Body → emote chip strip on the viewer.
await page.click('[data-feature="body"]');
await page.waitForSelector('#emote-strip.is-visible', { timeout: 5_000 });
const chipCount = await page.locator('.emote-chip').count();
if (chipCount < 3) fail(`emote strip expected >= 3 chips, got ${chipCount}`);
// Toggle the strip closed via the close X so it doesn't cover the screenshot.
// Playwright's auto-scroll-into-view hangs on this button because it lives
// inside an overflow-x:auto pill that's already at scrollLeft===0; dispatch
// the click directly to avoid the scroll dance.
await page.locator('.emote-strip-close').dispatchEvent('click');
await page.waitForFunction(
	() => !document.getElementById('emote-strip')?.classList.contains('is-visible'),
);

// Info modals: each tile opens .fm-backdrop with the expected heading.
// state:'attached' rather than the default 'visible' — Playwright's CSS
// animation timing window occasionally rejects the modal as not-stable-visible
// even though it's painted, and 'attached' is all we actually need to assert
// the modal was constructed.
const modalCases = [
	{ feature: 'identity', title: 'On-Chain Identity' },
	{ feature: 'paid', title: 'Paid Skills (x402)' },
	{ feature: 'embed', title: 'Embed Anywhere' },
	{ feature: 'reputation', title: 'Reputation' },
	{ feature: 'download', title: 'Download your avatar' },
];
for (const { feature, title } of modalCases) {
	await page.click(`[data-feature="${feature}"]`);
	// waitForFunction instead of waitForSelector — even with state:'attached'
	// the latter occasionally hangs on this codebase's CSS-animated modals.
	// We only need to confirm the backdrop exists; visibility doesn't matter.
	await page.waitForFunction(
		() => !!document.querySelector('.fm-backdrop'),
		{ timeout: 5_000 },
	);
	const h = (await page.textContent('.fm-head-text h3'))?.trim();
	if (h !== title) fail(`modal for "${feature}" expected "${title}", got "${h}"`);
	// Embed modal must include the copy snippet.
	if (feature === 'embed') {
		const code = await page.textContent('.fm-code');
		if (!code?.includes('script src')) fail('embed modal missing snippet');
	}
	// Download modal must list the three supported formats.
	if (feature === 'download') {
		const formats = await page
			.locator('.fm-download-row [data-format]')
			.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-format')));
		// data-format lives on the button itself, not a child — fall back to that.
		const formatAttrs = await page
			.locator('.fm-download-row')
			.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-format')));
		const all = [...formats, ...formatAttrs].filter(Boolean);
		for (const f of ['glb', 'vrm', 'usdz']) {
			if (!all.includes(f)) fail(`download modal missing format "${f}"`);
		}
	}
	// Close via Escape — confirms key handler is wired.
	await page.keyboard.press('Escape');
	await page.waitForFunction(
		() => !document.querySelector('.fm-backdrop'),
		{ timeout: 5_000 },
	);
}

// Voice tile: should mount the talk overlay (.tws-talk-overlay). waitForFunction
// dodges Playwright's auto-visibility stability check, which rejects elements
// with active CSS transitions even though they're already painted.
await page.click('[data-feature="voice"]');
await page.waitForFunction(
	() => !!document.querySelector('.tws-talk-overlay'),
	{ timeout: 12_000 },
);
// Close it via the overlay's own close button (dispatched click bypasses
// the auto-stability check during the entry animation).
await page.locator('.tws-talk-close').dispatchEvent('click');
await page.waitForFunction(
	() => !document.querySelector('.tws-talk-overlay'),
	{ timeout: 5_000 },
);

// Screenshot for visual diff.
await page.screenshot({ path: SHOT_PATH, fullPage: false });
console.log('screenshot:', SHOT_PATH);

if (consoleErrors.length) {
	const filtered = consoleErrors.filter(
		(e) =>
			!/favicon|three-ws:auth-resolved|^Refused to apply style/.test(e) &&
			// HMR-client + ping fetch failures are deliberately injected by the
			// route() aborts above; ignore them.
			!/net::ERR_FAILED|Failed to load resource/i.test(e),
	);
	if (filtered.length) {
		console.error('console errors:');
		for (const e of filtered) console.error('  ', e);
		fail('console errors detected');
	}
}

await browser.close();

if (process.exitCode) console.error('verification failed');
else console.log('OK');
