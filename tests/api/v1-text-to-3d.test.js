// POST /api/v1/ai/text-to-3d — the free, versioned text→3D endpoint.
//
// This is the flagship free lane of the AI package: a prompt goes to the NVIDIA
// NIM TRELLIS draft lane (via the SAME /api/forge submit the forge_free MCP tool
// uses) and comes back as a textured GLB — inline when fast, otherwise a job
// token + the existing free poll URL. The tests pin the contract that matters:
//   • validation (empty / too-short prompt → 400),
//   • missing NVIDIA env → 503 not_configured naming the var,
//   • per-IP daily quota → 429 with X-RateLimit-Reset + a paid-forge upsell,
//   • the lane response contract for the inline-done and pending paths, against
//     the REAL captured /api/forge draft-lane shapes.
//
// The rate limiter is mocked (switchable per test) and the network is stubbed via
// global fetch, so the suite runs fully offline while exercising the real handler,
// real originFromReq, and real viewerUrl.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// Switchable quota result — flip `quotaOk` per test. apiV1 always passes (it's the
// gateway's burst guard, not the thing under test here).
let quotaOk = true;
let quotaResult = { success: true, limit: 10, remaining: 9, reset: Date.now() + 86_400_000 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		aiTextTo3d: async () => (quotaOk ? { success: true, limit: 10, remaining: 9, reset: Date.now() + 86_400_000 } : quotaResult),
	},
	clientIp: () => '203.0.113.7',
}));

// Boundary stubs for the infra leaves the gateway/http import but the public
// text→3D path never exercises (no DB, no auth session, no Sentry, no ops
// alerts, no usage metering). Stubbing them keeps the suite hermetic — it
// exercises the REAL gateway control flow and REAL response envelope without
// depending on those packages being installed.
vi.mock('../../api/_lib/db.js', () => ({
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: () => {} }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => null, drain: async () => {} }));
vi.mock('../../api/_lib/usage.js', () => ({ recordEvent: () => {} }));
vi.mock('../../api/_lib/auth.js', () => ({
	authenticateBearer: async () => null,
	extractBearer: () => null,
	getSessionUser: async () => null,
	hasScope: () => true,
}));

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['NVIDIA_API_KEY', 'STUDIO_API_BASE', 'PUBLIC_APP_ORIGIN', 'APP_ORIGIN'];
const saved = {};

beforeEach(() => {
	quotaOk = true;
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	globalThis.fetch = ORIGINAL_FETCH;
	vi.restoreAllMocks();
});

function makeReq({ method = 'POST', url = '/api/v1/ai/text-to-3d', body = null, host = 'three.ws' } = {}) {
	const raw = body == null ? '' : JSON.stringify(body);
	const stream = Readable.from(raw ? [Buffer.from(raw)] : []);
	stream.method = method;
	stream.url = url;
	stream.headers = { 'content-type': 'application/json', host };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this._body = body;
			this.writableEnded = true;
		},
	};
}

async function dispatch(req, res) {
	const mod = await import('../../api/v1/ai/text-to-3d.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

// A JSON Response stub matching the subset of WHATWG Response startForge reads.
function jsonResponse(obj, { status = 200 } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => 'application/json' },
		json: async () => obj,
		text: async () => JSON.stringify(obj),
	};
}

// ── Real captured /api/forge draft-lane shapes (NVIDIA NIM TRELLIS) ───────────
// Inline finish — the sync branch (api/forge.js): job_id null, status done, GLB.
const DONE_FIXTURE = {
	job_id: null,
	creation_id: 'a1b2c3d4-0000-4000-8000-000000000001',
	status: 'done',
	glb_url: 'https://three.ws/cdn/forge/anon/a1b2c3d4.glb',
	durable: true,
	backend: 'nvidia',
	tier: 'draft',
	path: 'image',
};
// Queued — the async branch: a signed f1.* job token, status queued, no GLB yet.
const QUEUED_FIXTURE = {
	job_id: 'f1.eyJwIjoibnZpZGlhIiwiayI6InRleHQiLCJ0IjoibmltLXRhc2stMTIzIn0.c2lnbmF0dXJl',
	creation_id: 'a1b2c3d4-0000-4000-8000-000000000002',
	status: 'queued',
};

describe('shapeResult — lane boundary contract', () => {
	it('maps the inline-done shape to a done payload with a viewer URL', async () => {
		const { shapeResult } = await import('../../api/v1/ai/_text-to-3d-lane.js');
		const out = shapeResult(DONE_FIXTURE, 'https://three.ws');
		expect(out).toEqual({
			status: 'done',
			glb_url: 'https://three.ws/cdn/forge/anon/a1b2c3d4.glb',
			viewer_url: 'https://three.ws/viewer?src=' + encodeURIComponent(DONE_FIXTURE.glb_url),
			creation_id: 'a1b2c3d4-0000-4000-8000-000000000001',
			backend: 'nvidia',
			tier: 'draft',
		});
	});

	it('maps the queued shape to a pending payload with the free poll URL', async () => {
		const { shapeResult } = await import('../../api/v1/ai/_text-to-3d-lane.js');
		const out = shapeResult(QUEUED_FIXTURE, 'https://three.ws');
		expect(out).toEqual({
			status: 'pending',
			job: QUEUED_FIXTURE.job_id,
			poll_url: '/api/forge?job=' + encodeURIComponent(QUEUED_FIXTURE.job_id),
			viewer_url: null,
			backend: 'nvidia',
			tier: 'draft',
		});
	});
});

describe('POST /api/v1/ai/text-to-3d — validation', () => {
	it('rejects an empty prompt with 400', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const { res, body } = await dispatch(makeReq({ body: { prompt: '' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects a too-short prompt with 400', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'ab' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

describe('POST /api/v1/ai/text-to-3d — configuration', () => {
	it('returns 503 not_configured (var named to the operator, not the client) when the lane is unconfigured', async () => {
		// The platform never leaks which secret is unset to the client; the var is
		// named to the operator via the log line. Spy on it to prove that.
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('not_configured');
		// Client body stays generic (no secret name leaked).
		expect(body.error_description).not.toMatch(/NVIDIA_API_KEY/);
		// Operator-facing log names the exact missing var.
		expect(errSpy.mock.calls.flat().join(' ')).toMatch(/NVIDIA_API_KEY/);
	});
});

describe('POST /api/v1/ai/text-to-3d — quota', () => {
	it('returns 429 with X-RateLimit-Reset and a paid-forge upsell above quota', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		quotaOk = false;
		quotaResult = { success: false, limit: 10, remaining: 0, reset: Date.now() + 3_600_000 };
		// The lane must never be reached once quota is exhausted.
		globalThis.fetch = vi.fn(async () => {
			throw new Error('lane should not be called when over quota');
		});
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('quota_exceeded');
		expect(res.getHeader('x-ratelimit-reset')).toBeTruthy();
		expect(Number(res.getHeader('x-ratelimit-reset'))).toBeGreaterThan(0);
		expect(res.getHeader('retry-after')).toBeTruthy();
		expect(body.upgrade.endpoint).toBe('/api/x402/forge');
		expect(body.retry_after).toBeGreaterThan(0);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('POST /api/v1/ai/text-to-3d — response contract', () => {
	it('returns { status: done, glb_url, viewer_url } when the lane finishes inline', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		globalThis.fetch = vi.fn(async () => jsonResponse(DONE_FIXTURE));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data.status).toBe('done');
		expect(body.data.glb_url).toBe(DONE_FIXTURE.glb_url);
		expect(body.data.viewer_url).toBe('https://three.ws/viewer?src=' + encodeURIComponent(DONE_FIXTURE.glb_url));
		// The lane was submitted with the pinned free NVIDIA draft params.
		const [, opts] = globalThis.fetch.mock.calls[0];
		const sent = JSON.parse(opts.body);
		expect(sent).toMatchObject({ prompt: 'a small ceramic robot figurine', backend: 'nvidia', path: 'image', tier: 'draft' });
	});

	it('returns { status: pending, job, poll_url } when the lane queues the job', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		globalThis.fetch = vi.fn(async () => jsonResponse(QUEUED_FIXTURE));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data.status).toBe('pending');
		expect(body.data.job).toBe(QUEUED_FIXTURE.job_id);
		expect(body.data.poll_url).toBe('/api/forge?job=' + encodeURIComponent(QUEUED_FIXTURE.job_id));
		expect(body.data.viewer_url).toBeNull();
	});
});
