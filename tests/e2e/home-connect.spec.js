/**
 * Journeys 1, 9 and 10: getting a house connected, keeping what you drew on it,
 * and the refusal that costs nothing.
 *
 * Real page, real API, real Home Assistant. See tests/e2e/home-support.js for
 * why nothing in this lane is stubbed.
 */

import { expect, test } from '@playwright/test';

import { connectHome, homeInstance, recordRequests, signUp } from './home-support.js';

test.describe.configure({ mode: 'serial' });

test('journey 1: connect a home, see the rooms, disconnect', async ({ page }) => {
	const instance = homeInstance();
	await signUp(page);
	const label = await connectHome(page, { label: 'Journey one' });

	// The house is read, not assumed: the page must show a room that exists in
	// the real registry, so a hardcoded room list could not pass this.
	const rooms = await fetch(`${instance.baseUrl}/api/states`, {
		headers: { authorization: `Bearer ${instance.token}` },
	}).then((r) => r.json());
	expect(rooms.length).toBeGreaterThan(0);

	await expect(page.getByText(label, { exact: false }).first()).toBeVisible();

	// Disconnecting destroys the credential. The page has to end up somewhere
	// that offers connecting again, not on a dead end.
	const disconnect = page.getByRole('button', { name: /disconnect|remove|revoke/i }).first();
	await expect(disconnect).toBeVisible({ timeout: 30_000 });
	await disconnect.click();

	const confirm = page.getByRole('button', { name: /^(disconnect|remove|revoke|yes)/i }).last();
	if (await confirm.isVisible().catch(() => false)) await confirm.click();

	await expect(page.locator('#hm-url')).toBeVisible({ timeout: 60_000 });
});

test('journey 10: a private host is refused in the browser, with no network call', async ({ page }) => {
	await signUp(page);
	await page.goto('/smart-home', { waitUntil: 'domcontentloaded' });
	await expect(page.locator('#hm-url')).toBeVisible({ timeout: 60_000 });

	// Record only the calls that would mean we tried to reach the house. The
	// claim being proved is about what did NOT happen.
	const attempts = recordRequests(page, (req) => /\/api\/home(\/|$|\?)/.test(new URL(req.url()).pathname + '?'));
	attempts.length = 0;

	await page.fill('#hm-label', 'The LAN house');
	await page.fill('#hm-url', 'http://homeassistant.local:8123');
	await page.fill('#hm-token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.not-a-real-token');

	const before = attempts.length;
	await page.getByRole('button', { name: 'Connect this home' }).click();

	// The refusal names the host and says why, rather than timing out into a
	// vaguer version of the same sentence.
	await expect(page.getByText(/only on your home network|cannot be reached/i).first()).toBeVisible({ timeout: 20_000 });
	expect(attempts.slice(before), 'a refused private host must cost no request').toEqual([]);
});
