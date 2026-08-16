// Regressions for /api/subscriptions and /api/subscriptions/plans.
//
// Three faults these lock in, all found by probing the live handlers:
//   1. A malformed path id (/api/subscriptions/not-a-uuid, /plans/not-a-uuid)
//      went straight into a uuid comparison, so Postgres answered 22P02 and the
//      caller got an opaque 500 instead of "your id is wrong".
//   2. PUT /api/subscriptions/plans/:id answered 405, which meant the dashboard
//      plan editor (src/dashboard-next/pages/monetize.js saves an edit with PUT)
//      could never save a change to an existing tier.
//   3. GET /api/subscriptions/plans/:id fell through to the list handler and
//      answered "creator_id or agent_id required" for a perfectly well-formed
//      request. It now serves the plan, with drafts visible only to their owner.
//
// A HEAD probe used to match no dispatch branch and fall through to 405 on both
// handlers; RFC 9110 9.3.2 requires it to reach whatever GET reaches.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '127.0.0.1',
	limits: {
		publicIp: async () => ({ success: true, limit: 100, remaining: 99, reset: Date.now() + 1000 }),
		authIp: async () => ({ success: true, limit: 100, remaining: 99, reset: Date.now() + 1000 }),
	},
}));
vi.mock('../api/_lib/subscription-billing.js', () => ({
	chargeSubscription: vi.fn(async () => ({ success: false, error: 'creator_payout_wallet_missing' })),
}));

const { default: plansHandler } = await import('../api/subscriptions/plans.js');
const { default: subsHandler } = await import('../api/subscriptions/index.js');

const OWNER = 'ab2aabd2-39f7-493b-8191-c9f174af62ab';
const OTHER = 'f23703c0-9d75-4e60-9a4c-349da5d7a2f2';
const PLAN = '735977d9-289d-4517-8ac4-68e97c649de8';
const SUB = '7c8e0051-0279-484a-b7d5-a19d821ade61';

function mkReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
	return {
		method,
		url,
		headers: { ...headers },
		body: body ?? undefined,
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);
const jsonReq = (method, url, body) =>
	mkReq({ method, url, headers: { 'content-type': 'application/json' }, body });

// The handlers use tagged-template sql``; queue one result array per call.
let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue({ id: OWNER });
});

describe('subscriptions: malformed path ids answer 4xx, never a 500', () => {
	it('GET /api/subscriptions/:id rejects a non-uuid before touching the database', async () => {
		const res = mkRes();
		await subsHandler(mkReq({ url: '/api/subscriptions/not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('DELETE /api/subscriptions/:id rejects a non-uuid before touching the database', async () => {
		const res = mkRes();
		await subsHandler(mkReq({ method: 'DELETE', url: '/api/subscriptions/not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('PATCH /api/subscriptions/plans/:id rejects a non-uuid', async () => {
		const res = mkRes();
		await plansHandler(jsonReq('PATCH', '/api/subscriptions/plans/not-a-uuid', { name: 'abc' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/valid UUID/);
	});

	it('DELETE /api/subscriptions/plans/:id rejects a non-uuid', async () => {
		const res = mkRes();
		await plansHandler(mkReq({ method: 'DELETE', url: '/api/subscriptions/plans/not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('GET /api/subscriptions/plans/:id rejects a non-uuid', async () => {
		const res = mkRes();
		await plansHandler(mkReq({ url: '/api/subscriptions/plans/not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('subscription plans: the dashboard editor saves with PUT', () => {
	it('PUT /api/subscriptions/plans/:id updates the plan like PATCH does', async () => {
		sqlQueue = [
			[{ id: PLAN, active: true }],
			[{ id: PLAN, name: 'Renamed', active: true }],
		];
		const res = mkRes();
		await plansHandler(
			jsonReq('PUT', `/api/subscriptions/plans/${PLAN}`, { name: 'Renamed', price_usd: 6 }),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(parse(res).plan).toMatchObject({ id: PLAN, name: 'Renamed' });
	});

	it('advertises PUT in the CORS preflight', async () => {
		const res = mkRes();
		await plansHandler(
			mkReq({ method: 'OPTIONS', url: '/api/subscriptions/plans', headers: { origin: 'http://localhost:3000' } }),
			res,
		);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toContain('PUT');
	});
});

describe('subscription plans: single-plan read', () => {
	it('serves an active plan to an anonymous caller', async () => {
		getSessionUserMock.mockResolvedValue(null);
		sqlQueue = [[{ id: PLAN, creator_id: OTHER, name: 'Tier', active: true }]];
		const res = mkRes();
		await plansHandler(mkReq({ url: `/api/subscriptions/plans/${PLAN}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).plan.id).toBe(PLAN);
	});

	it('404s an unknown plan', async () => {
		sqlQueue = [[]];
		const res = mkRes();
		await plansHandler(mkReq({ url: `/api/subscriptions/plans/${PLAN}` }), res);
		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_found');
	});

	it('hides a draft from everyone but its creator', async () => {
		getSessionUserMock.mockResolvedValue({ id: OTHER });
		sqlQueue = [[{ id: PLAN, creator_id: OWNER, name: 'Draft', active: false }]];
		const res = mkRes();
		await plansHandler(mkReq({ url: `/api/subscriptions/plans/${PLAN}` }), res);
		expect(res.statusCode).toBe(404);
	});

	it('shows a draft to its creator', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		sqlQueue = [[{ id: PLAN, creator_id: OWNER, name: 'Draft', active: false }]];
		const res = mkRes();
		await plansHandler(mkReq({ url: `/api/subscriptions/plans/${PLAN}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).plan.active).toBe(false);
	});
});

describe('subscriptions: HEAD reaches the GET branch', () => {
	it('HEAD /api/subscriptions/mine answers like GET', async () => {
		sqlQueue = [[{ id: SUB, plan_id: PLAN, status: 'active' }]];
		const res = mkRes();
		await subsHandler(mkReq({ method: 'HEAD', url: '/api/subscriptions/mine' }), res);
		expect(res.statusCode).toBe(200);
	});

	it('HEAD /api/subscriptions/plans answers like GET', async () => {
		sqlQueue = [[]];
		const res = mkRes();
		await plansHandler(mkReq({ method: 'HEAD', url: `/api/subscriptions/plans?creator_id=${OWNER}` }), res);
		expect(res.statusCode).toBe(200);
	});
});

describe('subscriptions: unchanged contract', () => {
	it('GET /api/subscriptions/mine requires a session', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await subsHandler(mkReq({ url: '/api/subscriptions/mine' }), res);
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});

	it('POST /api/subscriptions refuses a plan the caller owns', async () => {
		sqlQueue = [[{ id: PLAN, creator_id: OWNER, price_usd: '9.99', interval: 'monthly', active: true }]];
		const res = mkRes();
		await subsHandler(jsonReq('POST', '/api/subscriptions', { plan_id: PLAN }), res);
		expect(res.statusCode).toBe(409);
		expect(parse(res).error_description).toMatch(/your own plan/);
	});

	it('GET /api/subscriptions/plans still requires creator_id or agent_id', async () => {
		const res = mkRes();
		await plansHandler(mkReq({ url: '/api/subscriptions/plans' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/creator_id or agent_id/);
	});
});
