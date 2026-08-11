// Handler behavior for @three-ws/copy-mcp: request shaping, the auth-exemption
// boundary, the update merge sequence, row shaping, and error normalization.
// Global fetch is stubbed for every test - nothing here touches the network.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/copy-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://copy.test';
process.env.THREE_WS_API_KEY = 'sk_test_copy_mcp';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: getEarnings } = await import('../src/tools/get-earnings.js');
const { def: createSubscription } = await import('../src/tools/create-subscription.js');
const { def: updateSubscription } = await import('../src/tools/update-subscription.js');
const { def: listSubscriptions } = await import('../src/tools/list-subscriptions.js');
const { shapeSubscription } = await import('../src/lib/shapes.js');
const { buildServer } = await import('../src/index.js');

const LEADER_ID = '8f3c1b2a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const SUB_ID = '11111111-2222-4333-8444-555555555555';
const WALLET = 'So11111111111111111111111111111111111111112';

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

// Answer each fetch in order from `responses`, recording every invocation.
function sequencedFetch(responses, log) {
	let i = 0;
	return async (url, init) => {
		log.push({ url: String(url), init });
		const r = responses[Math.min(i++, responses.length - 1)];
		return typeof r === 'function' ? r() : r;
	};
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

// A realistic copy_subscriptions row: Postgres numerics arrive as strings, and
// the create/update paths return the raw row with no joined leader or counts.
function subscriptionRow(overrides = {}) {
	return {
		id: SUB_ID,
		status: 'active',
		network: 'mainnet',
		leader_agent_id: LEADER_ID,
		copier_wallet: WALLET,
		sizing_rule: 'fixed',
		fixed_sol: '0.05',
		multiplier: '0.1',
		pct_balance: null,
		per_trade_cap_sol: '0.5',
		min_order_sol: '0.02',
		daily_budget_sol: '1',
		max_open_copies: 5,
		mcap_floor_usd: null,
		mcap_ceiling_usd: null,
		copy_sells: true,
		require_safety_pass: false,
		min_oracle_score: null,
		perf_fee_bps: 1000,
		high_water_mark_sol: '0',
		telegram_chat_id: null,
		created_at: '2026-08-01T00:00:00Z',
		updated_at: '2026-08-01T00:00:00Z',
		...overrides,
	};
}

// ── get_earnings: the auth-exemption boundary ─────────────────────────────

test('get_earnings with agent_id hits the public lane with NO authorization header', async () => {
	const log = [];
	const out = await withFetch(
		sequencedFetch([jsonResponse({ agent_id: LEADER_ID, network: 'mainnet', copiers: '3', accrued_fee_sol: '0.42', copier_profit_sol: '4.2' })], log),
		() => getEarnings.handler({ agent_id: LEADER_ID, network: 'mainnet' }),
	);
	assert.equal(log.length, 1);
	const url = new URL(log[0].url);
	assert.equal(url.pathname, '/api/copy/earnings');
	assert.equal(url.searchParams.get('agent_id'), LEADER_ID);
	assert.equal(url.searchParams.get('network'), 'mainnet');
	assert.equal(log[0].init.headers.authorization, undefined, 'public mode must not leak the bearer');
	assert.deepEqual(out, {
		ok: true,
		scope: 'leader',
		agent_id: LEADER_ID,
		network: 'mainnet',
		copiers: 3,
		accrued_fee_sol: 0.42,
		copier_profit_sol: 4.2,
	});
});

test('get_earnings without agent_id is account-scoped and sends the bearer', async () => {
	const log = [];
	const out = await withFetch(
		sequencedFetch([jsonResponse({ total_fee_owed_sol: '0.1', items: [{ subscription_id: SUB_ID }] })], log),
		() => getEarnings.handler({}),
	);
	assert.equal(log[0].init.headers.authorization, 'Bearer sk_test_copy_mcp');
	assert.equal(out.scope, 'mine');
	assert.equal(out.total_fee_owed_sol, 0.1);
	assert.equal(out.count, 1);
});

// ── create_subscription ───────────────────────────────────────────────────

test('create_subscription rejects fixed sizing without fixed_sol before any request', async () => {
	const log = [];
	await withFetch(sequencedFetch([jsonResponse({})], log), () =>
		assert.rejects(
			createSubscription.handler({ leader_agent_id: LEADER_ID, copier_wallet: WALLET }),
			(err) => {
				assert.equal(err.code, 'validation_error');
				assert.match(err.message, /fixed_sol/);
				return true;
			},
		),
	);
	assert.equal(log.length, 0, 'must fail client-side, no round trip');
});

test('create_subscription POSTs the follow and shapes the raw row (numeric strings become numbers)', async () => {
	const log = [];
	const out = await withFetch(
		sequencedFetch([jsonResponse({ subscription: subscriptionRow() })], log),
		() =>
			createSubscription.handler({
				leader_agent_id: LEADER_ID,
				copier_wallet: WALLET,
				sizing_rule: 'fixed',
				fixed_sol: 0.05,
			}),
	);
	assert.equal(log[0].init.method, 'POST');
	const body = JSON.parse(log[0].init.body);
	assert.equal(body.leader_agent_id, LEADER_ID);
	assert.equal(body.fixed_sol, 0.05);
	assert.equal(out.ok, true);
	assert.equal(out.subscription.sizing.fixed_sol, 0.05, 'Postgres numeric string coerced');
	assert.equal(out.subscription.guards.per_trade_cap_sol, 0.5);
	assert.equal(out.subscription.leader.name, null, 'create returns the raw row: no joined leader');
	assert.equal(out.subscription.pending_count, undefined, 'counts only exist on the list read');
});

// ── update_subscription: the three fetch sequences ────────────────────────

test('update_subscription with only an id throws no_changes and fetches nothing', async () => {
	const log = [];
	await withFetch(sequencedFetch([jsonResponse({})], log), () =>
		assert.rejects(updateSubscription.handler({ id: SUB_ID }), (err) => {
			assert.equal(err.code, 'no_changes');
			assert.equal(err.status, 400);
			return true;
		}),
	);
	assert.equal(log.length, 0);
});

test('update_subscription status-only is a single POST transition', async () => {
	const log = [];
	const out = await withFetch(
		sequencedFetch([jsonResponse({ subscription: subscriptionRow({ status: 'paused' }) })], log),
		() => updateSubscription.handler({ id: SUB_ID, status: 'paused' }),
	);
	assert.equal(log.length, 1);
	assert.deepEqual(JSON.parse(log[0].init.body), { id: SUB_ID, status: 'paused' });
	assert.equal(out.subscription.status, 'paused');
});

test('update_subscription config change on a paused follow: GET, merged upsert, then status restore', async () => {
	const log = [];
	const paused = subscriptionRow({ status: 'paused', mcap_floor_usd: '50000' });
	const out = await withFetch(
		sequencedFetch(
			[
				jsonResponse({ subscriptions: [paused] }),
				jsonResponse({ subscription: subscriptionRow({ status: 'active', daily_budget_sol: '2' }) }),
				jsonResponse({ subscription: subscriptionRow({ status: 'paused', daily_budget_sol: '2' }) }),
			],
			log,
		),
		() => updateSubscription.handler({ id: SUB_ID, daily_budget_sol: 2, mcap_floor_usd: null }),
	);
	assert.equal(log.length, 3, 'list + upsert + restore');
	assert.equal(log[0].init.method ?? 'GET', 'GET');
	const upsert = JSON.parse(log[1].init.body);
	assert.equal(upsert.daily_budget_sol, 2, 'passed field wins');
	assert.equal(upsert.mcap_floor_usd, null, 'explicit null clears the guard');
	assert.equal(upsert.copier_wallet, WALLET, 'unpassed fields carry over from the existing row');
	assert.deepEqual(JSON.parse(log[2].init.body), { id: SUB_ID, status: 'paused' }, 'guard edits never un-pause');
	assert.equal(out.subscription.status, 'paused');
	assert.equal(out.subscription.guards.daily_budget_sol, 2);
});

test('update_subscription throws not_found when the id is not in the account list', async () => {
	await withFetch(sequencedFetch([jsonResponse({ subscriptions: [] })], []), () =>
		assert.rejects(updateSubscription.handler({ id: SUB_ID, daily_budget_sol: 2 }), (err) => {
			assert.equal(err.code, 'not_found');
			assert.equal(err.status, 404);
			return true;
		}),
	);
});

// ── error normalization ───────────────────────────────────────────────────

test('upstream errors surface error_description, not the bare error code', async () => {
	await withFetch(
		sequencedFetch([jsonResponse({ error: 'unauthorized', error_description: 'sign in required' }, 401)], []),
		() =>
			assert.rejects(listSubscriptions.handler({}), (err) => {
				assert.equal(err.code, 'upstream_error');
				assert.equal(err.status, 401);
				assert.equal(err.message, 'sign in required', 'the human-readable message wins');
				return true;
			}),
	);
});

test('the registered MCP callback converts handler throws into an isError payload', async () => {
	const server = buildServer();
	const entry = server._registeredTools.list_subscriptions;
	assert.ok(entry, 'list_subscriptions must be registered');
	const result = await withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		() => entry.handler({}, {}),
	);
	assert.equal(result.isError, true);
	const payload = JSON.parse(result.content[0].text);
	assert.equal(payload.ok, false);
	assert.equal(payload.error, 'network_error');
});

// ── shapes ────────────────────────────────────────────────────────────────

test('shapeSubscription keeps list-only counts when present and coerces them', () => {
	const shaped = shapeSubscription(subscriptionRow({ pending_count: '2', acted_count: '7', leader_name: 'Ledger' }));
	assert.equal(shaped.pending_count, 2);
	assert.equal(shaped.acted_count, 7);
	assert.equal(shaped.leader.name, 'Ledger');
});
