// A retired provider key must resolve to its successor model, not 400.
//
// api/brain/chat.js carries a PROVIDER_ALIASES table for exactly that ("gpt-4o"
// and friends were deprecated upstream and still sit in saved client prefs), but
// POST /api/brain/chat looked the raw key up in PROVIDERS *before* resolveBrain()
// ran, so every aliased key died with `unknown_provider` and the table was dead
// code on the only surface that mattered. packages/brain-mcp advertises "gpt-4o"
// as a valid provider in its chat tool schema, so an MCP client following the
// documented schema got a 400.
//
// These tests pin both halves: the alias resolves, and an actually-unknown key
// still fails at the boundary with a 400.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

// The limiter talks to Redis/Postgres in production; here every bucket passes so
// the tests exercise routing, not throttling.
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		brainChatUser: vi.fn(async () => ({ success: true })),
		brainChatIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_FALLBACK_KEYS'];
const saved = {};

beforeEach(() => {
	sessionUser = null;
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.OPENAI_API_KEY = 'sk-test';
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const ask = (provider) => ({
	method: 'POST',
	url: '/api/brain/chat',
	body: { provider, messages: [{ role: 'user', content: 'hi' }] },
});

describe('canonicalProviderKey', () => {
	it('maps every retired key onto a live one in the provider menu', async () => {
		const { canonicalProviderKey, getAvailableProviders } = await import('../../api/brain/chat.js');
		const menu = new Set(getAvailableProviders().map((p) => p.key));
		for (const retired of ['gpt-4o', 'gpt-4o-mini', 'o3-mini']) {
			const live = canonicalProviderKey(retired);
			expect(live).not.toBe(retired);
			expect(menu.has(live)).toBe(true);
		}
	});

	it('passes a live key through untouched', async () => {
		const { canonicalProviderKey } = await import('../../api/brain/chat.js');
		expect(canonicalProviderKey('gpt-oss-120b')).toBe('gpt-oss-120b');
		expect(canonicalProviderKey('claude-sonnet-5')).toBe('claude-sonnet-5');
	});
});

describe('resolveBrain on a retired key', () => {
	it('plans the successor model instead of reporting unknown_provider', async () => {
		const { resolveBrain } = await import('../../api/brain/chat.js');
		const plan = resolveBrain('gpt-4o');
		expect(plan.ok).toBe(true);
		expect(plan.spec.label).toBe('GPT-5.6 Sol');
	});

	it('still rejects a key that is not a provider and not an alias', async () => {
		const { resolveBrain } = await import('../../api/brain/chat.js');
		const plan = resolveBrain('totally-not-a-model');
		expect(plan.ok).toBe(false);
		expect(plan.status).toBe(400);
		expect(plan.code).toBe('unknown_provider');
	});
});

describe('POST /api/brain/chat provider gate', () => {
	it('does not 400 a retired key: it is judged as the successor model', async () => {
		const handler = (await import('../../api/brain/chat.js')).default;
		const { status, body } = await invoke(handler, ask('gpt-4o'));
		// gpt-5.6-sol is a paid first-party lane, so an anonymous caller is turned
		// away by the sign-in gate. The point is the error: `unauthorized`, meaning
		// the alias resolved, not `unknown_provider`, meaning it never did.
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('still 400s an unknown provider key', async () => {
		const handler = (await import('../../api/brain/chat.js')).default;
		const { status, body } = await invoke(handler, ask('totally-not-a-model'));
		expect(status).toBe(400);
		expect(body.error).toBe('unknown_provider');
		expect(Array.isArray(body.available)).toBe(true);
	});

	// A malformed message list is the caller's error to fix. When the requested
	// provider ALSO has no configured route, the caller must still be told about
	// their own bad input rather than being sent after a missing API key.
	it('validates the message list before reporting an unconfigured provider', async () => {
		const handler = (await import('../../api/brain/chat.js')).default;
		const { status, body } = await invoke(handler, {
			method: 'POST',
			url: '/api/brain/chat',
			body: { provider: 'gpt-oss-120b', messages: [{ role: 'system', content: 'hi' }] },
		});
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
	});
});
