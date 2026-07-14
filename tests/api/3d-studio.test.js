// Tests for POST /api/3d/studio + GET /api/3d/studio?job=<id> — the ChatGPT
// Actions surface for free text→3D behind the "three.ws 3D Studio" custom GPT.
//
// Beyond the generate-lane lifecycle (mirrored from tests/api/3d-generate.test.js),
// this suite pins the two properties that make the route submittable to the GPT
// Store: every prompt passes the age-13+ safety gate before any lane work, and
// every response body is free of upsell/pricing/crypto fields.
//
// The rate limiter is mocked (switchable per test) and the network is stubbed via
// global fetch, so the suite runs fully offline while exercising the real handler,
// real safety gate, real originFromReq, real viewerUrl, and the real shape helpers
// against the REAL captured /api/forge draft-lane shapes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

let freeOk = true;
let freeResult = { success: true, limit: 60, remaining: 59, reset: Date.now() + 3_600_000 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dGenerateFree: async () =>
			freeOk ? { success: true, limit: 60, remaining: 59, reset: Date.now() + 3_600_000 } : freeResult,
		mcp3dStatus: async () => ({ success: true, limit: 240, remaining: 239, reset: Date.now() + 60_000 }),
	},
	clientIp: () => '203.0.113.7',
}));

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['STUDIO_API_BASE', 'PUBLIC_APP_ORIGIN', 'APP_ORIGIN'];
const saved = {};

beforeEach(() => {
	freeOk = true;
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

function makeReq({ method = 'POST', url = '/api/3d/studio', body = null, host = 'three.ws' } = {}) {
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
	const mod = await import('../../api/3d/studio.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

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
const SUBMIT_DONE = {
	job_id: null,
	creation_id: 'a1b2c3d4-0000-4000-8000-000000000001',
	status: 'done',
	glb_url: 'https://cdn.three.ws/forge/anon/a1b2c3d4.glb',
	durable: true,
	backend: 'nvidia',
	tier: 'draft',
	path: 'image',
};
const SUBMIT_QUEUED = {
	job_id: 'f1.eyJwIjoibnZpZGlhIiwiayI6InRleHQiLCJ0IjoibmltLXRhc2stMTIzIn0.c2lnbmF0dXJl',
	creation_id: 'a1b2c3d4-0000-4000-8000-000000000002',
	status: 'queued',
};
const POLL_DONE = { job_id: SUBMIT_QUEUED.job_id, status: 'done', glb_url: 'https://cdn.three.ws/forge/anon/done.glb', durable: true };
const POLL_RUNNING = { job_id: SUBMIT_QUEUED.job_id, status: 'running' };
const POLL_FAILED = { job_id: SUBMIT_QUEUED.job_id, status: 'failed', error: 'the generator hit a snag' };

// The GPT Store wire contract: nothing in any response body may reference
// pricing, upsells, or crypto surfaces, and internal creation ids stay internal.
const FORBIDDEN_WIRE_RE = /x402|wallet|coin|upgrade|forgePro|price|usd|creation_id|token(?!s)/i;

function expectCleanWire(body) {
	expect(JSON.stringify(body)).not.toMatch(FORBIDDEN_WIRE_RE);
}

describe('shape helpers — Actions wire contract', () => {
	it('shapeSubmit maps inline-done to { done, glbUrl, viewerUrl, arUrl } with nothing else attached', async () => {
		const { shapeSubmit } = await import('../../api/3d/studio.js');
		const out = shapeSubmit(SUBMIT_DONE, 'https://three.ws', 'a small ceramic robot figurine');
		expect(out).toEqual({
			status: 'done',
			glbUrl: SUBMIT_DONE.glb_url,
			viewerUrl: 'https://three.ws/viewer?src=' + encodeURIComponent(SUBMIT_DONE.glb_url),
			arUrl:
				'https://three.ws/api/ar?src=' +
				encodeURIComponent(SUBMIT_DONE.glb_url) +
				'&title=' +
				encodeURIComponent('a small ceramic robot figurine'),
			format: 'glb',
		});
		expectCleanWire(out);
	});

	it('shapeSubmit maps queued to { pending, job, poll } carrying the prompt as the AR title', async () => {
		const { shapeSubmit } = await import('../../api/3d/studio.js');
		const out = shapeSubmit(SUBMIT_QUEUED, 'https://three.ws', 'a small ceramic robot figurine');
		expect(out.status).toBe('pending');
		expect(out.job).toBe(SUBMIT_QUEUED.job_id);
		expect(out.poll).toBe(
			'/api/3d/studio?job=' +
				encodeURIComponent(SUBMIT_QUEUED.job_id) +
				'&title=' +
				encodeURIComponent('a small ceramic robot figurine'),
		);
		expectCleanWire(out);
	});

	it('shapePoll maps done/running/failed forge shapes cleanly, echoing the title into arUrl', async () => {
		const { shapePoll } = await import('../../api/3d/studio.js');
		const done = shapePoll(POLL_DONE, 'https://three.ws', SUBMIT_QUEUED.job_id, 'a tiny fox');
		expect(done.status).toBe('done');
		expect(done.glbUrl).toBe(POLL_DONE.glb_url);
		expect(done.viewerUrl).toContain('/viewer?src=');
		expect(done.arUrl).toBe(
			'https://three.ws/api/ar?src=' + encodeURIComponent(POLL_DONE.glb_url) + '&title=' + encodeURIComponent('a tiny fox'),
		);
		expectCleanWire(done);

		// No title (a caller polling with the bare job handle) → arUrl still present.
		const doneBare = shapePoll(POLL_DONE, 'https://three.ws', SUBMIT_QUEUED.job_id);
		expect(doneBare.arUrl).toBe('https://three.ws/api/ar?src=' + encodeURIComponent(POLL_DONE.glb_url));

		const pending = shapePoll(POLL_RUNNING, 'https://three.ws', SUBMIT_QUEUED.job_id, 'a tiny fox');
		expect(pending.status).toBe('pending');
		expect(pending.poll).toContain('/api/3d/studio?job=');
		expect(pending.poll).toContain('&title=' + encodeURIComponent('a tiny fox'));
		expectCleanWire(pending);

		const err = shapePoll(POLL_FAILED, 'https://three.ws', SUBMIT_QUEUED.job_id);
		expect(err.status).toBe('error');
		expect(err.error).toBe(POLL_FAILED.error);
		expectCleanWire(err);
	});
});

describe('POST /api/3d/studio — safety gate', () => {
	it('refuses a sexual-content prompt with 400 prompt_rejected before any lane work', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('lane must not be called for a refused prompt');
		});
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a nude figure statue' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('prompt_rejected');
		expect(body.message).toMatch(/ages 13\+/);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('refuses gore, hate iconography, and real-weapon prompts', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('lane must not be called for a refused prompt');
		});
		for (const prompt of ['a gory decapitated head', 'a swastika banner', 'an ar-15 rifle model']) {
			const { res, body } = await dispatch(makeReq({ body: { prompt } }), makeRes());
			expect(res.statusCode).toBe(400);
			expect(body.error).toBe('prompt_rejected');
		}
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('lets an ordinary creative prompt through (fantasy props are fine)', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(SUBMIT_DONE));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a knight holding a fantasy sword' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('done');
	});
});

describe('POST /api/3d/studio — validation + rate limit', () => {
	it('rejects an empty prompt with 400', async () => {
		const { res, body } = await dispatch(makeReq({ body: { prompt: '' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_prompt');
	});

	it('rejects an oversized prompt with 400', async () => {
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'x'.repeat(1001) } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_prompt');
	});

	it('returns a clean 429 (no upsell block) when the shared free-lane cap is hit', async () => {
		freeOk = false;
		freeResult = { success: false, limit: 60, remaining: 0, reset: Date.now() + 600_000 };
		globalThis.fetch = vi.fn(async () => {
			throw new Error('lane should not be called when rate-limited');
		});
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBeTruthy();
		expectCleanWire(body);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('POST /api/3d/studio — response contract', () => {
	it('returns { done, glbUrl, viewerUrl, arUrl } inline with the pinned fast free-lane params', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(SUBMIT_DONE));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('done');
		expect(body.glbUrl).toBe(SUBMIT_DONE.glb_url);
		expect(body.viewerUrl).toBe('https://three.ws/viewer?src=' + encodeURIComponent(SUBMIT_DONE.glb_url));
		// The place-in-your-room link is first-class on every finished generation,
		// labeled with the user's prompt.
		expect(body.arUrl).toBe(
			'https://three.ws/api/ar?src=' +
				encodeURIComponent(SUBMIT_DONE.glb_url) +
				'&title=' +
				encodeURIComponent('a small ceramic robot figurine'),
		);
		expectCleanWire(body);
		const [, opts] = globalThis.fetch.mock.calls[0];
		expect(JSON.parse(opts.body)).toMatchObject({ prompt: 'a small ceramic robot figurine', backend: 'nvidia', path: 'image', tier: 'standard' });
	});

	it('submits a known brand-mark prompt as image→3D against the deployment-hosted reference view', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(SUBMIT_DONE));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'pumpfun logo' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('done');
		expectCleanWire(body);
		const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		// The reference view is served by the same deployment the job is submitted
		// to, and the raw brand text never reaches the generator (it would be
		// lettered onto the mesh as garbled noise).
		expect(sent.image_urls).toEqual(['https://three.ws/marks/pump-fun.png']);
		expect(sent.prompt).toMatch(/capsule/i);
		expect(sent.prompt.toLowerCase()).not.toContain('pumpfun');
		expect(sent.backend).toBeUndefined();
	});

	it('startForge attaches the internal seed token on internal requests when CRON_SECRET is set', async () => {
		process.env.CRON_SECRET = 'test-seed-secret';
		try {
			const { startForge } = await import('../../api/_mcp-studio/forge-client.js');
			globalThis.fetch = vi.fn(async () => jsonResponse(SUBMIT_DONE));
			await startForge('https://three.ws', { prompt: 'a teapot', tier: 'high', internal: true });
			expect(globalThis.fetch.mock.calls[0][1].headers['x-forge-seed']).toBe('test-seed-secret');
		} finally {
			delete process.env.CRON_SECRET;
		}
	});

	it('startForge falls back to the ungated standard tier when the high-tier gate returns 402', async () => {
		const { startForge } = await import('../../api/_mcp-studio/forge-client.js');
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ error: 'three_hold_required' }, { status: 402 }))
			.mockResolvedValueOnce(jsonResponse(SUBMIT_DONE));
		const job = await startForge('https://three.ws', { prompt: 'a teapot', tier: 'high', internal: true });
		expect(job.glb_url).toBe(SUBMIT_DONE.glb_url);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		const retry = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
		expect(retry.tier).toBe('standard');
		expect(globalThis.fetch.mock.calls[1][1].headers['x-forge-seed']).toBeUndefined();
	});

	it('startForge falls back to standard when the high-tier submit times out (blocking lane)', async () => {
		const { startForge } = await import('../../api/_mcp-studio/forge-client.js');
		const abortErr = Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
		globalThis.fetch = vi.fn().mockRejectedValueOnce(abortErr).mockResolvedValueOnce(jsonResponse(SUBMIT_DONE));
		const job = await startForge('https://three.ws', { prompt: 'a teapot', tier: 'high', internal: true });
		expect(job.glb_url).toBe(SUBMIT_DONE.glb_url);
		expect(JSON.parse(globalThis.fetch.mock.calls[1][1].body).tier).toBe('standard');
	});

	it('returns { pending, job, poll } when the lane queues the job, carrying the AR title', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(SUBMIT_QUEUED));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('pending');
		expect(body.job).toBe(SUBMIT_QUEUED.job_id);
		expect(body.poll).toBe(
			'/api/3d/studio?job=' +
				encodeURIComponent(SUBMIT_QUEUED.job_id) +
				'&title=' +
				encodeURIComponent('a small ceramic robot figurine'),
		);
		expectCleanWire(body);
	});

	it('maps an unconfigured lane to a designed 503 with no deployment internals', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ message: '3D generation is not configured — set NVIDIA_API_KEY' }, { status: 503 }));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('not_configured');
		// The env-var hint from the internal lane must not leak to the GPT wire.
		expect(body.message).not.toMatch(/NVIDIA_API_KEY|env/i);
	});

	it('maps an upstream 429 (GPU lane saturated) to 429 + retry-after', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ message: 'busy', retry_after: 12 }, { status: 429 }));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBe('12');
	});
});

describe('GET /api/3d/studio?job= — poll lifecycle', () => {
	it('400s when no job param is present', async () => {
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/studio' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('missing_job');
	});

	it('400s on a malformed job handle', async () => {
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/studio?job=bad*job*id' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_job');
	});

	it('returns pending while the job runs', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(POLL_RUNNING));
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/studio?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('pending');
		expect(body.poll).toContain('/api/3d/studio?job=');
		expectCleanWire(body);
	});

	it('returns done with glbUrl + viewerUrl + arUrl when the job finishes', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(POLL_DONE));
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/studio?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('done');
		expect(body.glbUrl).toBe(POLL_DONE.glb_url);
		expect(body.viewerUrl).toContain('/viewer?src=');
		expect(body.arUrl).toContain('/api/ar?src=');
		expectCleanWire(body);
	});

	it('echoes the poll title into the done arUrl so the AR page stays labeled', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(POLL_DONE));
		const { res, body } = await dispatch(
			makeReq({ method: 'GET', url: `/api/3d/studio?job=${SUBMIT_QUEUED.job_id}&title=${encodeURIComponent('a tiny fox')}` }),
			makeRes(),
		);
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('done');
		expect(body.arUrl).toContain('&title=' + encodeURIComponent('a tiny fox'));
		expectCleanWire(body);
	});

	it('returns status:error when the job failed upstream', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(POLL_FAILED));
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/studio?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('error');
		expect(body.error).toBe(POLL_FAILED.error);
		expectCleanWire(body);
	});

	it('treats a transient poll network error as pending', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('network blip');
		});
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/studio?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('pending');
	});
});

describe('endpoint source — GPT Store compliance', () => {
	it('the route source contains no crypto/pricing surface strings', async () => {
		const { readFile } = await import('node:fs/promises');
		const src = await readFile(new URL('../../api/3d/studio.js', import.meta.url), 'utf8');
		expect(src).not.toMatch(/x402|wallet|\bcoin\b|pump|aixbt|\$THREE|forgePro|upgrade/i);
	});
});
