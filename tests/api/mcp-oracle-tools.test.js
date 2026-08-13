// Oracle MCP tools (api/_mcp/tools/oracle.js), registered in api/_mcp/catalog.js.
//
// Verifies: the two public read tools shape a conviction verdict into an
// agent-ready recommendation keyed off the tier; a degraded feed/intel store is
// reported as transient rather than as an empty market (the failure that used
// to coach agents into lowering their conviction floor during an outage); an
// unknown coin is distinguished from an outage; and the two account-scoped
// watch tools refuse an anonymous caller, refuse an agent the caller does not
// own, and clamp every numeric watch setting into its advertised range before
// persisting. The oracle store, rate limiter, and DB are mocked at their module
// boundary; the tool defs and their validation run real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = {
	readFeed: vi.fn(),
	scoreCoin: vi.fn(),
	getWatch: vi.fn(),
	upsertWatch: vi.fn(),
	recentActions: vi.fn(),
	actionsSummary: vi.fn(),
};
vi.mock('../../api/_lib/oracle/store.js', () => ({
	readFeed: (...a) => store.readFeed(...a),
	scoreCoin: (...a) => store.scoreCoin(...a),
	getWatch: (...a) => store.getWatch(...a),
	upsertWatch: (...a) => store.upsertWatch(...a),
	recentActions: (...a) => store.recentActions(...a),
	actionsSummary: (...a) => store.actionsSummary(...a),
}));

let ownedAgentIds = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (_strings, ...values) =>
		ownedAgentIds.includes(values[0]) ? [{ id: values[0] }] : [],
	),
}));

let rlOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: vi.fn(async () => ({ success: rlOk, reset: Date.now() + 60_000 })) },
}));

const { toolDefs } = await import('../../api/_mcp/tools/oracle.js');

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const ANON = { userId: null, rateKey: 'oracle-test', scope: '', source: 'free' };
const OWNER = { userId: 'user-1', rateKey: 'oracle-owner', scope: 'agents:read agents:write', source: 'oauth' };

const call = (name, args, auth = ANON) =>
	toolDefs.find((t) => t.name === name).handler(args, auth, {});

beforeEach(() => {
	for (const fn of Object.values(store)) fn.mockReset();
	ownedAgentIds = [AGENT_ID];
	rlOk = true;
});

describe('oracle MCP tools: registration', () => {
	it('registers four tools and scopes only the account-bound ones', () => {
		const byName = Object.fromEntries(toolDefs.map((t) => [t.name, t]));
		expect(Object.keys(byName)).toEqual([
			'oracle_top_plays',
			'oracle_coin',
			'oracle_arm_watch',
			'oracle_watch_status',
		]);
		expect(byName.oracle_top_plays.scope).toBeUndefined();
		expect(byName.oracle_coin.scope).toBeUndefined();
		expect(byName.oracle_arm_watch.scope).toBe('agents:write');
		expect(byName.oracle_watch_status.scope).toBe('agents:read');
		// oracle_arm_watch can spend real SOL once armed, so its destructive hint
		// must be explicit rather than left to the spec default.
		expect(byName.oracle_arm_watch.annotations.destructiveHint).toBe(false);
		expect(byName.oracle_arm_watch.inputSchema.properties.mode.default).toBe('simulate');
	});
});

describe('oracle_top_plays', () => {
	it('returns ranked plays with a tier-derived recommendation', async () => {
		store.readFeed.mockResolvedValue([
			{
				mint: MINT, symbol: 'THREE', score: 91, tier: 'prime', category: 'ai',
				smart_wallet_count: 4, pillars: { pedigree: 88 }, badges: ['smart_money_early'],
				scored_at: '2026-08-13T00:00:00.000Z',
			},
			{ mint: 'Mint2', symbol: 'TWO', score: 74, tier: 'strong', pillars: {}, scored_at: null },
		]);

		const r = await call('oracle_top_plays', { limit: 5, min_score: 72, network: 'mainnet' });
		expect(r.isError).toBeUndefined();
		expect(store.readFeed).toHaveBeenCalledWith({
			network: 'mainnet', limit: 5, minScore: 72, category: null, sinceSeconds: 6 * 3600,
		});
		expect(r.structuredContent.count).toBe(2);
		expect(r.structuredContent.top.recommendation).toEqual({
			action: 'buy', confidence: 'high', size_factor: 1.0,
			note: expect.stringContaining('top-conviction play'),
		});
		expect(r.structuredContent.plays[1].recommendation.size_factor).toBe(0.75);
		expect(r.structuredContent.plays[0].badges).toEqual(['smart_money_early']);
	});

	it('clamps limit, min_score, and an unknown category to the advertised bounds', async () => {
		store.readFeed.mockResolvedValue([]);
		await call('oracle_top_plays', { limit: 999, min_score: 500, category: 'nonsense', network: 'nope' });
		expect(store.readFeed).toHaveBeenCalledWith({
			network: 'mainnet', limit: 20, minScore: 100, category: null, sinceSeconds: 6 * 3600,
		});
	});

	it('reports a degraded feed store as transient, never as an empty market', async () => {
		store.readFeed.mockRejectedValue(new Error('connection terminated'));
		const r = await call('oracle_top_plays', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/temporarily unavailable/i);
		expect(r.content[0].text).not.toMatch(/lowering min_score/);
	});

	it('rate-limits per caller', async () => {
		rlOk = false;
		const r = await call('oracle_top_plays', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/rate limit/i);
		expect(store.readFeed).not.toHaveBeenCalled();
	});
});

describe('oracle_coin', () => {
	it('scores a coin on demand and reports data confidence alongside the verdict', async () => {
		store.scoreCoin.mockResolvedValue({
			verdict: { score: 55, tier: 'lean', pillars: { momentum: 40 }, badges: [], confidence: 0.4, confidenceLabel: 'thin' },
			intel: { symbol: 'THREE', category: 'ai', marketCapUsd: 1234, graduated: true, creator: 'Creator1', smartMoney: { smartWalletCount: 2 } },
		});
		const r = await call('oracle_coin', { mint: MINT });
		expect(store.scoreCoin).toHaveBeenCalledWith(MINT, { network: 'mainnet', classify: true, persist: true });
		expect(r.structuredContent.conviction).toBe(55);
		expect(r.structuredContent.recommendation.action).toBe('watch');
		expect(r.structuredContent.data_confidence).toBe(0.4);
		expect(r.structuredContent.market_cap_usd).toBe(1234);
	});

	it('rejects a non-base58 mint before touching the store', async () => {
		const r = await call('oracle_coin', { mint: 'not a mint!!' });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid mint/);
		expect(store.scoreCoin).not.toHaveBeenCalled();
	});

	it('distinguishes an unobserved coin from a degraded intel store', async () => {
		store.scoreCoin.mockResolvedValue(null);
		const unknown = await call('oracle_coin', { mint: MINT });
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toMatch(/not found in Oracle/);

		store.scoreCoin.mockRejectedValue(new Error('intel store down'));
		const degraded = await call('oracle_coin', { mint: MINT });
		expect(degraded.isError).toBe(true);
		expect(degraded.content[0].text).toMatch(/temporarily unavailable/i);
	});
});

describe('oracle_arm_watch', () => {
	it('arms an owned agent and clamps every numeric setting into range', async () => {
		store.upsertWatch.mockResolvedValue(undefined);
		store.getWatch.mockResolvedValue({ agent_id: AGENT_ID, armed: true, mode: 'live' });
		store.actionsSummary.mockResolvedValue({ total: 3, wins: 2, losses: 1, win_rate: 0.67, realized_pnl_sol: 0.2 });

		const r = await call('oracle_arm_watch', {
			agent_id: AGENT_ID, mode: 'live', min_score: 900, min_tier: 'bogus',
			categories: ['ai', 'not-a-category'], per_trade_sol: 99, max_daily_sol: 99,
			max_open: 900, require_smart_money: true, size_scaling: false,
		}, OWNER);

		expect(r.isError).toBeUndefined();
		const [agentId, userId, network, cfg] = store.upsertWatch.mock.calls[0];
		expect(agentId).toBe(AGENT_ID);
		expect(userId).toBe('user-1');
		expect(network).toBe('mainnet');
		expect(cfg).toEqual({
			armed: true, mode: 'live', min_score: 100, min_tier: 'strong',
			categories: ['ai'], per_trade_sol: 1, max_daily_sol: 10, max_open: 50,
			require_smart_money: true, size_scaling: false,
		});
		expect(r.structuredContent.track_record.wins).toBe(2);
	});

	it('refuses an anonymous caller and an agent the caller does not own', async () => {
		const anon = await call('oracle_arm_watch', { agent_id: AGENT_ID }, ANON);
		expect(anon.isError).toBe(true);
		expect(anon.content[0].text).toMatch(/signed in/i);

		ownedAgentIds = [];
		const foreign = await call('oracle_arm_watch', { agent_id: AGENT_ID }, OWNER);
		expect(foreign.isError).toBe(true);
		expect(foreign.content[0].text).toMatch(/does not belong to your account/);
		expect(store.upsertWatch).not.toHaveBeenCalled();
	});

	it('rejects a malformed agent_id before the ownership query', async () => {
		const r = await call('oracle_arm_watch', { agent_id: 'nope' }, OWNER);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid agent_id/);
		expect(store.upsertWatch).not.toHaveBeenCalled();
	});
});

describe('oracle_watch_status', () => {
	it('returns the config, track record, and recent actions for an armed agent', async () => {
		store.getWatch.mockResolvedValue({
			agent_id: AGENT_ID, armed: true, mode: 'simulate', min_score: 72, min_tier: 'strong',
			categories: ['ai'], per_trade_sol: 0.05, max_daily_sol: 0.5, max_open: 10,
			require_smart_money: false, size_scaling: true,
		});
		store.actionsSummary.mockResolvedValue({ total: 1, wins: 1, losses: 0, win_rate: 1, realized_pnl_sol: 0.4 });
		store.recentActions.mockResolvedValue([
			{ mint: MINT, symbol: 'THREE', tier: 'prime', conviction: 92, size_sol: 0.05, mode: 'simulate', outcome: 'win', realized_pnl_sol: 0.4, exit_signal: null, acted_at: '2026-08-12T00:00:00.000Z' },
		]);

		const r = await call('oracle_watch_status', { agent_id: AGENT_ID }, OWNER);
		expect(r.structuredContent.armed).toBe(true);
		expect(r.structuredContent.config.min_tier).toBe('strong');
		expect(r.structuredContent.recent_actions[0].pnl_sol).toBe(0.4);
		expect(store.recentActions).toHaveBeenCalledWith(AGENT_ID, 'mainnet', 10);
	});

	it('tells an unarmed agent how to get started instead of erroring', async () => {
		store.getWatch.mockResolvedValue(null);
		store.actionsSummary.mockResolvedValue(null);
		store.recentActions.mockResolvedValue([]);
		const r = await call('oracle_watch_status', { agent_id: AGENT_ID }, OWNER);
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent.armed).toBe(false);
		expect(r.structuredContent.message).toMatch(/oracle_arm_watch/);
	});
});
