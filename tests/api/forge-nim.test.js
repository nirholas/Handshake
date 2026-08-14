// api/forge-nim — the self-hosted TRELLIS NIM demo proxy.
//
// This endpoint backs /forge-nim: it forwards a real photo (or text prompt) to a
// self-hosted NIM's POST /v1/infer and normalizes the synchronous
// { artifacts:[{ base64 }] } GLB straight back to the browser. The tests pin the
// contract that matters: the NIM URL is env-gated, caller-supplied baseUrl is
// SSRF-guarded, every documented artifact shape decodes to GLB bytes, and upstream
// failures surface as actionable boundary errors. fetch + rate-limit are mocked so
// the suite runs fully offline.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { forgeNim: async () => ({ success: true }) },
	clientIp: () => '127.0.0.1',
}));

const ORIGINAL_FETCH = globalThis.fetch;
// MODEL_TRELLIS_URL is cleared too, and never set: it points at our own async
// Cloud Run TRELLIS worker, and api/forge-nim.js deliberately does not read it.
// Clearing it keeps an ambient value out of these cases and lets the last case
// below prove the handler still reports unconfigured when only it is set.
const ENV_KEYS = ['NIM_TRELLIS_URL', 'MODEL_TRELLIS_URL', 'NVIDIA_API_KEY'];
const saved = {};

beforeEach(() => {
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

// Minimal binary glTF buffer — opaque bytes after a valid 12-byte header.
function fakeGlb(payload = 64) {
	const h = Buffer.alloc(12);
	h.writeUInt32LE(0x46546c67, 0); // 'glTF'
	h.writeUInt32LE(2, 4);
	h.writeUInt32LE(12 + payload, 8);
	return Buffer.concat([h, Buffer.alloc(payload)]);
}

function makeReq({ method = 'POST', url = '/api/forge-nim', body = null } = {}) {
	const raw = body == null ? '' : JSON.stringify(body);
	const stream = Readable.from(raw ? [Buffer.from(raw)] : []);
	stream.method = method;
	stream.url = url;
	stream.headers = { 'content-type': 'application/json' };
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
	const mod = await import('../../api/forge-nim.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

// A JSON Response stub matching the subset of WHATWG Response the handler reads.
function jsonResponse(obj, { status = 200 } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
		json: async () => obj,
		text: async () => JSON.stringify(obj),
	};
}
function binaryResponse(buf, { status = 200, ct = 'model/gltf-binary' } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) },
		arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
		text: async () => '[binary]',
	};
}

describe('GET /api/forge-nim?action=health', () => {
	it('reports unconfigured when no NIM URL is set', async () => {
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: '/api/forge-nim?action=health' }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.configured).toBe(false);
		expect(body.reachable).toBe(false);
	});

	it('still reports unconfigured when only MODEL_TRELLIS_URL is set', async () => {
		// MODEL_TRELLIS_URL points at our own async Cloud Run TRELLIS worker, which
		// speaks /infer + /tasks/{id}, not the NIM's synchronous /v1/infer. Reading it
		// here reported a configured, unreachable NIM and 404ed every generation.
		process.env.MODEL_TRELLIS_URL = 'https://trellis-worker.example.run.app';
		const fetchMock = vi.fn(async () => jsonResponse({ status: 'ready' }));
		globalThis.fetch = fetchMock;
		const { body } = await dispatch(makeReq({ method: 'GET', url: '/api/forge-nim?action=health' }), makeRes());
		expect(body.configured).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reports live when the configured NIM ready check passes', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		const fetchMock = vi.fn(async () => jsonResponse({ status: 'ready' }));
		globalThis.fetch = fetchMock;
		const { body } = await dispatch(makeReq({ method: 'GET', url: '/api/forge-nim?action=health' }), makeRes());
		expect(body.configured).toBe(true);
		expect(body.reachable).toBe(true);
		expect(body.baseUrl).toBe('https://nim.example.run.app');
		expect(fetchMock.mock.calls[0][0]).toBe('https://nim.example.run.app/v1/health/ready');
	});

	it('reports down when the ready check is unreachable', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		});
		const { body } = await dispatch(makeReq({ method: 'GET', url: '/api/forge-nim?action=health' }), makeRes());
		expect(body.configured).toBe(true);
		expect(body.reachable).toBe(false);
		expect(body.detail).toMatch(/unreachable/i);
	});
});

describe('POST /api/forge-nim — image mode', () => {
	it('forwards a data-uri image to /v1/infer and returns the synchronous GLB', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app/';
		const glb = fakeGlb(96);
		const fetchMock = vi.fn(async () => jsonResponse({ artifacts: [{ base64: glb.toString('base64') }] }));
		globalThis.fetch = fetchMock;

		const { res, body } = await dispatch(
			makeReq({ body: { mode: 'image', tier: 'high', image: 'data:image/png;base64,iVBORw0KGgo=' } }),
			makeRes(),
		);

		expect(res.statusCode).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.mode).toBe('image');
		expect(body.tier).toBe('high');
		expect(body.contract).toBe('artifacts[0].base64');
		expect(body.bytes).toBe(glb.length);
		expect(Buffer.from(body.glb_base64, 'base64').length).toBe(glb.length);
		expect(typeof body.ms).toBe('number');

		// Verify the wire contract sent to the NIM.
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://nim.example.run.app/v1/infer');
		const sent = JSON.parse(init.body);
		expect(sent.mode).toBe('image');
		expect(sent.output_format).toBe('glb');
		expect(sent.ss_sampling_steps).toBe(50); // high tier (fidelity-tuned)
		expect(sent.image).toMatch(/^data:image\/png;base64,/);
	});

	it('decodes a raw binary (model/gltf-binary) NIM response', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		const glb = fakeGlb(48);
		globalThis.fetch = vi.fn(async () => binaryResponse(glb));
		const { body } = await dispatch(
			makeReq({ body: { mode: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' } }),
			makeRes(),
		);
		expect(body.ok).toBe(true);
		expect(body.bytes).toBe(glb.length);
	});

	it('rejects image mode with no image', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		const { res, body } = await dispatch(makeReq({ body: { mode: 'image' } }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error || body.code).toBeTruthy();
	});
});

describe('POST /api/forge-nim — text mode', () => {
	it('shapes the prompt and posts a text invoke', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		const glb = fakeGlb(32);
		const fetchMock = vi.fn(async () => jsonResponse({ artifacts: [{ base64: glb.toString('base64') }] }));
		globalThis.fetch = fetchMock;
		const { body } = await dispatch(makeReq({ body: { mode: 'text', prompt: 'a tiny robot' } }), makeRes());
		expect(body.ok).toBe(true);
		const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(sent.mode).toBe('text');
		expect(sent.prompt).toContain('a tiny robot');
		expect(sent.ss_sampling_steps).toBe(15); // default draft
	});

	it('rejects a too-short prompt', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		const { res } = await dispatch(makeReq({ body: { mode: 'text', prompt: 'a' } }), makeRes());
		expect(res.statusCode).toBe(400);
	});
});

describe('POST /api/forge-nim — configuration & SSRF', () => {
	it('returns 503 when no NIM is configured and none supplied', async () => {
		const { res, body } = await dispatch(
			makeReq({ body: { mode: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' } }),
			makeRes(),
		);
		expect(res.statusCode).toBe(503);
		expect(body.error).toBe('nim_unconfigured');
	});

	it('blocks a private-network baseUrl override (SSRF guard)', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (u) => {
			calls.push(u);
			return jsonResponse({ artifacts: [] });
		});
		for (const bad of ['https://10.0.0.1', 'https://192.168.1.10', 'https://169.254.169.254', 'http://nim.example.run.app']) {
			const { res } = await dispatch(
				makeReq({ body: { mode: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', baseUrl: bad } }),
				makeRes(),
			);
			expect(res.statusCode).toBe(400);
		}
		expect(calls.length).toBe(0); // never reached the network
	});

	it('accepts a public https baseUrl override', async () => {
		const glb = fakeGlb(16);
		const fetchMock = vi.fn(async () => jsonResponse({ artifacts: [{ base64: glb.toString('base64') }] }));
		globalThis.fetch = fetchMock;
		const { body } = await dispatch(
			makeReq({
				body: { mode: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', baseUrl: 'https://my-nim.example.com' },
			}),
			makeRes(),
		);
		expect(body.ok).toBe(true);
		expect(fetchMock.mock.calls[0][0]).toBe('https://my-nim.example.com/v1/infer');
	});
});

describe('POST /api/forge-nim — upstream failures', () => {
	it('maps a 401 from the NIM to an auth boundary error', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 401,
			headers: { get: () => 'application/json' },
			text: async () => 'unauthorized',
			json: async () => ({}),
		}));
		const { res, body } = await dispatch(
			makeReq({ body: { mode: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' } }),
			makeRes(),
		);
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('nim_auth');
	});

	it('surfaces an empty-artifact response as a clean error', async () => {
		process.env.NIM_TRELLIS_URL = 'https://nim.example.run.app';
		globalThis.fetch = vi.fn(async () => jsonResponse({ artifacts: [] }));
		const { res, body } = await dispatch(
			makeReq({ body: { mode: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' } }),
			makeRes(),
		);
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('nim_no_artifact');
	});
});
