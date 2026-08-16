// /bnb hub: the two regressions the route audit found, both of which reproduced
// live on production before the fix.
//
// 1. The hero tally ("3 of 3 demo tracks live now") is written by src/bnb.js,
//    but #bnb-progress also carries data-i18n for its "Checking…" placeholder.
//    The i18n catalog pass lands after an async /api/locale fetch and reverted
//    the finished tally back to the placeholder, so the page permanently read
//    "Checking which tracks are live…" while every card already said Live.
//    src/bnb.js now claims the element with data-i18n-owned.
//
// 2. Each card probes its route with HEAD/OPTIONS and reads only the status.
//    Leaving the body unread kept the stream open while the 4s timeout signal
//    stayed armed, so the browser cancelled all four probes seconds later and
//    logged a net::ERR_ABORTED failed request per card. src/bnb.js now drains
//    the response.
//
// Both assertions are about the page settling correctly, so each test waits
// past the point where the old bugs surfaced rather than sampling at load.

import { test, expect } from '@playwright/test';

// Longer than the 4s probe timeout, so a re-introduced abort has time to fire.
const SETTLE_MS = 6_000;

test('/bnb reports the real track tally instead of the i18n placeholder', async ({ page }) => {
	await page.goto('/bnb', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForTimeout(SETTLE_MS);

	const progress = page.locator('#bnb-progress');
	// The script sets data-any-live once it has resolved every card, so this
	// pins the assertion to a finished run rather than a slow one.
	await expect(progress).toHaveAttribute('data-i18n-owned', '1');
	await expect(progress).toHaveText(/\d+ of \d+ demo tracks? live/);

	const cards = page.locator('.bnb-card');
	await expect(cards).toHaveCount(3);
	for (const state of await cards.locator('.bnb-status').evaluateAll((els) => els.map((e) => e.dataset.state)))
		expect(state, 'every card resolves to a decided state').not.toBe('checking');
});

test('/bnb settles with no aborted probe requests and no console errors', async ({ page }) => {
	const failed = [];
	const errors = [];
	page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
	page.on('console', (m) => {
		// The Vite dev client's HMR websocket cannot reach a forwarded port in a
		// container; that is the harness, not this page. Production serves the
		// same page with an empty console.
		if (m.type() === 'error' && !m.text().includes('WebSocket') && !m.text().includes('[vite]'))
			errors.push(m.text());
	});
	page.on('pageerror', (e) => {
		if (!e.message.includes('WebSocket')) errors.push(`pageerror: ${e.message}`);
	});

	await page.goto('/bnb', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForTimeout(SETTLE_MS);

	expect(failed, 'card probes must drain their response, not get cancelled').toEqual([]);
	expect(errors).toEqual([]);
});

test('/bnb shows an actionable error state when the block-time API is unreachable', async ({ page }) => {
	let offline = true;
	await page.route('**/api/bnb/block-time**', (route) => (offline ? route.abort() : route.continue()));

	await page.goto('/bnb', { waitUntil: 'domcontentloaded', timeout: 60_000 });

	const retry = page.locator('#bnb-proof-retry');
	await expect(retry).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('#bnb-proof-card [role="alert"]')).toContainText(/unreachable/i);

	// Recovering has to be possible from the page itself, not by reloading.
	offline = false;
	await retry.click();
	await expect(page.locator('.bnb-proof-num')).toBeVisible({ timeout: 30_000 });
});
