/**
 * "Is it my house, or is it you?", answered in the browser.
 *
 * This is the one question a person cannot answer alone when their home stops
 * responding, and getting it wrong costs them a router power-cycle, a re-minted
 * access token and half an hour, during an outage that was ours. three.ws
 * already computes the verdict across every connected home
 * (api/_lib/ops/home-health.js) and publishes it on the public status feed, so
 * the manage view reads it and says which way it falls.
 *
 * Three behaviours, and the third matters as much as the first two: when the
 * status feed itself cannot be reached, the page says NOTHING. Guessing here is
 * worse than silence, because the wrong guess is "your house is broken" during
 * an outage we caused.
 *
 * Everything is fulfilled at the Playwright route layer, like the sibling flow
 * specs, so this needs no account, no database and no Home Assistant.
 */

import { expect, test } from '@playwright/test';

const PAGE = '/smart-home';
const LIST = '**/api/home';
const CSRF = '**/api/csrf-token';
const STATUS = '**/api/status';

// First hit transforms this page's module graph through the dev server.
const SLOW = 60_000;

const base = {
	id: '2b0d4c7e-1f8a-4c3d-9e11-7a6b5c4d3e2f',
	label: 'Home',
	base_url: 'https://home.example.com',
	transport: 'direct',
	relay_id: null,
	capabilities: { websocket: true, entityCount: 120, areaCount: 3, floorCount: 1, macroCount: 2, haVersion: '2026.9.0', mcp: false, mcpToolCount: 0 },
	last_ok_at: new Date().toISOString(),
	last_error_at: null,
	created_at: new Date().toISOString(),
	updated_at: new Date().toISOString(),
	revoked_at: null,
};

const connected = { ...base, status: 'connected', status_detail: null };
const unreachable = {
	...base,
	status: 'unreachable',
	status_detail: 'https://home.example.com did not answer within 15 seconds.',
	last_ok_at: new Date(Date.now() - 20 * 60_000).toISOString(),
	last_error_at: new Date().toISOString(),
};

function json(body, status = 200) {
	return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function statusFeed(homeStatus, detail = '') {
	return json({
		ok: true,
		subsystems: {
			status: homeStatus,
			items: [
				{ name: 'database', label: 'Database (Neon)', status: 'ok', detail: 'ping 100ms' },
				{ name: 'home', label: 'Home Assistant bridge', status: homeStatus, detail },
			],
		},
	});
}

async function stub(page, { homes, status }) {
	await page.route(CSRF, (route) => route.fulfill(json({ token: 'csrf-test-token', data: { token: 'csrf-test-token' } })));
	await page.route(LIST, (route) => route.fulfill(json({ homes })));
	await page.route(STATUS, status);
}

const root = (page) => page.locator('#hm-root');

test.describe('whose fault is it', () => {
	test('says plainly that it is us when the whole lane is unhealthy', async ({ page }) => {
		await stub(page, {
			homes: [unreachable],
			status: (route) => route.fulfill(statusFeed('down', 'handshakes 31.0% over 22 homes in 15m')),
		});
		await page.goto(PAGE);
		await expect(root(page)).toHaveAttribute('data-state', 'connected', { timeout: SLOW });

		const banner = page.locator('.hm-notice', { hasText: 'This one is us, not your house.' });
		await expect(banner).toBeVisible();
		// The instruction that saves them the wasted half hour.
		await expect(banner).toContainText('Nothing in your house needs restarting');
	});

	test('tells a single failing home that every other house is fine', async ({ page }) => {
		await stub(page, {
			homes: [unreachable],
			status: (route) => route.fulfill(statusFeed('ok', '48/49 homes connected')),
		});
		await page.goto(PAGE);
		await expect(root(page)).toHaveAttribute('data-state', 'connected', { timeout: SLOW });

		await expect(page.locator('.hm-status-verdict')).toContainText('looks like your house rather than us');
		await expect(page.locator('.hm-notice', { hasText: 'This one is us' })).toHaveCount(0);
	});

	test('never accuses a healthy home, even while the lane is degraded', async ({ page }) => {
		await stub(page, {
			homes: [connected],
			status: (route) => route.fulfill(statusFeed('ok', 'all good')),
		});
		await page.goto(PAGE);
		await expect(root(page)).toHaveAttribute('data-state', 'connected', { timeout: SLOW });

		await expect(page.locator('.hm-status-verdict')).toHaveCount(0);
	});

	test('stays silent when the status feed cannot be reached', async ({ page }) => {
		// The wrong answer here is "your house is broken" during an outage we
		// caused, so an unreachable status feed produces no verdict at all.
		await stub(page, {
			homes: [unreachable],
			status: (route) => route.abort(),
		});
		await page.goto(PAGE);
		await expect(root(page)).toHaveAttribute('data-state', 'connected', { timeout: SLOW });

		await expect(page.locator('.hm-status-verdict')).toHaveCount(0);
		await expect(page.locator('.hm-notice', { hasText: 'This one is us' })).toHaveCount(0);
		// And the home's own designed failure state is still on screen.
		await expect(page.locator('.hm-status')).toContainText('did not answer within 15 seconds');
	});
});
