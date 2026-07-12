import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	toVertexModelId,
	vertexMessagesUrl,
	toVertexBody,
	vertexClaudeConfigured,
	vertexClaudeEnabled,
	vertexClaudePrimary,
} from '../api/_lib/vertex-claude.js';
import { providerChain } from '../api/_lib/llm.js';

// Snapshot and restore the env keys these tests mutate so nothing leaks between
// cases (the flag/config helpers read process.env at call time).
const TOUCHED = [
	'GOOGLE_CLOUD_PROJECT',
	'GOOGLE_CLOUD_LOCATION_CLAUDE',
	'GOOGLE_CLOUD_LOCATION_GEMINI',
	'VERTEX_CLAUDE_ENABLED',
	'VERTEX_CLAUDE_PRIMARY',
	'GROQ_API_KEY',
	'CEREBRAS_API_KEY',
	'GEMINI_API_KEY',
	'OPENROUTER_API_KEY',
	'OPENROUTER_FALLBACK_KEYS',
	'NVIDIA_API_KEY',
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
];
let saved;
beforeEach(() => {
	saved = {};
	for (const k of TOUCHED) saved[k] = process.env[k];
	for (const k of TOUCHED) delete process.env[k];
});
afterEach(() => {
	for (const k of TOUCHED) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('toVertexModelId (shared model-id mapper)', () => {
	it('converts a dated first-party id to the Vertex @ form', () => {
		expect(toVertexModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5@20251001');
	});

	it('passes bare aliases through unchanged', () => {
		expect(toVertexModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
		expect(toVertexModelId('claude-opus-4-7')).toBe('claude-opus-4-7');
	});

	it('leaves an already-@ id untouched', () => {
		expect(toVertexModelId('claude-haiku-4-5@20251001')).toBe('claude-haiku-4-5@20251001');
	});

	it('only rewrites a trailing 8-digit date, not shorter numeric suffixes', () => {
		expect(toVertexModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
		expect(toVertexModelId('some-model-2025')).toBe('some-model-2025');
	});

	it('handles empty/nullish input without throwing', () => {
		expect(toVertexModelId('')).toBe('');
		expect(toVertexModelId(undefined)).toBe(undefined);
	});
});

describe('vertexMessagesUrl', () => {
	beforeEach(() => {
		process.env.GOOGLE_CLOUD_PROJECT = 'my-proj';
	});

	it('uses the global host + path and puts the model in the URL (default location)', () => {
		const url = vertexMessagesUrl('claude-sonnet-4-6', { stream: false });
		expect(url).toBe(
			'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-sonnet-4-6:rawPredict',
		);
	});

	it('uses :streamRawPredict for streaming', () => {
		const url = vertexMessagesUrl('claude-sonnet-4-6', { stream: true });
		expect(url.endsWith(':streamRawPredict')).toBe(true);
	});

	it('maps a dated id to @ form in the path', () => {
		const url = vertexMessagesUrl('claude-haiku-4-5-20251001', { stream: true });
		expect(url).toContain('/models/claude-haiku-4-5@20251001:streamRawPredict');
	});

	it('prefixes the host for a regional endpoint', () => {
		process.env.GOOGLE_CLOUD_LOCATION_CLAUDE = 'us-east5';
		const url = vertexMessagesUrl('claude-sonnet-4-6', { stream: false });
		expect(url.startsWith('https://us-east5-aiplatform.googleapis.com/')).toBe(true);
		expect(url).toContain('/locations/us-east5/');
	});
});

describe('toVertexBody', () => {
	it('drops model + stream, adds anthropic_version, keeps the rest', () => {
		const out = toVertexBody({
			model: 'claude-sonnet-4-6',
			stream: true,
			max_tokens: 512,
			system: 'be brief',
			messages: [{ role: 'user', content: 'hi' }],
			tools: [{ name: 'x' }],
		});
		expect(out.model).toBeUndefined();
		expect(out.stream).toBeUndefined();
		expect(out.anthropic_version).toBe('vertex-2023-10-16');
		expect(out.max_tokens).toBe(512);
		expect(out.system).toBe('be brief');
		expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
		expect(out.tools).toEqual([{ name: 'x' }]);
	});
});

describe('flag helpers under the four combinations', () => {
	// configured = GOOGLE_CLOUD_PROJECT present; enabled requires the flag AND
	// configured; primary requires enabled AND its flag.
	it('off/off: not enabled, not primary (even when configured)', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'p';
		expect(vertexClaudeConfigured()).toBe(true);
		expect(vertexClaudeEnabled()).toBe(false);
		expect(vertexClaudePrimary()).toBe(false);
	});

	it('enabled/off: enabled but not primary', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'p';
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		expect(vertexClaudeEnabled()).toBe(true);
		expect(vertexClaudePrimary()).toBe(false);
	});

	it('enabled/primary: both true', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'p';
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		process.env.VERTEX_CLAUDE_PRIMARY = '1';
		expect(vertexClaudeEnabled()).toBe(true);
		expect(vertexClaudePrimary()).toBe(true);
	});

	it('primary flag alone (not enabled) does nothing', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'p';
		process.env.VERTEX_CLAUDE_PRIMARY = '1';
		expect(vertexClaudeEnabled()).toBe(false);
		expect(vertexClaudePrimary()).toBe(false);
	});

	it('enabled flag without a configured project stays disabled', () => {
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		expect(vertexClaudeConfigured()).toBe(false);
		expect(vertexClaudeEnabled()).toBe(false);
	});
});

describe('providerChain ordering under the four flag combinations', () => {
	// A representative free lane (Groq) plus a paid backstop (Anthropic) so the
	// relative position of Vertex is observable.
	beforeEach(() => {
		process.env.GROQ_API_KEY = 'g';
		process.env.ANTHROPIC_API_KEY = 'a';
		process.env.GOOGLE_CLOUD_PROJECT = 'p';
	});

	const names = () => providerChain().map((p) => p.name);

	// GOOGLE_CLOUD_PROJECT alone (no Claude flags) always contributes the
	// vertex-gemini reliability rung after the free lanes, plus groq#instant as
	// the free-tier capability step-down — both precede the paid backstops.
	it('off/off: no vertex-CLAUDE lane; free lanes → vertex-gemini → step-down → paid tail', () => {
		expect(names()).toEqual(['groq', 'vertex-gemini', 'groq#instant', 'anthropic']);
	});

	it('enabled/off: vertex claude is a paid backstop AHEAD of first-party anthropic, behind free lanes', () => {
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		const n = names();
		expect(n).toEqual(['groq', 'vertex-gemini', 'groq#instant', 'vertex-anthropic', 'anthropic']);
		expect(n.indexOf('groq')).toBeLessThan(n.indexOf('vertex-anthropic'));
		expect(n.indexOf('vertex-anthropic')).toBeLessThan(n.indexOf('anthropic'));
	});

	it('enabled/primary: vertex claude LEADS the chain, before the free lanes', () => {
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		process.env.VERTEX_CLAUDE_PRIMARY = '1';
		const n = names();
		expect(n[0]).toBe('vertex-anthropic');
		expect(n.indexOf('vertex-anthropic')).toBeLessThan(n.indexOf('groq'));
		// Not added twice (primary path only).
		expect(n.filter((x) => x === 'vertex-anthropic')).toHaveLength(1);
	});

	it('primary flag alone (enabled unset) adds no vertex-claude lane', () => {
		process.env.VERTEX_CLAUDE_PRIMARY = '1';
		expect(names()).toEqual(['groq', 'vertex-gemini', 'groq#instant', 'anthropic']);
	});

	it('a caller BYOK key still leads even when vertex is primary', () => {
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		process.env.VERTEX_CLAUDE_PRIMARY = '1';
		const n = providerChain({ anthropicKey: 'byok' }).map((p) => p.name);
		expect(n[0]).toBe('anthropic'); // BYOK anthropicProvider leads
		expect(n[1]).toBe('vertex-anthropic');
	});
});

describe('providerChain free-tier resilience rungs', () => {
	beforeEach(() => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'or-primary';
		process.env.NVIDIA_API_KEY = 'nv';
	});

	it('the primary OpenRouter key gets a :free-variant rung behind its paid rung', () => {
		const chain = providerChain();
		const paid = chain.find((p) => p.name === 'openrouter');
		const free = chain.find((p) => p.name === 'openrouter:free');
		expect(paid.model).toBe('meta-llama/llama-3.3-70b-instruct');
		expect(free.model).toBe('meta-llama/llama-3.3-70b-instruct:free');
		expect(chain.indexOf(paid)).toBeLessThan(chain.indexOf(free));
	});

	it('cerebras and gemini rungs appear only when their keys are configured', () => {
		const before = providerChain().map((p) => p.name);
		expect(before).not.toContain('cerebras');
		expect(before).not.toContain('gemini');
		process.env.CEREBRAS_API_KEY = 'cb';
		process.env.GEMINI_API_KEY = 'gm';
		const n = providerChain().map((p) => p.name);
		// Cerebras is 70B-class: right after groq, before openrouter. AI Studio
		// Gemini sits after the 70B rungs (nvidia last of them), before the
		// groq#instant step-down.
		expect(n.indexOf('groq')).toBeLessThan(n.indexOf('cerebras'));
		expect(n.indexOf('cerebras')).toBeLessThan(n.indexOf('openrouter'));
		expect(n.indexOf('nvidia')).toBeLessThan(n.indexOf('gemini'));
		expect(n.indexOf('gemini')).toBeLessThan(n.indexOf('groq#instant'));
	});

	it('every 70B-class free rung precedes the groq#instant capability step-down', () => {
		process.env.OPENROUTER_FALLBACK_KEYS = 'or-fb1,or-fb2';
		const n = providerChain().map((p) => p.name);
		const stepDown = n.indexOf('groq#instant');
		for (const seventyB of ['groq', 'openrouter', 'openrouter:free', 'openrouter#2', 'openrouter#3', 'nvidia']) {
			expect(n.indexOf(seventyB), `${seventyB} should precede groq#instant`).toBeLessThan(stepDown);
		}
	});

	it('without GOOGLE_CLOUD_PROJECT there is no vertex-gemini rung', () => {
		expect(providerChain().map((p) => p.name)).not.toContain('vertex-gemini');
	});
});
