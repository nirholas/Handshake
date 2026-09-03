/**
 * Journeys 4, 5, 6 and 7: the gate on the front door.
 *
 * These are the ones that matter, and they share one rule: EVERY assertion
 * about the door reads the lock's state back out of Home Assistant. A
 * confirmation card that renders perfectly while the deadbolt moves anyway is
 * the exact failure this lane exists to catch, and our own UI text cannot tell
 * us which happened. `readState(instance, lock)` is Home Assistant answering,
 * not us.
 */

import { expect, test } from '@playwright/test';

import {
	connectHome,
	homeInstance,
	lockedDoor,
	openScene,
	readState,
	relock,
	resetHomes,
	signIn,
	waitForState,
} from './home-support.js';

test.describe.configure({ mode: 'serial' });

test('journey 5: an unlock is offered, cancelled, and the door stays locked', async ({ page }) => {
	const instance = homeInstance();
	await signIn(page, 'owner');
	await resetHomes(page);
	await connectHome(page, { label: 'Journey five' });
	await openScene(page);

	const lock = await lockedDoor(instance);
	expect(await readState(instance, lock)).toBe('locked');

	await unlockButton(page, instance, lock).click();

	const card = page.getByRole('alertdialog', { name: 'Confirm this action' });
	await expect(card).toBeVisible({ timeout: 60_000 });
	await expect(card.getByText('Opens your home')).toBeVisible();

	await card.getByRole('button', { name: 'Cancel' }).click();
	await expect(card).toBeHidden({ timeout: 30_000 });

	// Home Assistant's own answer, and the only one that counts.
	expect(await readState(instance, lock), 'a cancelled confirmation must leave the door locked').toBe('locked');

	// Give it room to be wrong: a late call would land in these seconds.
	await expect
		.poll(() => readState(instance, lock), { timeout: 10_000, intervals: [1000] })
		.toBe('locked');
});

test('journey 6: an unlock is offered, confirmed, and the door actually unlocks', async ({ page }) => {
	const instance = homeInstance();
	await signIn(page, 'owner');
	await openScene(page);

	const lock = await lockedDoor(instance);
	expect(await readState(instance, lock)).toBe('locked');

	try {
		await unlockButton(page, instance, lock).click();

		const card = page.getByRole('alertdialog', { name: 'Confirm this action' });
		await expect(card).toBeVisible({ timeout: 60_000 });
		await card.getByRole('button', { name: 'Yes, do it' }).click();

		// Home Assistant's own answer again. This is the one case where the door
		// is supposed to move, and nothing but the house can confirm it did.
		expect(await waitForState(instance, lock, ['unlocked', 'unlocking', 'open', 'opening'], { timeout: 45_000 })).toBeTruthy();
	} finally {
		// Never leave a door open behind a test run.
		await relock(instance, lock);
	}
	expect(await readState(instance, lock)).toMatch(/^(locked|locking)$/);
});

test('journey 7: a guest is refused the unlock by role, and the door stays locked', async ({ page, browser }) => {
	const instance = homeInstance();

	// The owner invites a guest into the household, through the real invite API
	// the members panel calls.
	await signIn(page, 'owner');
	const homes = await (await page.request.get('/api/home')).json();
	const home = (Array.isArray(homes?.homes) ? homes.homes : homes)[0];
	expect(home?.id, 'journey 5 left a connected home for this one to use').toBeTruthy();

	const guestContext = await browser.newContext();
	const guestPage = await guestContext.newPage();
	try {
		const guest = await signIn(guestPage, 'guest');

		const invited = await page.request.post(`/api/home/${home.id}/members`, {
			data: { email: guest.email, role: 'guest' },
			headers: { 'content-type': 'application/json' },
			timeout: 60_000,
		});
		expect(invited.ok(), `inviting the guest returned ${invited.status()}`).toBe(true);
		const invite = await invited.json().catch(() => ({}));
		if (invite?.invite?.token) {
			const accepted = await guestPage.request.post(`/api/home/invites/${invite.invite.token}`, { timeout: 60_000 });
			expect(accepted.ok(), `accepting the invite returned ${accepted.status()}`).toBe(true);
		}

		const lock = await lockedDoor(instance);
		expect(await readState(instance, lock)).toBe('locked');

		// The guest confirms, explicitly and deliberately. The point is that an
		// explicit yes is not enough when the role forbids it: `confirmed: true`
		// is a human saying yes, never an authorisation.
		const attempt = await guestPage.request.post(`/api/home/${home.id}/call`, {
			data: { domain: 'lock', service: 'unlock', entity_id: lock, confirmed: true },
			headers: { 'content-type': 'application/json' },
			timeout: 60_000,
		});
		expect(attempt.ok(), 'a guest must not be able to unlock a door').toBe(false);
		expect([401, 403]).toContain(attempt.status());

		expect(await readState(instance, lock), 'a refused guest must leave the door locked').toBe('locked');
		await expect
			.poll(() => readState(instance, lock), { timeout: 10_000, intervals: [1000] })
			.toBe('locked');
	} finally {
		await guestContext.close();
	}
});

test('journey 4: "good night" runs the house\'s own scene, and the lock it touches is gated', async ({ page }) => {
	const instance = homeInstance();
	await signIn(page, 'owner');
	const homes = await (await page.request.get('/api/home')).json();
	const home = (Array.isArray(homes?.homes) ? homes.homes : homes)[0];
	expect(home?.id).toBeTruthy();

	const lock = await lockedDoor(instance);

	// The phrase resolves to a scene this house actually has, not to anything we
	// shipped: the seeded house has Bedtime, and the resolver has to find it.
	const dry = await page.request.post(`/api/home/${home.id}/activate`, {
		data: { phrase: 'good night', dryRun: true },
		headers: { 'content-type': 'application/json' },
		timeout: 60_000,
	});
	expect(dry.ok(), `activate dry run returned ${dry.status()}`).toBe(true);
	const preview = await dry.json();
	expect(preview.match?.entityId, '"good night" must resolve to a scene in this house').toMatch(/^(scene|script)\./);

	const ran = await page.request.post(`/api/home/${home.id}/activate`, {
		data: { phrase: 'good night' },
		headers: { 'content-type': 'application/json' },
		timeout: 60_000,
	});
	const body = await ran.json().catch(() => ({}));

	if (ran.ok() && body.ran) {
		// Bedtime locks up. Locking is the safe direction and is never gated, so
		// the scene running must leave the door locked, not opened.
		expect(await waitForState(instance, lock, ['locked', 'locking'], { timeout: 45_000 })).toBeTruthy();
	} else {
		// The other correct outcome: the macro touches something guarded, so it
		// stopped and asked instead of running.
		expect(body.error || body.code).toMatch(/needs_confirmation/);
		expect(await readState(instance, lock)).toBe('locked');
	}
});

/** The Unlock control for one real lock, found by the label the page gives it. */
function unlockButton(page, instance, entityId) {
	return page.locator(`[data-entity-id="${entityId}"]`).getByRole('button', { name: /^Unlock\b/ }).first();
}
