// GET /api/platform/stats: the public traction counters behind the homepage
// strip and the monitor board.
//
// Invariants under test:
//   1. The success path serves real counts, `available: true`, and the 5-minute
//      public cache header.
//   2. A failed read is NEVER rounded down to zero. It answers
//      `available: false` under a short cache, so a database outage cannot park
//      a fabricated all-zero traction payload on the CDN for five minutes, and
//      nothing about that failure is cached for the next request.
//   3. `chains` is derived from the chain registry, not hardcoded: testnet and
//      unknown chain ids never inflate it, and Solana counts as the home chain.
//   4. The in-process cache serves repeats without re-querying, and concurrent
//      misses collapse into a single flight.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls = [];
let sqlRoutes = [];
let sqlFailure = null;
const sqlMock = vi.fn((strings, ...vals) => {
	const text = Array.isArray(strings) ? strings.join('?') : String(strings);
	sqlCalls.push({ text, vals });
	if (sqlFailure) return Promise.reject(sqlFailure);
	const route = sqlRoutes.find((r) => r.match.test(text));
	return Promise.resolve(route ? route.rows : []);
});
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	// http.js classifies thrown errors through these; a mocked db must still answer.
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const { default: handler, _resetStatsCache, countChains } = await import('../api/platform/stats.js');

const ROWS = [
	{ match: /from agent_identities/i, rows: [{ n: 3140 }] },
	{ match: /count\(distinct country\)/i, rows: [{ n: 29 }] },
	{ match: /from widget_views/i, rows: [{ n: '593' }] },
	{ match: /from widget_chat_threads/i, rows: [{ n: '29' }] },
	{ match: /from avatars/i, rows: [{ n: 25826 }] },
	{ match: /from widgets\b/i, rows: [{ n: 613 }] },
	{ match: /from erc8004_agents_index/i, rows: [{ chain_id: 8453 }, { chain_id: 1 }, { chain_id: 11155111 }] },
	{ match: /from solana_attestations/i, rows: [{ '?column?': 1 }] },
];

function mkReq({ method = 'GET', headers = {} } = {}) {
	return { method, url: '/api/platform/stats', headers, socket: { remoteAddress: '203.0.113.7' } };
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

async function call(reqInit) {
	const res = mkRes();
	await handler(mkReq(reqInit), res);
	return res;
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	sqlCalls.length = 0;
	sqlRoutes = ROWS;
	sqlFailure = null;
	_resetStatsCache();
});

describe('GET /api/platform/stats', () => {
	it('serves the real counters with a public five-minute cache', async () => {
		const res = await call();

		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body).toMatchObject({
			available: true,
			agents: 3140,
			views: 593,
			chats: 29,
			avatars: 25826,
			countries: 29,
			widgets: 613,
		});
		expect(body.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(res.headers['cache-control']).toBe('public, max-age=300, s-maxage=300, stale-while-revalidate=60');
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['content-type']).toMatch(/application\/json/);
	});

	it('counts mainnet chains plus Solana, never testnets', async () => {
		// Base + Ethereum are mainnets; Sepolia (11155111) is not.
		expect(parse(await call()).chains).toBe(3);
	});

	it('drops testnet and unregistered chain ids from the chain count', () => {
		const rows = [{ chain_id: 8453 }, { chain_id: 84532 }, { chain_id: 999999 }, { chain_id: '8453' }];
		expect(countChains(rows, [{}])).toBe(2); // Base + Solana, deduped
		expect(countChains(rows, [])).toBe(1); // no Solana attestations yet
		expect(countChains([], [])).toBe(0);
	});

	it('says unavailable instead of serving fabricated zeros when the db is down', async () => {
		sqlFailure = new Error('Missing required env var: DATABASE_URL');

		const res = await call();

		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ available: false, reason: 'db_unavailable' });
		// The all-zero payload that used to ship here must not exist at all.
		expect(res.body).not.toMatch(/"agents":0/);
		// A failure must not ride the five-minute public cache.
		expect(res.headers['cache-control']).toBe('public, s-maxage=15');
	});

	it('does not cache a failure: the next request re-queries and recovers', async () => {
		sqlFailure = new Error('connection terminated');
		expect(parse(await call()).available).toBe(false);

		sqlFailure = null;
		sqlCalls.length = 0;
		const res = await call();

		expect(parse(res).agents).toBe(3140);
		expect(sqlCalls.length).toBeGreaterThan(0);
	});

	it('serves repeats from cache and collapses concurrent misses into one flight', async () => {
		const [a, b] = await Promise.all([call(), call()]);
		const perFlight = sqlCalls.length;
		expect(parse(a)).toEqual(parse(b));
		expect(perFlight).toBe(8); // one flight, not two

		await call();
		expect(sqlCalls.length).toBe(perFlight); // cache hit, no new queries
	});

	it('rejects a write with a 405 and no stack trace', async () => {
		const res = await call({ method: 'POST' });

		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
		expect(res.body).not.toMatch(/at .*\.js:/);
	});

	it('answers a preflight with 204 and the read-only method set', async () => {
		const res = await call({ method: 'OPTIONS', headers: { origin: 'https://example.com' } });

		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toBe('GET,OPTIONS');
	});
});
