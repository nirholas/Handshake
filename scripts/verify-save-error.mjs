// Verifies the save-error UX added to /create-review:
//   - faked-auth window stages a real Save click
//   - presign route returns 502 to force the inline error surface
//   - asserts the error overlay shows title + detail + Retry/Cancel
//   - clicks Cancel → editing UI returns, save button re-enabled
//   - reopens the flow, clicks Retry → second presign request fires
//
// Run after `npm run dev`:  node scripts/verify-save-error.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const GLB_PATH = resolve('public/avatars/default.glb');

function fail(msg) {
	console.error('FAIL:', msg);
	process.exitCode = 1;
}

const glbBuffer = await readFile(GLB_PATH);
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

// Block Vite HMR so concurrent dev edits can't reload the page mid-test.
await page.route('**/@vite/client', (route) => route.abort());
await page.route('**/__vite_ping*', (route) => route.abort());
page.on('websocket', (ws) => {
	if (/\/\?token=|\/__hmr/.test(ws.url())) ws.close().catch(() => {});
});

// Fake a signed-in user so the page enables Save and the auth pre-check
// inside apiFetch's CSRF flow passes.
let presignCallCount = 0;
await page.route('**/api/auth/me', (route) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({
			user: {
				id: 'u-test',
				email: 'test@three.ws',
				display_name: 'Test User',
				plan: 'free',
				avatar_url: null,
				referral_code: 'TESTREF',
			},
		}),
	}),
);
await page.route('**/api/csrf-token', (route) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ data: { token: 'csrf-test' } }),
	}),
);
await page.route('**/api/avatars/presign', (route) => {
	presignCallCount++;
	return route.fulfill({
		status: 502,
		contentType: 'text/html',
		body: '<html>502 Bad Gateway</html>',
	});
});

async function gotoWithRetry(url, tries = 3) {
	for (let i = 0; i < tries; i++) {
		try {
			await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
			return;
		} catch (err) {
			if (i === tries - 1) throw err;
			await new Promise((r) => setTimeout(r, 1500));
		}
	}
}

await gotoWithRetry(`${BASE}/create-review`);

// Seed IDB with the staged GLB, then reload so create-review.js boots with it.
const glbB64 = Buffer.from(glbBuffer).toString('base64');
await page.evaluate(async (b64) => {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const blob = new Blob([bytes], { type: 'model/gltf-binary' });
	const id = 'errver01';
	const record = { blob, meta: { source: 'avaturn' }, id, name: 'Save-error verify', size: blob.size, createdAt: Date.now() };
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

consoleErrors.length = 0;
await page.reload({ waitUntil: 'load' });

// Wait for boot to finish staging + auth to resolve. The Save button starts
// disabled and becomes enabled by applyAuthState() once auth resolves.
await page.waitForFunction(
	() => !document.getElementById('content')?.hidden,
	{ timeout: 10_000 },
);
await page.waitForFunction(
	() => {
		const btn = document.getElementById('save-btn');
		return btn && !btn.disabled && btn.textContent.trim() === 'Save to my account';
	},
	{ timeout: 10_000 },
);

// First Save attempt → presign returns 502 → inline error surface appears.
await page.click('#save-btn');
await page.waitForFunction(
	() => document.getElementById('save-loading')?.getAttribute('data-state') === 'error',
	{ timeout: 10_000 },
);

// presign should have been called exactly once (no retry on 5xx for POST).
if (presignCallCount !== 1) fail(`expected 1 presign call, got ${presignCallCount}`);

const errLabel = await page.textContent('#save-loading .label');
const errDetail = await page.textContent('#save-loading .sublabel');
if (!/Couldn't reserve upload|Save didn't finish/.test(errLabel?.trim() || '')) {
	fail(`unexpected error title: "${errLabel}"`);
}
if (!/reach the server|try again/i.test(errDetail?.trim() || '')) {
	fail(`unexpected error detail: "${errDetail}"`);
}

// Cancel returns the page to editing.
await page.locator('#save-loading .cancel-btn').dispatchEvent('click');
await page.waitForFunction(
	() => !document.getElementById('save-loading'),
	{ timeout: 5_000 },
);
const saveStillEnabled = await page.evaluate(
	() => !document.getElementById('save-btn').disabled,
);
if (!saveStillEnabled) fail('Save button should re-enable after Cancel');

// Trigger the flow again, this time clicking Retry, and assert presign was
// called a second time (Retry actually re-runs onSave end to end).
await page.click('#save-btn');
await page.waitForFunction(
	() => document.getElementById('save-loading')?.getAttribute('data-state') === 'error',
	{ timeout: 10_000 },
);
const beforeRetry = presignCallCount;
await page.locator('#save-loading .retry-btn').dispatchEvent('click');
// Retry re-runs onSave → presign fires again → returns 502 → error surface
// reappears. Wait until presign has been called once more.
await page.waitForFunction(
	(prev) => window.__verifyPresignCount === undefined
		? true // We can't read presignCallCount across processes; just assert error reappears.
		: window.__verifyPresignCount > prev,
	beforeRetry,
	{ timeout: 10_000 },
);
// More authoritative: wait for the error overlay to reappear after Retry.
await page.waitForFunction(
	() => document.getElementById('save-loading')?.getAttribute('data-state') === 'error',
	{ timeout: 10_000 },
);
if (presignCallCount <= beforeRetry) fail(`Retry didn't fire a new presign call (count ${presignCallCount})`);

// Screenshot the error state for visual diff.
await page.screenshot({ path: '/tmp/create-review-save-error.png', fullPage: false });

if (consoleErrors.length) {
	const filtered = consoleErrors.filter(
		(e) =>
			!/favicon|three-ws:auth-resolved|^Refused to apply style/.test(e) &&
			!/net::ERR_FAILED|Failed to load resource/i.test(e) &&
			// The save itself logs '[create-review] save failed' to console.error —
			// expected and exercised below.
			!/\[create-review\] save failed/.test(e),
	);
	if (filtered.length) {
		console.error('console errors:');
		for (const e of filtered) console.error('  ', e);
		fail('unexpected console errors');
	}
}

await browser.close();

if (process.exitCode) console.error('verification failed');
else console.log('OK (presign calls:', presignCallCount, ')');
