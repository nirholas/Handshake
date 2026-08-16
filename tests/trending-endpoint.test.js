/**
 * HTTP-level tests for GET /api/trending, the feed behind the public /trending
 * leaderboard (agents by real chat activity, coins by Oracle conviction).
 *
 * These pin the two failures the coin half of the endpoint shipped with:
 *
 *   1. The `window` parameter only ever reached the agent ranking. The coin
 *      query hardcoded a 36 hour floor, so 24h, 7d and all-time answered with
 *      the same board while the page told the visitor it was filtering.
 *   2. That query ordered by `score desc` alone. Conviction saturates at 100,
 *      so Postgres was free to return a different slice of the tie on every
 *      request and the board reshuffled between two identical reads.
 *
 * Only the impure edges are stubbed (database, CDN URL builder, the reputation
 * enrichment, the rate limiter). The handler, its validation, its window
 * mapping, and its wire shape are the real module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every sql`` call, as its raw template text plus the values interpolated into
// it, so the window contract is assertable rather than inferred from row counts.
const queries = [];
let agentRows = [];
let coinRows = [];

vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async (strings, ...values) => {
			const text = strings.join(' ? ');
			queries.push({ text, values });
			return /from oracle_conviction/.test(text) ? coinRows : agentRows;
		}),
		{ transaction: vi.fn() },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false, sizeMb: 1, highWaterMb: 470 }),
}));

vi.mock('../api/_lib/r2.js', () => ({ thumbnailUrl: (key) => `https://cdn.test/${key}` }));

const scoreAgentsLite = vi.fn(async () => new Map());
vi.mock('../api/_lib/trust/wallet-reputation.js', () => ({
	scoreAgentsLite: (...a) => scoreAgentsLite(...a),
}));

const publicIp = vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: (...a) => publicIp(...a) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../api/trending.js');

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		_ended: false,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this._ended = true; },
		get json() {
			try { return JSON.parse(this._body); } catch { return null; }
		},
	};
}

const read = async (query = '') => {
	const res = mockRes();
	await handler(
		{
			method: 'GET',
			url: '/api/trending' + (query ? `?${query}` : ''),
			headers: { host: 'three.ws', origin: 'https://three.ws' },
		},
		res,
	);
	return res;
};

const coinQuery = () => queries.find((q) => /from oracle_conviction/.test(q.text));

const COINS = [
	{
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		symbol: 'THREE', name: 'three.ws',
		score: 100, tier: 'prime', momentum: 97, pedigree: 65, structure: 76, narrative: 48,
		smart_wallet_count: 12, scored_at: '2026-08-15T17:24:17.626Z',
	},
	{
		mint: 'THREEsynthetic1111111111111111111111111111',
		symbol: 'SYNTH', name: 'Synthetic',
		score: 100, tier: 'prime', momentum: 40, pedigree: 20, structure: 30, narrative: 10,
		smart_wallet_count: 0, scored_at: '2026-08-14T09:00:00.000Z',
	},
];

const AGENTS = [
	{
		id: '4339aafa-e5ed-496f-a8dd-9e6c4bff914d',
		name: 'Harbor #21',
		description: 'A friendly starter agent.',
		meta: { solana_address: '4Nex4B1MiquVWMF1FuDPHwBWQZWhQZTirichyBFwtxBV' },
		avatar_thumbnail_key: 'thumb/harbor.png',
		avatar_visibility: 'public',
		window_chats: 9,
		chat_count: 41,
	},
	{
		id: '845e4464-1d17-4cac-8990-be3f72bbc38d',
		name: 'Private avatar',
		description: null,
		meta: {},
		avatar_thumbnail_key: 'thumb/secret.png',
		avatar_visibility: 'private',
		window_chats: 2,
		chat_count: 3,
	},
];

beforeEach(() => {
	queries.length = 0;
	agentRows = AGENTS;
	coinRows = COINS;
	scoreAgentsLite.mockClear();
});

describe('GET /api/trending window', () => {
	it('filters the coin board to the requested window, not a fixed floor', async () => {
		const day = await read('window=24h');
		expect(day.statusCode).toBe(200);
		expect(day.json.window).toBe('24h');
		expect(coinQuery().text).toMatch(/scored_at >= now\(\) -\s+\?\s+::interval/);
		expect(coinQuery().values).toContain('24 hours');
		expect(coinQuery().text).not.toMatch(/36 hours/);

		queries.length = 0;
		const week = await read('window=7d');
		expect(week.json.window).toBe('7d');
		expect(coinQuery().values).toContain('7 days');
	});

	it('drops the freshness floor entirely for all time', async () => {
		const res = await read('window=all');
		expect(res.json.window).toBe('all');
		expect(coinQuery().text).toMatch(/from oracle_conviction/);
		expect(coinQuery().text).not.toMatch(/scored_at >=/);
	});

	it('falls back to 24h for a window it does not serve', async () => {
		const res = await read('window=lifetime');
		expect(res.json.window).toBe('24h');
		expect(coinQuery().values).toContain('24 hours');
	});

	it('orders the coin board deterministically so two identical reads rank the same', async () => {
		for (const w of ['24h', '7d', 'all']) {
			queries.length = 0;
			await read(`window=${w}`);
			// Score saturates at 100; the tie-break is what keeps the board stable.
			expect(coinQuery().text).toMatch(
				/order by score desc, momentum desc, smart_wallet_count desc, scored_at desc, mint/,
			);
		}
	});
});

describe('GET /api/trending payload', () => {
	it('ranks and shapes both boards for the page', async () => {
		const res = await read('window=24h&limit=10');
		const { agents, coins } = res.json;

		expect(agents.map((a) => a.rank)).toEqual([1, 2]);
		expect(agents[0].agent_url).toBe('https://three.ws/agent/4339aafa-e5ed-496f-a8dd-9e6c4bff914d');
		expect(agents[0].avatar_thumbnail_url).toBe('https://cdn.test/thumb/harbor.png');
		// A private avatar's thumbnail never leaves the platform on a public feed.
		expect(agents[1].avatar_thumbnail_url).toBeNull();
		expect(agents[0].solana_address).toBe('4Nex4B1MiquVWMF1FuDPHwBWQZWhQZTirichyBFwtxBV');

		expect(coins.map((c) => c.rank)).toEqual([1, 2]);
		expect(coins[0].coin_url).toBe('https://three.ws/oracle/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(coins[0].score).toBe(100);
		expect(res.getHeader('cache-control')).toMatch(/max-age=120/);
	});

	it('caps limit at 20 and floors it at 1', async () => {
		await read('limit=500');
		expect(coinQuery().values).toContain(20);
		queries.length = 0;
		await read('limit=0');
		expect(coinQuery().values).toContain(1);
	});

	it('still answers with the activity board when reputation enrichment fails', async () => {
		scoreAgentsLite.mockRejectedValueOnce(new Error('scoring down'));
		const res = await read('window=24h');
		expect(res.statusCode).toBe(200);
		expect(res.json.agents).toHaveLength(2);
		expect(res.json.agents[0].reputation).toBeUndefined();
	});
});
