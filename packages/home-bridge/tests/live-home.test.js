// The live suite. Everything in home-bridge.test.js is a pure function over a
// recording; this file drives a real Home Assistant and changes real state.
//
// It gets that instance from the lane's one harness rather than from a
// paragraph of setup instructions, so every live test in the lane is looking at
// the same seeded house:
//
//   HOME_LIVE=1 npx vitest run packages/home-bridge
//
// Pointing it at a house you already have works too, and skips the harness:
//
//   HOME_ASSISTANT_URL=https://home.example HOME_ASSISTANT_TOKEN=... \
//     npx vitest run packages/home-bridge
//
// With neither, the suite skips itself, so the default `npm test` needs no
// Docker and no house.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	acquireHomeInstance,
	liveHomeAvailable,
	pickEntity,
	readState,
	setState,
	waitForState,
} from '../../../tests/_helpers/home-instance.js';
import { connectHomeMcp, ERR, flattenEntities, HomeBridge } from '../src/index.js';

const live = describe.skipIf(!liveHomeAvailable());

live('against a real Home Assistant', () => {
	/** @type {HomeBridge} */
	let home;
	/** @type {{ baseUrl: string, token: string }} */
	let instance;

	beforeAll(async () => {
		instance = await acquireHomeInstance();
		home = new HomeBridge({ baseUrl: instance.baseUrl, token: instance.token });
		await home.connect();
	}, 600_000);

	afterAll(() => home?.close());

	it('connects and builds a room graph from the live registries', () => {
		expect(home.connected).toBe(true);
		expect(home.graph.rooms.length + home.graph.unassigned.length).toBeGreaterThan(0);
	});

	it('reports the unit the house measures temperature in, read from the house', async () => {
		// The point of this one is that it is not a guess. Home Assistant states
		// its unit system in get_config, and the assertion compares what the
		// bridge exposes against what the instance's own REST config says, so a
		// locale-derived or hardcoded default cannot pass it.
		const res = await fetch(`${instance.baseUrl}/api/config`, {
			headers: { Authorization: `Bearer ${instance.token}` },
		});
		expect(res.ok).toBe(true);
		const config = await res.json();
		expect(config.unit_system.temperature).toMatch(/^\u00b0[CF]$/);
		expect(home.temperatureUnit).toBe(config.unit_system.temperature);
		// And it reaches the graph the scene renders, which is the only copy the
		// browser ever sees.
		expect(home.graph.temperatureUnit).toBe(config.unit_system.temperature);
	}, 30_000);

	it('reports the version the house is actually running', () => {
		// The connect screen and the capability record both have to state this,
		// and a support conversation starts with it.
		expect(home.haVersion).toMatch(/^\d{4}\.\d+/);
	});

	it('changes real state and sees it come back on the socket', async () => {
		const light = await pickEntity(instance, 'light');
		expect(light).toBeTruthy();
		const before = home.states[light].state;
		await home.call('light', 'toggle', { entity_id: light });

		// Wait for the condition, not for a duration: the socket delivers when it
		// delivers, and a sleep here is how this suite would start flaking.
		await waitForState(instance, light, before === 'on' ? 'off' : 'on');
		await expect
			.poll(() => home.states[light].state, { timeout: 10_000 })
			.not.toBe(before);
	}, 60_000);

	it('refuses to unlock a door without an explicit yes, then does it when asked', async () => {
		const lock = await pickEntity(instance, 'lock', (s) => s.state === 'locked');
		expect(lock, 'the seeded house has a locked door').toBeTruthy();

		await expect(home.call('lock', 'unlock', { entity_id: lock })).rejects.toMatchObject({
			code: ERR.NEEDS_CONFIRMATION,
		});
		// Home Assistant's own answer, not our object graph: the refusal has to
		// mean the door did not move.
		expect(await readState(instance, lock)).toBe('locked');

		await home.call('lock', 'unlock', { entity_id: lock }, { confirmed: true });
		expect(await waitForState(instance, lock, ['unlocked', 'unlocking', 'open', 'opening'])).toBeTruthy();

		// Locking back up is the safe direction and needs no confirmation.
		await home.call('lock', 'lock', { entity_id: lock });
		expect(await waitForState(instance, lock, ['locked', 'locking'])).toBeTruthy();
	}, 90_000);

	it('reports a bad token as an auth problem, not a network one', async () => {
		const bad = new HomeBridge({ baseUrl: instance.baseUrl, token: 'not-a-real-token' });
		await expect(bad.connect()).rejects.toMatchObject({ code: ERR.AUTH });
	}, 30_000);

	it('runs the household macro this house actually has', async () => {
		const { match } = await home.activate('good night', { dryRun: true });
		expect(match, 'the seeded house has a Bedtime scene').toBeTruthy();
		expect(match.kind).toMatch(/^(scene|script)$/);

		const result = await home.activate('good night', { confirmed: true });
		expect(result.ran).toBe(true);
	}, 60_000);

	it('opens the MCP channel when the integration is enabled, and gates its tools', async () => {
		let mcp;
		try {
			mcp = await connectHomeMcp({
				baseUrl: instance.baseUrl,
				token: instance.token,
				entities: () => flattenEntities(home.graph),
				isAllowed: (id) => home.allowList.has(id),
			});
		} catch (err) {
			// An instance without mcp_server set up is the ordinary case, and the
			// error has to say so rather than looking like an outage.
			expect(err.code).toBe(ERR.NO_MCP);
			return;
		}

		expect(mcp.tools.length).toBeGreaterThan(0);
		const lock = await pickEntity(instance, 'lock');
		if (lock) {
			// Shut the door FIRST. The lane's instance is shared by every live test
			// in the run and by anything else pointed at it, so "the door stayed
			// shut" is only a statement about the gate if the door was shut when we
			// started. Without this the assertion inherits whatever the last
			// confirmed unlock left behind and fails for a reason that has nothing
			// to do with the gate.
			await setState(instance, 'lock', 'lock', lock);
			await waitForState(instance, lock, ['locked', 'locking']);

			const name = home.states[lock].attributes.friendly_name;
			await expect(mcp.callTool({ name: 'intent__HassTurnOff', arguments: { name } })).rejects.toMatchObject({
				code: ERR.NEEDS_CONFIRMATION,
			});
			// The gate is only worth anything if the door stayed shut.
			expect(await readState(instance, lock)).toMatch(/^(locked|locking)$/);
		}
		await mcp.close();
	}, 90_000);
});
