/**
 * /agent-wallet, the agent-wallet hub's entry page, driven in a real browser.
 *
 * The page has no single "content" state: it resolves who is asking and then
 * renders one of six screens (loading, signed out, no agents yet, picker,
 * invalid link, not found, or the live hub). Nothing else in the suite reaches
 * any of them, and every defect below is invisible to a unit test because it
 * only exists once the resolution has run:
 *
 *   - The signed-out and empty screens carried role="alert", which interrupts a
 *     screen reader mid-sentence to announce a state that is simply this page's
 *     ordinary answer. Only a real failure should interrupt.
 *   - The failure screen has to offer a Try again that actually re-runs the
 *     load rather than re-rendering the same message, which is only observable
 *     by letting the retry succeed.
 *   - An id that is not a UUID must be caught before the fetch, so a typo gets
 *     a designed screen rather than a 404 round trip.
 *
 * The session is never faked: the two owner-only screens are reached by
 * fulfilling the two endpoints the page reads (/api/auth/me and /api/agents) at
 * the Playwright route layer, exactly as _support.js does for the flow specs.
 * Everything between the response and the assertion is the shipped client code.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/agent-wallet';
const ME = '**/api/auth/me';
const AGENTS = '**/api/agents';
const ONE_AGENT = '**/api/agents/*';

// The dev server transforms this page's module graph (the hub pulls in every
// tab, including the vanity grinder's wordlists) on first hit, so the waits are
// explicit rather than leaning on the default.
const SLOW = 60_000;

const USER = { user: { id: '00000000-0000-4000-8000-00000000cafe', email: 'owner@example.test' } };

function json(body) {
	return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

/** Answer the session probe as a signed-in owner. */
async function signedIn(page) {
	await page.route(ME, (route) => route.fulfill(json(USER)));
}

/** The page's terminal screens all render into this one container. */
function message(page) {
	return page.locator('#awh-root .awh-page-msg');
}

test.describe('/agent-wallet entry page', () => {
	test('a signed-out visitor is offered a way in, without an alert interrupting them', async ({ page }) => {
		await page.route(ME, (route) => route.fulfill(json({ user: null })));
		await page.goto(PAGE);

		const box = message(page);
		await box.waitFor({ state: 'attached', timeout: SLOW });
		await expect(box.locator('h1')).toHaveText('Sign in to open an agent wallet');
		expect(await page.locator('h1').count()).toBe(1);

		// Both ways forward are real destinations, and the sign-in link returns here.
		await expect(box.locator('a').nth(0)).toHaveAttribute('href', '/login?next=/agent-wallet');
		await expect(box.locator('a').nth(1)).toHaveAttribute('href', '/register');

		// Being signed out is this page's ordinary answer, not an emergency: it is a
		// labelled region, read in turn, rather than an assertive interruption.
		await expect(box).toHaveAttribute('role', 'region');
		await expect(box).toHaveAttribute('aria-labelledby', await box.locator('h1').getAttribute('id'));
	});

	test('an owner with no agents is told what to create, also without an alert', async ({ page }) => {
		await signedIn(page);
		await page.route(AGENTS, (route) => route.fulfill(json({ agents: [] })));
		await page.goto(PAGE);

		const box = message(page);
		await box.waitFor({ state: 'attached', timeout: SLOW });
		await expect(box.locator('h1')).toHaveText('No agents yet');
		await expect(box.locator('a')).toHaveAttribute('href', '/create-agent');
		await expect(box).toHaveAttribute('role', 'region');
	});

	test('an owner with several agents picks one, and every row links to that wallet', async ({ page }) => {
		await signedIn(page);
		await page.route(AGENTS, (route) =>
			route.fulfill(
				json({
					agents: [
						{
							id: '11111111-1111-4111-8111-111111111111',
							name: 'First agent',
							wallet_ready: true,
							solana_address: 'THREEsynthetic1111111111111111111111111111',
						},
						{ id: '22222222-2222-4222-8222-222222222222', name: 'Second agent', wallet_ready: false },
					],
				}),
			),
		);
		await page.goto(PAGE);

		const rows = page.locator('.awh-pick-row');
		await expect(rows).toHaveCount(2, { timeout: SLOW });
		expect(await page.locator('h1').count()).toBe(1);
		await expect(rows.nth(0)).toHaveAttribute('href', '/agent/11111111-1111-4111-8111-111111111111/wallet');
		await expect(rows.nth(1)).toHaveAttribute('href', '/agent/22222222-2222-4222-8222-222222222222/wallet');

		// A wallet that is still being provisioned says so instead of showing a blank
		// address, and a ready one shows the truncated address it will receive at.
		await expect(rows.nth(0).locator('.awh-pick-state')).toHaveText('Ready');
		await expect(rows.nth(1).locator('.awh-pick-sub')).toHaveText('Wallet is being prepared');

		// The page names the agent it resolved rather than keeping the generic title.
		await expect(page).toHaveTitle(/Your agent wallets/);
	});

	test('an id that is not a UUID is caught before any fetch is made', async ({ page }) => {
		let fetched = false;
		await page.route(ONE_AGENT, (route) => {
			fetched = true;
			return route.continue();
		});
		await page.goto(`${PAGE}?id=not-a-uuid`);

		const box = message(page);
		await box.waitFor({ state: 'attached', timeout: SLOW });
		await expect(box.locator('h1')).toHaveText('That agent link is not valid');
		await expect(box.locator('a').nth(0)).toHaveAttribute('href', '/agent-wallet');
		await expect(box.locator('a').nth(1)).toHaveAttribute('href', '/agents');
		expect(fetched, 'a malformed id should never reach the agent endpoint').toBe(false);
	});

	test('an agent that does not exist says so and points at the directory', async ({ page }) => {
		await page.route(ONE_AGENT, (route) =>
			route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }),
		);
		await page.goto(`${PAGE}?id=33333333-3333-4333-8333-333333333333`);

		const box = message(page);
		await box.waitFor({ state: 'attached', timeout: SLOW });
		await expect(box.locator('h1')).toHaveText('Agent not found');
		await expect(box.locator('a')).toHaveAttribute('href', '/agents');
		// A genuine failure does interrupt.
		await expect(box).toHaveAttribute('role', 'alert');
	});

	test('a wallet that will not load offers a Try again that really retries', async ({ page }) => {
		const id = '44444444-4444-4444-8444-444444444444';
		let attempt = 0;
		await page.route(ONE_AGENT, (route) => {
			attempt += 1;
			if (attempt === 1) return route.abort();
			return route.fulfill(
				json({ agent: { id, name: 'Recovered agent', is_owner: true, wallet_ready: true } }),
			);
		});
		await page.goto(`${PAGE}?id=${id}`);

		const box = message(page);
		await box.waitFor({ state: 'attached', timeout: SLOW });
		await expect(box.locator('h1')).toHaveText("Couldn't load this wallet");
		await expect(box).toHaveAttribute('role', 'alert');

		// The retry re-runs the load rather than re-rendering the same message, so
		// the hub itself is what replaces it.
		await box.locator('button', { hasText: 'Try again' }).click({ noWaitAfter: true });
		await expect(page.locator('.awh-name')).toHaveText('Recovered agent wallet', { timeout: SLOW });
		expect(attempt).toBeGreaterThan(1);
	});

	test('the page holds its column at every width', async ({ page }) => {
		await signedIn(page);
		await page.route(AGENTS, (route) =>
			route.fulfill(
				json({
					agents: [
						{
							id: '55555555-5555-4555-8555-555555555555',
							// A long unbroken name is the widest single run this list can be
							// asked to lay out.
							name: 'Averyverylongagentnamewithnospacesatallinit'.repeat(2),
							wallet_ready: true,
							solana_address: 'THREEsynthetic1111111111111111111111111111',
						},
						{ id: '66666666-6666-4666-8666-666666666666', name: 'Second agent', wallet_ready: true },
					],
				}),
			),
		);
		await page.goto(PAGE);
		await expect(page.locator('.awh-pick-row')).toHaveCount(2, { timeout: SLOW });

		for (const width of [320, 768, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			const box = await page.evaluate(() => {
				document.documentElement.getBoundingClientRect(); // settle layout before reading
				return {
					scrollW: document.documentElement.scrollWidth,
					clientW: document.documentElement.clientWidth,
				};
			});
			expect(box.scrollW, `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(box.clientW + 1);
		}
	});
});
