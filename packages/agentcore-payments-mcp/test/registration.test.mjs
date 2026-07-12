// Tool-surface invariants for @three-ws/agentcore-payments-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no
// credential to advertise the tool surface. These tests run offline — they never
// touch the network (a tripwire fetch stub guarantees it).
//
// Run: node --test packages/agentcore-payments-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// This file also exercises the credential-missing error paths, so make sure a
// developer's shell env can't leak a real session into the module under test.
// (config.js snapshots env at import time — hence dynamic import below.)
delete process.env.THREE_WS_SESSION;
delete process.env.PAYMENT_SESSION_TOKEN;
delete process.env.THREE_WS_TIMEOUT_MS;
delete process.env.THREE_WS_BASE;

// Nothing in this file may reach the network.
globalThis.fetch = async (url) => {
	throw new Error(`registration tests must not touch the network (attempted ${url})`);
};

const { TOOLS, buildServer } = await import('../src/index.js');

const EXPECTED_NAMES = [
	'create_payment_session',
	'pay_with_session',
	'check_payment_session',
	'list_payment_sessions',
	'cancel_payment_session',
];

const READ_ONLY_NAMES = new Set(['check_payment_session', 'list_payment_sessions']);
const DESTRUCTIVE_NAMES = new Set(['pay_with_session', 'cancel_payment_session']);

function tool(name) {
	const t = TOOLS.find((x) => x.name === name);
	assert.ok(t, `${name} must exist`);
	return t;
}

function schema(name) {
	return z.object(tool(name).inputSchema);
}

// ── tool surface ─────────────────────────────────────────────────────────────

test('exactly the expected tools are registered', () => {
	assert.equal(TOOLS.length, EXPECTED_NAMES.length);
	assert.deepEqual(new Set(TOOLS.map((t) => t.name)), new Set(EXPECTED_NAMES));
});

test('every tool has a title, description, input schema and complete annotations', () => {
	for (const t of TOOLS) {
		assert.equal(typeof t.title, 'string', `${t.name} is missing a title`);
		assert.ok(t.title.length > 0, `${t.name} has an empty title`);
		assert.equal(typeof t.description, 'string', `${t.name} is missing a description`);
		assert.ok(t.description.length > 0, `${t.name} has an empty description`);
		assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} is missing inputSchema`);
		assert.equal(typeof t.handler, 'function', `${t.name} is missing a handler`);
		assert.ok(t.annotations, `${t.name} is missing MCP ToolAnnotations`);
		assert.equal(typeof t.annotations.readOnlyHint, 'boolean', `${t.name} must set readOnlyHint`);
		assert.equal(typeof t.annotations.idempotentHint, 'boolean', `${t.name} must set idempotentHint`);
		assert.equal(typeof t.annotations.openWorldHint, 'boolean', `${t.name} must set openWorldHint`);
	}
});

test('read tools are flagged read-only; write tools are not', () => {
	for (const t of TOOLS) {
		if (READ_ONLY_NAMES.has(t.name)) {
			assert.equal(t.annotations.readOnlyHint, true, `${t.name} should be read-only`);
		} else {
			assert.equal(t.annotations.readOnlyHint, false, `${t.name} mutates state — readOnlyHint must be false`);
			assert.equal(
				typeof t.annotations.destructiveHint,
				'boolean',
				`${t.name} is a write — it must set destructiveHint explicitly (spec default is TRUE when omitted)`,
			);
		}
	}
});

test('spending and cancelling are the destructive actions; creating a session is not', () => {
	const destructive = TOOLS.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name);
	assert.deepEqual(new Set(destructive), DESTRUCTIVE_NAMES);
	assert.equal(tool('create_payment_session').annotations.destructiveHint, false);
});

test('pay_with_session is the only open-world tool (it calls arbitrary x402 endpoints)', () => {
	for (const t of TOOLS) {
		assert.equal(
			t.annotations.openWorldHint,
			t.name === 'pay_with_session',
			`${t.name} openWorldHint mismatch`,
		);
	}
});

test('buildServer registers every tool with title and annotations, without a credential', () => {
	const server = buildServer();
	const registered = server._registeredTools;
	assert.ok(registered, 'McpServer should expose its tool registry');
	for (const t of TOOLS) {
		const entry = registered[t.name];
		assert.ok(entry, `${t.name} not registered on the server`);
		assert.equal(entry.title, t.title, `${t.name} title must survive registration`);
		assert.deepEqual(entry.annotations, t.annotations, `${t.name} annotations must survive registration`);
	}
});

// ── input schema validation ──────────────────────────────────────────────────

test('create_payment_session applies defaults and enforces budget/expiry bounds', () => {
	const s = schema('create_payment_session');

	const parsed = s.parse({ budget_usd: 5 });
	assert.equal(parsed.expiry_seconds, 3600, 'expiry defaults to 1 hour');
	assert.equal(parsed.network, 'solana', 'network defaults to solana');

	assert.throws(() => s.parse({ budget_usd: 0 }), 'zero budget must be rejected');
	assert.throws(() => s.parse({ budget_usd: -1 }), 'negative budget must be rejected');
	assert.throws(() => s.parse({ budget_usd: 5, expiry_seconds: 30 }), 'sub-minute expiry must be rejected');
	assert.throws(() => s.parse({ budget_usd: 5, expiry_seconds: 7776001 }), 'expiry above 90 days must be rejected');
	assert.throws(() => s.parse({ budget_usd: 5, agent_id: 'not-a-uuid' }), 'agent_id must be a UUID');
	assert.throws(() => s.parse({ budget_usd: 5, network: 'ethereum' }), 'only solana settlement is supported');
});

test('pay_with_session validates the URL and restricts the HTTP method', () => {
	const s = schema('pay_with_session');

	const parsed = s.parse({ url: 'https://api.example.com/paid' });
	assert.equal(parsed.method, 'GET', 'method defaults to GET');

	assert.throws(() => s.parse({ url: 'not a url' }), 'malformed URL must be rejected');
	assert.throws(() => s.parse({ url: 'https://x.test', method: 'PUT' }), 'only GET/POST are allowed');
	assert.throws(
		() => s.parse({ url: 'https://x.test', idempotency_key: 'k'.repeat(129) }),
		'idempotency key above 128 chars must be rejected',
	);
});

test('check/cancel require a UUID session_id; list bounds limit and status', () => {
	for (const name of ['check_payment_session', 'cancel_payment_session']) {
		const s = schema(name);
		s.parse({ session_id: '123e4567-e89b-12d3-a456-426614174000' });
		assert.throws(() => s.parse({ session_id: 'sess-1' }), `${name} must reject a non-UUID id`);
		assert.throws(() => s.parse({}), `${name} must require session_id`);
	}

	const check = schema('check_payment_session').parse({ session_id: '123e4567-e89b-12d3-a456-426614174000' });
	assert.equal(check.include_executions, false, 'include_executions defaults to false');

	const list = schema('list_payment_sessions');
	assert.equal(list.parse({}).limit, 20, 'limit defaults to 20');
	assert.throws(() => list.parse({ limit: 0 }), 'limit below 1 must be rejected');
	assert.throws(() => list.parse({ limit: 101 }), 'limit above 100 must be rejected');
	assert.throws(() => list.parse({ status: 'archived' }), 'unknown status must be rejected');
});

// ── credential-missing error paths (thrown BEFORE any network I/O) ───────────

test('management tools reject with no_session when THREE_WS_SESSION is unset', async () => {
	const cases = [
		['check_payment_session', { session_id: '123e4567-e89b-12d3-a456-426614174000' }],
		['list_payment_sessions', {}],
		['create_payment_session', { budget_usd: 1 }],
		['cancel_payment_session', { session_id: '123e4567-e89b-12d3-a456-426614174000' }],
	];
	for (const [name, args] of cases) {
		await assert.rejects(
			tool(name).handler(args),
			(err) => err.code === 'no_session' && err.status === 401,
			`${name} must fail closed without a session`,
		);
	}
});

test('pay_with_session rejects with no_token when no token is supplied anywhere', async () => {
	await assert.rejects(
		tool('pay_with_session').handler({ url: 'https://api.example.com/paid' }),
		(err) => err.code === 'no_token',
	);
});
