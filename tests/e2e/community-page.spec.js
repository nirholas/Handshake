/**
 * /community, driven in a real browser.
 *
 * The defect this file exists for is invisible to a unit test and to a reader
 * of the source: the live-activity rows were built as an <a> wrapped around
 * another <a> (the row linked to the creation, the creator's name linked to
 * their profile). That is unparseable HTML, so every browser split each row
 * into three sibling fragments and the list rendered as stacked, gap-ridden
 * debris. The template string looked correct; only the DOM the browser built
 * from it was wrong, which is exactly what a browser test can see.
 *
 * The rest pins the states a visitor can actually land in: a feed that fails,
 * a feed that returns nothing, and a body that is not JSON at all (which used
 * to throw past the handler and leave the skeletons shimmering forever).
 */

import { test, expect } from '@playwright/test';

const COMMUNITY = '/community';
const FEED = '**/api/users/me/feed*';

// This suite shares a box with the rest of the e2e run and the first hit pays
// the dev server's on-demand transform, so the waits are explicit.
const SLOW = 45_000;

function feedPayload(count) {
	return {
		items: Array.from({ length: count }, (_, i) => ({
			kind: 'avatar',
			id: `id-${i}`,
			created_at: new Date(Date.now() - i * 60_000).toISOString(),
			actor: { username: `creator${i}`, display_name: `Creator ${i}`, avatar_url: null },
			title: `Avatar ${i}`,
			href: `/avatars/id-${i}`,
			image: null,
		})),
	};
}

async function serveFeed(page, body, status = 200) {
	await page.route(FEED, (route) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
	);
}

test.describe('/community', () => {
	test('renders one intact row per feed item, with both of its links reachable', async ({ page }) => {
		// The dev server's own HMR socket cannot reach a forwarded port in a
		// container, and its failure is not the page's, so it is filtered out.
		const errors = [];
		page.on('pageerror', (e) => {
			if (!/WebSocket|\[vite\]/.test(e.message)) errors.push(e.message);
		});
		await serveFeed(page, feedPayload(6));

		await page.goto(COMMUNITY);
		await page.waitForSelector('.activity-row', { timeout: SLOW });

		// Six items must produce six rows. Nested anchors produced eighteen.
		expect(await page.locator('.activity-row').count()).toBe(6);
		expect(await page.locator('.activity-row > .activity-main').count()).toBe(6);
		// No anchor may contain another anchor anywhere on the page.
		expect(await page.locator('a a').count()).toBe(0);

		const first = page.locator('.activity-row').first();
		await expect(first.locator('.activity-main')).toHaveAttribute('href', '/avatars/id-0');
		await expect(first.locator('.activity-user')).toHaveAttribute('href', '/u/creator0');
		await expect(first.locator('.activity-line')).toContainText('created a new avatar');
		await expect(first.locator('.activity-meta')).toContainText('Avatar 0');

		// One h1, and every row link is keyboard-reachable.
		expect(await page.locator('h1').count()).toBe(1);
		expect(await first.locator('a').count()).toBe(2);

		// Clicking the row body (not the name) opens the creation.
		await first.click({ position: { x: 220, y: 30 } });
		await page.waitForURL('**/avatars/id-0', { waitUntil: 'commit', timeout: SLOW });

		expect(errors).toEqual([]);
	});

	test('a feed that fails, or answers with something unreadable, offers a working retry', async ({ page }) => {
		let attempt = 0;
		await page.route(FEED, (route) => {
			attempt += 1;
			if (attempt === 1) return route.abort('failed');
			if (attempt === 2) return route.fulfill({ status: 500, body: 'server error' });
			if (attempt === 3) return route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' });
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feedPayload(3)) });
		});

		await page.goto(COMMUNITY);
		// Each failure mode lands in the same designed, actionable state instead
		// of a blank box or a permanent skeleton.
		for (let i = 0; i < 3; i += 1) {
			await page.waitForSelector('.activity-retry', { timeout: SLOW });
			await expect(page.locator('.activity-error')).toContainText('Could not load live activity');
			expect(await page.locator('.activity-skeleton').count()).toBe(0);
			await page.click('.activity-retry');
		}

		await page.waitForSelector('.activity-row', { timeout: SLOW });
		expect(await page.locator('.activity-row').count()).toBe(3);
	});

	test('an empty feed says what to do next instead of showing a blank box', async ({ page }) => {
		await serveFeed(page, { items: [] });

		await page.goto(COMMUNITY);
		await page.waitForSelector('.activity-empty', { timeout: SLOW });
		await expect(page.locator('.activity-empty a')).toHaveAttribute('href', '/create');
	});

	test('the newsletter signup validates locally and posts to the real endpoint', async ({ page }) => {
		await serveFeed(page, feedPayload(2));
		await page.goto(COMMUNITY);
		await page.waitForSelector('.newsletter-form', { timeout: SLOW });

		// The field is labelled, so a screen reader announces it.
		await expect(page.locator('label[for="community-newsletter-email"]')).toHaveCount(1);

		await page.fill('#community-newsletter-email', 'not-an-email');
		await page.click('.newsletter-form button');
		await expect(page.locator('p.newsletter-msg')).toHaveText('Please enter a valid email.');

		let posted = null;
		await page.route('**/api/newsletter/subscribe', (route) => {
			posted = route.request().postDataJSON();
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
		});
		await page.fill('#community-newsletter-email', 'reader@example.com');
		await page.click('.newsletter-form button');
		await expect(page.locator('p.newsletter-msg')).toHaveClass(/is-success/, { timeout: SLOW });
		expect(posted).toEqual({ email: 'reader@example.com' });
	});

	test('lays out without a sideways scrollbar from 320px up', async ({ page }) => {
		await serveFeed(page, feedPayload(8));
		await page.goto(COMMUNITY);
		await page.waitForSelector('.activity-row', { timeout: SLOW });

		for (const width of [320, 768, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
			);
			expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
		}
	});
});
