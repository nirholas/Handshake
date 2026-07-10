#!/usr/bin/env node
/**
 * Reproduce the /walk mobile GLTFLoader texture + avatar-fetch failures with
 * full network detail, so the root cause is observed rather than guessed.
 *
 *   node scripts/repro-walk-mobile.mjs [url] [--desktop]
 */
import { chromium, devices } from 'playwright';

const url = process.argv[2]?.startsWith('http') ? process.argv[2] : 'https://three.ws/walk';
const desktop = process.argv.includes('--desktop');

const browser = await chromium.launch();
const context = await browser.newContext(
	desktop ? { viewport: { width: 1440, height: 900 } } : { ...devices['iPhone 13'] },
);
const page = await context.newPage();

const failures = [];
page.on('requestfailed', (r) => {
	failures.push({ kind: 'requestfailed', url: r.url().slice(0, 120), err: r.failure()?.errorText });
});
page.on('response', async (r) => {
	if (r.status() >= 400) failures.push({ kind: 'http', status: r.status(), url: r.url().slice(0, 120) });
});
page.on('console', (m) => {
	if (m.type() === 'error') failures.push({ kind: 'console', text: m.text().slice(0, 200) });
});
page.on('pageerror', (e) => failures.push({ kind: 'pageerror', text: String(e).slice(0, 200) }));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Report what three.js actually chose for its texture loader + whether the UA
// triggers the Safari/Firefox ImageBitmapLoader opt-out.
const env = await page.evaluate(() => ({
	ua: navigator.userAgent,
	hasCreateImageBitmap: typeof createImageBitmap !== 'undefined',
	safariMatch: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
	deviceMemory: navigator.deviceMemory ?? null,
	maxTextureHint: (() => {
		try {
			const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
			return gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 'no-webgl';
		} catch (e) { return `err:${e.message}`; }
	})(),
}));

await page.waitForTimeout(15000);

console.log('ENV', JSON.stringify(env, null, 1));
console.log('\nFAILURES', failures.length);
const seen = new Set();
for (const f of failures) {
	const key = `${f.kind}:${(f.text || f.url || '').slice(0, 60)}`;
	if (seen.has(key)) continue;
	seen.add(key);
	console.log(' ', JSON.stringify(f));
}

await browser.close();
