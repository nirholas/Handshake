/**
 * GET /api/objects/library, CC0 prop manifest proxy.
 *
 * The endpoint proxies the R2-hosted object manifest (published by
 * scripts/build-object-library.mjs). Contract under test:
 *   - pre-launch (manifest object missing) → 200 { objects: [], total: 0 },
 *     never an error, so /objects and the AR Studio Objects tray feature-detect
 *     by emptiness;
 *   - a real storage outage also degrades to empty, but with no-store so the
 *     edge cache cannot pin "no objects" for the next 300s;
 *   - published manifest ({ objects: [...] } shape) → passed through with total
 *     derived server-side; bare-array manifests (legacy shape) also accepted;
 *   - opt-in pagination via ?limit / ?offset, with a malformed cursor rejected
 *     as 400 JSON rather than silently coerced into a page nobody asked for;
 *   - non-GET → 405.
 */

import { describe, it, expect, vi } from 'vitest';

const getObjectBuffer = vi.fn();
vi.mock('../api/_lib/r2.js', () => ({ getObjectBuffer: (...a) => getObjectBuffer(...a) }));

const { default: handler } = await import('../api/objects/library.js');

function fakeReq(method = 'GET', url = '/api/objects/library') {
	return { method, url, headers: {} };
}

function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		ended: false,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
		_headers: headers,
	};
}

async function get(query = '') {
	const res = fakeRes();
	await handler(fakeReq('GET', `/api/objects/library${query}`), res);
	return { res, body: JSON.parse(res.body) };
}

const OBJECT = {
	name: 'adjustable_wrench',
	label: 'Adjustable Wrench',
	url: 'https://cdn.example/objects/polyhaven/glb/adjustable_wrench.glb',
	thumb: 'https://cdn.example/objects/polyhaven/thumbs/adjustable_wrench.png',
	bytes: 2639744,
	categories: ['props', 'tools'],
	tags: ['vintage', 'hand tool'],
	license: 'CC0',
	source: 'polyhaven',
};

// No beforeEach reset: every test installs its own mockResolvedValue/
// mockRejectedValue, which fully replaces the previous implementation.
describe('GET /api/objects/library', () => {
	it('returns an empty library when the manifest has not been uploaded yet', async () => {
		const missing = Object.assign(new Error('no such key'), { name: 'NoSuchKey' });
		getObjectBuffer.mockRejectedValue(missing);
		const { res, body } = await get();
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ objects: [], total: 0, generated_at: null });
		// A library that simply has not launched yet is a steady state, so it keeps
		// the normal edge cache.
		expect(res.getHeader('cache-control')).toContain('s-maxage=300');
	});

	it('degrades to an empty library on storage errors without caching the emptiness', async () => {
		getObjectBuffer.mockRejectedValue(new Error('socket hang up'));
		const { res, body } = await get();
		expect(res.statusCode).toBe(200);
		expect(body.objects).toEqual([]);
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('passes through a published { objects } manifest and derives total', async () => {
		getObjectBuffer.mockResolvedValue(Buffer.from(JSON.stringify({
			generated_at: '2026-07-21T13:16:14.305Z',
			total: 1,
			objects: [OBJECT],
		})));
		const { res, body } = await get();
		expect(res.statusCode).toBe(200);
		expect(body.objects).toEqual([OBJECT]);
		expect(body.total).toBe(1);
		expect(body.generated_at).toBe('2026-07-21T13:16:14.305Z');
		expect(res.getHeader('cache-control')).toContain('s-maxage=300');
	});

	it('accepts a bare-array manifest shape', async () => {
		getObjectBuffer.mockResolvedValue(Buffer.from(JSON.stringify([OBJECT])));
		const { body } = await get();
		expect(body.objects).toEqual([OBJECT]);
	});

	it('rejects non-GET methods', async () => {
		getObjectBuffer.mockResolvedValue(Buffer.from('[]'));
		const res = fakeRes();
		await handler(fakeReq('POST'), res);
		expect(res.statusCode).toBe(405);
	});

	// ── Bounded pagination (opt-in via ?limit) ──────────────────────────────
	const OBJECTS = Array.from({ length: 5 }, (_, i) => ({ ...OBJECT, name: `prop-${i}` }));
	const publish = () => getObjectBuffer.mockResolvedValue(Buffer.from(JSON.stringify({ objects: OBJECTS })));

	it('pages a large manifest with ?limit and exposes next_offset', async () => {
		publish();
		const { body } = await get('?limit=2');
		expect(body.total).toBe(5); // full catalog size, not the page size
		expect(body.objects.map((o) => o.name)).toEqual(['prop-0', 'prop-1']);
		expect(body.offset).toBe(0);
		expect(body.next_offset).toBe(2);
	});

	it('honors ?offset and returns next_offset=null on the final page', async () => {
		publish();
		const { body } = await get('?limit=2&offset=4');
		expect(body.objects.map((o) => o.name)).toEqual(['prop-4']);
		expect(body.offset).toBe(4);
		expect(body.next_offset).toBe(null);
	});

	it('returns an empty page (not an error) when offset runs past the end', async () => {
		publish();
		const { body } = await get('?limit=2&offset=99');
		expect(body.objects).toEqual([]);
		expect(body.total).toBe(5);
		expect(body.next_offset).toBe(null);
	});

	it('clamps an oversized limit to the documented maximum instead of failing', async () => {
		publish();
		const { res, body } = await get('?limit=99999');
		expect(res.statusCode).toBe(200);
		expect(body.objects).toHaveLength(5);
		expect(body.next_offset).toBe(null);
	});

	it('omits pagination fields entirely when ?limit is absent (legacy contract)', async () => {
		publish();
		const { body } = await get();
		expect(body).toEqual({ objects: OBJECTS, total: 5, generated_at: null });
		expect('next_offset' in body).toBe(false);
	});

	// ── Malformed cursors are the caller's bug, not a silently coerced page ──
	for (const bad of ['abc', '', '0', '-5', '2.7', '1e3', 'NaN']) {
		it(`rejects ?limit=${JSON.stringify(bad)} with a 400 JSON error`, async () => {
			publish();
			const { res, body } = await get(`?limit=${encodeURIComponent(bad)}`);
			expect(res.statusCode).toBe(400);
			expect(body.error).toBe('invalid_limit');
			expect(body.error_description).toContain('1 to 1000');
			expect(res.getHeader('cache-control')).toBe('no-store');
		});
	}

	for (const bad of ['abc', '-3', '1.5', '']) {
		it(`rejects ?offset=${JSON.stringify(bad)} with a 400 JSON error`, async () => {
			publish();
			const { res, body } = await get(`?limit=2&offset=${encodeURIComponent(bad)}`);
			expect(res.statusCode).toBe(400);
			expect(body.error).toBe('invalid_offset');
		});
	}

	it('rejects ?offset without ?limit rather than ignoring it', async () => {
		publish();
		const { res, body } = await get('?offset=2');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_offset');
		expect(body.error_description).toContain('limit');
	});
});
