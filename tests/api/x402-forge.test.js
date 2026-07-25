/**
 * Tests for the paid x402 generation endpoint (api/x402/forge.js).
 *
 * Payment verification/settlement, the FLUX text-to-image step, and the
 * Replicate reconstruction submit are stubbed at their module boundaries — the
 * real upstreams (payment facilitators, Replicate) are exercised by their own
 * suites. What's tested here is the endpoint's own logic: pricing sourced from
 * forge-tiers, the 402 challenge, input validation, and the verify → submit →
 * settle ordering that guarantees a failed generation never charges.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Readable } from 'node:stream';

// Env the 402 challenge builder reads. Set before importing the handler.
beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
		X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		REPLICATE_API_TOKEN: 'test-token',
		// Signs the forge poll token the NVIDIA async path hands back.
		JWT_SECRET: 'test-jwt-secret-for-forge-job-tokens',
	});
});

// Stub payment verify/settle (keep the rest of x402-spec real: send402,
// buildRequirements helpers, buildBazaarSchema, resolveResourceUrl).
vi.mock('../../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		verifyPayment: vi.fn(async () => ({ ok: true })),
		settlePayment: vi.fn(async () => ({ settled: true })),
		encodePaymentResponseHeader: vi.fn(() => 'stub-payment-response'),
	};
});

// Stub the FLUX text-to-image step and the Replicate reconstruction submit.
vi.mock('../../api/_mcp3d/text-to-image.js', () => ({
	textToImage: vi.fn(async () => ({ imageUrl: 'https://cdn.example/ref.png', model: 'flux', predictionId: 'p1' })),
}));
// Hoisted so a test can force the reconstruct submit to throw a throttle. The
// shared `submit` mock defaults to a queued job; mockRejectedValueOnce lets the
// 429 path exercise the endpoint's retryable rate-limit response.
const replicateMock = vi.hoisted(() => {
	const submit = vi.fn(async () => ({ extJobId: 'abcd1234efgh5678ij', jobId: 'abcd1234efgh5678ij', eta: 60 }));
	return { submit, createRegenProvider: vi.fn(() => ({ submit })) };
});
vi.mock('../../api/_providers/replicate.js', () => ({
	createRegenProvider: replicateMock.createRegenProvider,
}));

// Free NVIDIA NIM TRELLIS lane — the primary text→3D engine. Hoisted so each test
// controls it: by default createNvidiaProvider THROWS (no NVIDIA_API_KEY), which
// exercises the never-dead-end degrade to the Replicate reconstruct lane. The
// NVIDIA-path tests override it per-call with mockReturnValueOnce.
const nvidiaMock = vi.hoisted(() => ({
	createNvidiaProvider: vi.fn(() => {
		throw Object.assign(new Error('NVIDIA_API_KEY is required for the nvidia (TRELLIS) provider'), {
			code: 'missing_key',
			status: 503,
		});
	}),
}));
vi.mock('../../api/_providers/nvidia.js', () => nvidiaMock);

// Free HuggingFace Spaces reconstruct lane — the free-first alternative to the
// paid Replicate reconstruct. Default: UNAVAILABLE (createRegenProvider throws, as
// the real provider does without HF_TOKEN), so the existing reconstruct-fallback
// tests still reach Replicate. The free-first test overrides it per-call.
const hfMock = vi.hoisted(() => ({
	createRegenProvider: vi.fn(() => {
		throw Object.assign(new Error('HF_TOKEN env var is required for the huggingface provider'), {
			code: 'provider_unconfigured',
			status: 501,
		});
	}),
}));
vi.mock('../../api/_providers/huggingface.js', () => hfMock);

// Rate limiter: deterministic success, no Upstash dependency.
vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: { ...actual.limits, publicIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
		clientIp: () => '203.0.113.7',
	};
});

const { default: handler } = await import('../../api/x402/forge.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		getHeader(name) {
			return this.headers[String(name).toLowerCase()];
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

// A request the handler can consume: a real Readable (readBody in
// api/_lib/http.js reads via 'data'/'end' events like a Node IncomingMessage;
// a real stream supports both events and for-await) + headers/method/url.
function makeReq({ method = 'POST', url = '/api/x402/forge', headers = {}, body = null } = {}) {
	const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	req.method = method;
	req.url = url;
	req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers };
	return req;
}

describe('GET /api/x402/forge — pricing discovery', () => {
	it('returns the per-tier USDC pricing sourced from forge-tiers', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: '/api/x402/forge' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.route).toBe('/api/x402/forge');
		const standard = body.pricing_usdc.find((p) => p.tier === 'standard');
		expect(standard.price_usdc).toBe('0.15');
		expect(body.pricing_usdc.find((p) => p.tier === 'draft').price_usdc).toBe('0.05');
		expect(body.pricing_usdc.find((p) => p.tier === 'high').price_usdc).toBe('0.50');
	});
});

describe('POST /api/x402/forge — 402 challenge', () => {
	it('emits a 402 quoting the requested tier price when unpaid', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl', tier: 'high' } }), res);
		expect(res.statusCode).toBe(402);
		const body = JSON.parse(res.body);
		// High tier = $0.50 = 500000 atomic. The Base accept must quote it.
		const amounts = (body.accepts || []).map((a) => a.amount);
		expect(amounts).toContain('500000');
	});

	it('quotes the standard price by default', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'a brass owl' } }), res);
		expect(res.statusCode).toBe(402);
		const body = JSON.parse(res.body);
		expect((body.accepts || []).map((a) => a.amount)).toContain('150000');
	});
});

describe('POST /api/x402/forge — validation', () => {
	it('rejects a too-short prompt with no payment required', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { prompt: 'hi' } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_prompt');
	});

	it('rejects non-https image_urls', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { image_urls: ['http://insecure/x.png'] } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_image_urls');
	});
});

describe('POST /api/x402/forge — free NVIDIA NIM text lane', () => {
	it('routes a paid text prompt through the free NVIDIA lane and hands back a poll token (async)', async () => {
		// NVCF accepted the job for async processing — returns a request id to poll.
		nvidiaMock.createNvidiaProvider.mockReturnValueOnce({
			textTo3d: vi.fn(async () => ({ kind: 'text-to-3d', taskId: 'nvcf-req-abc123' })),
		});
		const res = makeRes();
		await handler(
			makeReq({ headers: { 'x-payment': 'pay-nvidia-async' }, body: { prompt: 'a brass steampunk owl', tier: 'high' } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.backend).toBe('nvidia');
		expect(body.mode).toBe('text_to_3d');
		expect(body.status).toBe('queued');
		// The poll token is a signed forge token (f1.*) so the free poll endpoint
		// routes the status check back to the NIM provider.
		expect(body.job_id.startsWith('f1.')).toBe(true);
		expect(body.poll_url).toBe('/api/forge?job=' + encodeURIComponent(body.job_id));
		expect(body.price_usdc).toBe('0.50');
		expect(res.headers['x-payment-response']).toBe('stub-payment-response');
	});

	it('returns the finished GLB inline when the NIM lane completes synchronously', async () => {
		nvidiaMock.createNvidiaProvider.mockReturnValueOnce({
			textTo3d: vi.fn(async () => ({
				kind: 'text-to-3d',
				taskId: null,
				resultGlbUrl: 'https://cdn.three.ws/forge/nvidia/abc.glb',
			})),
		});
		const res = makeRes();
		await handler(
			makeReq({ headers: { 'x-payment': 'pay-nvidia-sync' }, body: { prompt: 'a tiny red dragon', tier: 'draft' } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.backend).toBe('nvidia');
		expect(body.status).toBe('done');
		expect(body.glb_url).toBe('https://cdn.three.ws/forge/nvidia/abc.glb');
		expect(body.job_id).toBeNull();
		// Settlement still ran — the buyer paid and received a model.
		expect(res.headers['x-payment-response']).toBe('stub-payment-response');
	});

	it('degrades to the FLUX→TRELLIS reconstruct lane when the NIM lane is unavailable', async () => {
		// Default nvidiaMock throws (no key) → submitGeneration falls back to Replicate.
		const res = makeRes();
		await handler(
			makeReq({ headers: { 'x-payment': 'pay-fallback-trellis' }, body: { prompt: 'a brass owl', tier: 'standard' } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.backend).toBe('trellis');
		expect(body.job_id).toBe('abcd1234efgh5678ij');
		expect(body.poll_url).toBe('/api/forge?job=abcd1234efgh5678ij');
	});
});

describe('POST /api/x402/forge — paid generation', () => {
	it('submits a job and returns a free poll_url after payment (Replicate reconstruct fallback)', async () => {
		// NVIDIA unconfigured here (default mock throws), so this exercises the
		// reconstruct lane — the engine for image→3D and the text fallback.
		const res = makeRes();
		await handler(
			makeReq({ headers: { 'x-payment': 'pay-paid-standard' }, body: { prompt: 'a brass steampunk owl', tier: 'standard' } }),
			res,
		);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.job_id).toBe('abcd1234efgh5678ij');
		expect(body.poll_url).toBe('/api/forge?job=abcd1234efgh5678ij');
		expect(body.mode).toBe('text_to_3d');
		expect(body.tier).toBe('standard');
		expect(body.backend).toBe('trellis');
		expect(body.price_usdc).toBe('0.15');
		// Settlement ran (the x-payment-response header is set).
		expect(res.headers['x-payment-response']).toBe('stub-payment-response');
	});

	it('prefers the FREE HuggingFace lane over the paid Replicate reconstruct when available', async () => {
		// NVIDIA NIM unavailable (default throws) → reconstruct step. HF is live this
		// call, so it must be chosen BEFORE Replicate — the paid lane is never touched.
		hfMock.createRegenProvider.mockReturnValueOnce({
			submit: vi.fn(async () => ({ extJobId: 'hf-packed-job' })),
			status: vi.fn(async () => ({ status: 'done', resultGlbUrl: 'https://hf.example/out.glb' })),
		});
		replicateMock.submit.mockClear();
		// persistRemoteGlb fetches the GLB to copy it to R2; reject so it fail-softs to
		// the HF url without a real network call.
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in test'));
		try {
			const res = makeRes();
			await handler(
				makeReq({ headers: { 'x-payment': 'pay-free-hf' }, body: { prompt: 'a brass owl', tier: 'standard' } }),
				res,
			);
			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.backend).toBe('huggingface');
			expect(body.status).toBe('done');
			expect(body.glb_url).toBeTruthy();
			// Free was chosen first — the paid Replicate reconstruct was never invoked.
			expect(replicateMock.submit).not.toHaveBeenCalled();
			// The buyer still paid + received a model (settlement ran).
			expect(res.headers['x-payment-response']).toBe('stub-payment-response');
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('sanitizes a paid-lane "insufficient credit" failure into a clean unavailable state (no leak, no settle)', async () => {
		// NVIDIA unavailable, HF unavailable (default), Replicate out of credit: the
		// raw vendor billing message must never reach the buyer, and submit-before-
		// settle means the payment was not taken.
		replicateMock.submit.mockRejectedValueOnce(
			Object.assign(
				new Error(
					'You have insufficient credit to run this model. Go to https://replicate.com/account/billing#billing to purchase credit.',
				),
				{ code: 'provider_error', status: 502, providerStatus: 402 },
			),
		);
		const res = makeRes();
		await handler(
			makeReq({ headers: { 'x-payment': 'pay-broke-replicate' }, body: { prompt: 'a brass owl', tier: 'standard' } }),
			res,
		);
		expect(res.statusCode).toBe(503);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('generation_unavailable');
		expect(body.error_description).not.toMatch(/credit|replicate|billing|insufficient/i);
		// Submit failed before settle → no settlement receipt was emitted.
		expect(res.headers['x-payment-response']).toBeUndefined();
	});

	it('rejects a paid request that carries no actual input', async () => {
		const res = makeRes();
		await handler(makeReq({ headers: { 'x-payment': 'stub-payment-proof' }, body: {} }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('missing_input');
	});

	it('answers a generator throttle with 429 + Retry-After and does not settle', async () => {
		replicateMock.submit.mockRejectedValueOnce(
			Object.assign(new Error('Request was throttled. Your rate limit resets in ~10s.'), {
				code: 'rate_limited',
				status: 429,
				retryAfter: 10,
			}),
		);
		// Force the reconstruct lane (NVIDIA already throws by default → falls through).
		const res = makeRes();
		await handler(
			makeReq({ headers: { 'x-payment': 'stub-payment-proof' }, body: { prompt: 'a brass steampunk owl' } }),
			res,
		);
		expect(res.statusCode).toBe(429);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('rate_limited');
		expect(body.retry_after).toBe(10);
		expect(res.headers['retry-after']).toBe('10');
		// The buyer sees the endpoint's own clean, payment-aware copy — never the
		// upstream throttle text (which can name the generator account's internal
		// credit balance). The mock threw "Request was throttled. …rate limit…".
		expect(body.error_description).toBe(
			'Generation is briefly busy and your payment was not taken — retry in a few seconds.',
		);
		expect(body.error_description).not.toMatch(/throttl|rate limit|credit|\$5/i);
		// Submit failed before settle → no settlement receipt was emitted.
		expect(res.headers['x-payment-response']).toBeUndefined();
	});
});
