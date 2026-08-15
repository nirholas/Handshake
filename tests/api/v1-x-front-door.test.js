// GET /api/v1/x - the aggregator front door, and the routing regression that
// api/v1/x/index.js exists to prevent.
//
// The dispatch logic all lives in api/v1/x/[...slug].js, but a single-bracket
// catch-all never matches ZERO segments, so without the sibling index.js the
// exact URL documented in docs/api-reference.md, advertised as `base_url` in
// the discovery payload, and fetched by the /crypto-api storefront 404s. These
// tests pin both halves of that: index.js really is the same handler, and that
// handler answers the bare URL with the machine-readable provider catalog.
//
// Only the zero- and wrong-segment paths are exercised here, so nothing
// upstream is contacted and no billing lane runs: the free lane, the x402
// hand-off, and the plan/BYOK lanes are covered by tests/api/v1-free-tier.test.js
// and the x402 suites.

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';

function makeReq({ url, method = 'GET', host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = method;
	stream.url = url;
	stream.headers = { host };
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

async function dispatch(modulePath, url) {
	const mod = await import(modulePath);
	const res = makeRes();
	await mod.default(makeReq({ url }), res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

describe('GET /api/v1/x front door', () => {
	it('api/v1/x/index.js re-exports the catch-all handler itself, not a copy', async () => {
		const index = await import('../../api/v1/x/index.js');
		const catchAll = await import('../../api/v1/x/[...slug].js');
		expect(typeof index.default).toBe('function');
		expect(index.default).toBe(catchAll.default);
	});

	it('answers the bare /api/v1/x with the provider catalog', async () => {
		const { res, body } = await dispatch('../../api/v1/x/index.js', '/api/v1/x');
		expect(res.statusCode).toBe(200);
		expect(body.data.base_url).toBe('/api/v1/x');
		expect(Array.isArray(body.data.providers)).toBe(true);
		expect(body.data.providers.length).toBeGreaterThan(0);
		for (const lane of ['byok', 'plan', 'free', 'x402']) {
			expect(typeof body.data.billing[lane]).toBe('string');
		}
	});

	it('lists real provider/endpoint pairs a caller can then request', async () => {
		const { body } = await dispatch('../../api/v1/x/index.js', '/api/v1/x');
		const { ENDPOINT_INDEX } = await import('../../api/v1/_providers.js');
		for (const provider of body.data.providers) {
			expect(provider.endpoints.length).toBeGreaterThan(0);
			for (const endpoint of provider.endpoints) {
				expect(ENDPOINT_INDEX.has(`${provider.id}/${endpoint.id}`)).toBe(true);
			}
		}
	});

	it('404s a provider with no endpoint, pointing at the catalog', async () => {
		const { res, body } = await dispatch('../../api/v1/x/[...slug].js', '/api/v1/x/coingecko');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.error_description).toContain('/api/v1/x');
	});

	it('404s an unregistered provider/endpoint pair by name', async () => {
		const { res, body } = await dispatch('../../api/v1/x/[...slug].js', '/api/v1/x/nosuch/endpoint');
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('unknown_endpoint');
		expect(body.error_description).toContain('nosuch/endpoint');
	});

	it('treats a parameterless request as a discovery probe, a parameterized one as a call', async () => {
		const { isParameterlessProbe } = await import('../../api/v1/x/[...slug].js');
		expect(isParameterlessProbe(makeReq({ url: '/api/v1/x/coingecko/price' }))).toBe(true);
		expect(isParameterlessProbe(makeReq({ url: '/api/v1/x/coingecko/price?ids=solana' }))).toBe(false);
	});
});
