/**
 * Trader MCP tools (api/_mcp/tools/trader.js), the four tools that close the
 * autonomous copy-trading loop: trader_leaderboard, trader_profile,
 * copy_subscribe, copy_status.
 *
 * The handlers themselves are the real shipped code. Only their leaf boundaries
 * are stubbed: the Neon client, the trader-stats aggregators, and the rate
 * limiter. That keeps the assertions on what actually reaches Postgres, which is
 * where this module's real defects lived:
 *
 *   - copy_subscribe read `cfg.telegramChatId` from a normalizer that returns
 *     `telegram_chat_id`, so the alert chat was dropped on create and WIPED on
 *     update.
 *   - copy_subscribe never denormalized leader_wallet, so /api/copy/settle-fee
 *     could never pay the leader's performance fee on an MCP-created row.
 *   - every query was wrapped in `.catch(() => [])`, so a DB outage answered
 *     "leader not found" / "no subscriptions" instead of saying it was down.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Rows each awaited `sql` template resolves to, in call order. */
let queued = [];
/** One entry per awaited query: { text, params }. */
let executed = [];
/** When set, the next awaited query rejects with this error. */
let queryError = null;

function queue(...rowSets) {
	queued.push(...rowSets);
}

vi.mock('../api/_lib/db.js', () => {
	const flatten = (strings, values) => {
		let text = '';
		const params = [];
		for (let i = 0; i < strings.length; i++) {
			text += strings[i];
			if (i < values.length) {
				params.push(values[i]);
				text += '$' + params.length;
			}
		}
		return { text: text.replace(/\s+/g, ' ').trim(), params };
	};

	const run = (strings, values) => {
		const { text, params } = flatten(strings, values);
		executed.push({ text, params });
		if (queryError) {
			const err = queryError;
			queryError = null;
			return Promise.reject(err);
		}
		if (!queued.length) throw new Error(`unexpected query: ${text}`);
		return Promise.resolve(queued.shift());
	};

	const sql = (strings, ...values) => ({
		then: (ok, no) => run(strings, values).then(ok, no),
		catch: (no) => run(strings, values).catch(no),
		finally: (fn) => run(strings, values).finally(fn),
	});

	// Mirrors the real classifier closely enough for these tests: a connection
	// level failure is "unavailable", a statement fault (undefined column,
	// constraint violation) is a genuine bug that must keep propagating.
	const isDbUnavailableError = (err) =>
		/Error connecting to database|fetch failed|ECONNRESET|Missing required env var: DATABASE_URL/i.test(
			String(err?.message || ''),
		);

	return { sql, isDbUnavailableError, isDbCapacityError: () => false };
});

const getLeaderboard = vi.fn();
const getTraderStats = vi.fn();
vi.mock('../api/_lib/trader-stats.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		getLeaderboard: (...a) => getLeaderboard(...a),
		getTraderStats: (...a) => getTraderStats(...a),
	};
});

const mcpIp = vi.fn(async () => ({ success: true, limit: 600, remaining: 599, reset: 0 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.7',
	limits: { mcpIp: (...a) => mcpIp(...a) },
}));

const { toolDefs } = await import('../api/_mcp/tools/trader.js');
const TOOLS = Object.fromEntries(toolDefs.map((t) => [t.name, t]));

const ANON = { userId: null, rateKey: 'ip:203.0.113.7', scope: '', source: 'free' };
const USER = { userId: 'u-1111-2222', rateKey: 'user:u-1111-2222', scope: 'agents:read agents:write', source: 'oauth' };
const LEADER_ID = '11111111-2222-4333-8444-555555555555';
const LEADER_WALLET = 'So11111111111111111111111111111111111111112';
const COPIER_WALLET = '3XmnvxYtNvbYYDkVfsMbrJyVJUxCFyAMBjsqFYPRZUFn';

/** Parse the JSON payload an MCP ok-result carries. */
function payloadOf(result) {
	expect(result.isError).toBeFalsy();
	return result.structuredContent;
}

function textOf(result) {
	return result.content[0].text;
}

function boardRow(over = {}) {
	return {
		rank: 1,
		agent_id: LEADER_ID,
		agent_name: 'Sniper One',
		image: null,
		score: 82,
		verified: true,
		closed: 30,
		open_positions: 2,
		wins: 21,
		losses: 9,
		win_rate: 70,
		realized_pnl_sol: 12.5,
		realized_pnl_usd: 2500,
		roi_pct: 41.2,
		profit_factor: 2.1,
		max_drawdown_pct: 18,
		copiers: 4,
		last_active_at: '2026-08-10T00:00:00.000Z',
		...over,
	};
}

beforeEach(() => {
	queued = [];
	executed = [];
	queryError = null;
	getLeaderboard.mockReset();
	getTraderStats.mockReset();
	mcpIp.mockClear();
	mcpIp.mockResolvedValue({ success: true, limit: 600, remaining: 599, reset: 0 });
});

describe('tool surface', () => {
	it('exports the four trader tools with handlers and input schemas', () => {
		expect(Object.keys(TOOLS).sort()).toEqual(
			['copy_status', 'copy_subscribe', 'trader_leaderboard', 'trader_profile'],
		);
		for (const t of toolDefs) {
			expect(typeof t.handler).toBe('function');
			expect(t.inputSchema.type).toBe('object');
			expect(t.inputSchema.additionalProperties).toBe(false);
			expect(t.description.length).toBeGreaterThan(40);
		}
	});

	it('gates the write tool on agents:write and the private read on agents:read', () => {
		expect(TOOLS.copy_subscribe.scope).toBe('agents:write');
		expect(TOOLS.copy_status.scope).toBe('agents:read');
		expect(TOOLS.trader_leaderboard.scope).toBeUndefined();
		expect(TOOLS.trader_profile.scope).toBeUndefined();
		expect(TOOLS.copy_subscribe.annotations.readOnlyHint).toBe(false);
		expect(TOOLS.copy_status.annotations.readOnlyHint).toBe(true);
	});
});

describe('trader_leaderboard', () => {
	it('shapes real rows, ranks them, and counts copy candidates', async () => {
		getLeaderboard.mockResolvedValue({
			network: 'mainnet',
			window: '30d',
			sort: 'score',
			sol_usd: 200,
			leaderboard: [
				boardRow(),
				boardRow({ rank: 2, agent_id: 'aaaa', agent_name: 'Rookie', score: 41, verified: false, win_rate: 30, closed: 3 }),
			],
		});

		const out = payloadOf(await TOOLS.trader_leaderboard.handler({ limit: 5 }, ANON));

		expect(out.count).toBe(2);
		expect(out.copy_candidates).toBe(1);
		expect(out.traders[0].recommendation).toBe('copy');
		expect(out.traders[1].recommendation).toBe('skip');
		expect(out.traders[0].profile_url).toBe(`https://three.ws/trader/${LEADER_ID}`);
		expect(out.traders[0].win_rate_pct).toBe(70);
		expect(out.hint).toContain('Sniper One');
		expect(getLeaderboard).toHaveBeenCalledWith({
			network: 'mainnet', window: '30d', sort: 'score', limit: 5, verifiedOnly: false,
		});
	});

	it('clamps a non-finite limit instead of passing NaN into slice()', async () => {
		getLeaderboard.mockResolvedValue({ sol_usd: null, leaderboard: [] });
		await TOOLS.trader_leaderboard.handler({ limit: 'many' }, ANON);
		expect(getLeaderboard.mock.calls[0][0].limit).toBe(10);
	});

	it('falls back to defaults for unknown window / sort / network', async () => {
		getLeaderboard.mockResolvedValue({ sol_usd: null, leaderboard: [] });
		await TOOLS.trader_leaderboard.handler({ window: '99y', sort: 'vibes', network: 'testnet' }, ANON);
		expect(getLeaderboard.mock.calls[0][0]).toMatchObject({ window: '30d', sort: 'score', network: 'mainnet' });
	});

	it('reports a DB outage as temporarily unavailable', async () => {
		getLeaderboard.mockRejectedValue(new Error('Error connecting to database: fetch failed'));
		const res = await TOOLS.trader_leaderboard.handler({}, ANON);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/temporarily unavailable/i);
	});

	it('propagates a real SQL fault to the MCP dispatcher rather than swallowing it', async () => {
		const bug = new Error('column "nope" does not exist');
		bug.code = '42703';
		getLeaderboard.mockRejectedValue(bug);
		await expect(TOOLS.trader_leaderboard.handler({}, ANON)).rejects.toThrow('column "nope" does not exist');
	});

	it('refuses when the caller is over the MCP rate limit', async () => {
		mcpIp.mockResolvedValue({ success: false, limit: 600, remaining: 0, reset: 0 });
		const res = await TOOLS.trader_leaderboard.handler({}, ANON);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/rate limit/i);
		expect(getLeaderboard).not.toHaveBeenCalled();
	});
});

describe('trader_profile', () => {
	const stats = {
		agent: { id: LEADER_ID, name: 'Sniper One', image: null, is_public: true, copiers: 4 },
		sol_usd: 200,
		metrics: {
			score: 82, verified: true, closed_count: 30, open_count: 1, wins: 21, losses: 9,
			win_rate: 70, realized_pnl_sol: 12.5, realized_pnl_usd: 2500, roi_pct: 41.2,
			profit_factor: 2.1, avg_pnl_pct: 8, best_pnl_pct: 120, max_drawdown_pct: 18,
			avg_hold_seconds: 420, unique_coins: 14,
		},
		closed: [
			{ symbol: 'THREE', mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', realized_pnl_pct: 42, realized_pnl_sol: 1.2, hold_seconds: 300, exit_reason: 'take_profit', closed_at: '2026-08-10T00:00:00.000Z', sell_solscan: 'https://solscan.io/tx/sell1', buy_solscan: 'https://solscan.io/tx/buy1' },
			{ symbol: 'THREE', mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', realized_pnl_pct: -12, realized_pnl_sol: -0.3, hold_seconds: 120, exit_reason: 'stop_loss', closed_at: '2026-08-09T00:00:00.000Z', sell_solscan: null, buy_solscan: 'https://solscan.io/tx/buy2' },
		],
		open: [
			{ id: 'p-1', symbol: 'THREE', mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', entry_sol: 0.5, current_sol: 0.8, unrealized_pct: 60, opened_at: '2026-08-11T00:00:00.000Z', buy_url: 'https://solscan.io/tx/buy3' },
		],
		oracle: null,
	};

	it('returns metrics, proof-linked recent trades, and the open positions it advertises', async () => {
		getTraderStats.mockResolvedValue(stats);
		const out = payloadOf(await TOOLS.trader_profile.handler({ agent_id: LEADER_ID }, ANON));

		expect(out.score).toBe(82);
		expect(out.recommendation).toBe('copy');
		expect(out.metrics.win_rate_pct).toBe(70);
		expect(out.recent_trades).toHaveLength(2);
		expect(out.recent_trades[0]).toMatchObject({ outcome: 'win', proof_url: 'https://solscan.io/tx/sell1' });
		expect(out.recent_trades[1]).toMatchObject({ outcome: 'loss', proof_url: 'https://solscan.io/tx/buy2' });
		expect(out.open_positions).toEqual([
			{
				symbol: 'THREE',
				mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
				entry_sol: 0.5,
				current_sol: 0.8,
				unrealized_pct: 60,
				opened_at: '2026-08-11T00:00:00.000Z',
				proof_url: 'https://solscan.io/tx/buy3',
			},
		]);
	});

	it('rejects a non-UUID agent_id before touching the aggregator', async () => {
		const res = await TOOLS.trader_profile.handler({ agent_id: 'sniper-one' }, ANON);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/must be a UUID/i);
		expect(getTraderStats).not.toHaveBeenCalled();
	});

	it('distinguishes an unknown agent from a private one', async () => {
		getTraderStats.mockResolvedValueOnce(null);
		const missing = await TOOLS.trader_profile.handler({ agent_id: LEADER_ID }, ANON);
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toMatch(/not found/i);

		getTraderStats.mockResolvedValueOnce({ ...stats, agent: { ...stats.agent, is_public: false } });
		const private_ = await TOOLS.trader_profile.handler({ agent_id: LEADER_ID }, ANON);
		expect(private_.isError).toBe(true);
		expect(textOf(private_)).toMatch(/not public/i);
	});

	it('reports a DB outage as temporarily unavailable, not as a missing agent', async () => {
		getTraderStats.mockRejectedValue(new Error('Error connecting to database: fetch failed'));
		const res = await TOOLS.trader_profile.handler({ agent_id: LEADER_ID }, ANON);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/temporarily unavailable/i);
		expect(textOf(res)).not.toMatch(/not found/i);
	});
});

describe('copy_subscribe', () => {
	const goodArgs = {
		leader_agent_id: LEADER_ID,
		copier_wallet: COPIER_WALLET,
		sizing_rule: 'fixed',
		fixed_sol: 0.02,
		per_trade_cap_sol: 0.05,
		daily_budget_sol: 0.5,
		telegram_chat_id: '-1002233445566',
	};

	function queueHappyPath({ inserted = true } = {}) {
		queue(
			[{ id: LEADER_ID, name: 'Sniper One', is_public: true }],
			[{ wallet: LEADER_WALLET }],
			[{ id: 'sub-1', status: 'active', created_at: 'now', updated_at: 'now', inserted }],
		);
	}

	it('requires a signed-in principal', async () => {
		const res = await TOOLS.copy_subscribe.handler(goodArgs, ANON);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/sign in/i);
		expect(executed).toHaveLength(0);
	});

	it('rejects a non-UUID leader and a non-base58 wallet before any query', async () => {
		const badLeader = await TOOLS.copy_subscribe.handler({ ...goodArgs, leader_agent_id: 'top-guy' }, USER);
		expect(badLeader.isError).toBe(true);
		expect(textOf(badLeader)).toMatch(/leader_agent_id/);

		const badWallet = await TOOLS.copy_subscribe.handler({ ...goodArgs, copier_wallet: '0xdeadbeef' }, USER);
		expect(badWallet.isError).toBe(true);
		expect(textOf(badWallet)).toMatch(/copier_wallet/);

		expect(executed).toHaveLength(0);
	});

	it('persists telegram_chat_id and the denormalized leader_wallet', async () => {
		queueHappyPath();
		const out = payloadOf(await TOOLS.copy_subscribe.handler(goodArgs, USER));

		expect(out.action).toBe('created');
		expect(out.subscription_id).toBe('sub-1');
		expect(out.leader_name).toBe('Sniper One');

		const upsert = executed.at(-1);
		expect(upsert.text).toMatch(/insert into copy_subscriptions/i);
		expect(upsert.text).toMatch(/on conflict \(copier_user_id, leader_agent_id, network\) do update/i);
		// The alert chat used to be read off a camelCase key the normalizer never
		// sets, so it reached Postgres as null on create and erased the stored
		// value on update.
		expect(upsert.params).toContain('-1002233445566');
		// Without this the leader can never be paid their performance fee.
		expect(upsert.params).toContain(LEADER_WALLET);
		expect(upsert.params).toContain(USER.userId);
		expect(upsert.params).toContain(COPIER_WALLET);
	});

	it('reports an update when the upsert hit the existing row', async () => {
		queueHappyPath({ inserted: false });
		const out = payloadOf(await TOOLS.copy_subscribe.handler(goodArgs, USER));
		expect(out.action).toBe('updated');
		expect(out.message).toMatch(/updated/);
	});

	it('keeps a previously recorded leader_wallet when the leader has no position yet', async () => {
		queue(
			[{ id: LEADER_ID, name: 'Sniper One', is_public: true }],
			[],
			[{ id: 'sub-1', status: 'active', created_at: 'now', updated_at: 'now', inserted: false }],
		);
		payloadOf(await TOOLS.copy_subscribe.handler(goodArgs, USER));
		const upsert = executed.at(-1);
		expect(upsert.text).toMatch(/leader_wallet = coalesce\(excluded\.leader_wallet, copy_subscriptions\.leader_wallet\)/i);
	});

	it('refuses a leader that does not exist or is not public', async () => {
		queue([]);
		const missing = await TOOLS.copy_subscribe.handler(goodArgs, USER);
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toMatch(/not found/i);

		queue([{ id: LEADER_ID, name: 'Hidden', is_public: false }]);
		const hidden = await TOOLS.copy_subscribe.handler(goodArgs, USER);
		expect(hidden.isError).toBe(true);
		expect(textOf(hidden)).toMatch(/not public/i);
	});

	it('rejects unsafe sizing before writing anything', async () => {
		queue([{ id: LEADER_ID, name: 'Sniper One', is_public: true }]);
		const res = await TOOLS.copy_subscribe.handler({ ...goodArgs, per_trade_cap_sol: 0 }, USER);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/per_trade_cap_sol must be greater than 0/);
		expect(executed).toHaveLength(1);
	});

	it('reports a DB outage instead of claiming the leader does not exist', async () => {
		queryError = new Error('Error connecting to database: fetch failed');
		const res = await TOOLS.copy_subscribe.handler(goodArgs, USER);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/temporarily unavailable/i);
		expect(textOf(res)).not.toMatch(/not found/i);
	});
});

describe('copy_status', () => {
	it('requires a signed-in principal', async () => {
		const res = await TOOLS.copy_status.handler({}, ANON);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/sign in/i);
		expect(executed).toHaveLength(0);
	});

	it('separates active from paused rows and totals the pending intents', async () => {
		queue([
			{
				id: 'sub-1', leader_agent_id: LEADER_ID, status: 'active', network: 'mainnet',
				copier_wallet: COPIER_WALLET, sizing_rule: 'fixed', fixed_sol: '0.02', multiplier: null,
				pct_balance: null, per_trade_cap_sol: '0.05', daily_budget_sol: '0.5', max_open_copies: 5,
				min_oracle_score: 70, perf_fee_bps: 1000, created_at: 'now', updated_at: 'now',
				leader_name: 'Sniper One', leader_image: null, pending_count: 2, acted_count: 7,
			},
			{
				id: 'sub-2', leader_agent_id: LEADER_ID, status: 'paused', network: 'mainnet',
				copier_wallet: COPIER_WALLET, sizing_rule: 'multiplier', fixed_sol: null, multiplier: '0.5',
				pct_balance: null, per_trade_cap_sol: '0.1', daily_budget_sol: '1', max_open_copies: 3,
				min_oracle_score: null, perf_fee_bps: 500, created_at: 'now', updated_at: 'now',
				leader_name: 'Sniper Two', leader_image: null, pending_count: 0, acted_count: 1,
			},
		]);

		const out = payloadOf(await TOOLS.copy_status.handler({}, USER));

		expect(out.count).toBe(2);
		expect(out.active_count).toBe(1);
		expect(out.paused_count).toBe(1);
		expect(out.pending_total).toBe(2);
		expect(out.acted_total).toBe(8);
		expect(out.hint).toContain('1 active subscription');
		expect(out.hint).toContain('1 paused');
		expect(out.subscriptions[0].fixed_sol).toBe(0.02);
		expect(out.subscriptions[1].multiplier).toBe(0.5);
		expect(out.subscriptions[0].profile_url).toBe(`https://three.ws/trader/${LEADER_ID}`);
		expect(executed[0].params).toContain(USER.userId);
	});

	it('points a new copier at the discovery path when they have no subscriptions', async () => {
		queue([]);
		const out = payloadOf(await TOOLS.copy_status.handler({}, USER));
		expect(out.count).toBe(0);
		expect(out.hint).toMatch(/trader_leaderboard/);
	});

	it('reports a DB outage instead of an empty subscription list', async () => {
		queryError = new Error('Error connecting to database: fetch failed');
		const res = await TOOLS.copy_status.handler({}, USER);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toMatch(/temporarily unavailable/i);
	});
});
