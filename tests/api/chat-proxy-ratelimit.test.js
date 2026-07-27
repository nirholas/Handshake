// /api/chat/proxy.js forwards requests to OpenRouter using our shared API key.
// The endpoint is intentionally unauthenticated (it's the in-browser fallback
// chat used by anonymous visitors), but only :free upstream models are allowed.
// Without per-IP rate limiting, a single client could drain the shared free
// quota for everyone — this test pins the rate-limit behavior.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const rateLimitState = {
	chatIp: { success: true },
};

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_FALLBACK_KEYS: [] },
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		chatIp: vi.fn(async () => rateLimitState.chatIp),
	},
	clientIp: vi.fn(() => '203.0.113.7'),
}));

vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({
	instrument: vi.fn(() => null),
	drain: vi.fn(async () => {}),
}));

// Stub global fetch — we never want to hit OpenRouter from a unit test.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

const { default: handler } = await import('../../api/chat/proxy.js');

function makeReq({ method = 'POST', headers = {}, body = null } = {}) {
	const stream = body
		? Readable.from([Buffer.from(JSON.stringify(body))])
		: Readable.from([]);
	stream.method = method;
	stream.url = '/api/chat/proxy';
	stream.headers = {
		host: 'localhost',
		...(body ? { 'content-type': 'application/json' } : {}),
		...headers,
	};
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
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
		write(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
		},
	};
}

beforeEach(() => {
	rateLimitState.chatIp = { success: true };
	fetchMock.mockReset();
});

describe('POST /api/chat/proxy — per-IP rate limit', () => {
	it('returns 429 when the per-IP limiter rejects the request', async () => {
		rateLimitState.chatIp = { success: false };
		const req = makeReq({ body: { model: 'meta-llama/llama-3-8b-instruct:free', messages: [] } });
		const res = makeRes();

		await handler(req, res);

		expect(res.statusCode).toBe(429);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('rate_limited');
		// rateLimited() derives Retry-After from the limiter result, flooring at 1s
		// when the mock provides no reset window.
		expect(res.getHeader('retry-after')).toBe('1');
		// Upstream fetch must NOT have been called.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rate-limit runs before upstream, even with valid free-tier model', async () => {
		rateLimitState.chatIp = { success: false };
		fetchMock.mockResolvedValue({
			status: 200,
			body: null,
			text: async () => '',
			headers: { get: () => null },
		});
		const req = makeReq({ body: { model: 'mistral:free', messages: [{ role: 'user', content: 'hi' }] } });
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(429);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('passes through when limiter approves the request', async () => {
		rateLimitState.chatIp = { success: true };
		fetchMock.mockResolvedValue({
			status: 200,
			body: null,
			text: async () => '{"id":"x"}',
			headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
		});
		const req = makeReq({ body: { model: 'mistral:free', messages: [] } });
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		// A bare count of 1 was stale: the proxy now checks OpenRouter's model
		// catalog (/api/v1/models, via isLiveFreeModel) before forwarding, because
		// `:free` endpoints get retired without notice and a saved conversation can
		// name a dead one for months. So a healthy request makes TWO upstream
		// calls, catalog then completion. Pin the contract that matters: exactly
		// one completion is spent, and it goes to OpenRouter.
		const completions = fetchMock.mock.calls.filter(([url]) => String(url).includes('/chat/completions'));
		expect(completions).toHaveLength(1);
		expect(completions[0][0]).toContain('openrouter.ai');
	});

	it('rejects non-:free models without calling upstream', async () => {
		rateLimitState.chatIp = { success: true };
		const req = makeReq({ body: { model: 'gpt-4', messages: [] } });
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_model');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
