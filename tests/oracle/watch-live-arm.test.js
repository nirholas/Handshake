// Spend-safety contract for POST /api/oracle/watch.
//
// Arming an agent in `live` mode commits its custodial SOL, so the risk knobs
// are clamped server-side. The clamps have floors (per_trade_sol >= 0.001,
// max_daily_sol >= per_trade_sol), which means a caller asking for LESS than
// the floor used to be silently rounded UP: `{armed:true, mode:'live',
// per_trade_sol:0, max_daily_sol:0}` stored an armed live loop at 0.001 SOL a
// trade with a 0.5 SOL daily ceiling. The guard meant to stop that read the
// clamped value (`perTrade <= 0`) and could never fire.
//
// These tests pin the fix: a live arm rejects a raw request below the floor,
// a simulate run keeps the forgiving clamps, and an omitted knob still gets
// its default.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/http.js', async () => {
	const actual = await vi.importActual('../../api/_lib/http.js');
	return {
		...actual,
		wrap: (fn) => fn,
		cors: () => false,
		method: () => true,
		rateLimited: (res) => { res._rateLimited = true; },
		json: (res, status, body) => { res._json = { status, body }; return res; },
		error: (res, status, code, message) => {
			res._json = { status, body: { error: code, error_description: message } };
			return res;
		},
		readJson: async (req) => JSON.parse(req._rawBody),
	};
});

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));

const USER_ID = 'ab2aabd2-39f7-493b-8191-c9f174af62ab';
const AGENT_ID = '5e05f68f-eead-4ef9-b6b4-fc85ea73bbe9';

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => ({ id: USER_ID }),
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

// Ownership check is a single tagged-template read; the caller owns the agent.
vi.mock('../../api/_lib/db.js', () => ({
	sql: () => Promise.resolve([{ id: AGENT_ID }]),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const upserts = [];
vi.mock('../../api/_lib/oracle/store.js', () => ({
	getWatch: async () => null,
	upsertWatch: async (agentId, userId, network, cfg) => {
		upserts.push({ agentId, userId, network, cfg });
		return { agent_id: agentId, network, ...cfg };
	},
	recentActions: async () => [],
	actionsSummary: async () => ({ total: 0, wins: 0, losses: 0, open: 0, win_rate: null }),
}));

import watch from '../../api/oracle/watch.js';

function fakeRes() {
	return {
		statusCode: 200,
		_headers: {},
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end() { this.writableEnded = true; },
	};
}

function post(body) {
	return {
		method: 'POST',
		url: '/api/oracle/watch',
		headers: { host: 'three.ws', 'content-type': 'application/json' },
		_rawBody: JSON.stringify(body),
		on() {},
	};
}

beforeEach(() => { upserts.length = 0; });

describe('POST /api/oracle/watch live-arm spend guard', () => {
	it('refuses to arm live when per_trade_sol is below the floor', async () => {
		const res = fakeRes();
		await watch(post({ agent_id: AGENT_ID, armed: true, mode: 'live', per_trade_sol: 0 }), res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('validation_error');
		expect(res._json.body.error_description).toMatch(/per_trade_sol/);
		// The point of the guard: nothing was armed.
		expect(upserts).toHaveLength(0);
	});

	it('refuses to arm live when per_trade_sol is not a number', async () => {
		const res = fakeRes();
		await watch(post({ agent_id: AGENT_ID, armed: true, mode: 'live', per_trade_sol: 'lots' }), res);
		expect(res._json.status).toBe(400);
		expect(upserts).toHaveLength(0);
	});

	it('refuses to arm live when max_daily_sol is under one trade', async () => {
		const res = fakeRes();
		await watch(post({
			agent_id: AGENT_ID, armed: true, mode: 'live',
			per_trade_sol: 0.05, max_daily_sol: 0.01,
		}), res);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error_description).toMatch(/max_daily_sol/);
		expect(upserts).toHaveLength(0);
	});

	it('arms live with coherent sizes and clamps them to the ceiling', async () => {
		const res = fakeRes();
		await watch(post({
			agent_id: AGENT_ID, armed: true, mode: 'live',
			per_trade_sol: 99, max_daily_sol: 999,
		}), res);
		expect(res._json.status).toBe(200);
		expect(upserts).toHaveLength(1);
		// Clamping DOWN to the ceiling is always safe; only rounding up is not.
		expect(upserts[0].cfg.per_trade_sol).toBe(5);
		expect(upserts[0].cfg.max_daily_sol).toBe(50);
		expect(upserts[0].cfg.armed).toBe(true);
		expect(upserts[0].cfg.mode).toBe('live');
	});

	it('applies defaults for a live arm that omits the sizes entirely', async () => {
		const res = fakeRes();
		await watch(post({ agent_id: AGENT_ID, armed: true, mode: 'live' }), res);
		expect(res._json.status).toBe(200);
		expect(upserts[0].cfg.per_trade_sol).toBe(0.05);
		expect(upserts[0].cfg.max_daily_sol).toBe(0.5);
	});

	it('keeps the forgiving clamps for a simulate run', async () => {
		const res = fakeRes();
		await watch(post({
			agent_id: AGENT_ID, armed: true, mode: 'simulate',
			per_trade_sol: 0, max_daily_sol: 0,
		}), res);
		expect(res._json.status).toBe(200);
		expect(upserts[0].cfg.per_trade_sol).toBe(0.001);
		expect(upserts[0].cfg.mode).toBe('simulate');
	});

	it('keeps the forgiving clamps for an unarmed live config', async () => {
		const res = fakeRes();
		await watch(post({ agent_id: AGENT_ID, armed: false, mode: 'live', per_trade_sol: 0 }), res);
		expect(res._json.status).toBe(200);
		expect(upserts[0].cfg.armed).toBe(false);
	});
});
