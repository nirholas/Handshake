// Contract test: every body POST/GET /api/3d/studio can put on the wire must
// validate against the OpenAPI schema three.ws serves to the custom GPT builder
// (public/.well-known/3d-studio-openapi.yaml, byte-identical to
// prompts/store-submissions/_generated/openai-actions.yaml).
//
// tests/api/3d-studio.test.js pins the handler's behaviour and
// tests/api/3d-studio-openapi.test.js pins the schema document itself. Neither
// binds one to the other: a response key could change type, a required field
// could go missing, or an error body could use a field name the GPT has no slot
// for, and both suites would stay green while the Action broke in ChatGPT.
//
// The schemas are OpenAPI 3.1, which is JSON Schema 2020-12, so ajv (already a
// dependency) validates them directly with no conversion layer.
//
// The lane itself is stubbed at the network boundary (global fetch, standing in
// for the self-call to /api/gpt-forge) using the real captured forge payloads.
// Everything downstream of that seam is the real handler, the real shapers, and
// the real schema.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const spec = parse(readFileSync(resolve(ROOT, 'public/.well-known/3d-studio-openapi.yaml'), 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
// `const: glb` and `format: uri` come straight from the served document; nothing
// is relaxed for the test, so a response that ChatGPT would reject fails here.
const validateState = ajv.compile(spec.components.schemas.GenerationState);
const validateError = ajv.compile(spec.components.schemas.ErrorResponse);
const validateGenerateBody = ajv.compile(spec.paths['/api/3d/studio'].post.requestBody.content['application/json'].schema);

function why(validate) {
	return (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
}

function expectValidState(body, label) {
	expect(validateState(body), `${label}: ${why(validateState)}\n${JSON.stringify(body)}`).toBe(true);
}

function expectValidError(body, label) {
	expect(validateError(body), `${label}: ${why(validateError)}\n${JSON.stringify(body)}`).toBe(true);
}

// ── the handler under a stubbed lane ─────────────────────────────────────────

let freeOk = true;
let statusOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dGenerateFree: async () =>
			freeOk
				? { success: true, limit: 60, remaining: 59, reset: Date.now() + 3_600_000 }
				: { success: false, limit: 60, remaining: 0, reset: Date.now() + 3_600_000 },
		mcp3dStatus: async () =>
			statusOk
				? { success: true, limit: 240, remaining: 239, reset: Date.now() + 60_000 }
				: { success: false, limit: 240, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.9',
}));

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
	freeOk = true;
	statusOk = true;
});
afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	vi.restoreAllMocks();
});

function makeReq({ method = 'POST', url = '/api/3d/studio', body = null } = {}) {
	const raw = body == null ? '' : JSON.stringify(body);
	const stream = Readable.from(raw ? [Buffer.from(raw)] : []);
	stream.method = method;
	stream.url = url;
	stream.headers = { 'content-type': 'application/json', host: 'three.ws' };
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
		end(b) { this._body = b; this.writableEnded = true; },
	};
}

async function dispatch(req) {
	const res = makeRes();
	const mod = await import('../../api/3d/studio.js');
	await mod.default(req, res);
	return { status: res.statusCode, body: res._body ? JSON.parse(res._body) : null };
}

// The network seam: one canned /api/gpt-forge reply per test.
function stubForge(payload, { status = 200 } = {}) {
	globalThis.fetch = vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => 'application/json' },
		json: async () => payload,
		text: async () => JSON.stringify(payload),
	}));
}

// Real captured /api/forge draft-lane shapes (NVIDIA NIM TRELLIS), the same
// fixtures tests/api/3d-studio.test.js drives the handler with.
const FORGE_DONE = {
	job_id: null,
	creation_id: 'a1b2c3d4-0000-4000-8000-000000000001',
	status: 'done',
	glb_url: 'https://three.ws/cdn/forge/anon/a1b2c3d4.glb',
	durable: true,
	backend: 'nvidia',
	tier: 'draft',
	path: 'image',
};
const FORGE_QUEUED = {
	job_id: 'f1.eyJwIjoibnZpZGlhIiwiayI6InRleHQiLCJ0IjoibmltLXRhc2stMTIzIn0.c2lnbmF0dXJl',
	creation_id: 'a1b2c3d4-0000-4000-8000-000000000002',
	status: 'queued',
	tier: 'high',
	eta_seconds: 240,
	preview_image_url: 'https://three.ws/cdn/forge/anon/ref-view.png',
};
const FORGE_RUNNING = { job_id: FORGE_QUEUED.job_id, status: 'running', eta_remaining_seconds: 90, elapsed_seconds: 30 };
const FORGE_FAILED = { job_id: FORGE_QUEUED.job_id, status: 'failed', error: 'the generator hit a snag' };

const POLL_URL = `/api/3d/studio?job=${encodeURIComponent(FORGE_QUEUED.job_id)}&title=a%20low-poly%20fox`;

describe('POST /api/3d/studio bodies validate against the served GenerationState', () => {
	it('an inline-done generation', async () => {
		stubForge(FORGE_DONE);
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox' } }));
		expect(status).toBe(200);
		expectValidState(body, 'submit done');
		expect(body.status).toBe('done');
		expect(body.format).toBe('glb');
	});

	it('a queued generation carrying the poll handle, watch page, concept art and ETA', async () => {
		stubForge(FORGE_QUEUED);
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox', tier: 'high' } }));
		expect(status).toBe(200);
		expectValidState(body, 'submit pending');
		expect(body.status).toBe('pending');
		expect(typeof body.job).toBe('string');
		expect(typeof body.poll).toBe('string');
		expect(body.etaSeconds).toBe(240);
	});
});

describe('GET /api/3d/studio?job= bodies validate against the served GenerationState', () => {
	it('a still-running poll', async () => {
		stubForge(FORGE_RUNNING);
		const { status, body } = await dispatch(makeReq({ method: 'GET', url: POLL_URL, body: null }));
		expect(status).toBe(200);
		expectValidState(body, 'poll pending');
		expect(body).toMatchObject({ status: 'pending', etaSeconds: 90, elapsedSeconds: 30 });
	});

	it('a finished poll', async () => {
		stubForge({ job_id: FORGE_QUEUED.job_id, status: 'done', glb_url: 'https://three.ws/cdn/forge/anon/done.glb', durable: true });
		const { status, body } = await dispatch(makeReq({ method: 'GET', url: POLL_URL, body: null }));
		expect(status).toBe(200);
		expectValidState(body, 'poll done');
		expect(body.arUrl.startsWith('https://three.ws/api/ar?src=')).toBe(true);
	});

	it('a failed poll, which the schema calls status "error"', async () => {
		stubForge(FORGE_FAILED);
		const { status, body } = await dispatch(makeReq({ method: 'GET', url: POLL_URL, body: null }));
		expect(status).toBe(200);
		expectValidState(body, 'poll failed');
		expect(body.status).toBe('error');
		expect(typeof body.error).toBe('string');
	});

	it('a transient upstream hiccup stays a valid pending state rather than an error', async () => {
		stubForge({ message: 'bad gateway' }, { status: 502 });
		const { status, body } = await dispatch(makeReq({ method: 'GET', url: POLL_URL, body: null }));
		expect(status).toBe(200);
		expectValidState(body, 'poll upstream 5xx');
		expect(body.status).toBe('pending');
	});
});

describe('error bodies validate against the served ErrorResponse', () => {
	// Each documented failure code in the schema, driven through the real handler.
	it('400 invalid_prompt (too short)', async () => {
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a' } }));
		expect(status).toBe(400);
		expectValidError(body, 'invalid_prompt');
	});

	it('400 invalid_tier', async () => {
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox', tier: 'ultra' } }));
		expect(status).toBe(400);
		expectValidError(body, 'invalid_tier');
	});

	it('400 prompt_rejected from the age-13+ safety gate', async () => {
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a nude woman posing explicitly' } }));
		expect(status).toBe(400);
		expect(body.error).toBe('prompt_rejected');
		expectValidError(body, 'prompt_rejected');
	});

	it('400 bad_request on a non-JSON body', async () => {
		const stream = Readable.from([Buffer.from('not json at all')]);
		stream.method = 'POST';
		stream.url = '/api/3d/studio';
		stream.headers = { 'content-type': 'application/json', host: 'three.ws' };
		const { status, body } = await dispatch(stream);
		expect(status).toBe(400);
		expectValidError(body, 'bad_request');
	});

	it('400 missing_job on a bare GET', async () => {
		const { status, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/studio', body: null }));
		expect(status).toBe(400);
		expectValidError(body, 'missing_job');
	});

	it('400 invalid_job on a malformed handle', async () => {
		const { status, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/studio?job=%20%20nope', body: null }));
		expect(status).toBe(400);
		expectValidError(body, 'invalid_job');
	});

	it('429 rate_limited on the free generation cap, with retry_after', async () => {
		freeOk = false;
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox' } }));
		expect(status).toBe(429);
		expectValidError(body, 'generate rate_limited');
		expect(Number.isInteger(body.retry_after)).toBe(true);
	});

	it('429 rate_limited on the poll cap, with retry_after', async () => {
		statusOk = false;
		const { status, body } = await dispatch(makeReq({ method: 'GET', url: POLL_URL, body: null }));
		expect(status).toBe(429);
		expectValidError(body, 'poll rate_limited');
		expect(Number.isInteger(body.retry_after)).toBe(true);
	});

	it('429 rate_limited when the upstream lane itself is saturated', async () => {
		stubForge({ message: 'the free 3D generator is busy', retry_after: 12 }, { status: 429 });
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox' } }));
		expect(status).toBe(429);
		expectValidError(body, 'lane busy');
	});

	it('502 generation_failed when the lane refuses the job', async () => {
		stubForge({ message: 'no healthy backend' }, { status: 500 });
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox' } }));
		expect(status).toBe(502);
		expectValidError(body, 'generation_failed');
	});

	it('503 not_configured when no lane is deployed', async () => {
		stubForge({ message: '3D generation is not configured' }, { status: 503 });
		const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox' } }));
		expect(status).toBe(503);
		expectValidError(body, 'not_configured');
	});
});

describe('the schema describes requests the handler actually accepts', () => {
	it('the documented request example passes both the schema and the handler', async () => {
		const example = spec.paths['/api/3d/studio'].post.requestBody.content['application/json'].examples.fox.value;
		expect(validateGenerateBody(example), why(validateGenerateBody)).toBe(true);
		stubForge(FORGE_DONE);
		const { status } = await dispatch(makeReq({ body: example }));
		expect(status).toBe(200);
	});

	it('every tier the schema advertises is accepted by the handler', async () => {
		for (const tier of spec.paths['/api/3d/studio'].post.requestBody.content['application/json'].schema.properties.tier.enum) {
			stubForge(FORGE_QUEUED);
			const { status, body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox', tier } }));
			expect(status, `tier ${tier}`).toBe(200);
			expectValidState(body, `tier ${tier}`);
		}
	});

	it('the documented response examples are themselves valid GenerationState objects', () => {
		const post = spec.paths['/api/3d/studio'].post.responses['200'].content['application/json'].examples;
		const get = spec.paths['/api/3d/studio'].get.responses['200'].content['application/json'].examples;
		for (const [name, ex] of [...Object.entries(post), ...Object.entries(get)]) {
			expectValidState(ex.value, `example ${name}`);
		}
	});

	it('the poll path a pending response hands back matches the documented job pattern', async () => {
		stubForge(FORGE_QUEUED);
		const { body } = await dispatch(makeReq({ body: { prompt: 'a low-poly fox' } }));
		const jobParam = spec.paths['/api/3d/studio'].get.parameters.find((p) => p.name === 'job');
		const validateJob = ajv.compile(jobParam.schema);
		const emitted = new URL(body.poll, 'https://three.ws').searchParams.get('job');
		expect(validateJob(emitted), why(validateJob)).toBe(true);
		expect(emitted).toBe(body.job);
	});
});
