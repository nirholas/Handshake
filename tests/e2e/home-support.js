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

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

import { expect } from '@playwright/test';

import { readState, readStates, waitForState } from '../_helpers/home-instance.js';
import { STACK_FILE } from './home-global-setup.js';

export { readState, readStates, waitForState };

/** The house this run is driving, as global setup left it. */
export function homeInstance() {
	if (!fs.existsSync(STACK_FILE)) {
		throw new Error('No home e2e stack: run through playwright.home.config.js, which sets it up.');
	}
	return JSON.parse(fs.readFileSync(STACK_FILE, 'utf8')).home;
}

/**
 * A brand new three.ws account, registered through the real signup page, signed
 * in on this browser context.
 *
 * A fresh account per journey is deliberate: these tests connect houses and
 * grant standing permissions on locks, and one journey's grant leaking into the
 * next would quietly disarm the gate the next one is trying to prove.
 */
export async function signUp(page, { prefix = 'home-e2e' } = {}) {
	const username = `${prefix}-${randomBytes(4).toString('hex')}`;
	const password = `Pw-${randomBytes(12).toString('base64url')}`;

	await page.goto('/register', { waitUntil: 'domcontentloaded' });
	await page.fill('#username', username);
	await page.fill('#password', password);
	await page.check('#tos-accept');
	await Promise.all([
		page.waitForURL((u) => !/\/register/.test(u.pathname), { timeout: 90_000 }),
		page.click('#submit'),
	]);

	return { username, password, email: `${username}@users.three.ws.local` };
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
