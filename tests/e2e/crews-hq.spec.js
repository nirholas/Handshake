// /crews (Crew HQ): the route audit's findings, each of which reproduces on the
// pre-fix page.
//
// 1. /crews/<TAG> had no dev route at all, so every directory card and every
//    shared crew link 404'd locally while working in production. Half the page
//    (the public-crew view) could not be opened without deploying it first.
//
// 2. A signed-out visitor's first paint fired GET /api/crews, which is 401 by
//    design, and printed a red error in the console of a public page. The
//    session now resolves through /api/auth/me, which answers 200 for everyone.
//
// 3. The presence poll re-rendered the whole room every 20 seconds, destroying
//    and rebuilding every <agent-3d>: new WebGL contexts four times a minute
//    against a browser cap of roughly sixteen. Presence is now written into the
//    figures already standing.
//
// The crew data is live, so every assertion is about structure and behaviour
// rather than a particular crew being present.

import { test, expect } from '@playwright/test';

async function topCrewTag(request) {
	const res = await request.get('/api/crews/directory?limit=24');
	expect(res.ok()).toBe(true);
	const { data } = await res.json();
	return data?.crews?.[0]?.tag || '';
}

// Fire one presence poll now instead of waiting out PRESENCE_POLL_MS: the page
// polls on visibilitychange as well as on the interval, and both run the same
// tick.
async function pollNow(page) {
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await page.waitForTimeout(2500);
}

test('/crews serves a signed-out visitor the directory with a clean console', async ({ page }) => {
	const errors = [];
	page.on('console', (m) => {
		// The Vite dev client's HMR socket cannot reach a Codespace port that is
		// not forwarded; that is the harness, not the page.
		if (m.type() === 'error' && !/websocket/i.test(m.text())) errors.push(m.text());
	});

	await page.goto('/crews', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await expect(page.locator('h1')).toHaveText('Crew HQ');
	await expect(page.locator('#cw-signedout')).toBeVisible();
	// The founding form belongs to someone who can submit it.
	await expect(page.locator('#cw-found-panel')).toBeHidden();
	await expect(page.locator('#cw-dir-panel')).toBeVisible();
	await page.waitForFunction(() => !/Loading crews/.test(document.getElementById('cw-dir').textContent));

	expect(errors, `console errors on a public page: ${errors.join(' | ')}`).toEqual([]);
});

test('/crews/<TAG> opens a crew headquarters and keeps its figures across a poll', async ({
	page,
	request,
}) => {
	const tag = await topCrewTag(request);
	test.skip(!tag, 'no crew exists to open');

	const res = await page.goto(`/crews/${tag}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	expect(res.status(), '/crews/<TAG> must resolve in dev, not only in production').toBe(200);

	await page.waitForSelector('.cw-standee', { timeout: 60_000 });
	await expect(page.locator('#cw-room')).toBeVisible();
	await expect(page.locator('#cw-roster-panel')).toBeVisible();
	await expect(page).toHaveTitle(new RegExp(`\\(${tag}\\) · Crew HQ`));
	// The directory must not card the crew whose page this is.
	await expect(page.locator(`.cw-dir-card[href="/crews/${tag}"]`)).toHaveCount(0);

	// Every standee carries the member it stands for, which is what lets a poll
	// update it instead of replacing it.
	const standees = await page.locator('.cw-standee').count();
	expect(standees).toBeGreaterThan(0);
	expect(await page.locator('.cw-standee[data-member]').count()).toBe(standees);

	await page.evaluate(() =>
		document.querySelectorAll('.cw-standee').forEach((el, i) => {
			el.dataset.pinned = String(i);
		}),
	);
	await pollNow(page);

	// Same nodes, and no skeleton flashed over a room that was already standing.
	expect(await page.locator('.cw-standee[data-pinned]').count()).toBe(standees);
	await expect(page.locator('.cw-skeleton')).toHaveCount(0);
});

test('/crews/<TAG> offers a free tag only to someone who can take it', async ({ page }) => {
	await page.goto('/crews/ZZQQZ', { waitUntil: 'domcontentloaded', timeout: 60_000 });

	const error = page.locator('#cw-error');
	await expect(error).toContainText('No crew flies the tag ZZQQZ');
	await expect(error.locator('#cw-retry')).toBeVisible();
	// Signed out: the founding form would only 401, so the way in is offered.
	await expect(page.locator('#cw-found-panel')).toBeHidden();
	await expect(page.locator('#cw-signedout')).toBeVisible();
	await expect(page.locator('#cw-room')).toBeHidden();
});

test('/crews says what happened when the crew service is unreachable', async ({ page, request }) => {
	const tag = (await topCrewTag(request)) || 'ZZQQZ';
	await page.route('**/api/crews/**', (r) => r.abort('failed'));
	await page.goto(`/crews/${tag}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

	const error = page.locator('#cw-error');
	// The browser's own "Failed to fetch" tells a visitor nothing.
	await expect(error).toContainText('could not be reached');
	await expect(error).not.toContainText('Failed to fetch');
	await expect(error.locator('#cw-retry')).toBeVisible();
	// And the loading skeleton is gone: it promises something that is not coming.
	await expect(page.locator('.cw-skeleton')).toHaveCount(0);
	await expect(page.locator('#cw-dir')).toContainText('The directory did not load');

	await page.unroute('**/api/crews/**');
	await error.locator('#cw-retry').click();
	await expect(page.locator('#cw-error')).toBeHidden({ timeout: 60_000 });
});

test('/crews fits a 320px phone', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await page.goto('/crews', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForSelector('#cw-dir-panel:not([hidden])');
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	);
	expect(overflow, 'the page must not scroll sideways on a phone').toBe(false);
});
