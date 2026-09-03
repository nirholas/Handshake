/**
 * Shared ground for the home lane's e2e journeys.
 *
 * Fidelity contract, and it is stricter than the rest of tests/e2e: NOTHING in
 * this lane is stubbed. No route interception, no synthetic wallet, no fixture
 * standing in for a device. The page is the real page, the API is the real
 * handler set, the house is a real Home Assistant, and every assertion about a
 * lock reads that lock's state back out of Home Assistant rather than believing
 * a card that says "unlocked". A confirmation dialog that renders perfectly
 * while the deadbolt moves anyway is the exact failure this lane exists to
 * catch, and only Home Assistant can tell us which happened.
 */

import fs from 'node:fs';

import { expect } from '@playwright/test';

import { readState, readStates, waitForState } from '../_helpers/home-instance.js';
import { STACK_FILE } from './home-global-setup.js';

export { readState, readStates, waitForState };

/** The stack this run is driving, as global setup left it. */
function stack() {
	if (!fs.existsSync(STACK_FILE)) {
		throw new Error('No home e2e stack: run through playwright.home.config.js, which sets it up.');
	}
	return JSON.parse(fs.readFileSync(STACK_FILE, 'utf8'));
}

/** The house this run is driving. */
export function homeInstance() {
	return stack().home;
}

/**
 * Sign in as one of the two accounts global setup provisioned.
 *
 * Signing in rather than signing up on every journey is not a shortcut: account
 * creation is rate limited to five per hour per IP, so a suite that registered
 * per journey would pass once and then spend an hour reporting the rate limiter
 * as a product failure. The accounts are real, made through the real signup
 * page, and this is the real login endpoint.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'owner'|'guest'} role
 */
export async function signIn(page, role = 'owner') {
	const account = stack().accounts[role];
	if (!account) throw new Error(`no ${role} account in the e2e stack`);

	const res = await page.request.post('/api/auth/login', {
		data: { email: account.email, password: account.password },
		headers: { 'content-type': 'application/json' },
		timeout: 60_000,
	});
	if (!res.ok()) {
		throw new Error(`login as ${role} returned ${res.status()}: ${(await res.text()).slice(0, 200)}`);
	}
	return account;
}

/**
 * Take every home this account has off the platform.
 *
 * Journeys grant standing permissions on locks, and a grant surviving into the
 * next journey would quietly disarm the gate that journey is trying to prove.
 * Each one therefore starts from an account with no houses on it.
 */
export async function resetHomes(page) {
	const list = await page.request.get('/api/home', { timeout: 60_000 });
	if (!list.ok()) return 0;
	const body = await list.json().catch(() => null);
	const homes = Array.isArray(body?.homes) ? body.homes : Array.isArray(body) ? body : [];
	for (const home of homes) {
		await page.request.delete(`/api/home/${home.id}`, { timeout: 60_000 }).catch(() => {});
	}
	return homes.length;
}

/**
 * Connect the seeded house through the real connect form, and wait until the
 * page says it is connected.
 *
 * @returns {Promise<string>} the home id, read from the page's own state
 */
export async function connectHome(page, { label = 'The lane house' } = {}) {
	const home = homeInstance();

	await page.goto('/smart-home', { waitUntil: 'domcontentloaded' });
	await expect(page.locator('#hm-url')).toBeVisible({ timeout: 60_000 });

	await page.fill('#hm-label', label);
	await page.fill('#hm-url', home.baseUrl);
	await page.fill('#hm-token', home.token);
	await page.getByRole('button', { name: 'Connect this home' }).click();

	// The connected state is the one that lists rooms. Waiting for the room list
	// rather than for a spinner to vanish means the assertion is about the house
	// having been read, not about an animation having finished.
	await expect(page.getByText(label, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
	return label;
}

/**
 * Open the connected house's 3D page, in the 2D view.
 *
 * The 2D view is the one with named buttons. It renders the same model, calls
 * the same action endpoint and hits the same gate as the 3D view, so nothing
 * about what is under test changes; what changes is that a click lands on
 * "Unlock Front Door" instead of on a guessed pixel of a WebGL canvas.
 */
export async function openScene(page) {
	const list = await page.request.get('/api/home', { timeout: 60_000 });
	const body = await list.json();
	const homes = Array.isArray(body?.homes) ? body.homes : Array.isArray(body) ? body : [];
	if (!homes.length) throw new Error('no connected home to open');

	await page.goto(`/smart-home/${homes[0].id}`, { waitUntil: 'domcontentloaded' });
	const flat = page.locator('#hs-view-2d');
	await expect(flat).toBeVisible({ timeout: 90_000 });
	await flat.click();
	await expect(flat).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });

	// Wait for the house to have been read, not for a spinner to stop: the room
	// rail is only populated once the real registries have arrived.
	await expect(page.locator('#hs-rooms')).not.toHaveAttribute('aria-busy', 'true', { timeout: 120_000 });
	return homes[0].id;
}

/**
 * Every request the page makes, recorded. Journey 10 needs to prove a refusal
 * cost no network call at all, which is a claim about what did NOT happen.
 */
export function recordRequests(page, filter = () => true) {
	const seen = [];
	page.on('request', (req) => {
		if (filter(req)) seen.push(`${req.method()} ${req.url()}`);
	});
	return seen;
}

/** A lock in the house that is currently locked, chosen from the house itself. */
export async function lockedDoor(instance) {
	const states = await readStates(instance);
	const found = states.find((s) => s.entity_id.startsWith('lock.') && s.state === 'locked');
	if (!found) throw new Error('the seeded house has no locked door');
	return found.entity_id;
}

/** A light in the house, chosen from the house itself rather than hardcoded. */
export async function anyLight(instance) {
	const states = await readStates(instance);
	const found = states.find((s) => s.entity_id.startsWith('light.'));
	if (!found) throw new Error('the seeded house has no light');
	return { entityId: found.entity_id, state: found.state, name: found.attributes?.friendly_name };
}

/** Put a lock back the way the journey found it, whatever the journey did. */
export async function relock(instance, entityId) {
	await fetch(`${instance.baseUrl}/api/services/lock/lock`, {
		method: 'POST',
		headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ entity_id: entityId }),
	}).catch(() => {});
	await waitForState(instance, entityId, ['locked', 'locking'], { timeout: 25_000 }).catch(() => {});
}
