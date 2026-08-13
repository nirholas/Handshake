// /api/inference/livepeer behavior tests.
//
// The endpoint runs two inference legs side by side: the three.ws provider
// chain and a Livepeer AI gateway. What has to hold, and what these pin:
//
//   1. GET reports the resolved gateway, whether it is keyed, and whether it
//      is usable at all, so the demo can warn before a run instead of after.
//   2. The unkeyed public gateway is REFUSED, not dialed. Its hostname stopped
//      being Livepeer (docs/ops/livepeer-federation.md); dialing it would ship
//      the user's prompt to an unidentified host.
//   3. LIVEPEER_GATEWAY_URL routes the leg at a self-hosted gateway, with the
//      documented OpenAI-compatible envelope on the wire.
//   4. Both response shapes the gateway family returns (OpenAI `choices`, the
//      older `{ response, tokens_used }`) parse into the same leg envelope.
//   5. Failures are per-leg, never per-request: a dead Livepeer gateway still
//      returns 200 with the platform reply intact, coded and hinted.
//   6. Input validation rejects at the boundary with a 4xx JSON error.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const llmCompleteMock = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmCompleteMock(...a),
	LlmUnavailableError: class extends Error {},
}));

const rateLimitMock = vi.fn(async () => ({ success: true }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { livepeerIp: (...a) => rateLimitMock(...a) },
	clientIp: () => '203.0.113.7',
}));

const { default: handler } = await import('../api/inference/livepeer.js');

const ENV_KEYS = ['LIVEPEER_API_KEY', 'LIVEPEER_GATEWAY_URL'];

function mkReq({ method = 'POST', body = null, headers = {} } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method,
		url: '/api/inference/livepeer',
		headers: hdrs,
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
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

async function call(req) {
	const res = mkRes();
	await handler(req, res);
	return { res, json: parse(res) };
}

function gatewayResponse(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	};
}

const GOOD_PLATFORM = {
	text: 'pong',
	provider: 'groq',
	model: 'llama-3.3-70b',
	usage: { input: 8, output: 1 },
};

let fetchMock;

beforeEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
	llmCompleteMock.mockReset().mockResolvedValue(GOOD_PLATFORM);
	rateLimitMock.mockReset().mockResolvedValue({ success: true });
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	for (const k of ENV_KEYS) delete process.env[k];
});

describe('GET /api/inference/livepeer', () => {
	it('reports the unkeyed public gateway as unusable, with the fix named', async () => {
		const { res, json } = await call(mkReq({ method: 'GET' }));
		expect(res.statusCode).toBe(200);
		expect(json.gateway).toBe('public');
		expect(json.keyed).toBe(false);
		expect(json.usable).toBe(false);
		expect(json.hint).toMatch(/LIVEPEER_API_KEY/);
		expect(json.models).toContain(json.default_model);
	});

	it('reports a keyed studio gateway as usable', async () => {
		process.env.LIVEPEER_API_KEY = 'lp_key_123';
		const { json } = await call(mkReq({ method: 'GET' }));
		expect(json).toMatchObject({
			gateway: 'studio',
			gateway_url: 'https://livepeer.studio/api/generate/llm',
			keyed: true,
			usable: true,
		});
		expect(json.hint).toBeUndefined();
	});

	it('reports a self-hosted override gateway', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal:8088/';
		const { json } = await call(mkReq({ method: 'GET' }));
		expect(json.gateway).toBe('override');
		expect(json.gateway_url).toBe('https://gateway.internal:8088/llm');
		expect(json.usable).toBe(true);
	});
});

describe('POST /api/inference/livepeer input validation', () => {
	it('rejects a missing prompt with a 400 JSON error', async () => {
		const { res, json } = await call(mkReq({ body: {} }));
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('bad_request');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(llmCompleteMock).not.toHaveBeenCalled();
	});

	it('rejects a whitespace-only prompt', async () => {
		const { res, json } = await call(mkReq({ body: { prompt: '   \n ' } }));
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('bad_request');
	});

	it('rejects malformed JSON with a 400, not a stack trace', async () => {
		const { res, json } = await call(mkReq({ body: '{not json' }));
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('bad_request');
		expect(String(json.error_description)).not.toMatch(/\bat \w+ \(/);
	});

	it('rejects a non-POST, non-GET method', async () => {
		const { res } = await call(mkReq({ method: 'PUT' }));
		expect(res.statusCode).toBe(405);
	});

	it('returns 429 when the per-IP limiter trips, before any upstream call', async () => {
		rateLimitMock.mockResolvedValue({ success: false, limit: 20, remaining: 0, reset: Date.now() + 1000 });
		const { res } = await call(mkReq({ body: { prompt: 'hi' } }));
		expect(res.statusCode).toBe(429);
		expect(llmCompleteMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('clamps max_tokens and temperature into range', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockResolvedValue(gatewayResponse(200, { choices: [{ message: { content: 'ok' } }] }));
		const { json } = await call(mkReq({ body: { prompt: 'hi', max_tokens: 999999, temperature: 12 } }));
		expect(json.max_tokens).toBe(2048);
		expect(json.temperature).toBe(2);
		const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(sent.max_tokens).toBe(2048);
		expect(sent.temperature).toBe(2);
	});
});

describe('POST /api/inference/livepeer Livepeer leg', () => {
	it('refuses the unkeyed public gateway instead of dialing it', async () => {
		const { res, json } = await call(mkReq({ body: { prompt: 'hi' } }));
		expect(res.statusCode).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(json.livepeer).toMatchObject({ ok: false, gateway: 'public', error: 'gateway_unavailable' });
		expect(json.livepeer.hint).toMatch(/LIVEPEER_GATEWAY_URL/);
		// The refusal is per leg: the platform side still answered.
		expect(json.platform).toMatchObject({ ok: true, provider: 'groq', reply: 'pong' });
	});

	it('posts the OpenAI-compatible envelope to a keyed studio gateway', async () => {
		process.env.LIVEPEER_API_KEY = 'lp_key_123';
		fetchMock.mockResolvedValue(
			gatewayResponse(200, {
				choices: [{ message: { content: ' hello from an orchestrator ' } }],
				usage: { prompt_tokens: 11, completion_tokens: 5 },
			}),
		);

		const { json } = await call(mkReq({ body: { prompt: 'hi', model: 'Qwen/Qwen2.5-7B-Instruct' } }));

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://livepeer.studio/api/generate/llm');
		expect(init.headers.authorization).toBe('Bearer lp_key_123');
		expect(JSON.parse(init.body)).toMatchObject({
			model: 'Qwen/Qwen2.5-7B-Instruct',
			messages: [{ role: 'user', content: 'hi' }],
			stream: false,
		});
		expect(init.signal).toBeInstanceOf(AbortSignal);

		expect(json.livepeer).toMatchObject({
			ok: true,
			network: 'Livepeer',
			gateway: 'studio',
			reply: 'hello from an orchestrator',
			prompt_tokens: 11,
			completion_tokens: 5,
		});
	});

	it('parses the older { response, tokens_used } gateway shape', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockResolvedValue(gatewayResponse(200, { response: 'legacy reply', tokens_used: 40 }));

		const { json } = await call(mkReq({ body: { prompt: 'a'.repeat(40) } }));

		expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.internal/llm');
		expect(json.livepeer.ok).toBe(true);
		expect(json.livepeer.reply).toBe('legacy reply');
		expect(json.livepeer.prompt_tokens).toBe(10);
		expect(json.livepeer.completion_tokens).toBe(30);
	});

	it('parses OpenAI content parts, which some orchestrators return instead of a string', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockResolvedValue(
			gatewayResponse(200, {
				choices: [
					{
						message: {
							role: 'assistant',
							content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }],
						},
					},
				],
				usage: { prompt_tokens: 9, completion_tokens: 4 },
			}),
		);

		const { json } = await call(mkReq({ body: { prompt: 'hi' } }));

		// Before this was normalized the array reached String.prototype.trim and
		// threw, collapsing a good answer into a bare leg_failed.
		expect(json.livepeer).toMatchObject({
			ok: true,
			reply: 'part one part two',
			prompt_tokens: 9,
			completion_tokens: 4,
		});
		expect(json.livepeer.error).toBeUndefined();
	});

	it('treats an unusable content shape as empty_response, never a thrown leg', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockResolvedValue(gatewayResponse(200, { choices: [{ message: { content: { unexpected: true } } }] }));

		const { res, json } = await call(mkReq({ body: { prompt: 'hi' } }));

		expect(res.statusCode).toBe(200);
		expect(json.livepeer).toMatchObject({ ok: false, error: 'empty_response' });
		expect(json.livepeer.gateway).toBe('override');
		expect(json.platform.ok).toBe(true);
	});

	it('codes a non-2xx gateway as upstream_error and keeps the request 200', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockResolvedValue(gatewayResponse(503, 'no orchestrators available'));

		const { res, json } = await call(mkReq({ body: { prompt: 'hi' } }));

		expect(res.statusCode).toBe(200);
		expect(json.ok).toBe(true);
		expect(json.livepeer).toMatchObject({
			ok: false,
			error: 'upstream_error',
			upstream_status: 503,
			upstream_body: 'no orchestrators available',
		});
		expect(json.livepeer.hint).toMatch(/another model/i);
		expect(json.platform.ok).toBe(true);
	});

	it('codes an aborted gateway call as gateway_timeout, not a socket error', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

		const { json } = await call(mkReq({ body: { prompt: 'hi' } }));

		expect(json.livepeer).toMatchObject({ ok: false, error: 'gateway_timeout' });
		expect(json.livepeer.error_message).toMatch(/45s/);
	});

	it('codes a socket failure as gateway_unreachable', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));

		const { json } = await call(mkReq({ body: { prompt: 'hi' } }));

		expect(json.livepeer).toMatchObject({ ok: false, error: 'gateway_unreachable' });
		expect(json.livepeer.error_message).toMatch(/fetch failed/);
	});

	it('flags a 200 with no usable text as empty_response', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockResolvedValue(gatewayResponse(200, { choices: [] }));

		const { json } = await call(mkReq({ body: { prompt: 'hi' } }));

		expect(json.livepeer.ok).toBe(false);
		expect(json.livepeer.error).toBe('empty_response');
	});
});

describe('POST /api/inference/livepeer platform leg', () => {
	it('names the provider that actually answered, never a fixed vendor', async () => {
		llmCompleteMock.mockResolvedValue({
			text: 'hi there',
			provider: 'ovh',
			model: 'Meta-Llama-3_3-70B-Instruct',
			usage: { input: 4, output: 2 },
		});

		const { json } = await call(mkReq({ body: { prompt: 'hi' } }));

		expect(json.platform).toMatchObject({
			ok: true,
			network: 'three.ws',
			provider: 'ovh',
			model: 'Meta-Llama-3_3-70B-Instruct',
		});
	});

	it('reports no_provider_configured when the whole chain is unavailable', async () => {
		llmCompleteMock.mockRejectedValue(Object.assign(new Error('no provider'), { code: 'llm_unavailable' }));
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal';
		fetchMock.mockResolvedValue(gatewayResponse(200, { choices: [{ message: { content: 'up' } }] }));

		const { res, json } = await call(mkReq({ body: { prompt: 'hi' } }));

		expect(res.statusCode).toBe(200);
		expect(json.platform).toMatchObject({ ok: false, error: 'no_provider_configured', provider: null });
		// The other leg is unaffected: one dead provider must not blank the page.
		expect(json.livepeer.ok).toBe(true);
	});
});
