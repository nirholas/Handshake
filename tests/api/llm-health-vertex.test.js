// api/_lib/llm-health.js — Vertex Gemini / Vertex Anthropic probes.
//
// Regression this closes: llm.js's real provider chain reaches Vertex Gemini
// whenever GOOGLE_CLOUD_PROJECT is set (the platform's actual reliability
// anchor — see providerChain() in llm.js), but this health probe never knew
// Vertex existed, so /api/llm/health reported 'down'/'degraded' during an
// outage of OpenRouter/Anthropic/OpenAI even when Vertex was transparently
// keeping every user-facing AI feature alive. These tests pin that the probe
// now mirrors the real chain's gate exactly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_lib/env.js', () => ({
	env: new Proxy({}, { get: (_t, k) => process.env[k] }),
}));
vi.mock('../../api/_lib/gcp-auth.js', () => ({
	getGcpAccessToken: vi.fn(async () => 'fake-gcp-oauth-token'),
}));

const { probeLlmHealth } = await import('../../api/_lib/llm-health.js');
const { getGcpAccessToken } = await import('../../api/_lib/gcp-auth.js');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	vi.restoreAllMocks();
	for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'VERTEX_CLAUDE_ENABLED']) {
		delete process.env[k];
	}
});
afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe('probeLlmHealth — Vertex gating', () => {
	it('omits both Vertex rungs when GOOGLE_CLOUD_PROJECT is unset (unchanged pre-Vertex behavior)', async () => {
		const report = await probeLlmHealth();
		expect(report['vertex-gemini']).toBeUndefined();
		expect(report['vertex-anthropic']).toBeUndefined();
		expect(report.overall).toBe('unconfigured');
	});

	it('probes vertex-gemini whenever GOOGLE_CLOUD_PROJECT is set — the same gate providerChain() uses', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'three-ws-prod';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });

		const report = await probeLlmHealth();
		expect(report['vertex-gemini']).toMatchObject({ status: 'ok' });
		expect(report['vertex-anthropic']).toBeUndefined(); // VERTEX_CLAUDE_ENABLED not set
		expect(report.overall).toBe('ok');
		expect(getGcpAccessToken).toHaveBeenCalled();
	});

	it('probes vertex-anthropic only when VERTEX_CLAUDE_ENABLED=1 (matches vertexClaudeEnabled())', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'three-ws-prod';
		process.env.VERTEX_CLAUDE_ENABLED = '1';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });

		const report = await probeLlmHealth();
		expect(report['vertex-gemini']).toMatchObject({ status: 'ok' });
		expect(report['vertex-anthropic']).toMatchObject({ status: 'ok' });
	});

	it('reports a real error verdict — not an uncaught throw — when GCP token exchange fails', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'three-ws-prod';
		getGcpAccessToken.mockRejectedValueOnce(new Error('no credentials configured'));

		const report = await probeLlmHealth();
		expect(report['vertex-gemini'].status).toBe('error');
		expect(report['vertex-gemini'].error).toMatch(/token exchange failed/);
	});

	it('reports vertex-gemini as a real outage signal (a genuine 500) rather than masking it', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'three-ws-prod';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

		const report = await probeLlmHealth();
		expect(report['vertex-gemini'].status).toBe('error');
		expect(report.overall).toBe('down');
	});

	it('folds Vertex into overall alongside third-party providers: down third-party + ok Vertex = degraded, not down', async () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'three-ws-prod';
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).includes('openai.com')) return { ok: false, status: 429, statusText: 'Too Many Requests' };
			return { ok: true, status: 200, statusText: 'OK' }; // vertex-gemini
		});

		const report = await probeLlmHealth();
		expect(report.openai.status).toBe('error');
		expect(report['vertex-gemini'].status).toBe('ok');
		expect(report.overall).toBe('degraded');
	});
});
