// Without THREE_WS_API_KEY, the three account-scoped follower tools must fail
// with an actionable `auth_required` BEFORE any request leaves the process. A
// keyless server should never bounce off an upstream 401, and must never leak a
// subscribe/kill attempt onto the wire.
//
// This lives in its own file because src/config.js snapshots process.env at
// module load, and `node --test` runs each test file in its own process.
//
// Run: node --test packages/signals-mcp/test/auth-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://signals.test';
delete process.env.THREE_WS_API_KEY;

const { def: getSubscriptions } = await import('../src/tools/get-subscriptions.js');
const { def: subscribeSignal } = await import('../src/tools/subscribe-signal.js');
const { def: setSubscriptionStatus } = await import('../src/tools/set-subscription-status.js');
const { def: listSignalFeeds } = await import('../src/tools/list-signal-feeds.js');

// Any fetch at all is a failure for the account-scoped cases.
globalThis.fetch = async () => {
	throw new Error('a keyless account-scoped tool must never reach the network');
};

const isAuthRequired = (err) => err.code === 'auth_required' && err.status === 401 && /THREE_WS_API_KEY/.test(err.message);

test('get_subscriptions refuses without a key', async () => {
	await assert.rejects(() => getSubscriptions.handler(), isAuthRequired);
});

test('subscribe_signal refuses without a key, before any spend can be arranged', async () => {
	await assert.rejects(
		() => subscribeSignal.handler({ agent_id: 'agt_1', feed_id: 42, mode: 'live' }),
		isAuthRequired,
	);
});

test('set_subscription_status refuses without a key', async () => {
	await assert.rejects(
		() => setSubscriptionStatus.handler({ subscription_id: 7, state: 'killed' }),
		isAuthRequired,
	);
});

test('the public discovery tool still works keyless (it just needs the network)', async () => {
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(new URL(url));
		return new Response(JSON.stringify({ network: 'mainnet', sort: 'edge', feeds: [] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	const result = await listSignalFeeds.handler({});
	assert.equal(result.ok, true);
	assert.equal(calls[0].pathname, '/api/signals/marketplace');
	// No key configured means no Authorization header is attached at all.
	assert.equal(calls.length, 1);
});
