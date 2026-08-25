// The session gate: which reads are account-scoped, and what a caller gets back
// when THREE_WS_SESSION is not set.
//
// This is the boundary that decides whether a call ever leaves the process. It
// must refuse locally with an actionable message rather than firing an
// unauthenticated request and surfacing a bare 401 from the API, and the one
// public read (`get_fee_info`) must stay outside it.
//
// No network: every case here is decided before a request is made. The suite is
// only meaningful with THREE_WS_SESSION unset, which is the default for a
// freshly installed server.
//
// Run: node --test packages/billing-mcp/test/session-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/index.js';
import { THREE_WS_SESSION } from '../src/config.js';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const SESSION_SCOPED = ['get_billing_summary', 'query_usage', 'export_billing_history', 'get_receipt'];
const PUBLIC = ['get_fee_info'];

test('the tool list is exactly the session-scoped reads plus the public one', () => {
	assert.deepEqual(TOOLS.map((t) => t.name).sort(), [...SESSION_SCOPED, ...PUBLIC].sort());
});

test('THREE_WS_SESSION defaults to empty, so the gate under test is armed', () => {
	assert.equal(THREE_WS_SESSION, '', 'unset THREE_WS_SESSION before running this suite');
});

for (const name of SESSION_SCOPED) {
	test(`${name} refuses locally with no_session instead of calling unauthenticated`, async () => {
		const started = Date.now();
		const args = name === 'get_receipt' ? { event_id: 1 } : {};
		await assert.rejects(
			() => byName[name].handler(args),
			(err) => {
				assert.equal(err.code, 'no_session', `${name} must fail with no_session`);
				assert.equal(err.status, 401);
				assert.match(err.message, /THREE_WS_SESSION/, 'the message must name the variable to set');
				assert.match(err.message, /__Host-sid/, 'the message must say where to find the value');
				return true;
			},
		);
		// A local refusal, not a round trip that happened to fail.
		assert.ok(Date.now() - started < 1000, `${name} must refuse before any request`);
	});
}

test('get_receipt rejects an ambiguous request before it can reach the gate', async () => {
	// Exactly one of event_id / purchase_id. Neither and both are caller errors,
	// and both are caught locally rather than sent upstream to be sorted out.
	for (const args of [{}, { event_id: 1, purchase_id: '00000000-0000-4000-8000-000000000000' }]) {
		await assert.rejects(
			() => byName.get_receipt.handler(args),
			(err) => {
				assert.notEqual(err.code, 'no_session', 'the shape error must be reported before the session gate');
				assert.match(err.message, /exactly one of/i);
				return true;
			},
		);
	}
});

test('the public fee read is not behind the session gate', () => {
	// Asserted on the declared surface rather than by calling out to the network:
	// get_fee_info takes no arguments and is the only tool the README documents
	// as reachable without a session.
	assert.deepEqual(Object.keys(byName.get_fee_info.inputSchema ?? {}), []);
	assert.equal(byName.get_fee_info.annotations.readOnlyHint, true);
});
