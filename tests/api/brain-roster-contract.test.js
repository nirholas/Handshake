// Two things the /brain page reads off GET /api/brain/chat, pinned here because
// the page has no other source of truth for either.
//
// 1. `requiresAuth`. `available` only says the deployment holds a route for a
//    model; the anon gate (ANON_BRAIN_PROVIDERS) decides whether a signed-out
//    caller may use it. Without the flag the page cannot tell the two apart, so
//    it opened with a default line-up of paid models that could only answer 401
//    for the visitor most likely to be signed out: a first-time one.
//
// 2. The message a failed stream shows. When every rung of the fallback chain
//    fails, the raw error belongs to the last route tried, and the visitor read
//    a bare "Forbidden" inside the model's column: a word about a provider they
//    never chose and cannot act on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_FALLBACK_KEYS', 'NVIDIA_API_KEY'];
const saved = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.OPENAI_API_KEY = 'sk-test';
	process.env.NVIDIA_API_KEY = 'nv-test';
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('GET /api/brain/chat roster · requiresAuth', () => {
	it('flags every provider, and agrees with the anon gate the handler enforces', async () => {
		const { getAvailableProviders, ANON_BRAIN_PROVIDERS } = await import('../../api/brain/chat.js');
		const roster = getAvailableProviders();
		expect(roster.length).toBeGreaterThan(0);

		for (const p of roster) {
			expect(typeof p.requiresAuth).toBe('boolean');
			// The flag IS the gate, not a second opinion about it.
			expect(p.requiresAuth).toBe(!ANON_BRAIN_PROVIDERS.has(p.key));
		}
	});

	it('leaves the platform default open to a signed-out visitor', async () => {
		const { getAvailableProviders } = await import('../../api/brain/chat.js');
		const dflt = getAvailableProviders().find((p) => p.key === 'gpt-oss-120b');
		expect(dflt.requiresAuth).toBe(false);
	});

	it('keeps the paid first-party lanes behind sign-in', async () => {
		const { getAvailableProviders } = await import('../../api/brain/chat.js');
		const byKey = new Map(getAvailableProviders().map((p) => [p.key, p]));
		for (const key of ['claude-sonnet-5', 'gpt-5.6-sol', 'o3', 'qwen-plus']) {
			expect(byKey.get(key).requiresAuth).toBe(true);
		}
	});

	it('offers a signed-out visitor at least one usable model besides the default', async () => {
		const { getAvailableProviders } = await import('../../api/brain/chat.js');
		const open = getAvailableProviders().filter((p) => p.available && !p.requiresAuth);
		expect(open.length).toBeGreaterThan(1);
	});
});

describe('userFacingStreamError', () => {
	it('turns an upstream 403 into something the visitor can act on', async () => {
		const { userFacingStreamError } = await import('../../api/brain/chat.js');
		const msg = userFacingStreamError(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
		expect(msg).not.toMatch(/forbidden/i);
		expect(msg).toMatch(/pick another model/i);
	});

	it('names rate limiting as rate limiting', async () => {
		const { userFacingStreamError } = await import('../../api/brain/chat.js');
		expect(userFacingStreamError({ statusCode: 429, message: 'Too Many Requests' }))
			.toMatch(/rate limited/i);
		expect(userFacingStreamError(new Error('RESOURCE_EXHAUSTED: quota exceeded')))
			.toMatch(/rate limited/i);
	});

	it('distinguishes a timeout from a dead route', async () => {
		const { userFacingStreamError } = await import('../../api/brain/chat.js');
		expect(userFacingStreamError(new Error('The operation timed out'))).toMatch(/too long/i);
	});

	it('still says something useful for an error it has never seen', async () => {
		const { userFacingStreamError } = await import('../../api/brain/chat.js');
		const msg = userFacingStreamError(new Error('socket hang up'));
		expect(msg).toMatch(/could not answer/i);
		expect(msg).not.toMatch(/socket/i);
	});
});
