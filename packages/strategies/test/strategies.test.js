import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStrategies, ThreeWsError, StrategyError, PaymentRequiredError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

// Synthetic identifiers only — never a real third-party mint or trader address.
const AGENT = '11111111-1111-4111-8111-111111111111';
const DELEGATION = '22222222-2222-4222-8222-222222222222';
const LEADER = '33333333-3333-4333-8333-333333333333';
const STRATEGY = '44444444-4444-4444-8444-444444444444';
const EXEC = '55555555-5555-4555-8555-555555555555';
const SOL_WALLET = 'THREEsynthetic1111111111111111111111111111';
const TOKEN_IN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TOKEN_OUT = '0x0000000000000000000000000000000000000000';

test('dca() maps interval→period_seconds, shapes the created strategy', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: { ok: true, id: 'dca1', status: 'active', next_execution_at: '2026-06-24T00:00:00Z', created_at: '2026-06-23T00:00:00Z' } },
	]);
	const sx = createStrategies({ fetch, baseUrl: 'https://three.ws' });
	const res = await sx.dca({
		agentId: AGENT,
		delegationId: DELEGATION,
		tokenIn: TOKEN_IN,
		tokenOut: TOKEN_OUT,
		tokenOutSymbol: 'THREE',
		amountPerExecution: '1000000000000000000',
		interval: 'weekly',
	});

	assert.equal(calls[0].url.pathname, '/api/dca-strategies');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.period_seconds, 604800, 'weekly → 604800');
	assert.equal(sent.slippage_bps, 50, 'default slippage applied');
	assert.equal(sent.token_out_symbol, 'THREE');
	assert.ok(!('chain_id' in sent), 'unset optional pruned from body');
	assert.equal(res.id, 'dca1');
	assert.equal(res.status, 'active');
	assert.equal(res.nextExecutionAt, '2026-06-24T00:00:00Z');
});

test('dca() rejects a bad interval before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const sx = createStrategies({ fetch });
	await assert.rejects(
		() => sx.dca({ agentId: AGENT, delegationId: DELEGATION, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, tokenOutSymbol: 'THREE', amountPerExecution: '1', interval: 'hourly' }),
		(e) => { assert.ok(e instanceof ThreeWsError); assert.equal(e.code, 'invalid_input'); return /Invalid interval/.test(e.message); },
	);
	assert.equal(calls.length, 0, 'no request was made');
});

test('dca() rejects a non-hex tokenIn before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const sx = createStrategies({ fetch });
	await assert.rejects(
		() => sx.dca({ agentId: AGENT, delegationId: DELEGATION, tokenIn: 'not-an-address', tokenOut: TOKEN_OUT, tokenOutSymbol: 'THREE', amountPerExecution: '1', interval: 'daily' }),
		/tokenIn must be a 0x-prefixed/,
	);
	assert.equal(calls.length, 0);
});

test('listDca() passes agent_id as a query param and shapes rows', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { ok: true, data: [{ id: 'd1', status: 'active', token_out_symbol: 'THREE', last_execution: { tx_hash: 'sig', status: 'success' } }] } },
	]);
	const sx = createStrategies({ fetch });
	const rows = await sx.listDca(AGENT);
	assert.equal(calls[0].url.pathname, '/api/dca-strategies');
	assert.equal(calls[0].url.searchParams.get('agent_id'), AGENT);
	assert.equal(rows[0].tokenOutSymbol, 'THREE');
	assert.equal(rows[0].lastExecution.tx_hash, 'sig');
});

test('copy() posts the leader + sizing rules and shapes the subscription', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { subscription: { id: 'sub1', status: 'active', leader_agent_id: LEADER, copier_wallet: SOL_WALLET, sizing_rule: 'fixed', fixed_sol: 0.25, per_trade_cap_sol: 0.5, daily_budget_sol: 2 } } },
	]);
	const sx = createStrategies({ fetch });
	const sub = await sx.copy(LEADER, { copierWallet: SOL_WALLET, fixedSol: 0.25, perTradeCapSol: 0.5, dailyBudgetSol: 2 });

	assert.equal(calls[0].url.pathname, '/api/copy/subscriptions');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.leader_agent_id, LEADER);
	assert.equal(sent.copier_wallet, SOL_WALLET);
	assert.equal(sent.sizing_rule, 'fixed', 'default sizing rule');
	assert.equal(sent.network, 'mainnet', 'default network');
	assert.equal(sent.per_trade_cap_sol, 0.5);
	assert.equal(sub.perTradeCapSol, 0.5);
	assert.equal(sub.sizingRule, 'fixed');
});

test('copy() rejects a non-base58 copierWallet before network', async () => {
	const { fetch, calls } = stubFetch([]);
	const sx = createStrategies({ fetch });
	await assert.rejects(
		() => sx.copy(LEADER, { copierWallet: '0xnotsolana', perTradeCapSol: 1, dailyBudgetSol: 1 }),
		(e) => { assert.equal(e.code, 'invalid_input'); return /copierWallet/.test(e.message); },
	);
	assert.equal(calls.length, 0);
});

test('copyExecutions() defaults to no status filter and shapes the inbox', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { executions: [{ id: 'e1', status: 'pending', direction: 'buy', mint: 'THREEsynthetic1111111111111111111111111111', order_sol: 0.1, reason: 'sized' }] } },
	]);
	const sx = createStrategies({ fetch });
	const { executions } = await sx.copyExecutions({ status: 'pending' });
	assert.equal(calls[0].url.pathname, '/api/copy/executions');
	assert.equal(calls[0].url.searchParams.get('status'), 'pending');
	assert.equal(executions[0].orderSol, 0.1);
	assert.equal(executions[0].direction, 'buy');
});

test('mirror() targets /api/agents/:id/mirror with the follow rules', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { follow: { id: 7, leader_agent_id: LEADER, sizing_mode: 'proportional', proportion_pct: 50, max_per_trade_sol: 0.3, mint_allowlist: [], mint_denylist: [] } } } },
	]);
	const sx = createStrategies({ fetch });
	const follow = await sx.mirror(AGENT, LEADER, { sizingMode: 'proportional', proportionPct: 50, maxPerTradeSol: 0.3, dailyBudgetSol: 1.5 });

	assert.equal(calls[0].url.pathname, `/api/agents/${AGENT}/mirror`);
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.leader_agent_id, LEADER);
	assert.equal(sent.sizing_mode, 'proportional');
	assert.equal(sent.proportion_pct, 50);
	assert.equal(follow.sizingMode, 'proportional');
	assert.equal(follow.proportionPct, 50);
});

test('killSwitch() posts { killed } to /mirror/kill', async () => {
	const { fetch, calls } = stubFetch([{ body: { data: { killed: true } } }]);
	const sx = createStrategies({ fetch });
	const r = await sx.killSwitch(AGENT, true);
	assert.equal(calls[0].url.pathname, `/api/agents/${AGENT}/mirror/kill`);
	assert.equal(JSON.parse(calls[0].init.body).killed, true);
	assert.equal(r.killed, true);
});

test('sweep() and unmirror() hit the run-now and unfollow endpoints', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { synced: [{ leader_agent_id: LEADER, planned_sol: 0.2 }] } } },
		{ body: { data: { removed: true } } },
	]);
	const sx = createStrategies({ fetch });

	const swept = await sx.sweep(AGENT);
	assert.equal(calls[0].url.pathname, `/api/agents/${AGENT}/mirror/sync`);
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(swept.synced.length, 1);

	const removed = await sx.unmirror(AGENT, LEADER);
	assert.equal(calls[1].url.pathname, `/api/agents/${AGENT}/mirror/unfollow`);
	assert.equal(JSON.parse(calls[1].init.body).leader_agent_id, LEADER);
	assert.equal(removed.removed, true);
});

test('equipped() reads live mirror state and shapes follows + fills', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				data: {
					is_owner: true,
					killed: false,
					following_count: 1,
					followers_count: 4,
					active_followers: 2,
					following: [{ id: 7, leader_agent_id: LEADER, sizing_mode: 'fixed', fixed_sol: 0.1, enabled: true }],
					// A leashed SKIP is a designed state, not a failure; it must survive shaping.
					recent: [
						{ id: 'f1', side: 'buy', leader_sol: 1, planned_sol: 0.1, status: 'skipped', skip_reason: 'daily_budget', skip_label: 'Daily budget spent' },
					],
				},
			},
		},
	]);
	const sx = createStrategies({ fetch });
	const state = await sx.equipped(AGENT);

	assert.equal(calls[0].url.pathname, `/api/agents/${AGENT}/mirror`);
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(state.isOwner, true);
	assert.equal(state.killed, false);
	assert.equal(state.followingCount, 1);
	assert.equal(state.followersCount, 4);
	assert.equal(state.activeFollowers, 2);
	assert.equal(state.following[0].fixedSol, 0.1);
	assert.equal(state.recent[0].skipReason, 'daily_budget');
	assert.equal(state.recent[0].skipLabel, 'Daily budget spent');
});

test('leaderboard() ranks proven strategies and keeps unproven ones honest', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				data: {
					count: 2,
					leaders: [
						{ id: STRATEGY, name: 'Proven', rank: 1, performance: { proven: true, trades: 12, open: 1, wins: 8, losses: 4, pnl_sol: '1.25', roi_pct: '18.4', win_rate: '66.7' } },
						{ id: '66666666-6666-4666-8666-666666666666', name: 'Untested', rank: 2, performance: { proven: false, trades: 0, open: 0 } },
					],
				},
			},
		},
	]);
	const sx = createStrategies({ fetch });
	const board = await sx.leaderboard({ limit: 10 });

	assert.equal(calls[0].url.pathname, '/api/strategies/leaderboard');
	assert.equal(calls[0].url.searchParams.get('limit'), '10');
	assert.equal(board.count, 2);
	assert.equal(board.leaders[0].performance.proven, true);
	assert.equal(board.leaders[0].performance.pnlSol, 1.25);
	assert.equal(board.leaders[0].performance.roiPct, 18.4);
	assert.equal(board.leaders[1].performance.proven, false);
	assert.equal(board.leaders[1].performance.pnlSol, null);
});

test('deleteStrategy() soft-deletes and validates the id first', async () => {
	const { fetch, calls } = stubFetch([{ body: { data: { deleted: true } } }]);
	const sx = createStrategies({ fetch });
	const r = await sx.deleteStrategy(STRATEGY);
	assert.equal(calls[0].url.pathname, `/api/strategies/${STRATEGY}`);
	assert.equal(calls[0].init.method, 'DELETE');
	assert.equal(r.deleted, true);
	await assert.rejects(() => sx.deleteStrategy('not-a-uuid'), (e) => e instanceof StrategyError && e.code === 'invalid_input');
});

test('createStrategy() validates name and shapes performance', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: { data: { id: STRATEGY, name: 'Fresh-launch momentum', published: false, version: 1, performance: { proven: false, trades: 0, open: 0 } } } },
	]);
	const sx = createStrategies({ fetch });
	const s = await sx.createStrategy({ name: 'Fresh-launch momentum', config: { sizing: { amount_sol: 0.1 } } });
	assert.equal(calls[0].url.pathname, '/api/strategies');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(s.id, STRATEGY);
	assert.equal(s.performance.proven, false);
	assert.equal(s.performance.trades, 0);
});

test('createStrategy() rejects an empty name before network', async () => {
	const { fetch, calls } = stubFetch([]);
	const sx = createStrategies({ fetch });
	await assert.rejects(() => sx.createStrategy({ name: '   ' }), /name is required/);
	assert.equal(calls.length, 0);
});

test('listStrategies() validates scope/sort enums and shapes the list', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { data: { scope: 'published', sort: 'performance', strategies: [{ id: STRATEGY, name: 'x', performance: { proven: true, trades: 3, open: 1, roi_pct: 42.5 } }] } } },
	]);
	const sx = createStrategies({ fetch });
	const res = await sx.listStrategies({ scope: 'published', sort: 'performance', limit: 10 });
	assert.equal(calls[0].url.searchParams.get('scope'), 'published');
	assert.equal(calls[0].url.searchParams.get('sort'), 'performance');
	assert.equal(calls[0].url.searchParams.get('limit'), '10');
	assert.equal(res.strategies[0].performance.roiPct, 42.5);

	await assert.rejects(() => sx.listStrategies({ sort: 'magic' }), /Invalid sort/);
});

test('csrfToken is attached as x-csrf-token on writes', async () => {
	const { fetch, calls } = stubFetch([{ status: 201, body: { data: { id: STRATEGY, name: 'n' } } }]);
	const sx = createStrategies({ fetch, csrfToken: 'csrf-abc' });
	await sx.createStrategy({ name: 'n' });
	assert.equal(calls[0].init.headers['x-csrf-token'], 'csrf-abc');
});

test('token is attached as a bearer Authorization header', async () => {
	const { fetch, calls } = stubFetch([{ body: { subscriptions: [] } }]);
	const sx = createStrategies({ fetch, token: 'sk_test_123' });
	await sx.listSubscriptions();
	assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test_123');
});

test('validation_error (400) surfaces as a typed StrategyError', async () => {
	const { fetch } = stubFetch([{ status: 400, body: { error: 'validation_error', message: 'strategy rules are invalid', errors: ['sizing.amount_sol'] } }]);
	const sx = createStrategies({ fetch });
	await assert.rejects(() => sx.createStrategy({ name: 'bad', config: {} }), (e) => {
		assert.ok(e instanceof StrategyError);
		assert.ok(e instanceof ThreeWsError, 'StrategyError is a ThreeWsError');
		assert.equal(e.code, 'validation_error');
		assert.equal(e.status, 400);
		assert.deepEqual(e.body.errors, ['sizing.amount_sol']);
		return true;
	});
});

test('402 surfaces as PaymentRequiredError carrying the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'eip155:8453', maxAmountRequired: '150000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay', accepts } }]);
	const sx = createStrategies({ fetch });
	await assert.rejects(() => sx.leaderboard(), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});

test('actCopy() posts acted with an optional tx signature', async () => {
	const { fetch, calls } = stubFetch([{ body: { execution: { id: EXEC, status: 'acted', tx_signature: 'sig123' } } }]);
	const sx = createStrategies({ fetch });
	const r = await sx.actCopy(EXEC, 'sig123');
	assert.equal(calls[0].url.pathname, '/api/copy/executions');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.action, 'acted');
	assert.equal(sent.tx_signature, 'sig123');
	assert.equal(r.status, 'acted');
});
