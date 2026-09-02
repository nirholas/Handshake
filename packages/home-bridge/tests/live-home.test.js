// The live suite. Everything in home-bridge.test.js is a pure function over a
// recording; this file drives a real Home Assistant and changes real state.
//
// It skips itself unless you point it at an instance, so the default `npm test`
// never needs one:
//
//   docker run -d --name ha -p 8123:8123 ghcr.io/home-assistant/home-assistant:stable
//   # add `demo:` to its configuration.yaml, restart, create a long-lived token
//   HOME_ASSISTANT_URL=http://localhost:8123 HOME_ASSISTANT_TOKEN=... npx vitest run packages/home-bridge

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectHomeMcp, ERR, flattenEntities, HomeBridge } from '../src/index.js';

const baseUrl = process.env.HOME_ASSISTANT_URL;
const token = process.env.HOME_ASSISTANT_TOKEN;
const live = describe.skipIf(!baseUrl || !token);

const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

live('against a real Home Assistant', () => {
	/** @type {HomeBridge} */
	let home;

	beforeAll(async () => {
		home = new HomeBridge({ baseUrl, token });
		await home.connect();
	}, 30_000);

	afterAll(() => home?.close());

	it('connects and builds a room graph from the live registries', () => {
		expect(home.connected).toBe(true);
		expect(home.graph.rooms.length + home.graph.unassigned.length).toBeGreaterThan(0);
	});

	it('changes real state and sees it come back on the socket', async () => {
		const light = Object.keys(home.states).find((id) => id.startsWith('light.'));
		const before = home.states[light].state;
		await home.call('light', 'toggle', { entity_id: light });
		await settle();
		expect(home.states[light].state).not.toBe(before);
	});

	it('refuses to unlock a door without an explicit yes, then does it when asked', async () => {
		const lock = Object.keys(home.states).find((id) => id.startsWith('lock.') && home.states[id].state === 'locked');
		if (!lock) return;

		await expect(home.call('lock', 'unlock', { entity_id: lock })).rejects.toMatchObject({
			code: ERR.NEEDS_CONFIRMATION,
		});
		expect(home.states[lock].state).toBe('locked');

		await home.call('lock', 'unlock', { entity_id: lock }, { confirmed: true });
		await settle(1200);
		expect(['unlocked', 'unlocking', 'open', 'opening']).toContain(home.states[lock].state);

		// Locking back up is the safe direction and needs no confirmation.
		await home.call('lock', 'lock', { entity_id: lock });
		await settle(1200);
		expect(['locked', 'locking']).toContain(home.states[lock].state);
	}, 20_000);

	it('reports a bad token as an auth problem, not a network one', async () => {
		const bad = new HomeBridge({ baseUrl, token: 'not-a-real-token' });
		await expect(bad.connect()).rejects.toMatchObject({ code: ERR.AUTH });
	}, 20_000);

	it('runs the household macro this house actually has', async () => {
		const { match } = await home.activate('good night', { dryRun: true });
		if (!match) return;
		expect(match.kind).toMatch(/^(scene|script)$/);
		const result = await home.activate('good night');
		expect(result.ran).toBe(true);
	}, 20_000);

	it('opens the MCP channel when the integration is enabled, and gates its tools', async () => {
		let mcp;
		try {
			mcp = await connectHomeMcp({
				baseUrl,
				token,
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
		const lock = Object.keys(home.states).find((id) => id.startsWith('lock.'));
		if (lock) {
			const name = home.states[lock].attributes.friendly_name;
			await expect(mcp.callTool({ name: 'intent__HassTurnOff', arguments: { name } })).rejects.toMatchObject({
				code: ERR.NEEDS_CONFIRMATION,
			});
		}
		await mcp.close();
	}, 30_000);
});
