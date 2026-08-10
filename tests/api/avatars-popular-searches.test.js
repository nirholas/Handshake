// GET /api/avatars/popular-searches: the read side of the Avatar Search Index
// Warmup pipeline, powering the gallery's popular-search chips.
//
// Both branches matter and neither is obvious from the code: the warm branch
// must expose `top_results` ONLY when ?with_thumbnails=true (the slice is the
// heaviest part of the payload and the chips do not need it), and the cold
// branch must still answer 200 with usable queries so a gallery on a fresh
// database renders chips instead of an empty row.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

let rlOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: async () =>
			rlOk
				? { success: true, limit: 240, remaining: 239, reset: Date.now() + 60_000 }
				: { success: false, limit: 240, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.11',
}));

let warmed = [];
vi.mock('../../api/_lib/avatar-search-warm.js', () => ({
	getPopularSearches: async ({ limit, withThumbnails }) =>
		warmed.slice(0, limit).map((w) => ({ ...w, top_results: withThumbnails ? w.top_results : [] })),
}));

const WARM_ROW = {
	query: 'robot',
	result_count: 5,
	thumbnails: ['https://cdn.example/thumb/a.png'],
	sample_thumbnail: 'https://cdn.example/thumb/a.png',
	top_results: [{ id: 'a', name: 'Robot', slug: 'robot-a', thumbnail_url: 'https://cdn.example/thumb/a.png' }],
	warmed_at: '2026-08-10T10:00:00.000Z',
};

function makeReq({ method = 'GET', url = '/api/avatars/popular-searches' } = {}) {
	const stream = Readable.from([]);
	stream.method = method;
	stream.url = url;
	stream.headers = { host: 'three.ws' };
	return stream;
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}
const body = (res) => JSON.parse(res._body);

async function call(url, method = 'GET') {
	const mod = await import('../../api/avatars/popular-searches.js');
	const res = makeRes();
	await mod.default(makeReq({ url, method }), res);
	return res;
}

beforeEach(() => {
	rlOk = true;
	warmed = [];
});

describe('warm cache present', () => {
	beforeEach(() => { warmed = [WARM_ROW, { ...WARM_ROW, query: 'anime', result_count: 2 }]; });

	it('serves the warmed queries with their sample thumbnail', async () => {
		const res = await call('/api/avatars/popular-searches');
		expect(res.statusCode).toBe(200);
		const out = body(res);
		expect(out.source).toBe('warm_cache');
		expect(out.searches.map((s) => s.query)).toEqual(['robot', 'anime']);
		expect(out.searches[0].sample_thumbnail).toBe('https://cdn.example/thumb/a.png');
		expect(out.searches[0].result_count).toBe(5);
	});

	it('withholds the heavy top_results slice unless asked for it', async () => {
		expect(body(await call('/api/avatars/popular-searches')).searches[0]).not.toHaveProperty('top_results');
		const withThumbs = body(await call('/api/avatars/popular-searches?with_thumbnails=true'));
		expect(withThumbs.searches[0].top_results).toHaveLength(1);
	});

	it('honours ?limit and caches at the edge', async () => {
		const res = await call('/api/avatars/popular-searches?limit=1');
		expect(body(res).searches).toHaveLength(1);
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=600/);
	});
});

describe('cold start and guards', () => {
	it('falls back to seed queries when nothing is warmed yet', async () => {
		const res = await call('/api/avatars/popular-searches');
		expect(res.statusCode).toBe(200);
		const out = body(res);
		expect(out.source).toBe('seed');
		expect(out.searches.length).toBeGreaterThan(0);
		// Seed rows are shaped like warm rows so the client needs no branch.
		for (const s of out.searches) {
			expect(typeof s.query).toBe('string');
			expect(s.result_count).toBeNull();
			expect(s.thumbnails).toEqual([]);
		}
		// Short TTL so warmed data takes over as soon as the pipeline lands it.
		expect(res.getHeader('cache-control')).toMatch(/max-age=30/);
	});

	it('rejects non-GET methods', async () => {
		const res = await call('/api/avatars/popular-searches', 'POST');
		expect(res.statusCode).toBe(405);
	});

	it('returns 429 when the per-IP bucket is exhausted', async () => {
		rlOk = false;
		const res = await call('/api/avatars/popular-searches');
		expect(res.statusCode).toBe(429);
	});
});
