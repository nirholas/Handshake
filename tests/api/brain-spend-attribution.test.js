// /brain was the platform's largest unmetered LLM surface: it routes paid
// vendor mirrors (anthropic/claude-opus-5 at $5/$25 per MTok) on the platform
// OpenRouter key and wrote nothing at all to the spend ledger, so the $30
// balance drained with no record of where it went.
//
// Attribution only works if EVERY lane in the menu resolves to a ledger
// provider name. A lane that does not is invisible again, which is the exact
// bug, so this asserts the mapping is total rather than spot-checking it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAvailableProviders, meterProviderForNetwork } from '../../api/brain/chat.js';
import { costMicroUsd, isFreeLane } from '../../api/_lib/llm-pricing.js';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_FALLBACK_KEYS', 'GROK_API_KEY', 'GOOGLE_CLOUD_PROJECT'];
const saved = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	// A key for every lane so the whole menu resolves, including the paid ones.
	process.env.ANTHROPIC_API_KEY = 'sk-a';
	process.env.OPENAI_API_KEY = 'sk-o';
	process.env.GROQ_API_KEY = 'g';
	process.env.NVIDIA_API_KEY = 'nvapi-x';
	process.env.OPENROUTER_API_KEY = 'or';
	process.env.GROK_API_KEY = 'xai';
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('every /brain lane resolves to a metered provider', () => {
	it('maps every network in the provider menu', () => {
		const unmapped = getAvailableProviders()
			.map((p) => p.network)
			.filter((network, i, all) => all.indexOf(network) === i)
			.filter((network) => !meterProviderForNetwork(network));
		expect(unmapped).toEqual([]);
	});

	it('the menu is non-empty, so the check above cannot pass vacuously', () => {
		expect(getAvailableProviders().length).toBeGreaterThan(10);
	});
});

describe('a /brain turn on a paid mirror is priced, not zeroed', () => {
	// The exact shape of the spend that went missing: an OpenRouter-routed Claude
	// turn on the platform key.
	it('prices an OpenRouter Claude mirror turn above zero', () => {
		const cost = costMicroUsd({ provider: 'openrouter', model: 'anthropic/claude-opus-5', input: 2_000, output: 800 });
		expect(cost).toBeGreaterThan(0);
		expect(isFreeLane('openrouter', 'anthropic/claude-opus-5')).toBe(false);
	});

	it('still prices the free default route at zero', () => {
		expect(costMicroUsd({ provider: 'openrouter', model: 'google/gemma-4-31b-it:free', input: 2_000, output: 800 })).toBe(0);
	});

	it('prices the credits-funded Vertex Gemini anchor rather than treating it as free', () => {
		expect(costMicroUsd({ provider: 'vertex-gemini', model: 'google/gemini-2.5-flash', input: 2_000, output: 800 })).toBeGreaterThan(0);
	});
});
