// OpenRouter answers a free-tier quota cap with 429 and NO Retry-After header:
// the reset instant lives inside the error body, at
// error.metadata.headers['X-RateLimit-Reset'] (epoch milliseconds). The proxy
// used to look only at headers, so a quota-exhausted response reached the
// browser with no backoff hint at all and clients could only guess or spin.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_FALLBACK_KEYS: [] },
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { chatIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '203.0.113.7'),
}));

// The model gate and liveness check are covered by chat-proxy-ratelimit.test.js;
// here they must simply let a valid :free id through to the upstream call.
vi.mock('../../api/_lib/openrouter-free.js', () => ({
	isFreeModelId: (id) => typeof id === 'string' && id.endsWith(':free'),
	isLiveFreeModel: async () => true,
	pickDefaultFreeModel: async () => null,
}));

vi.mock('../../api/agent/run.js', () => ({
	AGENT_MODEL_ID: 'three-ws/agent',
	runAgentCompletion: vi.fn(),
}));

vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({
	instrument: vi.fn(() => null),
	drain: vi.fn(async () => {}),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

const { default: handler } = await import('../../api/chat/proxy.js');

function makeReq(body) {
	const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
	stream.method = 'POST';
	stream.url = '/api/chat/proxy';
	stream.headers = { host: 'localhost', 'content-type': 'application/json' };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		headersSent: false,
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

/** A 429 shaped exactly like OpenRouter's real quota-cap response. */
function quotaCapped(resetEpochMs, { retryAfterHeader = null } = {}) {
	return {
		status: 429,
		body: null,
		headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfterHeader : null) },
		text: async () =>
			JSON.stringify({
				error: {
					message: 'Rate limit exceeded: free-models-per-day-high-balance. ',
					code: 429,
					metadata: {
						headers: {
							'X-RateLimit-Limit': '1000',
							'X-RateLimit-Remaining': '0',
							'X-RateLimit-Reset': String(resetEpochMs),
						},
					},
				},
			}),
	};
}

async function send(upstream) {
	fetchMock.mockResolvedValue(upstream);
	const res = makeRes();
	await handler(makeReq({ model: 'google/gemma-4-31b-it:free', messages: [] }), res);
	return res;
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.useRealTimers();
});

describe('POST /api/chat/proxy: upstream 429 backoff hint', () => {
	it('derives Retry-After from the reset epoch in the error body', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
		// Reset at the next UTC midnight: 12 hours out.
		const res = await send(quotaCapped(Date.parse('2026-08-11T00:00:00Z')));
		expect(res.statusCode).toBe(429);
		expect(res.getHeader('retry-after')).toBe(String(12 * 60 * 60));
		expect(JSON.parse(res.body).retry_after).toBe(String(12 * 60 * 60));
	});

	it('prefers an explicit Retry-After header when the upstream sends one', async () => {
		const res = await send(quotaCapped(Date.parse('2026-08-11T00:00:00Z'), { retryAfterHeader: '30' }));
		expect(res.getHeader('retry-after')).toBe('30');
	});

	it('floors an already-elapsed reset at 1 second instead of going negative', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
		const res = await send(quotaCapped(Date.parse('2026-08-10T11:00:00Z')));
		expect(res.getHeader('retry-after')).toBe('1');
	});

	it('still answers 429 when the body carries no usable reset', async () => {
		const res = await send({
			status: 429,
			body: null,
			headers: { get: () => null },
			text: async () => 'upstream is unhappy',
		});
		expect(res.statusCode).toBe(429);
		expect(res.getHeader('retry-after')).toBeUndefined();
		const out = JSON.parse(res.body);
		expect(out.error).toBe('rate_limited');
		expect(out.retry_after).toBeUndefined();
	});
});
