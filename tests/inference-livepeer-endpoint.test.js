// /api/inference/livepeer endpoint behavior tests.
//
// The endpoint is the side-by-side inference demo: one leg on the three.ws
// provider chain, one leg on a Livepeer AI gateway. These pin the contract the
// demo page renders against:
//
//   1. GET advertises the resolved gateway, and whether it is usable at all,
//      so the client can say the Livepeer leg is dead before a run.
//   2. Input validation rejects a missing prompt before either leg is called.
//   3. The no-key public gateway is REFUSED, not dialled: the hostname stopped
//      resolving to Livepeer on 2026-08-12, so a POST there would be an
//      outbound copy of the user's prompt to an unidentified host.
//   4. One leg failing never fails the request: the demo's whole point is
//      showing the surviving side, so both legs report their own ok/error.
//   5. The platform leg names the provider that actually answered. It is a
//      chain, not a fixed vendor, and the card must not claim otherwise.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: (req, res, allowed) => {
		if (allowed.includes(req.method)) return true;
		res._json = { status: 405, body: { error: 'method_not_allowed' } };
		return false;
	},
	readJson: async (req) => req.body ?? {},
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	error: (res, status, code, message) => {
		res._json = { status, body: { error: code, error_description: message } };
		return res;
	},
	json: (res, status, body) => {
		res._json = { status, body };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { livepeerIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));
vi.mock('../api/_lib/llm.js', () => ({ llmComplete: vi.fn() }));

import handler from '../api/inference/livepeer.js';
import { llmComplete } from '../api/_lib/llm.js';

const ENV_KEYS = ['LIVEPEER_API_KEY', 'LIVEPEER_GATEWAY_URL'];

let fetchMock;

beforeEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
	llmComplete.mockReset();
	llmComplete.mockResolvedValue({
		provider: 'groq',
		model: 'llama-3.3-70b-versatile',
		text: '  platform answer  ',
		usage: { input: 11, output: 4 },
	});
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	for (const k of ENV_KEYS) delete process.env[k];
});

function fakeRes() {
	return { setHeader() {}, end() {}, statusCode: 200 };
}

function call(method, body) {
	const res = fakeRes();
	return handler({ method, url: '/api/inference/livepeer', headers: {}, body }, res).then(() => res);
}

function gatewayResponse(status, payload) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => payload,
		text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
	};
}

describe('GET /api/inference/livepeer', () => {
	it('reports the public gateway as unusable with the env var that fixes it', async () => {
		const res = await call('GET');
		expect(res._json.status).toBe(200);
		expect(res._json.body.gateway).toBe('public');
		expect(res._json.body.keyed).toBe(false);
		expect(res._json.body.usable).toBe(false);
		expect(res._json.body.hint).toContain('LIVEPEER_API_KEY');
		expect(res._json.body.models.length).toBeGreaterThan(0);
	});

	it('reports a keyed studio gateway as usable, with no hint to show', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		const res = await call('GET');
		expect(res._json.body.gateway).toBe('studio');
		expect(res._json.body.keyed).toBe(true);
		expect(res._json.body.usable).toBe(true);
		expect(res._json.body.gateway_url).toBe('https://livepeer.studio/api/generate/llm');
		expect(res._json.body.hint).toBeUndefined();
	});

	it('honors a self-hosted gateway override and appends the llm path', async () => {
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.example.com/';
		const res = await call('GET');
		expect(res._json.body.gateway).toBe('override');
		expect(res._json.body.gateway_url).toBe('https://gateway.example.com/llm');
		expect(res._json.body.usable).toBe(true);
	});
});

describe('POST /api/inference/livepeer', () => {
	it('400s a missing prompt before either leg runs', async () => {
		const res = await call('POST', {});
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('bad_request');
		expect(llmComplete).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('400s a whitespace-only prompt', async () => {
		const res = await call('POST', { prompt: '   \n  ' });
		expect(res._json.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('405s a method it does not serve', async () => {
		const res = await call('DELETE', {});
		expect(res._json.status).toBe(405);
	});

	it('refuses the unusable public gateway without dialing it', async () => {
		const res = await call('POST', { prompt: 'hello' });
		expect(res._json.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(res._json.body.livepeer.ok).toBe(false);
		expect(res._json.body.livepeer.error).toBe('gateway_unavailable');
		expect(res._json.body.livepeer.hint).toContain('LIVEPEER_API_KEY');
		// The surviving leg still answers: a dead gateway must not blank the page.
		expect(res._json.body.livepeer.gateway).toBe('public');
		expect(res._json.body.platform.ok).toBe(true);
	});

	it('names the provider that actually answered the platform leg', async () => {
		const res = await call('POST', { prompt: 'hello' });
		const platform = res._json.body.platform;
		expect(platform.network).toBe('three.ws');
		expect(platform.provider).toBe('groq');
		expect(platform.model).toBe('llama-3.3-70b-versatile');
		expect(platform.reply).toBe('platform answer');
		expect(platform.prompt_tokens).toBe(11);
		expect(platform.completion_tokens).toBe(4);
	});

	it('clamps max_tokens and temperature, and echoes what it used', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		fetchMock.mockResolvedValue(
			gatewayResponse(200, {
				choices: [{ message: { content: 'gateway answer' } }],
				usage: { prompt_tokens: 7, completion_tokens: 3 },
			}),
		);
		const res = await call('POST', { prompt: 'hello', max_tokens: 99_999, temperature: 42 });
		expect(res._json.body.max_tokens).toBe(2048);
		expect(res._json.body.temperature).toBe(2);
		const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(sent.max_tokens).toBe(2048);
		expect(sent.temperature).toBe(2);
		expect(sent.messages).toEqual([{ role: 'user', content: 'hello' }]);
		expect(sent.stream).toBe(false);
		expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer lp-test-key');
	});

	it('parses the OpenAI-style gateway shape into the card fields', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		fetchMock.mockResolvedValue(
			gatewayResponse(200, {
				choices: [{ message: { content: '  decentralized answer  ' } }],
				usage: { prompt_tokens: 7, completion_tokens: 3 },
			}),
		);
		const res = await call('POST', { prompt: 'hello' });
		const lp = res._json.body.livepeer;
		expect(lp.ok).toBe(true);
		expect(lp.reply).toBe('decentralized answer');
		expect(lp.prompt_tokens).toBe(7);
		expect(lp.completion_tokens).toBe(3);
		expect(lp.gateway).toBe('studio');
	});

	it('parses the legacy studio shape and splits its single token total', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		fetchMock.mockResolvedValue(gatewayResponse(200, { response: 'legacy answer', tokens_used: 20 }));
		const res = await call('POST', { prompt: 'hello' });
		const lp = res._json.body.livepeer;
		expect(lp.ok).toBe(true);
		expect(lp.reply).toBe('legacy answer');
		expect(lp.prompt_tokens + lp.completion_tokens).toBe(20);
	});

	it('surfaces a gateway HTTP error with its status and body, never a throw', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		fetchMock.mockResolvedValue(gatewayResponse(401, '{"errors":["request is not authenticated"]}'));
		const res = await call('POST', { prompt: 'hello' });
		expect(res._json.status).toBe(200);
		const lp = res._json.body.livepeer;
		expect(lp.ok).toBe(false);
		expect(lp.error).toBe('upstream_error');
		expect(lp.upstream_status).toBe(401);
		expect(lp.upstream_body).toContain('not authenticated');
		expect(res._json.body.platform.ok).toBe(true);
	});

	it('codes a socket failure and a timeout distinctly', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		fetchMock.mockRejectedValueOnce(new Error('fetch failed'));
		const down = await call('POST', { prompt: 'hello' });
		expect(down._json.body.livepeer.error).toBe('gateway_unreachable');

		const abort = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
		fetchMock.mockRejectedValueOnce(abort);
		const slow = await call('POST', { prompt: 'hello' });
		expect(slow._json.body.livepeer.error).toBe('gateway_timeout');
		expect(slow._json.body.livepeer.error_message).toContain('45s');
	});

	it('reports an unconfigured platform chain without failing the request', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		llmComplete.mockRejectedValue(
			Object.assign(new Error('No LLM provider available.'), { code: 'llm_unavailable' }),
		);
		fetchMock.mockResolvedValue(
			gatewayResponse(200, { choices: [{ message: { content: 'gateway answer' } }] }),
		);
		const res = await call('POST', { prompt: 'hello' });
		expect(res._json.status).toBe(200);
		expect(res._json.body.platform.ok).toBe(false);
		expect(res._json.body.platform.error).toBe('no_provider_configured');
		expect(res._json.body.platform.provider).toBeNull();
		expect(res._json.body.livepeer.ok).toBe(true);
	});

	it('flags an empty gateway reply rather than rendering a blank card', async () => {
		process.env.LIVEPEER_API_KEY = 'lp-test-key';
		fetchMock.mockResolvedValue(gatewayResponse(200, { choices: [] }));
		const res = await call('POST', { prompt: 'hello' });
		expect(res._json.body.livepeer.ok).toBe(false);
		expect(res._json.body.livepeer.error).toBe('empty_response');
	});
});
