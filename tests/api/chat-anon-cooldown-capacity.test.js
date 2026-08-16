/**
 * POST /api/chat - a throttled free lane is capacity, not authentication.
 *
 * Signed-out callers are pinned to the free providers (groq / openrouter /
 * nvidia, plus the vertex-gemini credits anchor). When every one of those is in
 * a health cooldown, pickProvider falls through to a provider outside the anon
 * set, and the handler used to answer `401 sign in to chat with the agent`.
 *
 * That reads as an auth problem and is unactionable: the assistant widget
 * (/assistant) runs its whole free lane anonymously and has no sign-in anywhere
 * in it, so its visitors were told to do something the surface cannot do, for a
 * throttle that clears on its own. The route must report the same
 * `503 rate_limited` + Retry-After it returns when the fallback chain is
 * exhausted, so every client backs off and retries on one code path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// An *auth* cooldown is the precondition that reaches the branch under test:
// pickProvider lets an explicitly requested provider ride out a transient health
// cooldown, but skips one whose key came back 401/402/403, so a signed-out
// request pinned to groq lands on the next configured provider instead - one
// outside the anonymous set.
const cooling = ['groq', 'openrouter', 'nvidia', 'vertex-gemini'];

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		chatIp: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
		chatUser: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
		chatHostKeyGlobal: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
	},
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/provider-health.js', () => ({
	providersInCooldown: vi.fn(async () => new Map(cooling.map((n) => [n, 'auth']))),
	markProviderCooldown: vi.fn(async () => {}),
	AUTH_COOLDOWN_SECONDS: 900,
	isBillingQuotaError: () => false,
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: () => null,
}));

vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));

const { default: handler } = await import('../../api/chat.js');

function makeReq(body) {
	return {
		method: 'POST',
		url: '/api/chat',
		headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
		socket: { remoteAddress: '127.0.0.1' },
		body,
	};
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null, headersSent: false };
	r.setHeader = (k, v) => {
		r._h[String(k).toLowerCase()] = v;
	};
	r.getHeader = (k) => r._h[String(k).toLowerCase()];
	r.writeHead = (code, headers) => {
		r.statusCode = code;
		Object.assign(r._h, headers || {});
		r.headersSent = true;
		return r;
	};
	r.write = () => true;
	r.end = (chunk) => {
		if (chunk !== undefined) r._b = String(chunk);
		r.headersSent = true;
		return r;
	};
	return r;
}

async function callChat() {
	const res = makeRes();
	await handler(makeReq({ message: 'hello', history: [], system_prompt: 'test' }), res);
	let payload = null;
	try {
		payload = JSON.parse(res._b);
	} catch {
		payload = null;
	}
	return { res, payload };
}

describe('anonymous /api/chat with every free lane cooling', () => {
	beforeEach(() => {
		// The missing-key branch legitimately 401s; this test is about configured
		// keys that are merely throttled, so give the free lanes real-looking keys.
		process.env.GROQ_API_KEY = 'test-groq-key';
		process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
		// A configured provider outside the anonymous set, so pickProvider has
		// somewhere to land once every free lane is skipped.
		process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
	});

	it('answers 503 rate_limited, never 401', async () => {
		const { res, payload } = await callChat();
		expect(res.statusCode).toBe(503);
		expect(payload?.error).toBe('rate_limited');
		expect(payload?.error_description).toMatch(/capacity/i);
	});

	it('sends a Retry-After the client can back off on', async () => {
		const { res, payload } = await callChat();
		expect(String(res.getHeader('Retry-After'))).toBe('20');
		expect(payload?.retry_after).toBe(20);
	});

	it('names the cooling free lanes so the failure is diagnosable', async () => {
		const { payload } = await callChat();
		expect(payload?.providers_tried).toEqual(
			expect.arrayContaining(['groq', 'openrouter', 'nvidia']),
		);
	});
});
