/**
 * Journeys 2, 3 and 8: acting on the house, seeing the house act, and surviving
 * the house going away.
 *
 * Every one drives the 2D house rather than the 3D one. That is not a lesser
 * path: it is the same model, the same action call and the same gate, rendered
 * with real buttons instead of a WebGL raycast, and it is the view the
 * accessibility and low-power paths use. Driving it means a click lands on a
 * named control and not on a guessed pixel.
 */

import { expect, test } from '@playwright/test';

import { anyLight, connectHome, homeInstance, openScene, readState, signIn, resetHomes, waitForState } from './home-support.js';

test.describe.configure({ mode: 'serial' });

test('journey 2: toggle a light in the house and see the real device change', async ({ page }) => {
	const instance = homeInstance();
	await signIn(page, 'owner');
	await resetHomes(page);
	await connectHome(page, { label: 'Journey two' });
	await openScene(page);

	const light = await anyLight(instance);
	const before = await readState(instance, light.entityId);
	const wanted = before === 'on' ? 'off' : 'on';
	const label = before === 'on' ? 'Turn off' : 'Turn on';

	const button = page.getByRole('button', { name: new RegExp(`^${label} ${escapeRe(light.name)}\\b`) }).first();
	await expect(button).toBeVisible({ timeout: 60_000 });
	await button.click();

	// Home Assistant's own answer. A button that flips its own label proves
	// nothing about a bulb.
	expect(await waitForState(instance, light.entityId, wanted, { timeout: 30_000 })).toBe(wanted);
});

test('journey 3: change a light in Home Assistant and see the house update', async ({ page }) => {
	const instance = homeInstance();
	await signIn(page, 'owner');
	await openScene(page);

	const light = await anyLight(instance);
	const before = await readState(instance, light.entityId);
	const wanted = before === 'on' ? 'off' : 'on';

	// Nothing in the browser did this. The change arrives from the house, over
	// the state stream, and the page has to follow it without being asked.
	await fetch(`${instance.baseUrl}/api/services/light/turn_${wanted}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ entity_id: light.entityId }),
	});
	await waitForState(instance, light.entityId, wanted, { timeout: 30_000 });

	// The button offers the opposite action once the page knows the new state.
	const nowOffers = wanted === 'on' ? 'Turn off' : 'Turn on';
	await expect(
		page.getByRole('button', { name: new RegExp(`^${nowOffers} ${escapeRe(light.name)}\\b`) }).first(),
	).toBeVisible({ timeout: 60_000 });
});

test('journey 8: the house goes away mid-session, and comes back, with no reload', async ({ page }) => {
	const instance = homeInstance();
	await signIn(page, 'owner');
	await openScene(page);

	const light = await anyLight(instance);
	await expect(page.getByRole('button', { name: new RegExp(escapeRe(light.name)) }).first()).toBeVisible({ timeout: 60_000 });

	// Stop Home Assistant under the running page. The page must say the state it
	// is showing is stale rather than keep presenting it as live.
	await stopHouse();
	try {
		await expect(page.locator('#hs-status')).toHaveAttribute('data-status', /stale|offline|reconnecting|error/, {
			timeout: 120_000,
		});
	} finally {
		await startHouse();
	}

	// And recover on its own, on the same page: no navigation, no reload.
	await expect(page.locator('#hs-status')).toHaveAttribute('data-status', /live|connected|ok/, { timeout: 180_000 });
	expect(page.url()).toContain('/smart-home/');
});

async function stopHouse() {
	await runDocker(['stop', containerName()]);
}

async function startHouse() {
	await runDocker(['start', containerName()]);
	const instance = homeInstance();
	// Wait for the house to answer again before handing control back, so the
	// recovery assertion is about our reconnect and not about a boot still
	// finishing.
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const res = await fetch(`${instance.baseUrl}/api/`, {
			headers: { authorization: `Bearer ${instance.token}` },
			signal: AbortSignal.timeout(4000),
		}).catch(() => null);
		if (res?.ok) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error('Home Assistant did not come back after being restarted');
}

/**
 * The container this run's house lives in. Derived from the harness's naming so
 * this can never stop a container belonging to another agent on this machine.
 */
function containerName() {
	return `three-ws-home-test-${process.env.HOME_LIVE_NAME || 'e2e'}`;
}

async function runDocker(args) {
	const { spawn } = await import('node:child_process');
	await new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: 'ignore' });
		child.on('error', reject);
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker ${args.join(' ')} exited ${code}`))));
	});
}

function escapeRe(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
