// Handler tests for the Magic Brush region-retexture gateway
// (api/studio/retexture-region.js).
//
// Only the two real external boundaries are stubbed: the auth lookup, the rate
// limiter, and the SSRF DNS probe (each covered by its own suite), plus
// global.fetch standing in for the GCP texture worker's HTTP surface. The
// provider (api/_providers/gcp.js) runs for real, so these pin the actual wire
// contract this endpoint speaks to workers/texture: POST /retexture_region and
// GET /tasks/:id, and the opaque job token that carries the task handle between
// them.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (req) => req.headers?.authorization?.replace(/^Bearer /i, '') || null,
	hasScope: (scopes, want) => String(scopes || '').split(/[\s,]+/).includes(want),
}));

// Quota behaviour has its own suites; here the limiters are open so the handler
// logic is what's under test. `allow` flips them to exercise the 429 path.
let allow = true;
const limitResult = () => ({
	success: allow,
	limit: 60,
	remaining: allow ? 59 : 0,
	reset: 1_000_000,
});
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.7',
	limits: {
		upload: async () => limitResult(),
		mcp3dStatus: async () => limitResult(),
	},
}));

// The guard resolves DNS; its own behaviour is covered by tests/ssrf-pinned-lookup
// and tests/auto-rig-ssrf. Here it enforces the shape the handler depends on
// (https + public host) without touching the network.
vi.mock('../api/_lib/ssrf-guard.js', () => ({
	assertSafePublicUrl: async (raw, { allowHttp = false } = {}) => {
		const u = new URL(raw);
		if (u.protocol !== 'https:' && !allowHttp) throw new Error('https required');
		if (/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) throw new Error('private host');
		return u;
	},
}));

const WORKER = 'https://texture-worker.test';
const { default: handler } = await import('../api/studio/retexture-region.js');

const MESH = 'https://three.ws/cdn/models/avatar.glb';
const MASK = 'iVBORw0KGgoAAAANSUhEUg==';

function mkReq({ method = 'GET', url = '/api/studio/retexture-region', headers = {}, body = null } = {}) {
	return {
		method,
		url,
		headers: { ...headers },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(cb);
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			this.body = chunk;
			this.writableEnded = true;
		},
	};
}

async function call(opts) {
	const res = mkRes();
	await handler(mkReq(opts), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, res };
}

const post = (body) =>
	call({ method: 'POST', headers: { 'content-type': 'application/json' }, body });
const poll = (job) =>
	call({ url: `/api/studio/retexture-region?job=${encodeURIComponent(job)}` });

const realFetch = global.fetch;
afterAll(() => {
	global.fetch = realFetch;
});

let workerCalls = [];

beforeEach(() => {
	allow = true;
	workerCalls = [];
	process.env.GCP_RECONSTRUCTION_KEY = 'test-worker-key';
	process.env.GCP_TEXTURE_URL = WORKER;
	getSessionUserMock.mockReset().mockResolvedValue({ id: 'user-1' });
	authenticateBearerMock.mockReset().mockResolvedValue(null);

	global.fetch = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		workerCalls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
		if (u === `${WORKER}/retexture_region`) {
			return { ok: true, status: 200, json: async () => ({ task_id: 'task-42', status: 'queued' }) };
		}
		if (u.startsWith(`${WORKER}/tasks/`)) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ status: 'done', result_url: 'https://three.ws/cdn/out/avatar-retex.glb' }),
			};
		}
		throw new Error(`unexpected fetch: ${u}`);
	});
});

describe('POST /api/studio/retexture-region: the success path', () => {
	it('submits the masked region to the texture worker and returns an opaque job token', async () => {
		const { status, body } = await post({
			mesh_url: MESH,
			prompt: 'worn red leather',
			mask_b64: MASK,
			texture_size: 2048,
			strength: 0.6,
		});

		expect(status).toBe(202);
		expect(body.ok).toBe(true);
		expect(body.status).toBe('queued');
		expect(typeof body.job).toBe('string');

		expect(workerCalls).toHaveLength(1);
		const sent = workerCalls[0];
		expect(sent.url).toBe(`${WORKER}/retexture_region`);
		expect(sent.method).toBe('POST');
		expect(sent.headers.authorization).toBe('Bearer test-worker-key');
		expect(sent.body).toMatchObject({
			mesh: MESH,
			prompt: 'worn red leather',
			mask_b64: MASK,
			texture_size: 2048,
			strength: 0.6,
			feather: 24,
			seed: 0,
		});

		// The token carries the task handle plus the worker it was issued for.
		const job = JSON.parse(Buffer.from(body.job, 'base64url').toString('utf8'));
		expect(job).toMatchObject({ mode: 'retex_region', taskId: 'task-42', baseUrl: WORKER });
	});

	it('accepts a colour-only edit with no prompt', async () => {
		const { status } = await post({ mesh_url: MESH, mask_b64: MASK, color: '#3fa9f5' });
		expect(status).toBe(202);
		expect(workerCalls[0].body.color).toBe('#3fa9f5');
	});

	it('polls the task through and hands back the finished texture', async () => {
		const { body: submitted } = await post({ mesh_url: MESH, prompt: 'brushed steel', mask_b64: MASK });
		const { status, body } = await poll(submitted.job);

		expect(status).toBe(200);
		expect(body).toMatchObject({
			ok: true,
			status: 'done',
			result_url: 'https://three.ws/cdn/out/avatar-retex.glb',
			error: null,
		});
		expect(workerCalls[1].url).toBe(`${WORKER}/tasks/task-42`);
	});
});

describe('auth and quota', () => {
	it('rejects an anonymous submit and an anonymous poll with 401', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const submit = await post({ mesh_url: MESH, prompt: 'gold leaf', mask_b64: MASK });
		expect(submit.status).toBe(401);
		expect(submit.body.error).toBe('unauthorized');

		const status = await poll('anything');
		expect(status.status).toBe(401);
		expect(workerCalls).toHaveLength(0);
	});

	it('accepts a bearer token carrying the avatars:write scope', async () => {
		getSessionUserMock.mockResolvedValue(null);
		authenticateBearerMock.mockResolvedValue({ userId: 'agent-9', scope: 'avatars:read avatars:write' });
		const { status } = await call({
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
			body: { mesh_url: MESH, prompt: 'gold leaf', mask_b64: MASK },
		});
		expect(status).toBe(202);
	});

	it('rejects a bearer token missing the write scope', async () => {
		getSessionUserMock.mockResolvedValue(null);
		authenticateBearerMock.mockResolvedValue({ userId: 'agent-9', scope: 'avatars:read' });
		const { status, body } = await call({
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
			body: { mesh_url: MESH, prompt: 'gold leaf', mask_b64: MASK },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('rate-limits both the submit and the status poll', async () => {
		allow = false;
		const submit = await post({ mesh_url: MESH, prompt: 'gold leaf', mask_b64: MASK });
		expect(submit.status).toBe(429);
		expect(submit.body.error).toBe('rate_limited');

		const status = await poll('anything');
		expect(status.status).toBe(429);
		expect(workerCalls).toHaveLength(0);
	});
});

describe('input validation', () => {
	it('rejects a request with neither a usable prompt nor a colour', async () => {
		const { status, body } = await post({ mesh_url: MESH, mask_b64: MASK, prompt: 'ab' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toContain('prompt');
	});

	it.each([
		['a missing mesh_url and mask', {}],
		['a non-hex colour', { mesh_url: MESH, mask_b64: MASK, color: 'reddish' }],
		['an unsupported texture size', { mesh_url: MESH, mask_b64: MASK, prompt: 'x-ray', texture_size: 333 }],
		['an out-of-range strength', { mesh_url: MESH, mask_b64: MASK, prompt: 'x-ray', strength: 4 }],
		['a fractional feather', { mesh_url: MESH, mask_b64: MASK, prompt: 'x-ray', feather: 2.5 }],
	])('rejects %s with a 400 JSON error', async (_label, body) => {
		const { status, body: out } = await post(body);
		expect(status).toBe(400);
		expect(out.error).toBe('validation_error');
		expect(workerCalls).toHaveLength(0);
	});

	it('rejects a mesh_url the SSRF guard will not vouch for', async () => {
		const { status, body } = await post({
			mesh_url: 'http://127.0.0.1:8080/private.glb',
			prompt: 'gold leaf',
			mask_b64: MASK,
		});
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_mesh_url');
		expect(workerCalls).toHaveLength(0);
	});

	it('rejects a poll with no job token', async () => {
		const { status, body } = await call({ url: '/api/studio/retexture-region' });
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_request');
	});
});

describe('job-token forgery cannot steer the server fetch', () => {
	it('refuses a token pointing at a host that is not the configured worker', async () => {
		const forged = Buffer.from(
			JSON.stringify({ mode: 'retex_region', taskId: 'x', baseUrl: 'https://evil.example.com' }),
		).toString('base64url');
		const { status, body } = await poll(forged);
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_job');
		expect(workerCalls).toHaveLength(0);
	});

	it('refuses a token for a different worker mode on our own host', async () => {
		const forged = Buffer.from(
			JSON.stringify({ mode: 'reconstruct', taskId: 'x', baseUrl: WORKER }),
		).toString('base64url');
		const { status, body } = await poll(forged);
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_job');
		expect(workerCalls).toHaveLength(0);
	});

	it('refuses a token that is not decodable at all', async () => {
		const { status, body } = await poll('%%%not-a-token%%%');
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_job');
		expect(workerCalls).toHaveLength(0);
	});
});

describe('the texture worker is unavailable', () => {
	it('answers 501 on both verbs when the worker URL is unset, never a bogus "malformed token"', async () => {
		// A token issued while the lane was up must not be reported as forged just
		// because the deployment lost GCP_TEXTURE_URL: the honest answer is 501.
		const { body: submitted } = await post({ mesh_url: MESH, prompt: 'brushed steel', mask_b64: MASK });
		delete process.env.GCP_TEXTURE_URL;

		const submit = await post({ mesh_url: MESH, prompt: 'brushed steel', mask_b64: MASK });
		expect(submit.status).toBe(501);
		expect(submit.body.error).toBe('region_retex_unconfigured');

		const status = await poll(submitted.job);
		expect(status.status).toBe(501);
		expect(status.body.error).toBe('region_retex_unconfigured');
		expect(workerCalls).toHaveLength(1); // only the first, pre-outage submit
	});

	it('answers 501 when the shared worker key is unset', async () => {
		delete process.env.GCP_RECONSTRUCTION_KEY;
		const { status, body } = await post({ mesh_url: MESH, prompt: 'brushed steel', mask_b64: MASK });
		expect(status).toBe(501);
		expect(body.error).toBe('region_retex_unconfigured');
	});

	it('surfaces a worker rejection as a 502 rather than a stack trace', async () => {
		global.fetch = vi.fn(async () => ({
			ok: false,
			status: 503,
			json: async () => ({ detail: 'model server warming up' }),
		}));
		const { status, body } = await post({ mesh_url: MESH, prompt: 'brushed steel', mask_b64: MASK });
		expect(status).toBe(502);
		expect(body.error).toBe('provider_error');
		expect(body.error_description).toBe('model server warming up');
	});

	it('reports a failed task through the poll body instead of throwing', async () => {
		const { body: submitted } = await post({ mesh_url: MESH, prompt: 'brushed steel', mask_b64: MASK });
		global.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'failed', error: 'mask covered no UV island' }),
		}));
		const { status, body } = await poll(submitted.job);
		expect(status).toBe(200);
		expect(body).toMatchObject({ status: 'failed', result_url: null, error: 'mask covered no UV island' });
	});
});

describe('transport', () => {
	it('answers a CORS preflight and refuses an unsupported method', async () => {
		const pre = await call({ method: 'OPTIONS', headers: { origin: 'https://three.ws' } });
		expect(pre.status).toBe(204);
		expect(pre.res.headers['access-control-allow-methods']).toContain('POST');

		const put = await call({ method: 'PUT' });
		expect(put.status).toBe(405);
	});
});
