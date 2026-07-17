import { describe, it, expect } from 'vitest';
import {
	MODEL_CATALOG,
	modelSupportsTools,
	isModelModerationGated,
	isPaidModel,
	usableModels,
	DEFAULT_FREE_MODEL,
	DEFAULT_PROVIDER_ORDER,
	PROVIDER_MODEL_DEFAULTS,
	OPENROUTER_SIBLINGS,
	ANON_PROVIDER_LIST,
	MAX_FALLBACK_ATTEMPTS,
	TOTAL_BUDGET_MS,
} from '../api/_lib/chat-models.js';

const GRANITE = 'ibm-granite/granite-4.1-8b';

// Models removed from the catalog because they will never succeed: OpenRouter
// 404 "No endpoints found" / no tool-capable endpoint. They must never appear
// in any routing list.
const DEAD_ROUTES = [
	'mistralai/mistral-7b-instruct:free',
	'meta-llama/llama-3.2-3b-instruct:free',
	'openai/gpt-oss-120b', // non-free variant, never catalogued
];

describe('chat-models catalog', () => {
	it('does not carry permanently-broken routes', () => {
		for (const dead of DEAD_ROUTES) {
			expect(MODEL_CATALOG[dead], `${dead} should be absent`).toBeUndefined();
		}
	});

	it('every catalogued model declares a provider and tool capability', () => {
		for (const [id, meta] of Object.entries(MODEL_CATALOG)) {
			expect(meta.provider, `${id} provider`).toBeTruthy();
			expect(typeof meta.tools, `${id} tools`).toBe('boolean');
		}
	});

	it('marks gpt-oss-120b:free moderation-gated and tool-capable', () => {
		expect(isModelModerationGated('openai/gpt-oss-120b:free')).toBe(true);
		expect(modelSupportsTools('openai/gpt-oss-120b:free')).toBe(true);
	});
});

describe('usableModels (route selector)', () => {
	const ALL = Object.keys(MODEL_CATALOG);

	it('a tool-required request never returns a non-tool model', () => {
		// Inject a hypothetical non-tool model id and confirm it is filtered.
		const candidates = [...ALL, 'meta-llama/llama-3.2-3b-instruct:free'];
		const picked = usableModels(candidates, { requireTools: true });
		for (const m of picked) {
			expect(modelSupportsTools(m), `${m} must support tools`).toBe(true);
		}
		// The unknown/non-tool id is dropped.
		expect(picked).not.toContain('meta-llama/llama-3.2-3b-instruct:free');
	});

	it('excludes moderation-gated models from auto selection by default', () => {
		const picked = usableModels(ALL, { requireTools: true });
		expect(picked).not.toContain('openai/gpt-oss-120b:free');
	});

	it('includes gated models only when explicitly allowed', () => {
		const picked = usableModels(['openai/gpt-oss-120b:free'], { allowGated: true });
		expect(picked).toContain('openai/gpt-oss-120b:free');
	});

	it('drops unknown models entirely', () => {
		expect(usableModels(['totally-made-up-model'])).toEqual([]);
	});
});

describe('free-first ordering', () => {
	it('every free provider ranks ahead of every paid provider', () => {
		// Free providers (Groq → OpenRouter → NVIDIA NIM) always lead; the paid
		// keys (Anthropic, OpenAI, Grok) are last-resort backstops only reached
		// when all three free lanes have failed.
		expect(DEFAULT_PROVIDER_ORDER).toEqual(['groq', 'openrouter', 'nvidia', 'anthropic', 'openai', 'grok']);
		const free = ['groq', 'openrouter', 'nvidia'];
		const paid = ['anthropic', 'openai', 'grok'];
		for (const f of free) {
			for (const p of paid) {
				expect(DEFAULT_PROVIDER_ORDER.indexOf(f), `${f} before ${p}`).toBeLessThan(DEFAULT_PROVIDER_ORDER.indexOf(p));
			}
		}
	});

	it('does not lead the free tier with the moderation-gated model', () => {
		expect(DEFAULT_FREE_MODEL).not.toBe('openai/gpt-oss-120b:free');
		expect(isModelModerationGated(DEFAULT_FREE_MODEL)).toBe(false);
		expect(modelSupportsTools(DEFAULT_FREE_MODEL)).toBe(true);
	});

	it('OpenRouter siblings are all live, tool-capable, non-gated', () => {
		for (const m of OPENROUTER_SIBLINGS) {
			expect(MODEL_CATALOG[m], `${m} catalogued`).toBeDefined();
			expect(modelSupportsTools(m)).toBe(true);
			expect(isModelModerationGated(m)).toBe(false);
		}
	});

	it('every provider default is a real, usable, tool-capable model', () => {
		for (const [provider, model] of Object.entries(PROVIDER_MODEL_DEFAULTS)) {
			expect(MODEL_CATALOG[model], `${provider} default ${model}`).toBeDefined();
			expect(MODEL_CATALOG[model].provider).toBe(provider);
			expect(modelSupportsTools(model)).toBe(true);
		}
	});

	it('anonymous callers are clamped to free tiers plus the credits-funded Vertex Gemini anchor', () => {
		expect(ANON_PROVIDER_LIST).toEqual(['groq', 'openrouter', 'nvidia', 'vertex-gemini']);
		// The free third-party lanes lead; the funded Vertex anchor is the
		// last-resort rung so an anon caller never 503s just because every free
		// tier is rate-limited at once.
		expect(ANON_PROVIDER_LIST[ANON_PROVIDER_LIST.length - 1]).toBe('vertex-gemini');
		// No paid third-party provider is ever exposed to anon callers.
		expect(ANON_PROVIDER_LIST).not.toContain('openai');
		expect(ANON_PROVIDER_LIST).not.toContain('anthropic');
		expect(ANON_PROVIDER_LIST).not.toContain('vertex-anthropic');
	});
});

describe('paid/BYOK model gating (OpenRouter Granite)', () => {
	it('the Granite lane is catalogued, tool-capable, and flagged paid', () => {
		expect(MODEL_CATALOG[GRANITE], 'granite catalogued').toBeDefined();
		expect(MODEL_CATALOG[GRANITE].provider).toBe('openrouter');
		expect(modelSupportsTools(GRANITE)).toBe(true);
		expect(isPaidModel(GRANITE)).toBe(true);
	});

	it('isPaidModel is false for free and unknown models', () => {
		expect(isPaidModel(DEFAULT_FREE_MODEL)).toBe(false);
		expect(isPaidModel('llama-3.3-70b-versatile')).toBe(false);
		expect(isPaidModel('totally-made-up-model')).toBe(false);
	});

	it('the paid model is never in an auto-selected free path', () => {
		// Not a per-provider default, not an OpenRouter sibling, not the free model.
		expect(Object.values(PROVIDER_MODEL_DEFAULTS)).not.toContain(GRANITE);
		expect(OPENROUTER_SIBLINGS).not.toContain(GRANITE);
		expect(DEFAULT_FREE_MODEL).not.toBe(GRANITE);
	});

	it('no free-provider default is a paid model (anon can never auto-hit one)', () => {
		for (const provider of ANON_PROVIDER_LIST) {
			const model = PROVIDER_MODEL_DEFAULTS[provider];
			expect(isPaidModel(model), `${provider} default ${model} must be free`).toBe(false);
		}
	});
});

describe('bounded fallback chain', () => {
	it('caps attempts and wall-clock to prevent provider churn', () => {
		expect(MAX_FALLBACK_ATTEMPTS).toBeGreaterThanOrEqual(2);
		expect(MAX_FALLBACK_ATTEMPTS).toBeLessThanOrEqual(4);
		// Budget must leave streaming headroom under the 60s function limit.
		expect(TOTAL_BUDGET_MS).toBeGreaterThan(0);
		expect(TOTAL_BUDGET_MS).toBeLessThan(60_000);
	});
});
