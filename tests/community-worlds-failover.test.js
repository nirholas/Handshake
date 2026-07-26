/**
 * GET /api/community/worlds trending failover tests.
 *
 * The lobby must stay alive without a CoinCommunities key: when CC is
 * unconfigured (or its upstream errors) the endpoint serves live pump.fun
 * trending coins as stat-less world cards (`social: false`) instead of a 503.
 * The original error envelopes only surface when the trending failover is
 * ALSO unavailable, so clients keep their designed degraded states.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000 })) },
	clientIp: () => '127.0.0.1',
}));

const ccState = { configured: false, communities: null, apiError: null };
vi.mock('../api/_lib/coin-communities.js', async () => {
	const actual = await vi.importActual('../api/_lib/coin-communities.js');
	return {
		...actual,
		cc: vi.fn(() => {
			if (!ccState.configured) throw new actual.UnconfiguredError();
			return {
				getTopCommunities: async () =>
					ccState.apiError
						? { data: null, error: ccState.apiError }
						: { data: { communities: ccState.communities ?? [] }, error: null },
			};
		}),
	};
});

const trending = { data: null };
vi.mock('../api/_lib/pump-trending.js', () => ({
	getTrendingSlim: vi.fn(async () => ({ data: trending.data, stale: false })),
}));

const { default: handler } = await import('../api/community/worlds.js');

function makeReq() {
	return {
		method: 'GET',
		url: '/api/community/worlds',
		headers: { origin: 'https://three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	r.json = () => JSON.parse(r._b);
	return r;
}
async function call() {
	const res = makeRes();
	await handler(makeReq(), res);
	return res;
}

const TRENDING_ROW = {
	mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	symbol: 'THREE',
	name: 'three.ws',
	logo: 'https://example.com/three.png',
	price_usd: 0.001,
	rank: 1,
};

beforeEach(() => {
	rl.ok = true;
	ccState.configured = false;
	ccState.communities = null;
	ccState.apiError = null;
	trending.data = null;
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('CoinCommunities configured', () => {
	it('serves CC communities as world cards, tagged source coincommunities', async () => {
		ccState.configured = true;
		ccState.communities = [
			{ tokenAddress: TRENDING_ROW.mint, tokenSymbol: 'THREE', memberCount: 12, postCount: 3, totalLikes: 5 },
		];
		const res = await call();
		expect(res.statusCode).toBe(200);
		const { data } = res.json();
		expect(data.source).toBe('coincommunities');
		expect(data.worlds).toHaveLength(1);
		expect(data.worlds[0].token).toBe(TRENDING_ROW.mint);
		expect(data.worlds[0].members).toBe(12);
	});

	it('falls back to trending when the CC upstream errors', async () => {
		ccState.configured = true;
		ccState.apiError = { message: 'upstream exploded' };
		trending.data = [TRENDING_ROW];
		const res = await call();
		expect(res.statusCode).toBe(200);
		const { data } = res.json();
		expect(data.source).toBe('pump-trending');
		expect(data.worlds[0]).toMatchObject({
			token: TRENDING_ROW.mint,
			symbol: 'THREE',
			name: 'three.ws',
			image: TRENDING_ROW.logo,
			social: false,
		});
	});

	it('502s only when CC errors AND trending is down', async () => {
		ccState.configured = true;
		ccState.apiError = { message: 'upstream exploded' };
		const res = await call();
		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe('upstream_error');
	});
});

describe('CoinCommunities unconfigured', () => {
	it('serves live trending worlds instead of 503', async () => {
		trending.data = [TRENDING_ROW];
		const res = await call();
		expect(res.statusCode).toBe(200);
		const { data } = res.json();
		expect(data.source).toBe('pump-trending');
		expect(data.worlds).toHaveLength(1);
		expect(data.worlds[0].social).toBe(false);
		expect(data.worlds[0].members).toBe(0);
		expect(res._h['cache-control']).toContain('max-age=20');
	});

	it('503s cc_unconfigured only when trending is ALSO unavailable', async () => {
		const res = await call();
		expect(res.statusCode).toBe(503);
		expect(res.json().error).toBe('cc_unconfigured');
	});
});
