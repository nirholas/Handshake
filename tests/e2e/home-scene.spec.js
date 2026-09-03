/**
 * The live 3D home, driven end to end.
 *
 * This spec is about the SCENE: that a real device changing in a real Home
 * Assistant reaches the rendered house, that the geometry the renderer draws is
 * the geometry the model computed, that a house never empties when its
 * connection drops, and that a device the browser cannot draw is still a device
 * the person can operate.
 *
 * Nothing is stubbed. The only thing this file fakes is the ABSENCE of WebGL,
 * which is a browser capability and not our code, and is exactly what an old or
 * locked-down device looks like from inside the page.
 */

import { expect, test } from '@playwright/test';

import { anyLight, connectHome, homeInstance, openScene, readState, resetHomes, signIn, waitForState } from './home-support.js';

test.describe.configure({ mode: 'serial' });

/** Open the scene at its own address, in the 3D view, and wait for a frame. */
async function open3d(page, label) {
	await signIn(page, 'owner');
	await resetHomes(page);
	await connectHome(page, { label });
	const id = await openScene(page);
	await page.goto(`/smart-home/${id}?view=3d`, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__homeScene?.stats()?.drawCalls > 0, null, { timeout: 180_000 });
	return id;
}

test('the scene renders the real house, and its geometry matches the model', async ({ page }) => {
	await open3d(page, 'Scene journey one');

	const view = await page.evaluate(() => {
		const model = window.__homeScene.model;
		return {
			rooms: model.rooms.length,
			entities: model.stats.entities,
			drawn: model.stats.drawn,
			floors: model.floors.length,
			objects: window.__homeScene.stats().objects,
			roomNames: model.rooms.map((r) => r.name),
			// Every room the model placed has a real footprint on a real floor.
			placed: model.rooms.every((r) => r.w > 0 && r.d > 0 && Number.isFinite(r.y)),
		};
	});

	expect(view.rooms).toBeGreaterThan(0);
	expect(view.entities).toBeGreaterThan(0);
	expect(view.placed).toBe(true);
	// The renderer holds exactly the objects the model asked for. A drift here is
	// the scene showing something the house does not contain, or hiding something
	// it does.
	expect(view.objects).toBe(view.drawn);

	// And the rail lists the same rooms the scene drew.
	for (const name of view.roomNames) {
		await expect(page.locator('#hs-rooms').getByText(name, { exact: true }).first()).toBeVisible();
	}
});

test('a real light changing in Home Assistant reaches the rendered house', async ({ page }) => {
	const instance = homeInstance();
	await open3d(page, 'Scene journey two');

	const light = await anyLight(instance);
	const before = await readState(instance, light.entityId);
	const wanted = before === 'on' ? 'off' : 'on';

	// The scene's own view of that entity, before anyone touches it.
	const seen = async () =>
		page.evaluate((id) => {
			for (const room of window.__homeScene.model.rooms) {
				const found = room.objects.find((o) => o.entityId === id);
				if (found) return { state: found.state, activity: found.activity };
			}
			return null;
		}, light.entityId);
	expect((await seen())?.state).toBe(before);

	// Change the real device, in Home Assistant, with no help from the page.
	await fetch(`${instance.baseUrl}/api/services/light/turn_${wanted}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ entity_id: light.entityId }),
	});
	expect(await waitForState(instance, light.entityId, wanted, { timeout: 30_000 })).toBe(wanted);

	await expect
		.poll(async () => (await seen())?.state, { timeout: 30_000, message: 'the scene never saw the real change' })
		.toBe(wanted);

	// The page measured how long that took, from the frame landing to the frame
	// painted. It is a real number, and it is not minutes.
	const latency = await page.evaluate(() => window.__homeScene.latency);
	expect(latency.samples.length).toBeGreaterThan(0);
	expect(latency.last).toBeLessThan(2000);
});

test('the house is retained, greyed and dated when its connection drops', async ({ page }) => {
	await open3d(page, 'Scene journey three');
	const before = await page.evaluate(() => window.__homeScene.model.rooms.length);
	expect(before).toBeGreaterThan(0);

	await stopHouse();
	try {
		await expect(page.locator('#hs-status')).toHaveAttribute('data-status', /stale|disconnected/, { timeout: 180_000 });
		// The whole point: the rooms are still there.
		expect(await page.evaluate(() => window.__homeScene.model.rooms.length)).toBe(before);
		await expect(page.locator('.hs-age')).toContainText(/Last seen/i, { timeout: 30_000 });
		await expect(page.locator('#hs-stage')).toHaveClass(/is-stale/);
	} finally {
		await startHouse();
	}

	// And it comes back on its own, with no navigation and no reload.
	await expect(page.locator('#hs-status')).toHaveAttribute('data-status', 'live', { timeout: 240_000 });
	await expect(page.locator('.hs-age')).toHaveCount(0, { timeout: 30_000 });
});

test('a browser with no WebGL gets a house it can read and operate', async ({ page }) => {
	// The capability itself is absent, which is what a locked-down or old device
	// looks like. Everything below this line is the shipped page.
	await page.addInitScript(() => {
		const original = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
			if (String(type).startsWith('webgl')) return null;
			return original.call(this, type, ...rest);
		};
	});

	const instance = homeInstance();
	await signIn(page, 'owner');
	await resetHomes(page);
	await connectHome(page, { label: 'Scene journey four' });
	const id = await openScene(page);
	await page.goto(`/smart-home/${id}`, { waitUntil: 'domcontentloaded' });

	// No canvas, no spinner, and the 3D button says why it cannot be used.
	await expect(page.locator('#hs-stage canvas')).toHaveCount(0);
	await expect(page.locator('#hs-view-3d')).toBeDisabled({ timeout: 60_000 });
	await expect(page.locator('#hs-live')).toContainText(/WebGL/i, { timeout: 60_000 });

	// And the house is fully operable: a real light, a real button, a real device.
	const light = await anyLight(instance);
	const before = await readState(instance, light.entityId);
	const wanted = before === 'on' ? 'off' : 'on';
	const label = before === 'on' ? 'Turn off' : 'Turn on';
	const button = page.getByRole('button', { name: new RegExp(`^${label} ${escapeRe(light.name)}\\b`) }).first();
	await expect(button).toBeVisible({ timeout: 90_000 });
	await button.click();
	expect(await waitForState(instance, light.entityId, wanted, { timeout: 30_000 })).toBe(wanted);
});

test('the scene holds its memory and its object count under a burst of real changes', async ({ page }) => {
	const instance = homeInstance();
	await open3d(page, 'Scene journey five');

	const baseline = await page.evaluate(() => window.__homeScene.stats());
	const states = await (await fetch(`${instance.baseUrl}/api/states`, { headers: { authorization: `Bearer ${instance.token}` } })).json();
	const lights = states.filter((s) => s.entity_id.startsWith('light.')).map((s) => s.entity_id);
	expect(lights.length).toBeGreaterThan(0);

	// Twenty real service calls against real devices, as fast as the house will
	// take them. A burst must not grow the scene.
	const call = (service, entityId) =>
		fetch(`${instance.baseUrl}/api/services/light/${service}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ entity_id: entityId }),
		});

	for (let i = 0; i < 20; i += 1) await call(i % 2 ? 'turn_on' : 'turn_off', lights[i % lights.length]);

	// Then one more, to a state the burst did not leave it in, and wait for the
	// SCENE to show it. Home Assistant delivers state changes in order, so the
	// sentinel arriving proves all twenty ahead of it were processed. A fixed
	// sleep here would be measuring the machine's mood: too short on a loaded box
	// and the assertion runs against a half-drained queue, too long and the suite
	// pays for it on every run forever.
	const sentinel = lights[0];
	await call('turn_off', sentinel);
	await call('turn_on', sentinel);
	await page.waitForFunction(
		(id) => {
			for (const room of window.__homeScene.model.rooms) {
				const found = room.objects.find((o) => o.entityId === id);
				if (found) return found.state === 'on';
			}
			return false;
		},
		sentinel,
		{ timeout: 60_000 },
	);

	const after = await page.evaluate(() => window.__homeScene.stats());
	expect(after.objects).toBe(baseline.objects);
	expect(after.geometries).toBe(baseline.geometries);
	expect(after.textures).toBe(baseline.textures);
	// The scene's own per-frame work, which is the part this order controls. The
	// rasterizer's cost is the machine's and is measured separately.
	expect(after.updateMs).toBeLessThan(8);
});

async function stopHouse() {
	await runDocker(['stop', containerName()]);
}

async function startHouse() {
	await runDocker(['start', containerName()]);
	const instance = homeInstance();
	for (let i = 0; i < 90; i += 1) {
		const ok = await fetch(`${instance.baseUrl}/api/`, { headers: { authorization: `Bearer ${instance.token}` } })
			.then((r) => r.ok)
			.catch(() => false);
		if (ok) return;
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error('the house did not come back');
}

function containerName() {
	const instance = homeInstance();
	if (!instance.container) throw new Error('the e2e stack did not record a container name');
	return instance.container;
}

async function runDocker(args) {
	const { execFile } = await import('node:child_process');
	await new Promise((resolve, reject) => {
		execFile('docker', args, (err) => (err ? reject(err) : resolve()));
	});
}

function escapeRe(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
