/**
 * GET /api/galaxy/flows, request handling + degraded-path contracts.
 *
 * The pure row shaping lives in tests/galaxy-flows.test.js. This file pins the
 * endpoint's own behaviour: how it sanitises query params before they reach
 * Postgres, and how its three request shapes (first page, delta poll, backfill
 * page) each degrade when the feed query fails.
 *
 * The last-good snapshot is the load-bearing part. It is keyed by
 * (network, type, limit) only, so a delta poll and the first page collide on it
 * while carrying completely different slices of the feed, which is why only the
 * first page may write or read it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
	queries: [],
	rows: [],
	failNext: false,
	cache: new Map(),
	sets: [],
}));

vi.mock('../api/_lib/db.js', () => ({
	// Tagged-template stand-in: fragments and the final query both land here. Only
	// the outermost call is awaited, so every call can return the same thenable.
	sql: (strings, ...values) => {
		const text = strings.join('?');
		h.queries.push({ text, values });
		return {
			text,
			values,
			then(resolve, reject) {
				if (h.failNext && text.includes('ORDER BY feed.ts DESC')) {
					reject(new Error('relation "agent_custody_events" does not exist'));
					return;
				}
				resolve(h.rows);
			},
		};
	},
	isDbUnavailableError: () => false,
}));

vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async (k) => (h.cache.has(k) ? h.cache.get(k) : null)),
	cacheSet: vi.fn(async (k, v) => { h.sets.push(k); h.cache.set(k, v); }),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { galaxyIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '198.51.100.7',
}));

vi.mock('../api/_lib/http.js', () => ({
	cors: () => false,
	method: () => true,
	rateLimited: (res) => { res._rateLimited = true; },
	json: (res, status, body) => { res._json = { status, body }; return res; },
}));

import handler from '../api/galaxy/flows.js';
import { encodeCursor } from '../api/_lib/galaxy-flows.js';

function fakeRes() {
	const headers = {};
	return {
		statusCode: 200,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		end() {},
	};
}

const call = async (query) => {
	const res = fakeRes();
	await handler({ method: 'GET', url: `/api/galaxy/flows${query}`, headers: {} }, res);
	return res;
};

// One real-shaped custody row: an outbound trade with no platform counterparty.
const ROW = {
	ts: new Date('2026-08-12T09:00:00Z'),
	kind: 'trade',
	direction: 'out',
	row_id: 'c900',
	network: 'mainnet',
	actor_id: 'agent-A',
	actor_name: 'Nova',
	actor_addr: 'NOVAwallet',
	actor_vp: null,
	actor_vs: null,
	asset: 'SOL',
	amount_lamports: '2000000',
	amount_raw: null,
	usd: 0.15,
	signature: 'SIGTRADE',
	counterparty_addr: null,
	counterparty_id: null,
	counterparty_name: null,
	mint: null,
	symbol: null,
	coin_name: null,
};

const feedQuery = () => h.queries.find((q) => q.text.includes('ORDER BY feed.ts DESC'));
const limitArg = () => { const q = feedQuery(); return q.values[q.values.length - 1]; };

beforeEach(() => {
	h.queries = [];
	h.rows = [ROW];
	h.failNext = false;
	h.cache = new Map();
	h.sets = [];
});

describe('query param sanitising', () => {
	it('floors a fractional ?limit so LIMIT stays an integer Postgres accepts', async () => {
		const res = await call('?limit=1.5&network=mainnet');
		expect(res._json.status).toBe(200);
		// LIMIT is sent as limit + 1 for the has_more probe; 1.5 once sent 2.5 and
		// errored the query, degrading a healthy feed to an empty window.
		expect(Number.isInteger(limitArg())).toBe(true);
		expect(limitArg()).toBe(2);
	});

	it('clamps out-of-range and unparseable limits without erroring', async () => {
		await call('?limit=99999');
		expect(limitArg()).toBe(201); // MAX_LIMIT + 1

		h.queries = [];
		await call('?limit=abc');
		expect(limitArg()).toBe(81); // DEFAULT_LIMIT + 1

		h.queries = [];
		await call('?limit=-5');
		expect(limitArg()).toBe(2);
	});

	it('falls back to the safe defaults for an unknown type/network', async () => {
		const res = await call('?type=bogus&network=bogus');
		expect(res._json.body.data.type).toBe('all');
		expect(res._json.body.data.network).toBe('mainnet');
	});
});

describe('last-good snapshot ownership', () => {
	it('writes the snapshot on a first-page build', async () => {
		await call('?limit=40&type=tips');
		expect(h.sets).toContain('galaxy:flows:lastgood:mainnet:tips:40');
	});

	it('never lets a delta poll overwrite the first page snapshot', async () => {
		const cur = encodeCursor('2026-08-12T09:00:00.000Z', 'c900');
		await call(`?limit=41&type=tips&since=${cur}`);
		expect(h.sets).not.toContain('galaxy:flows:lastgood:mainnet:tips:41');
		// A delta poll is live data: it must not be served from the feed cache either.
		expect(h.sets).toHaveLength(0);
	});

	it('never lets a backfill page overwrite the first page snapshot', async () => {
		const cur = encodeCursor('2026-08-12T09:00:00.000Z', 'c900');
		await call(`?limit=42&type=tips&cursor=${cur}`);
		expect(h.sets).not.toContain('galaxy:flows:lastgood:mainnet:tips:42');
	});
});

describe('degraded paths', () => {
	it('serves the last-good snapshot when a first-page build fails', async () => {
		const snapshot = { flows: [{ id: 'c900' }], head_cursor: 'HEAD', network: 'mainnet', type: 'all' };
		h.cache.set('galaxy:flows:lastgood:mainnet:all:50', snapshot);
		h.failNext = true;

		const res = await call('?limit=50');
		expect(res._json.status).toBe(200);
		expect(res.getHeader('x-galaxy-flows-degraded')).toBe('error');
		expect(res._json.body.data).toEqual(snapshot);
	});

	it('answers a failed delta poll with an empty window that echoes the client cursor', async () => {
		const cur = encodeCursor('2026-08-12T09:00:00.000Z', 'c900');
		// A stale first-page snapshot exists, the poll must NOT be answered with it,
		// or the client rewinds its cursor and replays past flows as new light.
		h.cache.set('galaxy:flows:lastgood:mainnet:all:50', { flows: [{ id: 'c1' }], head_cursor: 'OLDHEAD' });
		h.failNext = true;

		const res = await call(`?limit=50&since=${cur}`);
		expect(res._json.status).toBe(200);
		expect(res.getHeader('x-galaxy-flows-degraded')).toBe('error-empty');
		const body = res._json.body.data;
		expect(body.flows).toEqual([]);
		expect(body.head_cursor).toBe(cur); // client keeps its place
		expect(body.summary.count).toBe(0);
	});

	it('answers a failed backfill page with an exhausted window, not a newer one', async () => {
		const cur = encodeCursor('2026-08-12T09:00:00.000Z', 'c900');
		h.cache.set('galaxy:flows:lastgood:mainnet:all:50', { flows: [{ id: 'c1' }], head_cursor: 'OLDHEAD' });
		h.failNext = true;

		const res = await call(`?limit=50&cursor=${cur}`);
		expect(res._json.body.data.flows).toEqual([]);
		expect(res._json.body.data.next_cursor).toBeNull();
		expect(res._json.body.data.head_cursor).toBeNull();
	});
});

describe('successful feed shape', () => {
	it('summarises exactly what it returned and offers a head cursor to poll from', async () => {
		const res = await call('?limit=10');
		const body = res._json.body.data;
		expect(body.flows).toHaveLength(1);
		expect(body.flows[0]).toMatchObject({ id: 'c900', kind: 'trade', direction: 'out' });
		expect(body.summary).toMatchObject({ count: 1, edges: 0, flares: 1 });
		expect(body.summary.by_kind.trade).toBe(1);
		expect(body.has_more).toBe(false);
		expect(body.head_cursor).toBe(encodeCursor('2026-08-12T09:00:00.000Z', 'c900'));
		expect(res.getHeader('cache-control')).toBe('public, max-age=6');
	});
});
