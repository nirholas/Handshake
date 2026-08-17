// Boundary tests for GET /api/characters, the public published-agent feed.
//
// The handler runs for real (http.js json/cors/method/wrap included); the DB,
// rate limiter and bucket-URL helper are stubbed at the module boundary. What
// these pin is the pagination contract: a hand-edited `cursor` must come back
// as a 4xx, not as a 500 from `new Date('junk').toISOString()` throwing a
// RangeError deep inside the handler, and a `next_cursor` must carry every
// column its sort orders by, or "Top" stops paging after one screen.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = [];
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => {
	// Mirror the real wrapper's shape: every sql`` call returns a composable
	// thenable, and a fragment spliced into a parent query is never awaited, so
	// it never runs. Resolving lazily keeps `sqlCalls` to the one query the
	// handler actually executes, whatever fragments it assembled on the way.
	const sql = vi.fn((...args) => ({
		then(resolve, reject) {
			sqlCalls.push(args);
			return Promise.resolve(rows.splice(0, rows.length)).then(resolve, reject);
		},
	}));
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

let rateLimitOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({
			success: rateLimitOk,
			limit: 60,
			remaining: rateLimitOk ? 59 : 0,
			reset: 0,
		})),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	thumbnailUrl: vi.fn((k) => (k ? `https://cdn.test/${k}` : null)),
}));

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const { default: handler } = await import('../../api/characters.js');

function mkReq({ query = '', method = 'GET' } = {}) {
	return { method, url: `/api/characters${query}`, query: {}, headers: {} };
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(payload) {
			this.body = payload || '';
			this.writableEnded = true;
		},
		get json() {
			try {
				return JSON.parse(this.body);
			} catch {
				return null;
			}
		},
	};
}

// The interpolated values of the Nth sql`` call (everything after the strings).
function interpolations(n) {
	return sqlCalls[n].slice(1);
}

const AGENT = {
	id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
	name: 'Zenith',
	description: 'An accountability partner.',
	meta: { solana_address: '37wDaX4Xe25zFZXZqXawMzM1Kt6JK7pdsnWUNo3kAh2q' },
	created_at: '2026-08-15T13:37:01.660Z',
	avatar_id: null,
	author_name: 'ChiQhi',
	author_username: null,
	author_avatar: null,
	avatar_thumbnail_key: 'thumb/abc.png',
	avatar_visibility: 'public',
	chat_count: 4,
};

beforeEach(() => {
	rows.length = 0;
	sqlCalls.length = 0;
	rateLimitOk = true;
	vi.clearAllMocks();
});

describe('GET /api/characters', () => {
	it('serves the feed with a CDN cache header and a next cursor', async () => {
		rows.push(AGENT, { ...AGENT, id: 'b', created_at: '2026-08-14T00:00:00.000Z' });
		const res = mkRes();
		await handler(mkReq({ query: '?limit=1' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toMatch(/s-maxage=60/);
		expect(res.json.characters).toHaveLength(1);
		expect(res.json.characters[0].name).toBe('Zenith');
		// A public avatar's thumbnail becomes the card image.
		expect(res.json.characters[0].image_url).toBe('https://cdn.test/thumb/abc.png');
		// limit + 1 is fetched so `has more` needs no second query.
		expect(res.json.next_cursor).toBe('2026-08-15T13:37:01.660Z');
	});

	it('400s an unparseable cursor instead of 500ing on Invalid Date', async () => {
		const res = mkRes();
		await handler(mkReq({ query: '?cursor=notadate' }), res);

		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('bad_request');
		// Rejected at the boundary: the query never ran.
		expect(sqlCalls).toHaveLength(0);
	});

	it('passes a normalised ISO cursor through to the keyset predicate', async () => {
		rows.push(AGENT);
		const res = mkRes();
		await handler(mkReq({ query: '?cursor=2026-08-16T00:00:00Z' }), res);

		expect(res.statusCode).toBe(200);
		expect(interpolations(0)).toContain('2026-08-16T00:00:00.000Z');
	});

	// sort=chats orders by (chat_count DESC, created_at DESC), so a cursor that
	// names only created_at cannot resume it: page 2 kept whatever was older than
	// the last row and re-ranked THAT by chats, which ended the "Top" feed after
	// a single screen. The cursor now carries both keys.
	it('issues a composite cursor under sort=chats', async () => {
		rows.push(AGENT, { ...AGENT, id: 'b', chat_count: 1, created_at: '2026-08-14T00:00:00.000Z' });
		const res = mkRes();
		await handler(mkReq({ query: '?limit=1&sort=chats' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.json.next_cursor).toBe('4:2026-08-15T13:37:01.660Z');
	});

	it('resumes sort=chats from both keys of a composite cursor', async () => {
		rows.push(AGENT);
		const res = mkRes();
		await handler(mkReq({ query: '?sort=chats&cursor=4%3A2026-08-15T13%3A37%3A01.660Z' }), res);

		expect(res.statusCode).toBe(200);
		const values = interpolations(0);
		expect(values).toContain(4);
		expect(values).toContain('2026-08-15T13:37:01.660Z');
	});

	it('rejects a cursor whose shape does not match the requested sort', async () => {
		// A bare timestamp is what sort=new issues; under sort=chats it is either a
		// hand-edited URL or a cursor carried across a sort switch, and resuming
		// from it would silently skip rows.
		const res = mkRes();
		await handler(mkReq({ query: '?sort=chats&cursor=2026-08-15T13:37:01.660Z' }), res);

		expect(res.statusCode).toBe(400);
		expect(sqlCalls).toHaveLength(0);
	});

	it('400s a composite cursor with a junk count', async () => {
		const res = mkRes();
		await handler(mkReq({ query: '?sort=chats&cursor=abc%3A2026-08-15T13%3A37%3A01.660Z' }), res);

		expect(res.statusCode).toBe(400);
		expect(sqlCalls).toHaveLength(0);
	});

	it('coerces junk pagination and caps the page size', async () => {
		rows.push(AGENT);
		const junk = mkRes();
		await handler(mkReq({ query: '?limit=abc' }), junk);
		// clampInt fallback 24, fetched as limit + 1.
		expect(interpolations(0)).toContain(25);

		sqlCalls.length = 0;
		rows.push(AGENT);
		const over = mkRes();
		await handler(mkReq({ query: '?limit=9999' }), over);
		expect(interpolations(0)).toContain(61);
	});

	it('hides an avatar thumbnail the viewer is not allowed to see', async () => {
		rows.push({ ...AGENT, avatar_visibility: 'private', meta: {} });
		const res = mkRes();
		await handler(mkReq(), res);
		expect(res.json.characters[0].image_url).toBeNull();
	});

	it('405s a write method', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST' }), res);
		expect(res.statusCode).toBe(405);
		expect(sqlCalls).toHaveLength(0);
	});

	it('429s when the public IP bucket is exhausted', async () => {
		rateLimitOk = false;
		const res = mkRes();
		await handler(mkReq(), res);
		expect(res.statusCode).toBe(429);
		expect(sqlCalls).toHaveLength(0);
	});
});
