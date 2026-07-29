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

import { describe, it, expect } from 'vitest';
import { costMicroUsd } from '../api/_lib/llm-pricing.js';
import {
	modelRejectsSampling,
	modelThinksByDefault,
	MODEL_CATALOG,
	PROVIDER_MODEL_DEFAULTS,
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
