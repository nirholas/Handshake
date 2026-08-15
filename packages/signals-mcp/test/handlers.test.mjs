// Handler behavior for @three-ws/signals-mcp: query shaping and clamping,
// request bodies, response mapping, auth gating, and error normalization.
// globalThis.fetch is swapped per test, so nothing here touches the network.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/signals-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://signals.test';
process.env.THREE_WS_API_KEY = 'sk_test_signals_mcp';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: listSignalFeeds } = await import('../src/tools/list-signal-feeds.js');
const { def: getMirrorLeaderboard } = await import('../src/tools/get-mirror-leaderboard.js');
const { def: getSubscriptions } = await import('../src/tools/get-subscriptions.js');
const { def: subscribeSignal } = await import('../src/tools/subscribe-signal.js');
const { def: setSubscriptionStatus } = await import('../src/tools/set-subscription-status.js');
const { apiRequest, requireApiKey } = await import('../src/lib/api.js');
const { THREE_WS_BASE } = await import('../src/config.js');

// Swap globalThis.fetch for the duration of fn, always restoring it.
async function withFetch(stub, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

// Record each fetch invocation and answer with a JSON body at `status`.
function recordingFetch(body, log, status = 200) {
	return async (url, init) => {
		log.push({ url: new URL(url), init });
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	};
}

// ── list_signal_feeds ────────────────────────────────────────────────────────

test('list_signal_feeds defaults to the mainnet edge ranking', async () => {
	const log = [];
	const result = await withFetch(recordingFetch({ network: 'mainnet', sort: 'edge', feeds: [] }, log), () =>
		listSignalFeeds.handler({}),
	);
	assert.equal(log[0].url.origin, new URL(THREE_WS_BASE).origin);
	assert.equal(log[0].url.pathname, '/api/signals/marketplace');
	assert.equal(log[0].url.searchParams.get('network'), 'mainnet');
	assert.equal(log[0].url.searchParams.get('sort'), 'edge');
	assert.equal(log[0].url.searchParams.get('limit'), '60');
	assert.deepEqual(result, { ok: true, network: 'mainnet', sort: 'edge', count: 0, feeds: [] });
});

test('list_signal_feeds clamps limit and refuses an unknown sort', async () => {
	const log = [];
	await withFetch(recordingFetch({ feeds: [] }, log), () =>
		listSignalFeeds.handler({ network: 'devnet', sort: 'made-up', limit: 5000 }),
	);
	assert.equal(log[0].url.searchParams.get('network'), 'devnet');
	assert.equal(log[0].url.searchParams.get('sort'), 'edge');
	assert.equal(log[0].url.searchParams.get('limit'), '100');
});

test('list_signal_feeds reports the count of the feeds it returns', async () => {
	const feeds = [
		{ rank: 1, id: 42, slug: 'alpha-trader-1a2b3c4d', edge_score: 77 },
		{ rank: 2, id: 43, slug: 'beta-trader-5e6f7a8b', edge_score: 61 },
	];
	const result = await withFetch(recordingFetch({ network: 'mainnet', sort: 'roi', feeds }, []), () =>
		listSignalFeeds.handler({ sort: 'roi', limit: 2 }),
	);
	assert.equal(result.count, 2);
	assert.equal(result.sort, 'roi');
	assert.equal(result.feeds[0].id, 42);
});

// ── get_mirror_leaderboard ───────────────────────────────────────────────────

test('get_mirror_leaderboard unwraps the data envelope and clamps limit', async () => {
	const log = [];
	const leaders = [{ rank: 1, agent_id: 'agt_1', name: 'Crosshair', pnl_sol: 0.16 }];
	const result = await withFetch(
		recordingFetch({ data: { network: 'mainnet', sort: 'pnl', leaders } }, log),
		() => getMirrorLeaderboard.handler({ sort: 'pnl', limit: 999 }),
	);
	assert.equal(log[0].url.pathname, '/api/mirror/leaderboard');
	assert.equal(log[0].url.searchParams.get('limit'), '50');
	assert.equal(result.sort, 'pnl');
	assert.equal(result.count, 1);
	assert.equal(result.leaders[0].name, 'Crosshair');
});

test('get_mirror_leaderboard returns an empty board rather than throwing', async () => {
	const result = await withFetch(recordingFetch({ data: {} }, []), () => getMirrorLeaderboard.handler({}));
	assert.deepEqual(result, { ok: true, network: 'mainnet', sort: 'score', count: 0, leaders: [] });
});

// ── account-scoped tools ─────────────────────────────────────────────────────

test('get_subscriptions sends the bearer key and shapes the list', async () => {
	const log = [];
	const result = await withFetch(
		recordingFetch({ subscriptions: [{ id: 7, feed_id: 42, mode: 'live', stats: { executed: 3 } }] }, log),
		() => getSubscriptions.handler(),
	);
	assert.equal(log[0].url.pathname, '/api/signals/subscribe');
	assert.equal(log[0].init.method, 'GET');
	assert.equal(log[0].init.headers.authorization, 'Bearer sk_test_signals_mcp');
	assert.equal(result.count, 1);
	assert.equal(result.subscriptions[0].stats.executed, 3);
});

test('subscribe_signal defaults to simulate and omits unset sizing fields', async () => {
	const log = [];
	const result = await withFetch(
		recordingFetch({ subscription: { id: 7, feed_id: 42, mode: 'simulate', status: 'active', killed: false } }, log),
		() => subscribeSignal.handler({ agent_id: '  agt_1  ', feed_id: 42 }),
	);
	const body = JSON.parse(log[0].init.body);
	assert.equal(log[0].init.method, 'POST');
	assert.equal(body.agent_id, 'agt_1');
	assert.equal(body.feed_id, 42);
	assert.equal(body.mode, 'simulate');
	assert.equal(body.billing, 'per_signal');
	assert.equal(body.firewall_level, 'block');
	assert.equal(body.copy_exits, true);
	for (const key of ['base_sol', 'size_scaling', 'max_per_trade_sol', 'slippage_bps']) {
		assert.ok(!(key in body), `${key} should be left to the server default`);
	}
	assert.equal(result.subscription.mode, 'simulate');
});

test('subscribe_signal passes live sizing through and rounds slippage to whole bps', async () => {
	const log = [];
	await withFetch(recordingFetch({ subscription: { id: 7 } }, log), () =>
		subscribeSignal.handler({
			agent_id: 'agt_1',
			feed_id: 42,
			mode: 'live',
			billing: 'per_epoch',
			base_sol: 0.05,
			size_scaling: 1.5,
			max_per_trade_sol: 0.25,
			slippage_bps: 300.4,
			firewall_level: 'warn',
			copy_exits: false,
		}),
	);
	const body = JSON.parse(log[0].init.body);
	assert.equal(body.mode, 'live');
	assert.equal(body.billing, 'per_epoch');
	assert.equal(body.base_sol, 0.05);
	assert.equal(body.size_scaling, 1.5);
	assert.equal(body.max_per_trade_sol, 0.25);
	assert.equal(body.slippage_bps, 300);
	assert.equal(body.firewall_level, 'warn');
	assert.equal(body.copy_exits, false);
});

test('set_subscription_status sends killed:true for the kill switch, status otherwise', async () => {
	const log = [];
	const killed = await withFetch(
		recordingFetch({ subscription: { id: 7, killed: true, status: 'paused' } }, log),
		() => setSubscriptionStatus.handler({ subscription_id: 7, state: 'killed' }),
	);
	assert.deepEqual(JSON.parse(log[0].init.body), { id: 7, killed: true });
	assert.equal(killed.state, 'killed');

	const log2 = [];
	const paused = await withFetch(
		recordingFetch({ subscription: { id: 7, killed: false, status: 'paused' } }, log2),
		() => setSubscriptionStatus.handler({ subscription_id: 7, state: 'paused' }),
	);
	assert.deepEqual(JSON.parse(log2.at(0).init.body), { id: 7, status: 'paused' });
	assert.equal(paused.state, 'paused');
});

// ── auth gating + error normalization ────────────────────────────────────────

// The keyless case lives in auth-gate.test.mjs: config.js snapshots the env at
// module load, and node --test gives each file its own process.
test('requireApiKey passes once a key is configured', () => {
	assert.doesNotThrow(() => requireApiKey());
});

test('an upstream error carries its code, status and message', async () => {
	await withFetch(
		recordingFetch({ error: 'not_found', message: 'feed not found' }, [], 404),
		async () => {
			await assert.rejects(
				() => apiRequest('/api/signals/subscribe', { method: 'POST', body: { id: 1 } }),
				(err) => err.code === 'upstream_error' && err.status === 404 && err.message === 'feed not found',
			);
		},
	);
});

test('a non-JSON error body still yields a typed error, not a parse crash', async () => {
	await withFetch(
		async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
		async () => {
			await assert.rejects(
				() => apiRequest('/api/signals/marketplace'),
				(err) => err.code === 'upstream_error' && err.status === 502 && /HTTP 502/.test(err.message),
			);
		},
	);
});

test('a transport failure is reported as network_error, not a raw fetch throw', async () => {
	await withFetch(
		async () => {
			throw new TypeError('connect ECONNREFUSED');
		},
		async () => {
			await assert.rejects(
				() => apiRequest('/api/signals/marketplace'),
				(err) => err.code === 'network_error' && /ECONNREFUSED/.test(err.message),
			);
		},
	);
});

test('an aborted request is reported as a timeout naming the budget', async () => {
	await withFetch(
		async () => {
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		},
		async () => {
			await assert.rejects(
				() => apiRequest('/api/signals/marketplace'),
				(err) => err.code === 'timeout' && /20000ms/.test(err.message),
			);
		},
	);
});
