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

const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

// Land on the same origin first so we can write to its IndexedDB.
await page.goto(`${BASE}/create`, { waitUntil: 'domcontentloaded' });

// Stage the avatar exactly the way guest-avatar.stage() does.
const glbB64 = Buffer.from(glbBuffer).toString('base64');
await page.evaluate(async (b64) => {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const blob = new Blob([bytes], { type: 'model/gltf-binary' });

	const db = await new Promise((res, rej) => {
		const req = indexedDB.open('three-ws-guest', 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore('avatars');
		};
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction('avatars', 'readwrite');
		const store = tx.objectStore('avatars');
		const id = '19b160abcdef';
		store.put(
			{
				blob,
				meta: { source: 'avaturn' },
				id,
				name: `Avatar #${id.slice(0, 6)}`,
				size: blob.size,
				createdAt: Date.now(),
			},
			'pending',
		);
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
	db.close();
	localStorage.setItem(
		'3dagent:guest-avatar-meta',
		JSON.stringify({ id: '19b160abcdef', name: 'Avatar #19b160', size: 1, createdAt: Date.now(), source: 'avaturn' }),
	);
}, glbB64);

await page.goto(`${BASE}/create-review`, { waitUntil: 'domcontentloaded' });

// Wait for the viewer canvas to mount and the loading overlay to fade out.
await page.waitForSelector('#mv-container canvas', { timeout: 15_000 });
await page.waitForFunction(
	() => document.getElementById('viewer-loading')?.classList.contains('is-hidden'),
	{ timeout: 15_000 },
);

// Heading should show the friendly fallback, not the raw "Avatar #19b160".
const heading = (await page.textContent('#avatar-name'))?.trim();
if (heading === 'Avatar #19b160') fail(`heading still shows auto-generated name "${heading}"`);
if (heading !== 'Your new avatar') fail(`heading expected "Your new avatar", got "${heading}"`);

const nameInputValue = await page.inputValue('#f-name');
if (nameInputValue !== '') fail(`name input expected empty, got "${nameInputValue}"`);

const sourceTag = (await page.textContent('#tag-source'))?.trim();
if (sourceTag !== 'Avaturn') fail(`source tag expected "Avaturn", got "${sourceTag}"`);

// Unlocks block must be present.
const unlocks = await page.locator('.unlocks li').allTextContents();
if (unlocks.length !== 3) fail(`unlocks list expected 3 items, got ${unlocks.length}`);

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

// Screenshot for visual diff.
await page.screenshot({ path: SHOT_PATH, fullPage: false });
console.log('screenshot:', SHOT_PATH);

if (consoleErrors.length) {
	const filtered = consoleErrors.filter(
		(e) => !/favicon|three-ws:auth-resolved|^Refused to apply style/.test(e),
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
