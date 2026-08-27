/**
 * Tests for POST /api/v1/ai/image (api/v1/ai/image.js).
 *
 * The endpoint is a free-quota funnel over the platform's text→image lanes: the
 * first N images/day per IP are free (payment bypassed), then callers fall
 * through to the x402 pay-per-image lane. What's tested here is the endpoint's
 * own logic — validation, the free→402 fall-through, the honest no-lane 503, and
 * safety-refusal mapping — with the payment rail and the text→image lane stubbed
 * at their module boundaries (each has its own suite). The provider boundaries
 * (lane success shape, Vertex refusal shape) use the REAL captured shapes from
 * api/_mcp3d/text-to-image.js and api/_mcp3d/vertex-imagen.js.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
		X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		X402_ADVERTISE_BASE: 'true',
	});
});

// Stub payment verify/settle — the 402 challenge, buildRequirements, and bazaar
// schema stay real; only the facilitator round-trips are faked.
vi.mock('../../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		verifyPayment: vi.fn(async () => ({ ok: true, requirement: { network: 'base', amount: '20000' }, payer: '0xpayer' })),
		settlePayment: vi.fn(async () => ({ settled: true, transaction: '0xtx', network: 'base' })),
		encodePaymentResponseHeader: vi.fn(() => 'stub-payment-response'),
	};
});

// Deterministic client IP; keep the real limiters (permissive in-memory in test).
vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return { ...actual, clientIp: () => '203.0.113.9' };
});

// Text→image lane — controlled per test. Default: a real NIM FLUX success shape
// (see nimFluxImage return, api/_mcp3d/text-to-image.js).
const laneState = vi.hoisted(() => ({
	impl: async () => ({ imageUrl: 'https://cdn.example/forge/refs/abc.jpg', model: 'black-forest-labs/flux.1-schnell' }),
}));
vi.mock('../../api/_mcp3d/text-to-image.js', () => ({
	textToImage: (...args) => laneState.impl(...args),
}));

// Free-quota module — controlled per test.
const quotaState = vi.hoisted(() => ({ allowed: true, consumed: 0 }));
vi.mock('../../api/_lib/ai-image-quota.js', () => ({
	freePerDay: () => 5,
	peekFreeQuota: vi.fn(async () => ({
		allowed: quotaState.allowed,
		used: quotaState.allowed ? 0 : 5,
		limit: 5,
		remaining: quotaState.allowed ? 5 : 0,
		resetAt: '2026-07-08T00:00:00.000Z',
	})),
	consumeFreeQuota: vi.fn(async () => {
		quotaState.consumed += 1;
		return { used: quotaState.consumed, limit: 5, remaining: 5 - quotaState.consumed, resetAt: '2026-07-08T00:00:00.000Z' };
	}),
	__resetFreeQuota: () => {},
}));

const { default: handler } = await import('../../api/v1/ai/image.js');
const { CATALOG } = await import('../../api/v1/_catalog.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
		getHeader(name) { return this.headers[String(name).toLowerCase()]; },
		end(body) { this.body = body ?? null; },
	};
}

// A real Readable stream (not a plain async-iterable object) so it matches
// production `req` semantics — the shared readBody() helper (api/_lib/http.js)
// reads via `.on('data'/'end')`, which only a real stream implements.
function makeReq({ method = 'POST', url = '/api/v1/ai/image', headers = {}, body = null } = {}) {
	const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	const buf = Buffer.from(payload, 'utf8');
	const req = Readable.from(buf.length ? [buf] : []);
	req.method = method;
	req.url = url;
	req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', 'content-length': String(buf.length), ...headers };
	return req;
}

const LANE_ENV = ['NVIDIA_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GCP_SERVICE_ACCOUNT_JSON', 'REPLICATE_API_TOKEN', 'VERTEX_IMAGEN_ENABLED', 'X402_PRICE_AI_IMAGE'];
const savedEnv = {};
beforeEach(() => {
	for (const k of LANE_ENV) savedEnv[k] = process.env[k];
	quotaState.allowed = true;
	quotaState.consumed = 0;
	laneState.impl = async () => ({ imageUrl: 'https://cdn.example/forge/refs/abc.jpg', model: 'black-forest-labs/flux.1-schnell' });
	// A configured lane by default so the happy paths run.
	process.env.NVIDIA_API_KEY = 'nvapi-test';
});
afterEach(() => {
	for (const k of LANE_ENV) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	vi.restoreAllMocks();
});

describe('catalog registration', () => {
	it('registers v1.ai.image as a public POST route', () => {
		const entry = CATALOG.find((e) => e.id === 'v1.ai.image');
		expect(entry).toBeTruthy();
		expect(entry.method).toBe('POST');
		expect(entry.path).toBe('/api/v1/ai/image');
		expect(entry.auth).toBe('public');
	});
});

describe('validation (free path, fresh IP)', () => {
	it('rejects an empty prompt with 400 and no charge', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { prompt: '' } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_prompt');
	});

	it('rejects an oversized prompt with 400', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'x'.repeat(2001) } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('prompt_too_long');
	});

	it('rejects an unsupported aspect_ratio with 400', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl', aspect_ratio: '5:1' } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_aspect_ratio');
	});

	it('rejects a non-integer seed with 400', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl', seed: 1.5 } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_seed');
	});

	it('does not spend a quota slot on a validation error', async () => {
		const { consumeFreeQuota } = await import('../../api/_lib/ai-image-quota.js');
		const res = makeRes();
		await handler(makeReq({ body: { prompt: '' } }), res);
		expect(consumeFreeQuota).not.toHaveBeenCalled();
	});
});

describe('free path success', () => {
	it('serves an image free, shapes { url, provider, width, height }, and spends a slot', async () => {
		const { consumeFreeQuota } = await import('../../api/_lib/ai-image-quota.js');
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl figurine', aspect_ratio: '16:9', seed: 42 } }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.url).toBe('https://cdn.example/forge/refs/abc.jpg');
		expect(body.provider).toBe('nvidia-nim');
		expect(body.width).toBe(1344);
		expect(body.height).toBe(768);
		expect(body.aspect_ratio).toBe('16:9');
		expect(body.seed).toBe(42);
		expect(body.free).toBe(true);
		expect(consumeFreeQuota).toHaveBeenCalledTimes(1);
	});

	it('forwards the seed to the lane', async () => {
		const spy = vi.fn(async () => ({ imageUrl: 'https://cdn.example/x.jpg', model: 'black-forest-labs/flux.1-schnell' }));
		laneState.impl = spy;
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl', seed: 7 } }), res);
		expect(spy).toHaveBeenCalledWith('a brass owl', expect.objectContaining({ aspectRatio: '1:1', seed: 7 }));
	});
});

describe('quota fall-through to x402', () => {
	it('emits a 402 quoting $0.02 once the free quota is exhausted', async () => {
		quotaState.allowed = false;
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl figurine' } }), res);
		expect(res.statusCode).toBe(402);
		const body = JSON.parse(res.body);
		expect((body.accepts || []).map((a) => a.amount)).toContain('20000');
	});
});

describe('no-lane honesty', () => {
	// Keyless Pollinations is always behind the keyed rungs, so "no key at all"
	// is no longer "no lane": the request still runs, and the health surface is
	// where the absent keyed lanes are named (see the GET ?health=1 case).
	it('still serves with no keyed lane set, through the keyless rung', async () => {
		delete process.env.NVIDIA_API_KEY;
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl figurine' } }), res);
		expect(res.statusCode).toBe(200);
	});
});

describe('provider safety refusal', () => {
	it('maps a Vertex/Gemini content block to 422 without retrying', async () => {
		// Real captured refusal shape: generateViaGemini throws this exact message
		// when candidates carry a finishReason and no image part.
		laneState.impl = async () => {
			throw new Error('Vertex Gemini returned no image data (finishReason: IMAGE_SAFETY)');
		};
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'something blocked' } }), res);
		expect(res.statusCode).toBe(422);
		expect(JSON.parse(res.body).error).toBe('content_refused');
	});
});

describe('GET surfaces', () => {
	it('serves a discovery doc with free-tier + price on plain GET', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.route).toBe('/api/v1/ai/image');
		expect(body.free_tier.images_per_day_per_ip).toBe(5);
		expect(body.price_usdc).toBe('0.020000');
	});

	// Keyless Pollinations means the image surface is never "unconfigured":
	// with no key at all it still answers 200 and names the keyed lanes missing.
	it('reports per-lane health on GET ?health=1 with no keyed lane: still configured via the keyless rung', async () => {
		delete process.env.NVIDIA_API_KEY;
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: '/api/v1/ai/image?health=1' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.configured).toBe(true);
		expect(body.lanes.pollinations.configured).toBe(true);
		expect(body.lanes.nim.status).toBe('unconfigured');
		expect(body.missing_env).toContain('NVIDIA_API_KEY');
	});

	it('probes a configured Replicate lane as reachable on GET ?health=1', async () => {
		delete process.env.NVIDIA_API_KEY;
		process.env.REPLICATE_API_TOKEN = 'r8_test';
		globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: '/api/v1/ai/image?health=1' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.configured).toBe(true);
		expect(body.healthy).toBe(true);
		expect(body.lanes.replicate.status).toBe('ok');
	});
});
