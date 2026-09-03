/**
 * Journey 9: draw where the rooms are, reload, and find them still there.
 *
 * Plus the thing that makes the floorplan worth building at all: dragging a
 * device that nobody filed into a room writes the area into the user's OWN Home
 * Assistant registry. That assertion reads the area back out of Home Assistant
 * rather than believing our own tray, for the same reason every lock assertion
 * in this lane reads the deadbolt: a UI that renders the move perfectly while
 * the registry is untouched is exactly the failure worth catching.
 */

import { expect, test } from '@playwright/test';

import { connectHome, homeInstance, openScene, resetHomes, signIn } from './home-support.js';

test.describe.configure({ mode: 'serial' });

/** The entity registry, straight from Home Assistant over its WebSocket API. */
async function registry(instance, type = 'config/entity_registry/list') {
	const socket = new WebSocket(`${instance.baseUrl.replace(/^http/, 'ws')}/api/websocket`);
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 20_000);
			socket.onerror = () => { clearTimeout(timer); reject(new Error('websocket failed')); };
			socket.onmessage = (event) => {
				const msg = JSON.parse(event.data);
				if (msg.type === 'auth_required') return socket.send(JSON.stringify({ type: 'auth', access_token: instance.token }));
				if (msg.type === 'auth_ok') return socket.send(JSON.stringify({ id: 1, type }));
				if (msg.type === 'result') {
					clearTimeout(timer);
					resolve(msg.success ? msg.result : []);
				}
			};
		});
	} finally {
		socket.close();
	}
}

/** The area Home Assistant currently has this entity filed under. */
async function areaOf(instance, entityId) {
	const entries = await registry(instance);
	return entries.find((e) => e.entity_id === entityId)?.area_id ?? null;
}

async function openPlan(page) {
	const plan = page.getByRole('button', { name: /Draw where the rooms are/i });
	await expect(plan).toBeVisible({ timeout: 60_000 });
	await plan.click();
	await expect(page.locator('#hs-plan')).toBeVisible();
}

test('journey 9: a floorplan is drawn, saved, and still there after a reload', async ({ page }) => {
	await signIn(page, 'owner');
	await resetHomes(page);
	await connectHome(page, { label: 'Journey nine' });
	await openScene(page);
	await openPlan(page);

	// A room nobody has placed yet. The tray is the only way in, which is the
	// point: a house arrives with no geometry at all.
	const toPlace = page.locator('.hm-plan-tray-room').first();
	await expect(toPlace).toBeVisible({ timeout: 30_000 });
	const roomName = (await toPlace.textContent())?.trim();
	await toPlace.click();

	const room = page.locator('.hm-plan-room').filter({ hasText: roomName });
	await expect(room).toBeVisible();

	// Move it with the keyboard, so the assertion covers the path a mouse-free
	// user takes rather than only the drag.
	await room.click();
	await room.press('ArrowRight');
	await room.press('ArrowRight');
	await room.press('ArrowDown');

	const save = page.getByRole('button', { name: /^Save floorplan$/ });
	await expect(save).toBeEnabled();
	await save.click();
	await expect(page.getByText(/Floorplan saved/i)).toBeVisible({ timeout: 30_000 });

	// The real test of persistence: a full navigation, not a client-side rerender.
	await page.reload();
	await openPlan(page);
	await expect(page.locator('.hm-plan-room').filter({ hasText: roomName })).toBeVisible({ timeout: 60_000 });
	await expect(page.locator('.hm-plan-tray-room').filter({ hasText: roomName })).toHaveCount(0);
});

test('journey 9b: undo takes a placement back, and redo puts it again', async ({ page }) => {
	await signIn(page, 'owner');
	await openScene(page);
	await openPlan(page);

	const tray = page.locator('.hm-plan-tray-room');
	const before = await page.locator('.hm-plan-room').count();
	if (!(await tray.count())) test.skip(true, 'every room in this house is already placed');

	const name = (await tray.first().textContent())?.trim();
	await tray.first().click();
	await expect(page.locator('.hm-plan-room')).toHaveCount(before + 1);

	await page.getByRole('button', { name: /^Undo$/ }).click();
	await expect(page.locator('.hm-plan-room').filter({ hasText: name })).toHaveCount(0);

	await page.getByRole('button', { name: /^Redo$/ }).click();
	await expect(page.locator('.hm-plan-room').filter({ hasText: name })).toHaveCount(1);
});

test('journey 9c: filing a device from the tray changes the area in Home Assistant itself', async ({ page }) => {
	const instance = homeInstance();
	await signIn(page, 'owner');
	await openScene(page);
	await openPlan(page);

	const loose = page.locator('.hm-plan-tray-entity');
	if (!(await loose.count())) test.skip(true, 'this house has nothing left unfiled');

	// The File button is the keyboard route; the drag is the mouse one. Driving
	// the button means the assertion lands on a named control, and the code path
	// below it is the same one the drop handler calls.
	const first = loose.first();
	const label = (await first.getAttribute('title')) || '';
	await first.getByRole('button', { name: /^File$/ }).click();

	const target = page.locator('.hm-plan-filemenu-item').first();
	await expect(target).toBeVisible();
	await target.click();

	await expect(page.getByText(/was written to your Home Assistant/i)).toBeVisible({ timeout: 30_000 });

	// Home Assistant's own registry, not our tray. This is the assertion the
	// whole feature rests on.
	await expect.poll(() => areaOf(instance, label), { timeout: 30_000 }).not.toBeNull();
});

test('journey 9d: resetting the plan returns the house to its default arrangement', async ({ page }) => {
	await signIn(page, 'owner');
	await openScene(page);
	await openPlan(page);

	const reset = page.getByRole('button', { name: /^Reset to default$/ });
	await expect(reset).toBeEnabled({ timeout: 30_000 });
	await reset.click();
	await expect(page.getByText(/Back to the default arrangement/i)).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.hm-plan-room')).toHaveCount(0);

	// And it survives a reload, so the reset really wrote through rather than
	// only clearing the editor's own state.
	await page.reload();
	await openPlan(page);
	await expect(page.locator('.hm-plan-room')).toHaveCount(0);
});
