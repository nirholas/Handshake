// Cost-model tests for the paid OpenRouter Granite lane. A BYOK model on an
// otherwise-free provider must be metered by its list price, while genuinely
// free lanes (and the free Gemini tier) stay at zero. Guards the invariant that
// adding a paid model under a free provider did not silently start charging the
// free lanes or silently zero the paid one.

import { describe, it, expect } from 'vitest';
import { costMicroUsd, isPriced } from '../api/_lib/llm-pricing.js';

const GRANITE = 'ibm-granite/granite-4.1-8b';
const M = 1_000_000;

describe('llm-pricing — paid Granite lane', () => {
	it('meters Granite by list price despite openrouter being a free provider', () => {
		// $0.05/1M in + $0.10/1M out → 50000 + 100000 = 150000 micro-USD ($0.15).
		expect(costMicroUsd({ provider: 'openrouter', model: GRANITE, input: M, output: M })).toBe(150_000);
	});

	it('meters Granite across multi-key rungs (openrouter#2)', () => {
		expect(costMicroUsd({ provider: 'openrouter#2', model: GRANITE, input: M, output: 0 })).toBe(50_000);
	});

	it('reports Granite as priced', () => {
		expect(isPriced(GRANITE)).toBe(true);
	});
});

describe('llm-pricing — free lanes stay zero', () => {
	it('free OpenRouter models are still $0', () => {
		expect(costMicroUsd({ provider: 'openrouter', model: 'google/gemma-4-31b-it:free', input: M, output: M })).toBe(0);
	});

	it('the free Gemini tier is still $0 (invariant not broken by the paid override)', () => {
		expect(costMicroUsd({ provider: 'gemini', model: 'gemini-2.5-flash', input: M, output: M })).toBe(0);
	});

	it('Vertex Gemini is still metered (draws GCP credits)', () => {
		// vertex-gemini provider is NOT in FREE_PROVIDERS → priced by model.
		expect(costMicroUsd({ provider: 'vertex-gemini', model: 'gemini-2.5-flash', input: M, output: 0 })).toBe(300_000);
	});

	it('unpriced model on a free provider is $0', () => {
		expect(costMicroUsd({ provider: 'groq', model: 'llama-3.3-70b-versatile', input: M, output: M })).toBe(0);
	});
});
