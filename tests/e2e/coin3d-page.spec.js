// /coin3d: the defects the route audit found, all of which reproduce on the
// pre-fix page.
//
// 1. The page had no <h1> in any state but the populated one. Landing, loading
//    and both error states led with an <h2> under a heading that never
//    rendered, so the document had no top-level heading at all.
//
// 2. The landing card sized its grid track from its own max-content, so on a
//    320px screen the "View in 3D" button and the third column of the launch
//    grid sat off-screen, and `body { overflow: hidden }` meant the card's own
//    footer links were clipped with no way to scroll to them.
//
// 3. Every failure produced the same "Token not found" copy, including a total
//    outage where nothing answered at all. A visitor with no connection was
//    told the coin does not exist.
//
// These tests deliberately avoid waiting on live token data: the landing and
// the two error states need no upstream, so the spec is fast and deterministic
// while still driving the real shipped module.

import { test, expect } from '@playwright/test';
import { collectPageErrors } from './_support.js';

// The platform's own coin. Used only as a well-formed mint for the routing
// assertions; no test here asserts on its market data.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

/** Cut every data source the token view can reach, upstream ones included. */
async function blackout(page) {
	for (const glob of [
		'**/api/pump-fun-mcp',
		'**/api/pump/**',
		'**/api/oracle/**',
		'**/api.geckoterminal.com/**',
		'**/api.dexscreener.com/**',
		'**/lite-api.jup.ag/**',
	]) {
		await page.route(glob, (route) => route.abort('failed'));
	}
}

test('/coin3d leads every state with exactly one h1', async ({ page }) => {
	const errors = collectPageErrors(page);

	await page.goto('/coin3d', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await expect(page.locator('h1')).toHaveCount(1);
	await expect(page.locator('h1')).toHaveText('See any token in 3D');
	// The landing is the empty state, and it is designed: it says what to do
	// and offers a way in that needs no typing.
	await expect(page.locator('#status')).toHaveAttribute('data-kind', 'empty');
	await expect(page.locator(`a.c3d-three[href="?mint=${THREE_MINT}"]`)).toBeVisible();

	// An unusable mint is an error state, not a blank scene.
	await page.goto('/coin3d?mint=notavalidmint', {
		waitUntil: 'domcontentloaded',
		timeout: 60_000,
	});
	await expect(page.locator('#status')).toHaveAttribute('data-kind', 'error');
	await expect(page.locator('h1')).toHaveCount(1);
	await expect(page.locator('h1')).toHaveText('Invalid mint address');
	// The recovery action is a real link back to the search, not a dead end.
	await expect(page.locator('.status-action')).toHaveAttribute('href', '/coin3d');

	expect(errors).toEqual([]);
});

test('/coin3d landing fits a 320px viewport and can be scrolled to its last link', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 640 });
	await page.goto('/coin3d', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForSelector('.c3d-search button', { timeout: 60_000 });

	const box = await page.evaluate(() => {
		const de = document.documentElement;
		const status = document.getElementById('status');
		const card = document.querySelector('.c3d-landing');
		return {
			pageOverflows: de.scrollWidth > de.clientWidth,
			overlayOverflows: status.scrollWidth > status.clientWidth,
			cardRight: Math.round(card.getBoundingClientRect().right),
			viewport: de.clientWidth,
		};
	});
	expect(box.pageOverflows).toBe(false);
	expect(box.overlayOverflows).toBe(false);
	expect(box.cardRight).toBeLessThanOrEqual(box.viewport);

	// The submit button is the whole point of the landing; it must be on screen.
	await expect(page.locator('.c3d-search button')).toBeInViewport();

	// The footer links live below the fold on a short screen. They are reachable
	// because the overlay scrolls, even though the body never does.
	const footer = page.locator('.c3d-landing-foot a', { hasText: 'Launch your own' });
	await footer.scrollIntoViewIfNeeded();
	await expect(footer).toBeInViewport();
});

test('/coin3d search rejects a malformed mint in place and routes a good one', async ({ page }) => {
	await page.goto('/coin3d', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForSelector('#c3d-form', { timeout: 60_000 });

	await page.fill('#c3d-mint-input', 'not-a-mint');
	await page.click('#c3d-go');
	await expect(page.locator('#c3d-err')).not.toBeEmpty();
	// Rejected in place: the visitor keeps their typing and the page stays put.
	expect(new URL(page.url()).search).toBe('');

	// Typing again clears the complaint rather than leaving it stale.
	await page.fill('#c3d-mint-input', THREE_MINT);
	await expect(page.locator('#c3d-err')).toBeEmpty();

	await page.click('#c3d-go');
	await page.waitForURL(`**/coin3d?mint=${THREE_MINT}`, { timeout: 60_000 });
});

test('/coin3d says it could not reach the sources, rather than that the coin does not exist', async ({
	page,
}) => {
	await blackout(page);
	await page.goto(`/coin3d?mint=${THREE_MINT}`, {
		waitUntil: 'domcontentloaded',
		timeout: 60_000,
	});

	const status = page.locator('#status');
	await expect(status).toHaveAttribute('data-kind', 'error', { timeout: 120_000 });
	await expect(page.locator('h1')).toHaveText("Can't reach the data sources");
	// Actionable: retrying this exact token is one click, and it is a real URL.
	const action = page.locator('.status-action');
	await expect(action).toHaveText('Retry');
	await expect(action).toHaveAttribute('href', `/coin3d?mint=${THREE_MINT}`);
});
