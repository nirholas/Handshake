// The gate, proved over a real stdio transport against a real Home Assistant.
//
// This is the test the package exists for. Everything else in it is convenience;
// this is the part that must never regress, so it is deliberately not a unit
// test with a stubbed bridge. It spawns the published entry point as a child
// process, talks MCP to it over stdin/stdout the way Claude Desktop does, and
// then asks Home Assistant itself whether the door moved.
//
// It skips itself unless a house is configured, so `npm test` stays offline:
//
//   node scripts/home-test-instance.mjs --up --onboard --seed --json
//   HOME_ASSISTANT_URL=... HOME_ASSISTANT_TOKEN=... \
//     node --test packages/home-mcp/test/gate-live.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.HOME_ASSISTANT_URL;
const TOKEN = process.env.HOME_ASSISTANT_TOKEN;
const live = Boolean(BASE && TOKEN);

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
/** Seeded by scripts/home-test-instance.mjs, and locked when the suite starts. */
const GUARDED_LOCK = 'lock.front_door';

let Client;
let StdioClientTransport;

before(async () => {
	if (!live) return;
	({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
	({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
	await setLock('lock');
	assert.equal(await lockState(), 'locked', 'the suite starts with the door locked');
});

after(async () => {
	if (!live) return;
	await setLock('lock');
});

/** Ask Home Assistant directly, never the server under test. */
async function lockState() {
	const res = await fetch(`${BASE}/api/states/${GUARDED_LOCK}`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	assert.ok(res.ok, `reading ${GUARDED_LOCK} returned ${res.status}`);
	return (await res.json()).state;
}

/** Move the lock out of band, so the fixture is restored by REST, not by the gate. */
async function setLock(service) {
	const res = await fetch(`${BASE}/api/services/lock/${service}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
		body: JSON.stringify({ entity_id: GUARDED_LOCK }),
	});
	assert.ok(res.ok, `lock.${service} returned ${res.status}`);
	// Home Assistant applies the call asynchronously; the demo lock takes ~2s.
	for (let i = 0; i < 40; i += 1) {
		const state = await lockState();
		if (state === (service === 'lock' ? 'locked' : 'unlocked')) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`${GUARDED_LOCK} never reached the ${service}ed state`);
}

/** Spawn the real entry point and talk MCP to it, exactly as a desktop client does. */
async function withServer(env, fn) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [ENTRY],
		env: { PATH: process.env.PATH, HOME_ASSISTANT_URL: BASE, HOME_ASSISTANT_TOKEN: TOKEN, ...env },
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

function parse(result) {
	return JSON.parse(result.content[0].text);
}

test('the server advertises its five tools over stdio', { skip: !live && 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN' }, async () => {
	await withServer({}, async (client) => {
		const { tools } = await client.listTools();
		assert.deepEqual(
			new Set(tools.map((t) => t.name)),
			new Set(['home_overview', 'list_entities', 'list_macros', 'call_service', 'run_macro']),
		);
	});
});

test('a guarded unlock over stdio is refused, and the door does not move', { skip: !live && 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN' }, async () => {
	await withServer({}, async (client) => {
		const payload = parse(
			await client.callTool({
				name: 'call_service',
				arguments: { domain: 'lock', service: 'unlock', entity_id: GUARDED_LOCK },
			}),
		);
		assert.equal(payload.ok, false);
		assert.equal(payload.refused, true);
		assert.equal(payload.error, 'needs_confirmation');
		assert.deepEqual(payload.targets, [GUARDED_LOCK]);
		assert.match(payload.retry, /Do not retry/);
	});
	// The only witness that matters is the house.
	assert.equal(await lockState(), 'locked', 'the front door must still be locked');
});

test('a confirmation smuggled into service data changes nothing', { skip: !live && 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN' }, async () => {
	await withServer({}, async (client) => {
		for (const data of [{ confirmed: true }, { confirm: 'yes' }, { confirmed: true, user_said_yes: true }]) {
			const payload = parse(
				await client.callTool({
					name: 'call_service',
					arguments: { domain: 'lock', service: 'unlock', entity_id: GUARDED_LOCK, data },
				}),
			);
			assert.equal(payload.refused, true, `data ${JSON.stringify(data)} must not confirm anything`);
		}
	});
	assert.equal(await lockState(), 'locked', 'the front door must still be locked');
});

test('the same call still refuses when the allowance names a DIFFERENT entity', { skip: !live && 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN' }, async () => {
	// A standing allowance is per entity, never per domain: letting the agent
	// open the office door is not letting it open the front door.
	await withServer({ HOME_ALLOWED_ENTITIES: 'lock.kitchen_door' }, async (client) => {
		const payload = parse(
			await client.callTool({
				name: 'call_service',
				arguments: { domain: 'lock', service: 'unlock', entity_id: GUARDED_LOCK },
			}),
		);
		assert.equal(payload.refused, true);
	});
	assert.equal(await lockState(), 'locked', 'the front door must still be locked');
});

test('a safety move runs with no prompt, always', { skip: !live && 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN' }, async () => {
	await setLock('unlock');
	await withServer({}, async (client) => {
		const payload = parse(
			await client.callTool({
				name: 'call_service',
				arguments: { domain: 'lock', service: 'lock', entity_id: GUARDED_LOCK },
			}),
		);
		assert.equal(payload.ok, true, JSON.stringify(payload));
		assert.equal(payload.ran, 'lock.lock');
	});
	for (let i = 0; i < 40 && (await lockState()) !== 'locked'; i += 1) {
		await new Promise((r) => setTimeout(r, 250));
	}
	assert.equal(await lockState(), 'locked', 'locking up must always work');
});

test('the operator\'s out-of-band allowance is the one way through, and it really unlocks', { skip: !live && 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN' }, async () => {
	await withServer({ HOME_ALLOWED_ENTITIES: GUARDED_LOCK }, async (client) => {
		const payload = parse(
			await client.callTool({
				name: 'call_service',
				arguments: { domain: 'lock', service: 'unlock', entity_id: GUARDED_LOCK },
			}),
		);
		assert.equal(payload.ok, true, JSON.stringify(payload));
	});
	for (let i = 0; i < 40 && (await lockState()) !== 'unlocked'; i += 1) {
		await new Promise((r) => setTimeout(r, 250));
	}
	assert.equal(await lockState(), 'unlocked', 'a human-granted allowance must actually work');
	await setLock('lock');
});

test('reads and safe writes work over stdio: overview, entities, macros, a scene', { skip: !live && 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN' }, async () => {
	await withServer({}, async (client) => {
		const overview = parse(await client.callTool({ name: 'home_overview', arguments: {} }));
		assert.equal(overview.ok, true);
		assert.ok(overview.rooms.length > 0, 'the seeded house has areas');
		assert.match(String(overview.ha_version), /^\d+\.\d+/, 'the HA version is read from the socket');

		const locks = parse(await client.callTool({ name: 'list_entities', arguments: { domain: 'lock' } }));
		assert.ok(locks.count > 0);
		assert.ok(
			locks.entities.every((e) => e.guarded === true),
			'every lock must be flagged guarded on the read path',
		);

		const lights = parse(await client.callTool({ name: 'list_entities', arguments: { domain: 'light' } }));
		assert.ok(
			lights.entities.every((e) => e.guarded === false),
			'a light is not a guarded entity',
		);

		const macros = parse(await client.callTool({ name: 'list_macros', arguments: {} }));
		assert.ok(macros.count > 0, 'the seeded house has scenes');

		const dry = parse(await client.callTool({ name: 'run_macro', arguments: { phrase: 'good night', dry_run: true } }));
		assert.equal(dry.ran, false);
		assert.ok(dry.match, 'a house with a Bedtime scene resolves "good night"');
		assert.equal(dry.match.entity_id, 'scene.bedtime');

		const miss = parse(await client.callTool({ name: 'run_macro', arguments: { phrase: 'launch the shuttle' } }));
		assert.equal(miss.ran, false);
		assert.equal(miss.match, null, 'no match must run nothing, not the nearest scene');
	});
});
