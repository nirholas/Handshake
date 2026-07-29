// Prompt caching + Claude 5 request-shape guards.
//
// Two classes of regression are covered here, both silent when broken:
//
//   1. COST UNDER-REPORTING. Once a request carries a `cache_control`
//      breakpoint, Anthropic reports `usage.input_tokens` as the UNCACHED
//      REMAINDER only, moving the rest onto `cache_creation_input_tokens` /
//      `cache_read_input_tokens`. Pricing that reads only `input_tokens` sees
//      a large prompt shrink to near zero and reports spend that never
//      happened — the numbers look better, which is exactly why nobody
//      notices. costMicroUsd must price all three counters.
//
//   2. EMPTY REPLIES ON CLAUDE 5. Those models think by default, `max_tokens`
//      caps thinking + visible text together, and they reject sampling
//      params with a 400. A small max_tokens or a stray `temperature` carried
//      over from an older model yields a truncated/empty reply or a hard 400.
//
// See api/_lib/llm-pricing.js, api/_lib/chat-models.js, api/llm/anthropic.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { costMicroUsd } from '../api/_lib/llm-pricing.js';
import {
	modelRejectsSampling,
	modelThinksByDefault,
	MODEL_CATALOG,
	PROVIDER_MODEL_DEFAULTS,
	promptCacheMinChars,
	vertexServesModel,
} from '../api/_lib/chat-models.js';
import { sanitizeAnthropicBody } from '../api/llm/anthropic.js';
import { promptTokens } from '../api/_lib/llm.js';

const M = 1_000_000;

describe('promptTokens — true prompt size across the cache counters', () => {
	it('sums the uncached remainder with both cache counters', () => {
		expect(promptTokens({ input: 120, cacheWrite: 0, cacheRead: 9_000, output: 50 })).toBe(9_120);
	});

	it('matches usage.input when nothing was cached', () => {
		expect(promptTokens({ input: 1234, cacheWrite: 0, cacheRead: 0 })).toBe(1234);
	});

	it('tolerates providers that report no cache fields at all', () => {
		expect(promptTokens({ input: 77, output: 9 })).toBe(77);
	});

	it('is defensive about a missing usage object', () => {
		expect(promptTokens(undefined)).toBe(0);
		expect(promptTokens(null)).toBe(0);
	});
});

describe('costMicroUsd — prompt-cache accounting', () => {
	it('prices a cache write at 1.25x the model input rate', () => {
		// Sonnet 5 input is $3/MTok → a 1M-token cache write is $3.75.
		const cost = costMicroUsd({
			provider: 'anthropic',
			model: 'claude-sonnet-5',
			cacheWrite: M,
		});
		expect(cost).toBe(3.75 * M);
	});

	it('prices a cache read at 0.1x the model input rate', () => {
		const cost = costMicroUsd({
			provider: 'anthropic',
			model: 'claude-sonnet-5',
			cacheRead: M,
		});
		expect(cost).toBe(0.3 * M);
	});

	it('treats cache counters as disjoint from input, not overlapping', () => {
		// The API splits one prompt across the three counters. Pricing must sum
		// them; treating cacheRead as a subset of input (or ignoring it) is the
		// under-reporting bug this guards.
		const split = costMicroUsd({
			provider: 'anthropic',
			model: 'claude-opus-5',
			input: 1000,
			cacheRead: 9000,
			output: 0,
		});
		const inputOnly = costMicroUsd({
			provider: 'anthropic',
			model: 'claude-opus-5',
			input: 1000,
		});
		expect(split).toBeGreaterThan(inputOnly);
		// Opus 5 input $5/MTok: 1000 * 5 + 9000 * 5 * 0.1 = 5000 + 4500.
		expect(split).toBe(9500);
	});

	it('is cheaper to re-read a cached prefix than to send it uncached', () => {
		// The whole point of caching. A warm turn must price below a cold one.
		const cold = costMicroUsd({ provider: 'anthropic', model: 'claude-sonnet-5', input: 50_000 });
		const warm = costMicroUsd({
			provider: 'anthropic',
			model: 'claude-sonnet-5',
			input: 0,
			cacheRead: 50_000,
		});
		expect(warm).toBeLessThan(cold);
	});

	it('leaves uncached calls priced exactly as before', () => {
		const before = costMicroUsd({ provider: 'anthropic', model: 'claude-sonnet-5', input: 1000, output: 500 });
		expect(before).toBe(1000 * 3 + 500 * 15);
	});

	it('still zeroes free providers even when cache counters are present', () => {
		expect(
			costMicroUsd({ provider: 'groq', model: 'llama-3.3-70b-versatile', cacheRead: M, cacheWrite: M }),
		).toBe(0);
	});
});

describe('Claude 5 catalog wiring', () => {
	it('registers the current generation as tool-capable', () => {
		for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
			expect(MODEL_CATALOG[id]?.tools, id).toBe(true);
		}
	});

	it('defaults the Anthropic provider to Sonnet 5', () => {
		expect(PROVIDER_MODEL_DEFAULTS.anthropic).toBe('claude-sonnet-5');
	});

	it('routes the current generation through the Vertex credits transport', () => {
		expect(vertexServesModel('claude-sonnet-5')).toBe(true);
		expect(vertexServesModel('claude-opus-5')).toBe(true);
	});

	it('keeps Mythos out of auto-built chains (restricted access)', () => {
		expect(MODEL_CATALOG['claude-mythos-5']?.moderationGated).toBe(true);
	});

	it('flags sampling rejection for Opus 4.7 onward only', () => {
		expect(modelRejectsSampling('claude-opus-5')).toBe(true);
		expect(modelRejectsSampling('claude-sonnet-5')).toBe(true);
		expect(modelRejectsSampling('claude-opus-4-7')).toBe(true);
		// Older models still accept temperature — stripping it there would be a
		// silent behavior change for existing callers.
		expect(modelRejectsSampling('claude-haiku-4-5-20251001')).toBe(false);
		expect(modelRejectsSampling('claude-sonnet-4-6')).toBe(false);
	});

	it('flags thinking-by-default for the Claude 5 family only', () => {
		expect(modelThinksByDefault('claude-sonnet-5')).toBe(true);
		expect(modelThinksByDefault('claude-opus-5')).toBe(true);
		expect(modelThinksByDefault('claude-fable-5')).toBe(true);
		// 4.8/4.7 need thinking requested explicitly, so their budgets are fine.
		expect(modelThinksByDefault('claude-opus-4-8')).toBe(false);
		expect(modelThinksByDefault('claude-haiku-4-5-20251001')).toBe(false);
	});
});

describe('promptCacheMinChars — per-model cacheable minimum', () => {
	it('uses the low 512-token minimum for Opus 5 / Fable / Mythos', () => {
		// These cache from half the prefix Sonnet 5 needs. A flat threshold set
		// for Sonnet would silently forfeit those savings.
		expect(promptCacheMinChars('claude-opus-5')).toBe(1792);
		expect(promptCacheMinChars('claude-fable-5')).toBe(1792);
	});

	it('uses the 1024-token minimum for the Sonnet 5 / Opus 4.8 tier', () => {
		expect(promptCacheMinChars('claude-sonnet-5')).toBe(3584);
		expect(promptCacheMinChars('claude-opus-4-8')).toBe(3584);
	});

	it('is NOT monotonic across generations — Haiku 4.5 needs 8x Opus 5', () => {
		// The trap this table exists to encode: a newer model can have a much
		// LOWER minimum than an older one, so "newer means cheaper to cache" is
		// a wrong assumption to hardcode.
		expect(promptCacheMinChars('claude-haiku-4-5')).toBe(14_336);
		expect(promptCacheMinChars('claude-haiku-4-5')).toBeGreaterThan(
			promptCacheMinChars('claude-opus-5'),
		);
	});

	it('resolves the dated Haiku alias to its family threshold', () => {
		expect(promptCacheMinChars('claude-haiku-4-5-20251001')).toBe(
			promptCacheMinChars('claude-haiku-4-5'),
		);
	});

	it('falls back to the most conservative threshold for unknown models', () => {
		// An unknown id must not get a marker that would bill a wasted cache
		// write, so it gets the strictest requirement in the table.
		expect(promptCacheMinChars('some-future-model')).toBe(14_336);
		expect(promptCacheMinChars(undefined)).toBe(14_336);
	});
});

describe('sanitizeAnthropicBody — embed proxy request-shape guard', () => {
	it('strips temperature for models that 400 on it', () => {
		const out = sanitizeAnthropicBody({ temperature: 0.7, max_tokens: 8000 }, 'claude-opus-5');
		expect(out.temperature).toBeUndefined();
	});

	it('keeps temperature for models that accept it', () => {
		const out = sanitizeAnthropicBody({ temperature: 0.7, max_tokens: 600 }, 'claude-haiku-4-5-20251001');
		expect(out.temperature).toBe(0.7);
		expect(out.max_tokens).toBe(600);
	});

	it('upgrades the removed budget_tokens thinking form to adaptive', () => {
		const out = sanitizeAnthropicBody(
			{ max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 2000 } },
			'claude-opus-5',
		);
		expect(out.thinking).toEqual({ type: 'adaptive' });
	});

	it('drops an explicit disabled-thinking config on Fable (always-on model)', () => {
		const out = sanitizeAnthropicBody(
			{ max_tokens: 8000, thinking: { type: 'disabled' } },
			'claude-fable-5',
		);
		expect(out.thinking).toBeUndefined();
	});

	it('preserves an adaptive thinking config with a display preference', () => {
		const thinking = { type: 'adaptive', display: 'summarized' };
		const out = sanitizeAnthropicBody({ max_tokens: 8000, thinking }, 'claude-fable-5');
		expect(out.thinking).toEqual(thinking);
	});

	it('floors max_tokens on thinking-by-default models so the reply survives', () => {
		// A 300-token cap would be spent entirely on thinking, returning an empty
		// visible reply with no error.
		const out = sanitizeAnthropicBody({ max_tokens: 300 }, 'claude-sonnet-5');
		expect(out.max_tokens).toBeGreaterThanOrEqual(4096);
	});

	it('never lowers a caller budget that is already generous', () => {
		const out = sanitizeAnthropicBody({ max_tokens: 16_000 }, 'claude-opus-5');
		expect(out.max_tokens).toBe(16_000);
	});

	it('adds a cache breakpoint to a large string system prompt', () => {
		const out = sanitizeAnthropicBody({ system: 'x'.repeat(5000), max_tokens: 8000 }, 'claude-sonnet-5');
		expect(Array.isArray(out.system)).toBe(true);
		expect(out.system[0].cache_control).toEqual({ type: 'ephemeral' });
		expect(out.system[0].text).toHaveLength(5000);
	});

	it('leaves a short system prompt as a plain string', () => {
		const out = sanitizeAnthropicBody({ system: 'be brief', max_tokens: 8000 }, 'claude-sonnet-5');
		expect(out.system).toBe('be brief');
	});

	it('does not clobber a caller-supplied block array system prompt', () => {
		const system = [{ type: 'text', text: 'x'.repeat(5000), cache_control: { type: 'ephemeral' } }];
		const out = sanitizeAnthropicBody({ system, max_tokens: 8000 }, 'claude-sonnet-5');
		expect(out.system).toBe(system);
	});

	it('does not mutate the caller body', () => {
		const body = { temperature: 0.7, max_tokens: 300, thinking: { type: 'enabled', budget_tokens: 100 } };
		sanitizeAnthropicBody(body, 'claude-opus-5');
		expect(body.temperature).toBe(0.7);
		expect(body.max_tokens).toBe(300);
		expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 100 });
	});
});

// ── Integration: the assembled request and the spend ledger must agree ────────
//
// The unit tests above cover each helper in isolation. This block drives the
// real llmComplete() against a stubbed upstream and asserts on the body that
// actually goes over the wire plus the cost derived from a CACHED response —
// the seam where the under-reporting bug lived.

describe('llmComplete — Anthropic request shape and cached-turn accounting', () => {
	const ANTHROPIC_KEYS = [
		'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'CEREBRAS_API_KEY',
		'GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROK_API_KEY', 'GOOGLE_CLOUD_PROJECT',
		'VERTEX_CLAUDE_ENABLED', 'DATABASE_URL',
	];
	const saved = {};
	let llm;
	let captured;

	beforeEach(async () => {
		for (const k of ANTHROPIC_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
		captured = [];
		vi.stubGlobal('fetch', async (url, opts = {}) => {
			const u = String(url);
			captured.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
			if (!u.includes('api.anthropic.com')) return new Response('nope', { status: 500 });
			return new Response(
				JSON.stringify({
					// A thinking-model response: the leading block carries no text.
					content: [
						{ type: 'thinking', thinking: '' },
						{ type: 'text', text: 'the real answer' },
					],
					// A CACHE HIT: input_tokens is the uncached remainder only.
					usage: {
						input_tokens: 40,
						output_tokens: 100,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 20_000,
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		});
		vi.resetModules();
		llm = await import('../api/_lib/llm.js');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		delete process.env.ANTHROPIC_API_KEY;
		for (const k of ANTHROPIC_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	const run = () =>
		llm.llmComplete({
			system: 'PERSONA AND PLATFORM KNOWLEDGE. '.repeat(200), // ~6.4k chars
			user: 'hello',
			maxTokens: 2000,
			anthropicKey: 'sk-byok',
			anthropicModel: 'claude-sonnet-5',
		});

	it('sends a cache breakpoint on a qualifying system prompt', async () => {
		await run();
		const req = captured.find((c) => c.url.includes('api.anthropic.com'));
		expect(Array.isArray(req.body.system)).toBe(true);
		expect(req.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
	});

	it('omits temperature for a model that rejects sampling params', async () => {
		await run();
		const req = captured.find((c) => c.url.includes('api.anthropic.com'));
		expect(req.body.temperature).toBeUndefined();
		expect(req.body.model).toBe('claude-sonnet-5');
	});

	it('reads the answer past an empty leading thinking block', async () => {
		// content[0].text would be undefined here — the reply would silently
		// come back blank on every thinking-model turn.
		const out = await run();
		expect(out.text).toBe('the real answer');
	});

	it('surfaces cache counters so a cached turn is not under-billed', async () => {
		const out = await run();
		expect(out.usage.cacheRead).toBe(20_000);
		expect(llm.promptTokens(out.usage)).toBe(20_040);

		const priced = costMicroUsd({
			provider: 'anthropic',
			model: 'claude-sonnet-5',
			input: out.usage.input,
			output: out.usage.output,
			cacheWrite: out.usage.cacheWrite,
			cacheRead: out.usage.cacheRead,
		});
		// 40*$3 + 100*$15 + 20000*$3*0.1 per MTok, in micro-USD.
		expect(priced).toBe(7_620);

		// Pricing that ignored the cache counters would report ~4.7x too little —
		// the regression this whole file exists to prevent.
		const ignoringCache = costMicroUsd({
			provider: 'anthropic',
			model: 'claude-sonnet-5',
			input: out.usage.input,
			output: out.usage.output,
		});
		expect(ignoringCache).toBeLessThan(priced);
	});

	it('still makes the cached turn far cheaper than an uncached one', async () => {
		const out = await run();
		const cached = costMicroUsd({
			provider: 'anthropic', model: 'claude-sonnet-5',
			input: out.usage.input, output: out.usage.output,
			cacheWrite: out.usage.cacheWrite, cacheRead: out.usage.cacheRead,
		});
		const uncached = costMicroUsd({
			provider: 'anthropic', model: 'claude-sonnet-5',
			input: llm.promptTokens(out.usage), output: out.usage.output,
		});
		expect(cached).toBeLessThan(uncached);
	});
});

// ── /brain output-token budget ───────────────────────────────────────────────
//
// The /brain proxy floored every request at 64 output tokens. That is safe for
// a model whose whole budget becomes visible text, and wrong for one that
// thinks by default: `max_tokens` covers reasoning AND the reply, so a small
// budget is consumed entirely by reasoning and the caller gets an empty stream
// with no error. See resolveMaxTokens in api/brain/chat.js.

describe('resolveMaxTokens — /brain budget floor', () => {
	it('floors a tiny budget on thinking-by-default models', async () => {
		const { resolveMaxTokens } = await import('../api/brain/chat.js');
		expect(resolveMaxTokens(100, 'claude-opus-5', 16_384)).toBe(4096);
		expect(resolveMaxTokens(100, 'claude-sonnet-5', 16_384)).toBe(4096);
		expect(resolveMaxTokens(100, 'claude-fable-5', 16_384)).toBe(4096);
	});

	it('leaves budgets untouched on models that answer directly', async () => {
		const { resolveMaxTokens } = await import('../api/brain/chat.js');
		// Raising these would silently increase spend on the cheap/free lanes.
		expect(resolveMaxTokens(100, 'claude-haiku-4-5', 8192)).toBe(100);
		expect(resolveMaxTokens(100, 'gpt-oss-120b', 8192)).toBe(100);
	});

	it('keeps the 4096 default when the caller names no budget', async () => {
		const { resolveMaxTokens } = await import('../api/brain/chat.js');
		expect(resolveMaxTokens(undefined, 'gpt-oss-120b', 8192)).toBe(4096);
		expect(resolveMaxTokens(0, 'gpt-oss-120b', 8192)).toBe(4096);
	});

	it('never exceeds the model output ceiling, floor included', async () => {
		const { resolveMaxTokens } = await import('../api/brain/chat.js');
		expect(resolveMaxTokens(100, 'claude-fable-5', 2048)).toBe(2048);
	});

	it('never lowers a generous caller request', async () => {
		const { resolveMaxTokens } = await import('../api/brain/chat.js');
		expect(resolveMaxTokens(16_000, 'claude-opus-5', 16_384)).toBe(16_000);
	});
});
