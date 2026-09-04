// Regression guard: every LLM surface keeps the credits-funded Vertex Gemini
// anchor in its fallback chain (the api/chat.js fix pattern, commit 2b3d00254).
//
// The 2026-07-21 production diagnosis: brain, widgets, copilot, vision, and the
// anthropic-proxy each hand-rolled their model fallback chains WITHOUT the
// keyless Vertex Gemini rung, so a simultaneous throttle of the free lanes
// (groq/openrouter/nvidia) surfaced 5xx even though GCP credits could answer -
// the prod OPENAI_API_KEY is billing-dead (429 billing_not_active) and the
// OpenRouter host key must never route to paid models. These tests lock the
// chat.js semantics onto every surface, via the shared api/_lib/vertex-gemini.js:
//   • the anchor is present whenever GOOGLE_CLOUD_PROJECT is set,
//   • it survives when other provider keys (OPENAI_API_KEY etc.) are present,
//   • it sits at the tail (never a primary),
//   • an anonymous/keyless deployment still gets a working chain from it,
//   • it is absent (no behavior change) without a GCP project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
	vertexGeminiAvailable,
	vertexGeminiModel,
	vertexGeminiChatUrl,
	vertexGeminiOpenAIBase,
	vertexGeminiBudget,
	vertexGeminiThinkingBudget,
} from '../../api/_lib/vertex-gemini.js';
import { providerChain } from '../../api/_lib/llm.js';
import { freeFallbackChain } from '../../api/brain/chat.js';
import { providerChain as copilotProviderChain } from '../../api/agents/copilot.js';
import { pickProviderChain as widgetProviderChain } from '../../api/widgets/[id]/[action].js';
import { visionChain, visionConfigured } from '../../api/_lib/vision.js';
import { modelFallbackChain, resolveModelRoute } from '../../api/llm/anthropic.js';

// Every env var these chains read. Saved/restored around each test so the
// suite is deterministic regardless of the host environment.
const ENV_KEYS = [
	'GOOGLE_CLOUD_PROJECT',
	'GOOGLE_CLOUD_LOCATION_GEMINI',
	'VERTEX_GEMINI_MODEL',
	'VERTEX_GEMINI_THINKING_BUDGET',
	'VERTEX_CLAUDE_ENABLED',
	'VERTEX_CLAUDE_PRIMARY',
	'GROQ_API_KEY',
	'CEREBRAS_API_KEY',
	'OPENROUTER_API_KEY',
	'OPENROUTER_FALLBACK_KEYS',
	'NVIDIA_API_KEY',
	'GEMINI_API_KEY',
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
	'GROK_API_KEY',
	'WATSONX_API_KEY',
	'CHAT_MODEL',
];

const saved = {};
beforeEach(() => {
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

// The prod repro: every free key AND the (billing-dead) paid keys present.
// The anchor must never be evicted by any of them.
function setAllProviderKeys() {
	process.env.GROQ_API_KEY = 'gsk-test';
	process.env.OPENROUTER_API_KEY = 'or-test';
	process.env.NVIDIA_API_KEY = 'nv-test';
	process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
	process.env.OPENAI_API_KEY = 'sk-test';
	process.env.GROK_API_KEY = 'xai-test';
}

describe('shared vertex-gemini helper (api/_lib/vertex-gemini.js)', () => {
	it('is unavailable without a GCP project and available with one', () => {
		expect(vertexGeminiAvailable()).toBe(false);
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		expect(vertexGeminiAvailable()).toBe(true);
	});

	it('builds the OpenAI-compatible Vertex endpoint from the env knobs', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		expect(vertexGeminiChatUrl()).toBe(
			'https://aiplatform.googleapis.com/v1beta1/projects/test-project/locations/global/endpoints/openapi/chat/completions',
		);
		expect(vertexGeminiChatUrl()).toBe(`${vertexGeminiOpenAIBase()}/chat/completions`);
		process.env.GOOGLE_CLOUD_LOCATION_GEMINI = 'us-central1';
		expect(vertexGeminiChatUrl()).toContain('https://us-central1-aiplatform.googleapis.com/');
		expect(vertexGeminiChatUrl()).toContain('/locations/us-central1/');
	});

	it('defaults to full Gemini Flash and honors the VERTEX_GEMINI_MODEL override', () => {
		expect(vertexGeminiModel()).toBe('google/gemini-2.5-flash');
		process.env.VERTEX_GEMINI_MODEL = 'google/gemini-2.5-pro';
		expect(vertexGeminiModel()).toBe('google/gemini-2.5-pro');
	});
});

describe('brain (api/brain/chat.js): freeFallbackChain anchor', () => {
	const spec = { openrouterModel: 'nvidia/nemotron-3-super-120b-a12b:free' };

	it('appends the anchor at the tail when a GCP project is set', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		setAllProviderKeys();
		const chain = freeFallbackChain('gpt-oss-120b', spec, { via: 'native' });
		expect(chain.length).toBeGreaterThan(1);
		const last = chain[chain.length - 1];
		expect(last.vertexGemini).toBe(true);
		expect(last.label).toBe('vertex-gemini/google/gemini-2.5-flash');
		// Exactly one anchor entry: never doubled.
		expect(chain.filter((a) => a.vertexGemini)).toHaveLength(1);
	});

	it('still provides a working chain with ZERO provider keys (anon/keyless deploy)', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const chain = freeFallbackChain('gpt-oss-120b', spec, null);
		expect(chain).toHaveLength(1);
		expect(chain[0].vertexGemini).toBe(true);
	});

	it('omits the anchor entirely without a GCP project (no behavior change)', () => {
		setAllProviderKeys();
		const chain = freeFallbackChain('gpt-oss-120b', spec, { via: 'native' });
		expect(chain.some((a) => a.vertexGemini)).toBe(false);
	});
});

describe('copilot (api/agents/copilot.js): providerChain anchor', () => {
	it('keeps the keyless anchor as the final rung past every present provider key', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		setAllProviderKeys();
		const chain = copilotProviderChain();
		const last = chain[chain.length - 1];
		expect(last.name).toBe('vertex-gemini');
		expect(last.model).toBe('google/gemini-2.5-flash');
		expect(last.url).toContain('aiplatform.googleapis.com');
		expect(last.url).toContain('test-project');
		expect(last.key).toBeNull(); // keyless: auth minted per request
		expect(typeof last.getHeaders).toBe('function');
		// The (billing-dead) paid OpenAI rung may exist, but never after the anchor.
		expect(chain.findIndex((p) => p.name === 'openai')).toBeLessThan(
			chain.findIndex((p) => p.name === 'vertex-gemini'),
		);
	});

	it('serves a non-empty chain with zero provider keys: the 503 gate opens on credits alone', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const chain = copilotProviderChain();
		expect(chain).toHaveLength(1);
		expect(chain[0].name).toBe('vertex-gemini');
	});

	it('adds no anchor without a GCP project', () => {
		setAllProviderKeys();
		const chain = copilotProviderChain();
		expect(chain.some((p) => p.name === 'vertex-gemini')).toBe(false);
	});
});

describe('widgets (api/widgets/[id]/[action].js): pickProviderChain anchor', () => {
	it('appends the anchor after every configured route and never as the primary', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		setAllProviderKeys();
		const chain = widgetProviderChain('auto', null);
		expect(chain[0].name).not.toBe('vertex-gemini');
		const last = chain[chain.length - 1];
		expect(last.name).toBe('vertex-gemini');
		expect(last.cfg.style).toBe('openai');
		expect(last.cfg.url).toContain('aiplatform.googleapis.com');
		expect(typeof last.cfg.resolveHeaders).toBe('function');
		expect(last.model).toBe('google/gemini-2.5-flash');
		expect(chain.filter((r) => r.name === 'vertex-gemini')).toHaveLength(1);
	});

	it('honors the VERTEX_GEMINI_MODEL override', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		process.env.VERTEX_GEMINI_MODEL = 'google/gemini-2.5-pro';
		const chain = widgetProviderChain('auto', null);
		expect(chain[chain.length - 1].model).toBe('google/gemini-2.5-pro');
	});

	it('anonymous embeds on a keyless deploy still get a working chain', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const chain = widgetProviderChain('auto', null);
		expect(chain).toHaveLength(1);
		expect(chain[0].name).toBe('vertex-gemini');
	});

	it('adds no anchor without a GCP project', () => {
		setAllProviderKeys();
		const chain = widgetProviderChain('auto', null);
		expect(chain.some((r) => r.name === 'vertex-gemini')).toBe(false);
	});
});

describe('vision (api/_lib/vision.js): visionChain anchor', () => {
	it('sits after the free NIM lanes and ahead of the paid OpenAI backstop', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		process.env.NVIDIA_API_KEY = 'nv-test';
		process.env.OPENAI_API_KEY = 'sk-test';
		const chain = visionChain();
		const names = chain.map((p) => p.name);
		const anchorAt = names.indexOf('vertex-gemini');
		expect(anchorAt).toBeGreaterThan(-1);
		expect(anchorAt).toBeGreaterThan(names.lastIndexOf('nvidia'));
		expect(anchorAt).toBeLessThan(names.indexOf('openai'));
		const anchor = chain[anchorAt];
		expect(anchor.url).toContain('aiplatform.googleapis.com');
		expect(anchor.model).toBe('google/gemini-2.5-flash');
		expect(typeof anchor.getHeaders).toBe('function');
		expect(anchor.headers).toBeUndefined(); // keyless: no static bearer header
	});

	it('visionConfigured() is true on a GCP project alone: the multimodal anchor serves', () => {
		expect(visionConfigured()).toBe(false);
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		expect(visionConfigured()).toBe(true);
		const chain = visionChain();
		expect(chain).toHaveLength(1);
		expect(chain[0].name).toBe('vertex-gemini');
	});

	it('adds no anchor without a GCP project', () => {
		process.env.NVIDIA_API_KEY = 'nv-test';
		expect(visionChain().some((p) => p.name === 'vertex-gemini')).toBe(false);
	});

	it('the anchor builds a standard OpenAI multimodal body', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const [anchor] = visionChain();
		const parts = [
			{ type: 'text', text: 'describe' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
		];
		const body = anchor.buildBody('sys', parts, 256);
		expect(body.model).toBe('google/gemini-2.5-flash');
		expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
		expect(body.messages[1]).toEqual({ role: 'user', content: parts });
	});
});

describe('anthropic-proxy (api/llm/anthropic.js): model fallback anchor', () => {
	it('appends the anchor model as the final fallback when a GCP project is set', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		setAllProviderKeys();
		const chain = modelFallbackChain('google/gemma-4-31b-it:free');
		expect(chain[chain.length - 1]).toBe('google/gemini-2.5-flash');
		// Paid Anthropic stays ahead of it; the anchor is strictly last resort.
		expect(chain.indexOf('claude-haiku-4-5-20251001')).toBeLessThan(
			chain.indexOf('google/gemini-2.5-flash'),
		);
		expect(chain.filter((m) => m === 'google/gemini-2.5-flash')).toHaveLength(1);
	});

	it('resolves the anchor model to a keyless openai-kind vertex-gemini route', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		expect(resolveModelRoute('google/gemini-2.5-flash')).toEqual({
			kind: 'openai',
			provider: 'vertex-gemini',
		});
		// Static allowlist entries are untouched.
		expect(resolveModelRoute('llama-3.3-70b-versatile')).toMatchObject({ provider: 'groq' });
		// Unknown models still resolve to nothing (the 400 allowlist gate).
		expect(resolveModelRoute('made-up/model')).toBeNull();
	});

	it('without a GCP project the anchor neither resolves nor joins the chain', () => {
		const chain = modelFallbackChain('google/gemma-4-31b-it:free');
		expect(chain).not.toContain('google/gemini-2.5-flash');
		expect(resolveModelRoute('google/gemini-2.5-flash')).toBeNull();
	});

	it('dedupes when the caller requests the anchor model directly', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const chain = modelFallbackChain('google/gemini-2.5-flash');
		expect(chain[0]).toBe('google/gemini-2.5-flash');
		expect(chain.filter((m) => m === 'google/gemini-2.5-flash')).toHaveLength(1);
	});
});

describe('marketplace preview (api/marketplace/[action].js): buildPreviewRoutes anchor', () => {
	it('appends a keyless vertex-gemini tail route when a GCP project is set', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		process.env.GROQ_API_KEY = 'gk';
		process.env.OPENAI_API_KEY = 'ok';
		const { buildPreviewRoutes } = await import('../../api/marketplace/[action].js');
		const routes = buildPreviewRoutes();
		const last = routes[routes.length - 1];
		expect(last.name).toBe('vertex-gemini');
		expect(last.url).toBe(vertexGeminiChatUrl());
		expect(typeof last.getHeaders).toBe('function');
		// Never a primary: keyed providers still lead.
		expect(routes[0].name).toBe('groq');
	});

	it('keeps previews alive on a keyless deploy (anchor is the whole chain)', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const { buildPreviewRoutes } = await import('../../api/marketplace/[action].js');
		const routes = buildPreviewRoutes();
		expect(routes).toHaveLength(1);
		expect(routes[0].name).toBe('vertex-gemini');
		const payload = routes[0].buildPayload({
			systemPrompt: 'be brief',
			history: [{ role: 'user', content: 'hi' }],
		});
		expect(payload.model).toBe(vertexGeminiModel());
		expect(payload.messages[0]).toEqual({ role: 'system', content: 'be brief' });
	});

	it('is absent without a GCP project', async () => {
		process.env.GROQ_API_KEY = 'gk';
		const { buildPreviewRoutes } = await import('../../api/marketplace/[action].js');
		const routes = buildPreviewRoutes();
		expect(routes.map((r) => r.name)).not.toContain('vertex-gemini');
	});
});

// Second production defect on the same anchor, measured 2026-08-11 against the
// live Vertex endpoint: Gemini 2.5 reasons by default and the OpenAI-compatible
// surface bills those tokens against `max_tokens` without returning them. A
// 400-token request spent 382 on reasoning and returned 14 visible tokens with
// finish_reason "length", so every anchored answer arrived truncated
// mid-sentence. vertexGeminiBudget caps the reasoning and funds it on top of the
// caller's budget; these lock that onto the surfaces that build Gemini payloads.
describe('vertex-gemini reasoning budget', () => {
	it('funds the reasoning cap on top of the visible-output budget', () => {
		const budget = vertexGeminiBudget(400);
		expect(budget.max_tokens).toBe(400 + vertexGeminiThinkingBudget());
		expect(budget.extra_body.google.thinking_config.thinking_budget).toBe(vertexGeminiThinkingBudget());
	});

	it('honors an env-tuned reasoning cap, zero included', () => {
		process.env.VERTEX_GEMINI_THINKING_BUDGET = '0';
		expect(vertexGeminiThinkingBudget()).toBe(0);
		expect(vertexGeminiBudget(256)).toEqual({
			max_tokens: 256,
			extra_body: { google: { thinking_config: { thinking_budget: 0 } } },
		});
		process.env.VERTEX_GEMINI_THINKING_BUDGET = '1024';
		expect(vertexGeminiBudget(256).max_tokens).toBe(1280);
	});

	it('falls back to a sane visible budget when the caller passes none', () => {
		expect(vertexGeminiBudget(undefined).max_tokens).toBe(1024 + vertexGeminiThinkingBudget());
		expect(vertexGeminiBudget(0).max_tokens).toBe(1024 + vertexGeminiThinkingBudget());
	});

	it('the llm.js text anchor carries the cap in its body', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const anchor = providerChain().find((p) => p.name === 'vertex-gemini');
		const body = anchor.buildBody('sys', 'hello', 300);
		expect(body.max_tokens).toBe(300 + vertexGeminiThinkingBudget());
		expect(body.extra_body.google.thinking_config.thinking_budget).toBe(vertexGeminiThinkingBudget());
	});
});
