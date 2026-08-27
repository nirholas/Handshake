// The OpenRouter Claude mirror for the surfaces that reach Anthropic only
// through api.anthropic.com (_lib/llm.js, api/chat.js). With no
// ANTHROPIC_API_KEY on the service, those surfaces get no Claude at all, while
// /brain already routes the mirror ids.
//
// It draws real money on the platform key, so the contract is: OFF by default,
// on only when OPENROUTER_CLAUDE_MIRROR_MODEL names a model registered
// `paid: true` in MODEL_CATALOG, and never ahead of a free lane.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
	'OPENROUTER_API_KEY',
	'OPENROUTER_FALLBACK_KEYS',
	'OPENROUTER_CLAUDE_MIRROR_MODEL',
	'GROQ_API_KEY',
	'NVIDIA_API_KEY',
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
	'GROK_API_KEY',
	'CEREBRAS_API_KEY',
	'GEMINI_API_KEY',
	'GOOGLE_CLOUD_PROJECT',
	'VERTEX_CLAUDE_ENABLED',
	'VERTEX_CLAUDE_PRIMARY',
];

const saved = {};
let llm;

beforeEach(async () => {
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.OPENROUTER_API_KEY = 'or-platform';
	process.env.GROQ_API_KEY = 'g';
	vi.resetModules();
	llm = await import('../../api/_lib/llm.js');
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const names = () => llm.providerChain().map((p) => p.name);

describe('the mirror is off unless it is explicitly turned on', () => {
	it('is absent by default', () => {
		expect(names()).not.toContain('openrouter:claude-mirror');
	});

	it('is absent when the named model is not a metered paid model', () => {
		// An unregistered id would be priced as free openrouter traffic, so it is
		// refused rather than silently spending on an unmetered lane.
		process.env.OPENROUTER_CLAUDE_MIRROR_MODEL = 'anthropic/claude-not-a-real-model';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(names()).not.toContain('openrouter:claude-mirror');
		expect(warn).toHaveBeenCalled();
	});

	it('is absent without an OpenRouter key to bill', () => {
		delete process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_CLAUDE_MIRROR_MODEL = 'anthropic/claude-sonnet-5';
		expect(names()).not.toContain('openrouter:claude-mirror');
	});
});

describe('when on, it rides in the paid tail and never leads', () => {
	beforeEach(() => {
		process.env.OPENROUTER_CLAUDE_MIRROR_MODEL = 'anthropic/claude-sonnet-5';
	});

	it('sits after every free rung', () => {
		const chain = names();
		const mirror = chain.indexOf('openrouter:claude-mirror');
		expect(mirror).toBeGreaterThan(-1);
		for (const free of ['groq', 'openrouter', 'ovh', 'pollinations', 'groq#instant']) {
			expect(chain.indexOf(free), `${free} must be tried before the paid mirror`).toBeLessThan(mirror);
		}
	});

	it('yields to a real Anthropic key when one exists', () => {
		process.env.ANTHROPIC_API_KEY = 'sk-real';
		expect(names()).not.toContain('openrouter:claude-mirror');
	});

	it('yields to a caller BYOK key', () => {
		expect(llm.providerChain({ anthropicKey: 'sk-byok' }).map((p) => p.name)).not.toContain('openrouter:claude-mirror');
	});

	it('yields to Vertex Claude when that transport is enabled', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'proj';
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		expect(names()).not.toContain('openrouter:claude-mirror');
	});

	it('actually serves Claude when every free rung is dead', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			const u = String(url);
			const body = JSON.parse(opts.body);
			calls.push(body.model);
			if (body.model === 'anthropic/claude-sonnet-5') {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						choices: [{ message: { content: 'claude via the mirror' } }],
						// The mirror lane asks for usage accounting, so the reported
						// charge rides back with the completion.
						usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.00042 },
					}),
					text: async () => 'ok',
				};
			}
			return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' };
		});
		const out = await llm.llmComplete({ user: 'u', timeoutMs: 20_000 });
		expect(out.provider).toBe('openrouter:claude-mirror');
		expect(out.text).toBe('claude via the mirror');
		// The free lanes were all tried first.
		expect(calls[0]).toBe('qwen/qwen3.8-27b');
		expect(calls[calls.length - 1]).toBe('anthropic/claude-sonnet-5');
	}, 20_000);
});

describe('OpenRouter requests ask for usage accounting', () => {
	it('sends usage.include on every OpenRouter rung', async () => {
		const bodies = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			bodies.push({ url: String(url), body: JSON.parse(opts.body) });
			if (String(url).includes('openrouter.ai')) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
					text: async () => 'ok',
				};
			}
			return { ok: false, status: 500, json: async () => ({}), text: async () => 'down' };
		});
		await llm.llmComplete({ user: 'u', timeoutMs: 20_000 });
		const or = bodies.find((b) => b.url.includes('openrouter.ai'));
		expect(or.body.usage).toEqual({ include: true });
		// Non-OpenRouter lanes are untouched: the field is an OpenRouter extension
		// and some OpenAI-compatible backends reject unknown body fields.
		const groq = bodies.find((b) => b.url.includes('api.groq.com'));
		expect(groq.body.usage).toBeUndefined();
	}, 20_000);
});
