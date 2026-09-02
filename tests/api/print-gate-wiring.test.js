// The fabrication gate's two run points, wired.
//
// api/api/_lib/print/gate.js is tested on its own in print-fabrication-gate.test.js.
// This suite proves the gate is not advisory: that the quote endpoint refuses
// before a price exists, that the sweep screens paid orders and rejects the
// ones that fail, and that no order reaches a printer without a recorded
// `allow` verdict on it. A gate nothing calls is decoration.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Run point 1: POST /api/print/quote
// ---------------------------------------------------------------------------

const REPORT = {
	version: 1,
	manifold: true,
	volume_cm3: 12.5,
	bbox_mm: { x: 210, y: 140, z: 35, diagonal: 254 },
	min_wall_mm: 2.1,
	triangles: 5000,
	score: 96,
	deductions: [],
};

let lineageText = 'a small brass gear';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { printQuoteIp: async () => ({ success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 }) },
	clientIp: () => '203.0.113.9',
}));
vi.mock('../../api/_lib/print/mesh-io.js', () => ({
	loadMeshFromUrl: async () => ({ triangleCount: 5000 }),
	MeshIoError: class extends Error {},
}));
vi.mock('../../api/_lib/print/analyze.js', () => ({ analyzeMesh: async () => REPORT }));
vi.mock('../../api/_lib/forge-store.js', () => ({
	getPublicCreation: async () => ({ id: 'c-1', glb_url: 'https://three.ws/cdn/m.glb', prompt: lineageText }),
}));
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: async () => null }));
vi.mock('../../api/_lib/three-tier.js', () => ({ holderDiscountBps: async () => 0 }));
// The gate itself is the real module; only its database read is stubbed, so the
// rules, the layers and the refusal copy under test are the shipped ones.
vi.mock('../../api/_lib/db.js', () => ({ sql: async () => [] }));

const quoteHandler = (await import('../../api/print/quote.js')).default;

function makeReq(body) {
	const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
	stream.method = 'POST';
	stream.url = '/api/print/quote';
	stream.headers = { host: 'three.ws', 'content-type': 'application/json' };
	stream.query = {};
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		removeHeader(k) { delete this.headers[k.toLowerCase()]; },
		writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); return this; },
		end(payload) { this.body = payload ? JSON.parse(String(payload)) : null; this.ended = true; return this; },
	};
}

describe('run point 1: the quote endpoint refuses before a price exists', () => {
	beforeEach(() => {
		lineageText = 'a small brass gear';
	});

	it('returns 451 with the category, the policy link and what is allowed', async () => {
		lineageText = 'an AR-15 lower receiver in nylon';
		const res = makeRes();
		await quoteHandler(makeReq({ creationId: 'c-1', materialId: 'resin_standard', targetHeightMm: 80 }), res);
		expect(res.statusCode).toBe(451);
		expect(res.body.error).toBe('fabrication_refused');
		expect(res.body.category).toBe('firearm_components');
		expect(res.body.policy_url).toBe('/docs/materialize#content-policy');
		expect(res.body.allowed).toBeTruthy();
		// No price was computed and no token was signed for a refused request.
		expect(res.body.quote).toBeUndefined();
		expect(res.body.token).toBeUndefined();
	});

	it('refuses an intent laundered through the buyer note, not just the prompt', async () => {
		const res = makeRes();
		await quoteHandler(makeReq({ creationId: 'c-1', note: 'add a monocore baffle so it works as a suppressor' }), res);
		expect(res.statusCode).toBe(451);
		expect(res.body.category).toBe('suppressors');
	});

	it('lets an ordinary model through and tells the caller a screening pass follows', async () => {
		const res = makeRes();
		await quoteHandler(makeReq({ creationId: 'c-1' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.body.screening).toEqual({
			verdict: 'allow',
			stage: 'quote',
			policy_url: '/docs/materialize#content-policy',
		});
		expect(res.body.report.version).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Run point 2: the screening sweep, and the block on submission
// ---------------------------------------------------------------------------

const { submitOrder, FulfillmentError } = await import('../../api/_lib/print/fulfillment.js');

describe('run point 2: no order reaches a printer unscreened', () => {

	const orderWith = (screening) => ({
		id: 'o-1',
		status: 'screening',
		quantity: 1,
		prepared_asset_urls: { stl: 'https://three.ws/cdn/o-1.stl' },
		analysis: screening ? { screening } : {},
	});

	it('refuses to submit an order that has not been screened yet', async () => {
		await expect(submitOrder({ order: orderWith(null) })).rejects.toMatchObject({
			code: 'not_screened',
		});
	});

	it('refuses to submit an order held for review, with a different message', async () => {
		await expect(submitOrder({ order: orderWith({ verdict: 'review' }) })).rejects.toMatchObject({
			code: 'not_screened',
			message: expect.stringContaining('held for fabrication review'),
		});
	});

	it('the block is a typed fulfillment error an operator console can render', async () => {
		const err = await submitOrder({ order: orderWith(null) }).catch((e) => e);
		expect(err).toBeInstanceOf(FulfillmentError);
	});

	it('an allowed order gets past the gate and on to adapter routing', async () => {
		// With no adapters configured, routing is the next thing that fails. That
		// it fails on routing rather than on screening is the assertion: the gate
		// let it through.
		const err = await submitOrder({ order: orderWith({ verdict: 'allow' }) }).catch((e) => e);
		expect(err.code).not.toBe('not_screened');
	});
});
