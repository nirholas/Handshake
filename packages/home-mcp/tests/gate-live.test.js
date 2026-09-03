// The gate, proved over a real stdio transport against a real Home Assistant.
//
// This is the test the package exists for, and it is deliberately not a unit
// test with a stubbed bridge: it spawns the published entry point as a child
// process, speaks MCP to it over stdin and stdout the way Claude Desktop does,
// and then asks Home Assistant itself whether the door moved. A card that says
// "refused" proves nothing about a lock.
//
// It skips itself with no house, so the default `npm test` needs no Docker:
//
//   HOME_LIVE=1 npx vitest run packages/home-mcp
//
// Pointing it at a house you already have works too, and skips the harness:
//
//   HOME_ASSISTANT_URL=... HOME_ASSISTANT_TOKEN=... npx vitest run packages/home-mcp

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	acquireHomeInstance,
	liveHomeAvailable,
	readState,
	readStates,
	setState,
	waitForState,
} from '../../../tests/_helpers/home-instance.js';

const live = describe.skipIf(!liveHomeAvailable());
const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');

/**
 * The last lock in the house that is sitting cleanly locked or unlocked.
 *
 * `pickEntity` returns the FIRST match, and four other live suites in this lane
 * take exactly that against the same shared instance. Taking the last one keeps
 * this suite off their door. Filtering to a settled state keeps it off the demo
 * integration's deliberately unreliable lock, whose transitional states would
 * make "did the door move" unanswerable.
 */
async function pickLastSettledLock(instance) {
	const states = await readStates(instance);
	const locks = states
		.filter((s) => s.entity_id.startsWith('lock.') && (s.state === 'locked' || s.state === 'unlocked'))
		.map((s) => s.entity_id)
		.sort();
	return locks.at(-1) || null;
}

live('the gate, over a real stdio transport', () => {
	let instance;
	let Client;
	let StdioClientTransport;
	/**
	 * A lock the seeded house really has, chosen from the instance, never assumed.
	 *
	 * Deliberately NOT the first one. The lane shares a single harness instance
	 * across every live suite, and four other files take `pickEntity(instance,
	 * 'lock')`, which is the first match. Two suites locking and unlocking the
	 * same door in parallel forks is how a gate test starts flapping and stops
	 * being believed, so this one takes the last settled lock instead. "Settled"
	 * excludes the demo integration's deliberately unreliable lock, which reports
	 * transitional states and would make a door assertion a coin toss.
	 */
	let lockId;

	beforeAll(async () => {
		instance = await acquireHomeInstance();
		({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
		({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
		lockId = await pickLastSettledLock(instance);
		expect(lockId, 'the house needs a lock for any of this to mean anything').toBeTruthy();
		await setState(instance, 'lock', 'lock', lockId);
		await waitForState(instance, lockId, 'locked');
	}, 620_000);

	afterAll(async () => {
		if (instance && lockId) await setState(instance, 'lock', 'lock', lockId).catch(() => {});
	});

	/** Spawn the real entry point and talk MCP to it, exactly as a desktop client does. */
	async function withServer(env, fn) {
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [ENTRY],
			env: {
				PATH: process.env.PATH,
				HOME_ASSISTANT_URL: instance.baseUrl,
				HOME_ASSISTANT_TOKEN: instance.token,
				...env,
			},
			stderr: 'ignore',
		});
		const client = new Client({ name: 'home-mcp gate test', version: '0.1.0' }, { capabilities: {} });
		await client.connect(transport);
		try {
			return await fn(client);
		} finally {
			await client.close();
		}
	}

	const parse = (result) => JSON.parse(result.content[0].text);

	const unlock = (client) =>
		client.callTool({ name: 'call_service', arguments: { domain: 'lock', service: 'unlock', entity_id: lockId } });

	it('advertises its five tools', async () => {
		await withServer({}, async (client) => {
			const { tools } = await client.listTools();
			expect(new Set(tools.map((t) => t.name))).toEqual(
				new Set(['home_overview', 'list_entities', 'list_macros', 'call_service', 'run_macro']),
			);
		});
	});

	it('refuses a guarded unlock, and the door does not move', async () => {
		await withServer({}, async (client) => {
			const payload = parse(await unlock(client));
			expect(payload).toMatchObject({ ok: false, refused: true, error: 'needs_confirmation' });
			expect(payload.targets).toEqual([lockId]);
			expect(payload.retry).toMatch(/Do not retry/);
		});
		// The only witness that matters is the house.
		expect(await readState(instance, lockId)).toBe('locked');
	});

	it('ignores a confirmation smuggled into service data', async () => {
		await withServer({}, async (client) => {
			for (const data of [{ confirmed: true }, { confirm: 'yes' }, { confirmed: true, user_said_yes: true }]) {
				const payload = parse(
					await client.callTool({
						name: 'call_service',
						arguments: { domain: 'lock', service: 'unlock', entity_id: lockId, data },
					}),
				);
				expect(payload.refused, `data ${JSON.stringify(data)} must not confirm anything`).toBe(true);
			}
		});
		expect(await readState(instance, lockId)).toBe('locked');
	});

	it('keeps a standing allowance per entity, so a different lock does not clear this one', async () => {
		await withServer({ HOME_ALLOWED_ENTITIES: 'lock.some_other_door' }, async (client) => {
			expect(parse(await unlock(client)).refused).toBe(true);
		});
		expect(await readState(instance, lockId)).toBe('locked');
	});

	it('runs a safety move with no prompt, always', async () => {
		await setState(instance, 'lock', 'unlock', lockId);
		await waitForState(instance, lockId, 'unlocked');
		await withServer({}, async (client) => {
			const payload = parse(
				await client.callTool({ name: 'call_service', arguments: { domain: 'lock', service: 'lock', entity_id: lockId } }),
			);
			expect(payload, JSON.stringify(payload)).toMatchObject({ ok: true, ran: 'lock.lock' });
		});
		expect(await waitForState(instance, lockId, 'locked')).toBe('locked');
	});

	it('lets the operator\'s own out-of-band allowance through, and it really unlocks', async () => {
		await withServer({ HOME_ALLOWED_ENTITIES: lockId }, async (client) => {
			const payload = parse(await unlock(client));
			expect(payload, JSON.stringify(payload)).toMatchObject({ ok: true });
		});
		expect(await waitForState(instance, lockId, 'unlocked')).toBe('unlocked');
		await setState(instance, 'lock', 'lock', lockId);
		await waitForState(instance, lockId, 'locked');
	});

	it('reads the house: overview, entities, macros, and a scene resolved but not run', async () => {
		await withServer({ HOME_ALLOWED_ENTITIES: lockId }, async (client) => {
			const overview = parse(await client.callTool({ name: 'home_overview', arguments: {} }));
			expect(overview.ok).toBe(true);
			expect(overview.connected).toBe(true);
			expect(overview.stale).toBe(false);
			expect(overview.rooms.length).toBeGreaterThan(0);
			expect(String(overview.ha_version)).toMatch(/^\d+\.\d+/);
			// The allowance the operator set is visible, so the model can plan
			// around the gate instead of discovering it on a door.
			expect(overview.standing_allowances).toContain(lockId);

			const locks = parse(await client.callTool({ name: 'list_entities', arguments: { domain: 'lock' } }));
			expect(locks.count).toBeGreaterThan(0);
			expect(locks.entities.every((e) => e.guarded === true), 'every lock is guarded').toBe(true);
			expect(locks.entities.find((e) => e.entity_id === lockId).allowed).toBe(true);
			expect(locks.entities.filter((e) => e.entity_id !== lockId).every((e) => e.allowed === false)).toBe(true);

			const lights = parse(await client.callTool({ name: 'list_entities', arguments: { domain: 'light' } }));
			expect(lights.entities.every((e) => e.guarded === false), 'a light is not guarded').toBe(true);

			const macros = parse(await client.callTool({ name: 'list_macros', arguments: {} }));
			expect(macros.count).toBeGreaterThan(0);

			const dry = parse(await client.callTool({ name: 'run_macro', arguments: { phrase: 'good night', dry_run: true } }));
			expect(dry.ran).toBe(false);
			expect(dry.match, 'a house with a Bedtime scene resolves "good night"').toBeTruthy();

			const miss = parse(await client.callTool({ name: 'run_macro', arguments: { phrase: 'launch the shuttle' } }));
			expect(miss.ran).toBe(false);
			expect(miss.match, 'no match must run nothing, not the nearest scene').toBeNull();
		});
	});

	it('reports a missing credential as an ordinary state, not a stack trace', async () => {
		await withServer({ HOME_ASSISTANT_TOKEN: '' }, async (client) => {
			const payload = parse(await client.callTool({ name: 'home_overview', arguments: {} }));
			expect(payload.ok).toBe(false);
			expect(payload.error).toBe('auth');
			expect(payload.message).toMatch(/long-lived access token/i);
		});
	});
});
