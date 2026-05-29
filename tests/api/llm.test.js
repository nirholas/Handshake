// Tests for api/_lib/llm.js — the canonical server-side LLM helper.
// Focus: the platform provider policy — Groq/OpenRouter are the free defaults,
// Anthropic is BYOK-only, nothing hard-fails on a missing Anthropic key, and a
// failing provider falls over to the next.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// env.js reads process.env lazily through getters, so setting/clearing keys
// here is reflected on the next llmComplete() call without re-importing.
function clearKeys() {
	delete process.env.GROQ_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
}

// Route a mocked fetch by host so each provider returns its own wire shape.
function installFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts) => {
		const u = String(url);
		const body = opts?.body ? JSON.parse(opts.body) : null;
		calls.push({ url: u, headers: opts?.headers || {}, body });
		const match = Object.keys(routes).find((host) => u.includes(host));
		if (!match) throw new Error(`unexpected fetch: ${u}`);
		return routes[match];
	});
	return calls;
}

function okJson(payload) {
	return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}
function errResp(status, text = 'upstream boom') {
	return { ok: false, status, json: async () => ({}), text: async () => text };
}

const GROQ_HOST = 'api.groq.com';
const OPENROUTER_HOST = 'openrouter.ai';
const ANTHROPIC_HOST = 'api.anthropic.com';

const openaiShape = (content) => okJson({
	choices: [{ message: { content } }],
	usage: { prompt_tokens: 11, completion_tokens: 22 },
});
const anthropicShape = (text) => okJson({
	content: [{ type: 'text', text }],
	usage: { input_tokens: 33, output_tokens: 44 },
});

let llm;
beforeEach(async () => {
	clearKeys();
	vi.resetModules();
	llm = await import('../../api/_lib/llm.js');
});
afterEach(() => {
	vi.restoreAllMocks();
	clearKeys();
});

describe('llmConfigured', () => {
	it('false when no free key and no BYOK key', () => {
		expect(llm.llmConfigured()).toBe(false);
	});
	it('true when GROQ_API_KEY is set', () => {
		process.env.GROQ_API_KEY = 'g';
		expect(llm.llmConfigured()).toBe(true);
	});
	it('true when only a BYOK Anthropic key is supplied (no free keys)', () => {
		expect(llm.llmConfigured({ anthropicKey: 'sk-byok' })).toBe(true);
	});
});

describe('llmComplete — free platform providers', () => {
	it('uses Groq (OpenAI-compat) when GROQ_API_KEY is set', async () => {
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({ [GROQ_HOST]: openaiShape('hello from groq') });
		const out = await llm.llmComplete({ system: 'sys', user: 'hi', maxTokens: 64 });
		expect(out.provider).toBe('groq');
		expect(out.text).toBe('hello from groq');
		expect(out.usage).toEqual({ input: 11, output: 22 });
		// OpenAI-compat body: system+user as messages, bearer auth.
		expect(calls[0].body.messages).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'hi' },
		]);
		expect(calls[0].headers.authorization).toBe('Bearer g');
	});

	it('falls back to OpenRouter when Groq errors', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		const calls = installFetch({
			[GROQ_HOST]: errResp(500),
			[OPENROUTER_HOST]: openaiShape('from openrouter'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('openrouter');
		expect(out.text).toBe('from openrouter');
		expect(calls.map((c) => c.url.includes(GROQ_HOST) ? 'groq' : 'or')).toEqual(['groq', 'or']);
	});
});

describe('llmComplete — Anthropic is BYOK-only', () => {
	it('does NOT call Anthropic when no BYOK key is passed, even with a server env key', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-server'; // present but must be ignored
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({ [GROQ_HOST]: openaiShape('groq wins') });
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('groq');
		expect(calls.every((c) => !c.url.includes(ANTHROPIC_HOST))).toBe(true);
	});

	it('uses Anthropic first when a BYOK key is explicitly supplied', async () => {
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({ [ANTHROPIC_HOST]: anthropicShape('claude says hi') });
		const out = await llm.llmComplete({ system: 's', user: 'u', anthropicKey: 'sk-byok' });
		expect(out.provider).toBe('anthropic');
		expect(out.text).toBe('claude says hi');
		expect(out.usage).toEqual({ input: 33, output: 44 });
		expect(calls[0].headers['x-api-key']).toBe('sk-byok');
		// Anthropic body: top-level system + user-only messages.
		expect(calls[0].body.system).toBe('s');
		expect(calls[0].body.messages).toEqual([{ role: 'user', content: 'u' }]);
	});
});

describe('llmComplete — failure modes', () => {
	it('throws LlmUnavailableError (503) when no provider is configured', async () => {
		installFetch({});
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
			code: 'llm_unavailable',
			status: 503,
		});
	});

	it('throws the last upstream error (502) when every provider fails', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		installFetch({ [GROQ_HOST]: errResp(500), [OPENROUTER_HOST]: errResp(429) });
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ status: 502 });
	});
});
