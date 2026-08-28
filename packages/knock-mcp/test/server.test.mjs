import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, buildServer } from '../src/index.js';

test('every advertised tool is complete', () => {
	assert.equal(TOOLS.length, 6);
	for (const tool of TOOLS) {
		assert.match(tool.name, /^knock_[a-z_]+$/, `${tool.name} follows the knock_ prefix`);
		assert.ok(tool.title, `${tool.name} has a title`);
		assert.ok(tool.description.length > 120, `${tool.name} explains itself`);
		assert.ok(tool.annotations, `${tool.name} carries MCP annotations`);
		assert.equal(typeof tool.handler, 'function');
	}
});

test('the public tools are marked read-only so clients do not gate them', () => {
	for (const name of ['knock_quote', 'knock_directory', 'knock_receipt', 'knock_inbox']) {
		const tool = TOOLS.find((t) => t.name === name);
		assert.equal(tool.annotations.readOnlyHint, true, `${name} is read-only`);
	}
});

test('the writing tools are not read-only and not destructive', () => {
	for (const name of ['knock_send', 'knock_act']) {
		const tool = TOOLS.find((t) => t.name === name);
		assert.equal(tool.annotations.readOnlyHint, false);
		assert.equal(tool.annotations.destructiveHint, false);
	}
});

test('buildServer registers without a credential', () => {
	const server = buildServer();
	assert.ok(server, 'the tool surface is advertised with no key configured');
});

test('a priced door is quoted, never paid, by knock_send', async () => {
	const send = TOOLS.find((t) => t.name === 'knock_send');
	const realFetch = globalThis.fetch;
	let posts = 0;
	globalThis.fetch = async (url, init = {}) => {
		if (init.method === 'POST') posts += 1;
		return new Response(
			JSON.stringify({
				door: {
					handle: 'ada', display_name: 'Ada', free: false, price: '$0.05', price_atomics: '50000',
					currency: 'USDC', networks: ['solana'], max_chars: 600,
					endpoint: 'https://three.ws/api/x402/knock?to=ada', protocol: 'x402',
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	};
	try {
		const out = await send.handler({ to: 'ada', from: 'Bob', message: 'a real message here' });
		assert.equal(out.ok, false);
		assert.equal(out.error, 'payment_required');
		assert.equal(out.confirm.amount, '$0.05');
		assert.deepEqual(out.confirm.chains, ['solana']);
		assert.match(out.confirm.settles_to, /recipient directly/);
		assert.equal(posts, 0, 'a priced door must not be posted to by this server');
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a free door is sent immediately', async () => {
	const send = TOOLS.find((t) => t.name === 'knock_send');
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		const body = init.method === 'POST'
			? { ok: true, knock_id: 'k1', delivered_to: 'Ada', duplicate: false, paid: '$0.00', receipt_url: 'https://three.ws/api/knock/reply?id=k1&token=t' }
			: { door: { handle: 'ada', display_name: 'Ada', free: true, price: '$0.00', price_atomics: '0', currency: 'USDC', networks: [], max_chars: 600, endpoint: 'https://three.ws/api/knock/send', protocol: 'http' } };
		return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	};
	try {
		const out = await send.handler({ to: '@ada', from: 'Bob', message: 'a real message here', subject: 'hi' });
		assert.equal(out.ok, true);
		assert.equal(out.knock_id, 'k1');
		assert.match(out.receipt_url, /token=/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('the owner tools refuse clearly with no credential', async () => {
	const inbox = TOOLS.find((t) => t.name === 'knock_inbox');
	await assert.rejects(() => inbox.handler({}), (err) => {
		assert.equal(err.code, 'missing_credential');
		assert.match(err.message, /THREE_WS_API_KEY/);
		return true;
	});
});
