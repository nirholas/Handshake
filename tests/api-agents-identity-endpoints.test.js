// Regression cover for the /api/agents identity + economy read surfaces.
//
// Every case here is a defect this suite was written against, found by probing
// the live handlers:
//
//  1. balances.js read the session id off `auth.userId`, but getSessionUser
//     returns the user row (`auth.id`). `isOwner` was therefore false for
//     every signed-in owner, so the "Yours" marker could never render.
//  2. check-name.js and economy.js passed caller-supplied ids straight into
//     `WHERE col = $1` against uuid columns. A malformed id came back as
//     Postgres 22P02 and surfaced to the caller as a 500 instead of a 400.
//  3. by-wallet.js coerced `chain_id` with `Number(...) || null`, so a
//     non-numeric value silently dropped the filter and returned every chain's
//     agents as if that were what the caller asked for.
//
// The DB and the on-chain valuation layer are mocked so these assert the
// handlers' own validation and shaping, not Neon or Helius.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const AGENT_ID = '5eff00ac-65fa-4b0f-aef1-c26eb1a9c37d';
const OWNER_ID = '36b42d48-e968-476b-826a-3b8f700da867';
const OTHER_ID = '11111111-2222-4333-8444-555555555555';
const EVM_ADDR = '0x49da9e65cfa25b13732a46ddb2d2ceeada14f65e';

// The session the auth mock hands back; individual tests flip it to null.
let session = null;
// What the db mock resolves for the next sql`` call.
let dbRows = [];
let dbCalls = 0;

vi.mock('../api/_lib/db.js', () => ({
	sql: () => {
		dbCalls += 1;
		return Promise.resolve(dbRows);
	},
	sqlValues: () => ({}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: async () => session,
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		walletRead: async () => ({ success: true }),
		authedReadIp: async () => ({ success: true }),
		checkName: async () => ({ success: true }),
	},
	clientIp: () => '203.0.113.7',
}));

vi.mock('../api/_lib/balances.js', () => ({
	getBalances: async () => ({ native: { amount: 0, usd: 0, price: 0 }, tokens: [] }),
	walletUsdTotal: () => 0,
}));

// Economy reads have their own suites; here they only need to prove that a
// malformed id never reaches them.
const economyCalls = [];
vi.mock('../api/_lib/agent-economy.js', () => ({
	listOffersWithStats: async (a) => { economyCalls.push(['offers', a]); return []; },
	listHiresForAgent: async (...a) => { economyCalls.push(['hires', a]); return []; },
	agentEconomySummary: async (a) => { economyCalls.push(['summary', a]); return {}; },
	providerStats: async (a) => { economyCalls.push(['stats', a]); return {}; },
	getOfferBySlug: async () => null,
	getHireById: async () => null,
	rateHire: async () => null,
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: async () => true }));

const { default: balancesHandler } = await import('../api/agents/balances.js');
const { default: checkNameHandler } = await import('../api/agents/check-name.js');
const { default: byWalletHandler } = await import('../api/agents/by-wallet.js');
const { default: economyHandler } = await import('../api/agents/economy.js');

// Minimal Vercel-shaped res that records what json()/error() wrote.
function fakeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		writeHead(status) { this.statusCode = status; return this; },
		end(payload) {
			if (payload) { try { this.body = JSON.parse(payload); } catch { this.body = payload; } }
			return this;
		},
	};
}

function req({ method = 'GET', url = '/', body = null, headers = {} } = {}) {
	return {
		method,
		url,
		headers: { 'content-type': 'application/json', ...headers },
		query: {},
		body,
	};
}

beforeEach(() => {
	session = null;
	dbRows = [];
	dbCalls = 0;
	economyCalls.length = 0;
});

describe('POST /api/agents/balances', () => {
	it('marks the signed-in owner isOwner (reads session.id, not session.userId)', async () => {
		session = { id: OWNER_ID, email: 'owner@three.ws' };
		dbRows = [{ id: AGENT_ID, user_id: OWNER_ID, meta: {} }];
		const res = fakeRes();
		await balancesHandler(req({ method: 'POST', url: '/api/agents/balances', body: { ids: [AGENT_ID] } }), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.data[AGENT_ID].isOwner).toBe(true);
	});

	it('leaves isOwner false for a signed-in non-owner', async () => {
		session = { id: OTHER_ID, email: 'stranger@three.ws' };
		dbRows = [{ id: AGENT_ID, user_id: OWNER_ID, meta: {} }];
		const res = fakeRes();
		await balancesHandler(req({ method: 'POST', url: '/api/agents/balances', body: { ids: [AGENT_ID] } }), res);

		expect(res.body.data[AGENT_ID].isOwner).toBe(false);
	});

	it('rejects a body without an ids array', async () => {
		const res = fakeRes();
		await balancesHandler(req({ method: 'POST', url: '/api/agents/balances', body: {} }), res);

		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
	});

	it('drops malformed ids and never queries when none survive', async () => {
		const res = fakeRes();
		await balancesHandler(req({ method: 'POST', url: '/api/agents/balances', body: { ids: ['not-a-uuid', 42] } }), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.data).toEqual({});
		expect(dbCalls).toBe(0);
	});
});

describe('GET /api/agents/check-name', () => {
	it('rejects a non-uuid agent_id instead of leaking a Postgres error', async () => {
		session = { id: OWNER_ID };
		const res = fakeRes();
		await checkNameHandler(req({ url: '/api/agents/check-name?name=freshname&agent_id=not-a-uuid' }), res);

		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
		expect(dbCalls).toBe(0);
	});

	it('accepts a well-formed agent_id and reports availability', async () => {
		session = { id: OWNER_ID };
		dbRows = [];
		const res = fakeRes();
		await checkNameHandler(req({ url: `/api/agents/check-name?name=freshname&agent_id=${AGENT_ID}` }), res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ available: true });
	});

	it('requires a session', async () => {
		const res = fakeRes();
		await checkNameHandler(req({ url: '/api/agents/check-name?name=freshname' }), res);

		expect(res.statusCode).toBe(401);
	});

	it('reports a denylisted name as unavailable without a lookup', async () => {
		session = { id: OWNER_ID };
		const res = fakeRes();
		await checkNameHandler(req({ url: '/api/agents/check-name?name=admin' }), res);

		expect(res.body).toEqual({ available: false, reason: 'denylisted' });
		expect(dbCalls).toBe(0);
	});
});

describe('GET /api/agents/by-wallet', () => {
	it('rejects a non-numeric chain_id rather than silently widening the result', async () => {
		const res = fakeRes();
		await byWalletHandler(req({ url: `/api/agents/by-wallet?address=${EVM_ADDR}&chain_id=abc` }), res);

		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
		expect(dbCalls).toBe(0);
	});

	it('honours a numeric chain_id', async () => {
		dbRows = [{ id: AGENT_ID, name: 'Agent', description: null, avatar_id: null, home_url: null, erc8004_agent_id: null, erc8004_registry: null, chain_id: 8453, wallet_address: EVM_ADDR, created_at: '2026-05-13T12:47:24.086Z' }];
		const res = fakeRes();
		await byWalletHandler(req({ url: `/api/agents/by-wallet?address=${EVM_ADDR}&chain_id=8453` }), res);

		expect(res.statusCode).toBe(200);
		expect(res.body.agents[0]).toMatchObject({ id: AGENT_ID, chain_id: 8453, home_url: `/agents/${AGENT_ID}` });
	});

	it('rejects a malformed wallet address', async () => {
		const res = fakeRes();
		await byWalletHandler(req({ url: '/api/agents/by-wallet?address=0xnope' }), res);

		expect(res.statusCode).toBe(400);
	});
});

describe('GET /api/agents/economy', () => {
	it.each([
		['offers', '/api/agents/economy?view=offers&agentId=nope', 'agentId'],
		['hires', '/api/agents/economy?view=hires&agentId=nope', 'agentId'],
		['hires cursor', `/api/agents/economy?view=hires&agentId=${AGENT_ID}&beforeId=junk`, 'beforeId'],
		['summary', '/api/agents/economy?view=summary&agentId=nope', 'agentId'],
	])('rejects a non-uuid id on view=%s', async (_label, url, field) => {
		const res = fakeRes();
		await economyHandler(req({ url }), res);

		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
		expect(res.body.error_description).toContain(field);
		expect(economyCalls).toEqual([]);
	});

	it('passes a well-formed agentId through to the summary reads', async () => {
		const res = fakeRes();
		await economyHandler(req({ url: `/api/agents/economy?view=summary&agentId=${AGENT_ID}` }), res);

		expect(res.statusCode).toBe(200);
		expect(economyCalls.map((c) => c[0]).sort()).toEqual(['stats', 'summary']);
		expect(res.body.data.agent_id).toBe(AGENT_ID);
	});

	it('rejects an unknown view', async () => {
		const res = fakeRes();
		await economyHandler(req({ url: '/api/agents/economy?view=nope' }), res);

		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('bad_view');
	});
});
