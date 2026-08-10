// GET /api/coin/:mint/cohorts: the authorization and cost-ordering contract.
//
// The live (agent-token) branch fetches the holder set from Helius. That call
// costs an upstream request and can fail 503 on its own, so every rejection the
// handler can decide by itself must happen FIRST. It used to happen last, with
// two consequences: an anonymous caller asking for a bogus cohort got
// "holder data is temporarily unavailable" instead of 404/401, and any
// unauthenticated request could make the platform spend a Helius call.
//
// The same tests pin the surrounding guards: the IP limiter covers every shape
// (it once guarded only the live branch, leaving the snapshot DB reads
// unbounded), and CORS advertises exactly the one method the handler accepts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const cohortsIp = vi.fn(async () => ({ success: true }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { cohortsIp: (...a) => cohortsIp(...a) },
	clientIp: () => '203.0.113.9',
}));

const sql = vi.fn(async () => []);
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sql(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const getSessionUser = vi.fn(async () => null);
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: (...a) => getSessionUser(...a) }));

const loadCoinByMint = vi.fn(async () => null);
const liveHolderSet = vi.fn();
const cohortCounts = vi.fn(async () => ({ holders: 3 }));
vi.mock('../../api/_lib/coin/index.js', () => ({
	loadCoinByMint: (...a) => loadCoinByMint(...a),
	listCohorts: () => [{ id: 'holders', name: 'All holders' }, { id: 'whales', name: 'Whales' }],
	isCohortId: (id) => ['holders', 'whales', 'diamond-hands'].includes(id),
	cohortCounts: (...a) => cohortCounts(...a),
	queryCohort: async () => ({ members: [], nextCursor: null, sampled: false }),
	isLiveCohort: (id) => id !== 'diamond-hands',
	liveHolderSet: (...a) => liveHolderSet(...a),
	liveCohortCounts: () => ({ holderCount: 3, counts: { holders: 3 }, concentration: { top1Share: 1 } }),
	liveCohortMembers: () => ({ members: ['A'], sampled: false, total: 1, truncated: false }),
}));

const MINT = 'AXsKDdVquPPm8c4vc65Ycw1yMvZFMSXc5DHDz56HNmjp';
const AGENT_TOKEN_ROW = { id: 7, user_id: 42, token: { symbol: 'AA', name: 'a' } };

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

const handler = (await import('../../api/coin/[mint]/cohorts.js')).default;

async function call(query = '', { httpMethod = 'GET', mint = MINT } = {}) {
	const res = makeRes();
	await handler({ url: `/api/coin/${mint}/cohorts${query}`, method: httpMethod, headers: {}, query: { mint } }, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

/** The mint resolves to an agent token (no coin_launches row) → the live branch. */
function asAgentToken() {
	loadCoinByMint.mockResolvedValue(null);
	sql.mockResolvedValue([AGENT_TOKEN_ROW]);
}

beforeEach(() => {
	cohortsIp.mockReset().mockResolvedValue({ success: true });
	sql.mockReset().mockResolvedValue([]);
	getSessionUser.mockReset().mockResolvedValue(null);
	loadCoinByMint.mockReset().mockResolvedValue(null);
	liveHolderSet.mockReset().mockResolvedValue({ stale: false });
	cohortCounts.mockReset().mockResolvedValue({ holders: 3 });
});

describe('/api/coin/:mint/cohorts guards', () => {
	it('rejects a mint that is not a Solana address before touching the database', async () => {
		const { res, body } = await call('', { mint: 'notavalidmint' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(loadCoinByMint).not.toHaveBeenCalled();
	});

	it('advertises only the method it accepts', async () => {
		const res = makeRes();
		await handler({ url: `/api/coin/${MINT}/cohorts`, method: 'OPTIONS', headers: {}, query: { mint: MINT } }, res);
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-methods')).toBe('GET,OPTIONS');
	});

	it('rate-limits the snapshot path, not only the live one', async () => {
		cohortsIp.mockResolvedValue({ success: false, limit: 45, remaining: 0, reset: Date.now() + 1000 });
		loadCoinByMint.mockResolvedValue({ id: 1, mint: MINT, symbol: 'AA', name: 'a' });
		const { res, body } = await call();
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(loadCoinByMint).not.toHaveBeenCalled();
	});

	it('404s a mint that is neither a launch nor an agent token', async () => {
		const { res, body } = await call();
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('/api/coin/:mint/cohorts live branch ordering', () => {
	it('404s an unknown cohort id without spending a Helius call', async () => {
		asAgentToken();
		const { res, body } = await call('?cohort=bogus');
		expect(res.statusCode).toBe(404);
		expect(body.error_description).toBe('unknown cohort: bogus');
		expect(liveHolderSet).not.toHaveBeenCalled();
	});

	it('401s an anonymous member export without spending a Helius call', async () => {
		asAgentToken();
		const { res, body } = await call('?cohort=whales');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthenticated');
		expect(liveHolderSet).not.toHaveBeenCalled();
	});

	it('403s a signed-in caller who does not own the token, still without the call', async () => {
		asAgentToken();
		getSessionUser.mockResolvedValue({ id: 999, is_admin: false });
		const { res, body } = await call('?cohort=whales');
		expect(res.statusCode).toBe(403);
		expect(body.error).toBe('forbidden');
		expect(liveHolderSet).not.toHaveBeenCalled();
	});

	it('422s a tenure cohort this token has no history for, still without the call', async () => {
		asAgentToken();
		getSessionUser.mockResolvedValue({ id: 42, is_admin: false });
		const { res, body } = await call('?cohort=diamond-hands');
		expect(res.statusCode).toBe(422);
		expect(body.error).toBe('snapshot_required');
		expect(liveHolderSet).not.toHaveBeenCalled();
	});

	it('exports members for the token creator', async () => {
		asAgentToken();
		getSessionUser.mockResolvedValue({ id: 42, is_admin: false });
		const { res, body } = await call('?cohort=whales');
		expect(res.statusCode).toBe(200);
		expect(liveHolderSet).toHaveBeenCalledTimes(1);
		expect(body).toMatchObject({ cohort: 'whales', count: 1, members: ['A'], source: 'live' });
	});

	it('serves public counts with a CDN cache header and no auth', async () => {
		asAgentToken();
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(body.holderCount).toBe(3);
		expect(res.getHeader('cache-control')).toContain('s-maxage=120');
		expect(getSessionUser).not.toHaveBeenCalled();
	});

	it('reports a Helius outage as a typed 503 that never echoes the upstream message', async () => {
		asAgentToken();
		liveHolderSet.mockRejectedValue(new Error('403 https://mainnet.helius-rpc.com/?api-key=secret'));
		const { res, body } = await call();
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('holders_unavailable');
		expect(JSON.stringify(body)).not.toContain('api-key');
	});
});

describe('/api/coin/:mint/cohorts snapshot branch', () => {
	it('serves cacheable public counts for a launched coin', async () => {
		loadCoinByMint.mockResolvedValue({ id: 1, mint: MINT, symbol: 'AA', name: 'a', last_snapshot_at: null });
		const { res, body } = await call();
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('cache-control')).toContain('s-maxage=120');
		expect(body.cohorts.find((c) => c.id === 'holders').count).toBe(3);
		// Counts absent upstream render as 0 on the snapshot path, not null.
		expect(body.cohorts.find((c) => c.id === 'whales').count).toBe(0);
	});

	it('401s an anonymous member export', async () => {
		loadCoinByMint.mockResolvedValue({ id: 1, mint: MINT, symbol: 'AA', name: 'a' });
		const { res, body } = await call('?cohort=whales');
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthenticated');
	});
});
