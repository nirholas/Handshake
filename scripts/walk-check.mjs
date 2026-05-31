// Headless smoke test for /walk — loads the page in real Chromium, grants
// camera permission, waits for the avatar to load, and reports what actually
// happens: console errors, page errors, failed network requests, whether the
// loading overlay clears, whether the canvas renders, and whether the AR
// button is reachable. Writes a JSON verdict to /tmp/walk-check.json.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.env.WALK_URL || 'http://localhost:3000/walk?avatar=803832e4-737e-4222-a7af-d040aa0567a4&name=guest-846x';
const OUT = '/tmp/walk-check.json';

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await chromium.launch({
	args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({
	permissions: ['camera'],
	viewport: { width: 390, height: 844 },     // iPhone-ish so touch/AR UI paths run
	userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
	isMobile: true,
	hasTouch: true,
});
const page = await ctx.newPage();

page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => {
	const u = r.url();
	// Ignore the known-noisy third parties so the signal is the app itself.
	if (/posthog|i\.posthog|ingest|chrome-extension|google|sentry/.test(u)) return;
	failedRequests.push(`${r.failure()?.errorText || 'failed'} ${u}`);
});

let navError = null;
try {
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) {
	navError = e.message;
}

// Give the scene time to boot, load the avatar GLB, and connect.
await page.waitForTimeout(9000);

const verdict = await page.evaluate(() => {
	const q = (id) => document.getElementById(id);
	const loading = q('walk-loading');
	const canvas = q('walk-canvas');
	const arBtn = q('walk-ar-toggle');
	const status = q('walk-status');
	const cs = arBtn ? getComputedStyle(arBtn) : null;
	const actions = document.querySelector('.walk-actions');
	const acs = actions ? getComputedStyle(actions) : null;
	return {
		loadingPresent: !!loading,
		loadingDone: loading ? loading.classList.contains('is-done') : null,
		loadingDisplay: loading ? getComputedStyle(loading).display : null,
		loadingText: q('walk-loading-text')?.textContent ?? null,
		canvasPresent: !!canvas,
		canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
		statusText: status?.textContent ?? null,
		arButtonPresent: !!arBtn,
		arButtonVisible: cs ? (cs.display !== 'none' && cs.visibility !== 'hidden') : null,
		actionsVisible: acs ? (acs.display !== 'none') : null,
		onlineLabel: q('walk-online')?.getAttribute('data-status') ?? null,
		title: document.title,
		bodyChildCount: document.body.childElementCount,
	};
});

// Did WebGL actually produce pixels? Sample the canvas center.
let canvasHasPixels = null;
try {
	const shot = await page.locator('#walk-canvas').screenshot({ timeout: 5000 });
	canvasHasPixels = shot.length > 2000; // a blank canvas PNG is tiny
} catch (e) {
	canvasHasPixels = `screenshot failed: ${e.message}`;
}

await page.screenshot({ path: '/tmp/walk-shot.png', fullPage: false }).catch(() => {});

const result = {
	url: URL,
	navError,
	verdict,
	canvasHasPixels,
	consoleErrors: consoleErrors.slice(0, 25),
	pageErrors: pageErrors.slice(0, 25),
	failedRequests: failedRequests.slice(0, 25),
	counts: {
		consoleErrors: consoleErrors.length,
		pageErrors: pageErrors.length,
		failedRequests: failedRequests.length,
	},
};

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('WALK_CHECK_DONE');
console.log(JSON.stringify(result.counts));
await browser.close();
