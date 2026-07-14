// Tests for POST /api/3d/generate + GET /api/3d/generate?job=<id> — the free,
// keyless, agent-first text→3D front door that wraps the /api/forge draft lane.
//
// The rate limiter is mocked (switchable per test) and the network is stubbed via
// global fetch, so the suite runs fully offline while exercising the real handler,
// real originFromReq, real viewerUrl, and the real shape helpers against the REAL
// captured /api/forge draft-lane shapes (inline-done, queued, poll-done, failed).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// Switchable free-lane quota — flip `freeOk` per test. mcp3dStatus (poll flood
// guard) always passes; it isn't the thing under test.
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

function makeReq({ method = 'POST', url = '/api/3d/generate', body = null, host = 'three.ws' } = {}) {
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
	const mod = await import('../../api/3d/generate.js');
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

describe('shape helpers — lane boundary contract', () => {
	it('shapeSubmit maps the inline-done shape to a done payload with a viewer URL', async () => {
		const { shapeSubmit } = await import('../../api/3d/generate.js');
		const out = shapeSubmit(SUBMIT_DONE, 'https://three.ws');
		expect(out.status).toBe('done');
		expect(out.glbUrl).toBe(SUBMIT_DONE.glb_url);
		expect(out.viewerUrl).toBe('https://three.ws/viewer?src=' + encodeURIComponent(SUBMIT_DONE.glb_url));
		expect(out.format).toBe('glb');
		expect(out.tier).toBe('draft');
		expect(out.free).toBe(true);
	});

	it('shapeSubmit maps the queued shape to a pending payload with the poll URL', async () => {
		const { shapeSubmit } = await import('../../api/3d/generate.js');
		const out = shapeSubmit(SUBMIT_QUEUED, 'https://three.ws');
		expect(out.status).toBe('pending');
		expect(out.job).toBe(SUBMIT_QUEUED.job_id);
		expect(out.poll).toBe('/api/3d/generate?job=' + encodeURIComponent(SUBMIT_QUEUED.job_id));
		expect(out.free).toBe(true);
	});

	it('shapePoll maps done/running/failed forge poll shapes', async () => {
		const { shapePoll } = await import('../../api/3d/generate.js');
		const done = shapePoll(POLL_DONE, 'https://three.ws', SUBMIT_QUEUED.job_id);
		expect(done.status).toBe('done');
		expect(done.glbUrl).toBe(POLL_DONE.glb_url);
		expect(done.viewerUrl).toContain('/viewer?src=');

		const pending = shapePoll(POLL_RUNNING, 'https://three.ws', SUBMIT_QUEUED.job_id);
		expect(pending.status).toBe('pending');
		expect(pending.poll).toContain('/api/3d/generate?job=');

		const err = shapePoll(POLL_FAILED, 'https://three.ws', SUBMIT_QUEUED.job_id);
		expect(err.status).toBe('error');
		expect(err.error).toBe(POLL_FAILED.error);
		expect(err.free).toBe(true);
	});
});

describe('POST /api/3d/generate — validation', () => {
	it('rejects an empty prompt with 400', async () => {
		const { res, body } = await dispatch(makeReq({ body: { prompt: '' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_prompt');
	});

	it('rejects a too-short prompt with 400', async () => {
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'ab' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_prompt');
	});

	it('rejects an oversized prompt with 400', async () => {
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'x'.repeat(1001) } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_prompt');
	});

	it('rejects an unsupported format with 400', async () => {
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine', format: 'obj' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('unsupported_format');
	});
});

describe('POST /api/3d/generate — rate limit', () => {
	it('returns 429 with an upgrade pointer when the free lane cap is hit', async () => {
		freeOk = false;
		freeResult = { success: false, limit: 60, remaining: 0, reset: Date.now() + 600_000 };
		globalThis.fetch = vi.fn(async () => {
			throw new Error('lane should not be called when rate-limited');
		});
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBeTruthy();
		expect(body.upgrade.forgePro).toBe('/api/x402/forge');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

describe('POST /api/3d/generate — response contract', () => {
	it('returns { status: done, glbUrl, viewerUrl } when the lane finishes inline', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(SUBMIT_DONE));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('done');
		expect(body.glbUrl).toBe(SUBMIT_DONE.glb_url);
		expect(body.viewerUrl).toBe('https://three.ws/viewer?src=' + encodeURIComponent(SUBMIT_DONE.glb_url));
		// The place-in-your-room AR link rides along, labeled with the prompt.
		expect(body.arUrl).toBe(
			'https://three.ws/api/ar?src=' +
				encodeURIComponent(SUBMIT_DONE.glb_url) +
				'&title=' +
				encodeURIComponent('a small ceramic robot figurine'),
		);
		// The lane was submitted with the pinned free NVIDIA draft params.
		const [, opts] = globalThis.fetch.mock.calls[0];
		expect(JSON.parse(opts.body)).toMatchObject({ prompt: 'a small ceramic robot figurine', backend: 'nvidia', path: 'image', tier: 'draft' });
	});

	it('returns { status: pending, job, poll } when the lane queues the job, carrying the AR title', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(SUBMIT_QUEUED));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('pending');
		expect(body.job).toBe(SUBMIT_QUEUED.job_id);
		expect(body.poll).toBe(
			'/api/3d/generate?job=' +
				encodeURIComponent(SUBMIT_QUEUED.job_id) +
				'&title=' +
				encodeURIComponent('a small ceramic robot figurine'),
		);
	});

	it('surfaces a 503 not_configured when the lane is unconfigured', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ message: '3D generation is not configured' }, { status: 503 }));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('not_configured');
	});

	it('maps an upstream 429 (GPU lane saturated) to 429 + retry-after', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ message: 'busy', retry_after: 12 }, { status: 429 }));
		const { res, body } = await dispatch(makeReq({ body: { prompt: 'a small ceramic robot figurine' } }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBe('12');
	});
});

describe('GET /api/3d/generate?job= — poll lifecycle', () => {
	it('400s when no job param is present', async () => {
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/generate' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('missing_job');
	});

	it('treats a whitespace-only job param as missing', async () => {
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/generate?job=%20%20' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('missing_job');
	});

	it('400s on a malformed job handle', async () => {
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/generate?job=bad*job*id' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_job');
	});

	it('returns pending while the job runs', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(POLL_RUNNING));
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/generate?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('pending');
		expect(body.poll).toContain('/api/3d/generate?job=');
	});

	it('returns done with glbUrl + viewerUrl when the job finishes', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(POLL_DONE));
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/generate?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('done');
		expect(body.glbUrl).toBe(POLL_DONE.glb_url);
		expect(body.viewerUrl).toContain('/viewer?src=');
	});

	it('returns status:error (no charge) when the job failed upstream', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(POLL_FAILED));
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/generate?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('error');
		expect(body.error).toBe(POLL_FAILED.error);
		expect(body.free).toBe(true);
	});

	it('treats a transient poll network error as pending', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('network blip');
		});
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: `/api/3d/generate?job=${SUBMIT_QUEUED.job_id}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.status).toBe('pending');
	});
});

describe('catalog entry', () => {
	it('exports a well-formed entry the /api/3d index can merge', async () => {
		const entry = (await import('../../api/_lib/3d-catalog/generate.js')).default;
		expect(entry.slug).toBe('generate');
		expect(entry.method).toBe('POST');
		expect(entry.path).toBe('/api/3d/generate');
		expect(entry.free).toBe(true);
		expect(entry.inputSchema.required).toContain('prompt');
		expect(entry.example.request.path).toBe('/api/3d/generate');
	});
});
