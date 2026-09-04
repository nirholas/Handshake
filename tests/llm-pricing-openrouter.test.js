// The metering rule this file locks in: a lane that spends money must never
// report exactly $0.
//
// The defect it guards against was live and expensive. `openrouter` was on the
// blanket free-provider list, and OpenRouter namespaces every model by vendor
// (`anthropic/claude-opus-5`), which matched no key in the price table. So a
// $5/$25-per-MTok Claude turn on the platform key priced to 0 twice over, and
// the $30 balance drained with the dashboard reporting "served free" the whole
// way down. $0 and "we could not price it" must be different answers.

import { describe, it, expect } from 'vitest';
import {
	costMicroUsd,
	isPriced,
	isFreeLane,
	openRouterBaseId,
	isOpenRouterFreeModel,
} from '../api/_lib/llm-pricing.js';

describe('OpenRouter is free only on its :free routes', () => {
	it('prices a :free model at 0 on every key rung', () => {
		for (const provider of ['openrouter', 'openrouter#2', 'openrouter#3']) {
			expect(costMicroUsd({ provider, model: 'google/gemma-4-31b-it:free', input: 100_000, output: 50_000 })).toBe(0);
		}
	});

	it('prices a paid vendor mirror at the underlying model, not 0', () => {
		// 1M in / 1M out of Opus 5 at $5/$25 = $30.00 = 30,000,000 micro-USD.
		const cost = costMicroUsd({
			provider: 'openrouter',
			model: 'anthropic/claude-opus-5',
			input: 1_000_000,
			output: 1_000_000,
		});
		expect(cost).toBe(30_000_000);
	});

	it('resolves a dotted mirror id to its first-party price', () => {
		// OpenRouter writes Haiku 4.5 as `claude-haiku-4.5`; the table keys it
		// `claude-haiku-4-5`. $1/$5 per MTok.
		expect(costMicroUsd({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', input: 1_000_000, output: 0 })).toBe(1_000_000);
		expect(isPriced('anthropic/claude-haiku-4.5')).toBe(true);
	});

	it('prices the OpenAI and xAI mirrors too', () => {
		expect(costMicroUsd({ provider: 'openrouter', model: 'openai/gpt-5.6-sol', input: 1_000_000, output: 0 })).toBe(5_000_000);
		expect(costMicroUsd({ provider: 'openrouter', model: 'x-ai/grok-4.5', input: 1_000_000, output: 0 })).toBe(2_000_000);
	});

	it('keeps the Granite BYOK lane metered (the pre-existing paid openrouter route)', () => {
		expect(costMicroUsd({ provider: 'openrouter', model: 'ibm-granite/granite-4.1-8b', input: 1_000_000, output: 1_000_000 })).toBe(150_000);
	});

	it('classifies lanes: :free is free, a mirror is not', () => {
		expect(isFreeLane('openrouter', 'google/gemma-4-31b-it:free')).toBe(true);
		expect(isFreeLane('openrouter#2', 'google/gemma-4-31b-it:free')).toBe(true);
		expect(isFreeLane('openrouter', 'anthropic/claude-sonnet-5')).toBe(false);
		expect(isFreeLane('openrouter', 'ibm-granite/granite-4.1-8b')).toBe(false);
		expect(isOpenRouterFreeModel('google/gemma-4-31b-it:free')).toBe(true);
		expect(isOpenRouterFreeModel('anthropic/claude-opus-5')).toBe(false);
		expect(openRouterBaseId('anthropic/claude-opus-5')).toBe('claude-opus-5');
		expect(openRouterBaseId('grok-4.5')).toBe('grok-4.5');
	});
});

describe('an unpriceable spending lane reports unknown, never 0', () => {
	it('returns null for a mirror of a model that is not in the price table', () => {
		const cost = costMicroUsd({ provider: 'openrouter', model: 'somevendor/unknown-model-9', input: 1000, output: 1000 });
		expect(cost).toBeNull();
	});

	it('returns null for an unpriced model on a first-party paid provider', () => {
		expect(costMicroUsd({ provider: 'anthropic', model: 'claude-unreleased-9', input: 1000, output: 1000 })).toBeNull();
		expect(costMicroUsd({ provider: 'openai', model: 'gpt-9-unreleased', input: 1000, output: 1000 })).toBeNull();
	});

	it('still returns 0 (not unknown) for the genuinely free lanes', () => {
		for (const [provider, model] of [
			['groq', 'llama-3.3-70b-versatile'],
			['groq#instant', 'llama-3.1-8b-instant'],
			['nvidia', 'meta/llama-3.3-70b-instruct'],
			['cerebras', 'llama-3.3-70b'],
			['gemini', 'gemini-2.5-flash-lite'],
			['ovh', 'Meta-Llama-3_3-70B-Instruct'],
			['pollinations', 'openai-fast'],
		]) {
			expect(costMicroUsd({ provider, model, input: 500_000, output: 500_000 }), `${provider}/${model}`).toBe(0);
		}
	});

	it('keeps the credits-billed Vertex lanes metered rather than free', () => {
		expect(costMicroUsd({ provider: 'vertex-gemini', model: 'google/gemini-2.5-flash', input: 1_000_000, output: 0 })).toBe(300_000);
		expect(costMicroUsd({ provider: 'vertex-anthropic', model: 'claude-sonnet-5', input: 1_000_000, output: 0 })).toBe(3_000_000);
	});
});

describe('a provider-reported cost outranks the table', () => {
	it('uses the reported charge when OpenRouter returns usage.cost', () => {
		// The table would say $30 for these tokens; OpenRouter says it charged
		// $0.0123, and OpenRouter is the one sending the invoice.
		const cost = costMicroUsd({
			provider: 'openrouter',
			model: 'anthropic/claude-opus-5',
			input: 1_000_000,
			output: 1_000_000,
			reportedCostUsd: 0.0123,
		});
		expect(cost).toBe(12_300);
	});

	it('prices an otherwise-unpriceable model from the reported charge', () => {
		expect(costMicroUsd({ provider: 'openrouter', model: 'newvendor/brand-new', input: 10, output: 10, reportedCostUsd: 0.002 })).toBe(2_000);
	});

	it('a reported 0 on a free route is a real zero, not unknown', () => {
		expect(costMicroUsd({ provider: 'openrouter', model: 'google/gemma-4-31b-it:free', input: 10, output: 10, reportedCostUsd: 0 })).toBe(0);
	});
});
