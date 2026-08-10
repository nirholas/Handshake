// Tests for POST /api/agents/:id/embed, the AgentMemory.recall() embedder.
//
// The handler delegates every provider decision to api/_lib/embeddings.js, the
// platform's single embedder registry, so what this pins is the registry's
// policy as the endpoint exposes it: the free NIM lane leads over any paid key,
// a missing key is a designed 503 (never a crash), the response names the
// embedder TAG that produced the vector (model plus dimension), and a failing
// lane 502s rather than silently answering from a different vector space.
//
// That last rule is why there is no cross-provider failover to assert: vectors
// from two embedders are not comparable, so a fallback that quietly swapped
// spaces would return plausible-looking garbage to a caller storing the result.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const getSessionUserMock = vi.fn();
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => true),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { embedUser: vi.fn(async () => ({ success: true })) },
}));

const { handleEmbed } = await import('../../api/agents/_id/embed.js');

// Every key the registry reads, so an ambient one on the machine running the
// suite can never decide which lane a test exercises.
function clearKeys() {
	delete process.env.NVIDIA_API_KEY;
	delete process.env.GOOGLE_CLOUD_PROJECT;
	delete process.env.OPENAI_API_KEY;
}

function mkReq(body) {
	const req = {
		method: 'POST',
		url: '/api/agents/a1/embed',
		headers: { 'content-type': 'application/json' },
		on(event, cb) {
			if (event === 'data') {
				queueMicrotask(() => {
					cb(Buffer.from(JSON.stringify(body)));
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
			}
		},
		destroy() {},
	};
	return req;
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
	};
}

const VECTOR = Array.from({ length: 4 }, (_, i) => i / 10);
const okEmbedding = () => ({
	ok: true,
	status: 200,
	json: async () => ({ data: [{ embedding: VECTOR }] }),
	text: async () => '',
});
const errResp = (status) => ({ ok: false, status, json: async () => ({}), text: async () => 'boom' });

beforeEach(() => {
	clearKeys();
	getSessionUserMock.mockResolvedValue({ id: 'u1' });
	sqlMock.mockResolvedValue([{ id: 'a1' }]); // caller owns the agent
});
afterEach(() => {
	vi.restoreAllMocks();
	clearKeys();
});

async function invoke(body = { text: 'hello memory' }) {
	const res = mkRes();
	await handleEmbed(mkReq(body), res, 'a1');
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

describe('POST /api/agents/:id/embed: free-first embedder registry', () => {
	it('serves from the free NIM lane while a paid key is also set', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		process.env.OPENAI_API_KEY = 'sk-paid';
		const calls = [];
		globalThis.fetch = vi.fn(async (url) => {
			calls.push(String(url));
			return okEmbedding();
		});
		const { res, json } = await invoke();
		expect(res.statusCode).toBe(200);
		expect(json.embedding).toEqual(VECTOR);
		expect(json.provider).toBe('nim');
		expect(json.model).toBe('nvidia/nv-embedqa-e5-v5');
		// The tag is what callers persist beside a stored vector.
		expect(json.embedder).toBe('nvidia/nv-embedqa-e5-v5@1024');
		expect(json.dim).toBe(1024);
		expect(json.inputType).toBe('query');
		// The paid backstop was never touched while the free lane could serve.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('integrate.api.nvidia.com');
	});

	it('embeds into the caller-named vector space when one is requested', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		process.env.OPENAI_API_KEY = 'sk-paid';
		const calls = [];
		globalThis.fetch = vi.fn(async (url) => {
			calls.push(String(url));
			return okEmbedding();
		});
		const { res, json } = await invoke({
			text: 'hello memory',
			embedder: 'text-embedding-3-small@256',
		});
		expect(res.statusCode).toBe(200);
		expect(json.provider).toBe('openai');
		expect(json.embedder).toBe('text-embedding-3-small@256');
		expect(calls[0]).toContain('api.openai.com');
	});

	it('carries inputType through to the provider', async () => {
		// NIM's retrieval models are asymmetric: a stored chunk and the query that
		// should retrieve it embed differently, so the distinction has to survive the
		// hop rather than being defaulted away.
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		let sent = null;
		globalThis.fetch = vi.fn(async (_url, init) => {
			sent = JSON.parse(init.body);
			return okEmbedding();
		});
		const { res, json } = await invoke({ text: 'a stored chunk', inputType: 'passage' });
		expect(res.statusCode).toBe(200);
		expect(json.inputType).toBe('passage');
		expect(sent.input_type).toBe('passage');
	});

	it('rejects an inputType outside the query/passage pair', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		globalThis.fetch = vi.fn();
		const { res, json } = await invoke({ text: 'hello memory', inputType: 'sideways' });
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('503s for a known embedder whose provider is unconfigured here', async () => {
		// Distinct from the unknown-embedder 400: the space is real, this build just
		// cannot serve it, and the caller needs to know which of the two it hit.
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		globalThis.fetch = vi.fn();
		const { res, json } = await invoke({
			text: 'hello memory',
			embedder: 'text-embedding-3-small@256',
		});
		expect(res.statusCode).toBe(503);
		expect(json.error).toBe('not_configured');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it('502s rather than answering from a different vector space', async () => {
		// A fallback across embedders would hand back a vector the caller cannot
		// compare with anything it has stored, so the failure is surfaced instead.
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		process.env.OPENAI_API_KEY = 'sk-paid';
		globalThis.fetch = vi.fn(async (url) =>
			String(url).includes('integrate.api.nvidia.com') ? errResp(429) : okEmbedding(),
		);
		const { res, json } = await invoke();
		expect(res.statusCode).toBe(502);
		expect(json.error).toBe('upstream_error');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('returns a designed 503 (not a crash) when no embedding key is configured', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('must not be called');
		});
		const { res, json } = await invoke();
		expect(res.statusCode).toBe(503);
		expect(json.error).toBe('not_configured');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('returns 502 naming the lane when the upstream fails', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		globalThis.fetch = vi.fn(async () => errResp(500));
		const { res, json } = await invoke();
		expect(res.statusCode).toBe(502);
		expect(json.error).toBe('upstream_error');
		expect(json.error_description).toContain('nim');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('rejects an embedder this build does not know', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		globalThis.fetch = vi.fn();
		const { res, json } = await invoke({ text: 'hello memory', embedder: 'made-up/model@7' });
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('still validates input before touching any provider', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		globalThis.fetch = vi.fn();
		const { res } = await invoke({ text: '' });
		expect(res.statusCode).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
