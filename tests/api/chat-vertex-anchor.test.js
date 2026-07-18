// Regression guard for the anonymous-chat credits anchor (api/chat.js).
//
// ANON_PROVIDER_LIST (chat-models.js) lists 'vertex-gemini' as the last-resort
// anchor that keeps signed-out /api/chat alive when groq/openrouter/nvidia are
// all rate-limited at once. That list is only a FILTER, though — it can keep a
// route in the fallback chain but can never add one. For a long window the route
// was in the list but never in PROVIDERS or providerOrder(), so the anchor was
// dead and anon chat 503'd on a triple free-lane throttle. These tests lock the
// wiring: the anchor must be present in the try-order AND constructible as a real
// route, and must stay absent (no behavior change) when no GCP project is set.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ANON_PROVIDER_LIST } from '../../api/_lib/chat-models.js';
import { providerOrder, buildFallbackChain } from '../../api/chat.js';

const saved = {};
function setEnv(k, v) {
	saved[k] = process.env[k];
	if (v === undefined) delete process.env[k];
	else process.env[k] = v;
}
beforeEach(() => {
	// Isolate the Vertex flags so the order is deterministic.
	for (const k of ['GOOGLE_CLOUD_PROJECT', 'VERTEX_CLAUDE_ENABLED', 'VERTEX_CLAUDE_PRIMARY', 'GOOGLE_CLOUD_LOCATION_GEMINI']) {
		setEnv(k, undefined);
	}
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe('anonymous-chat vertex-gemini anchor wiring', () => {
	it('providerOrder appends vertex-gemini at the tail when a GCP project is set', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const order = providerOrder();
		expect(order).toContain('vertex-gemini');
		expect(order[order.length - 1]).toBe('vertex-gemini'); // last resort, never leads
	});

	it('omits the anchor entirely when no GCP project is configured (no behavior change)', () => {
		const order = providerOrder();
		expect(order).not.toContain('vertex-gemini');
	});

	it('the anchor survives the anonymous clamp — it is in ANON_PROVIDER_LIST', () => {
		// The handler filters the fallback chain to ANON_PROVIDER_LIST for signed-out
		// traffic; the anchor is only useful if that filter keeps it.
		expect(ANON_PROVIDER_LIST).toContain('vertex-gemini');
	});

	it('buildFallbackChain constructs a real, keyless vertex-gemini route (the piece that was missing)', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		const primary = { name: 'groq', model: 'llama-3.3-70b-versatile' };
		const chain = buildFallbackChain(primary, {}, new Map());
		const anchor = chain.find((r) => r.name === 'vertex-gemini');
		expect(anchor).toBeTruthy();
		// OpenAI-compatible Vertex endpoint, model in the body, token minted per call.
		expect(anchor.url).toContain('aiplatform.googleapis.com');
		expect(anchor.url).toContain('test-project');
		expect(anchor.model).toBe(process.env.VERTEX_GEMINI_MODEL || 'google/gemini-2.5-flash');
		expect(anchor.style).toBe('openai');
		expect(typeof anchor.resolveHeaders).toBe('function');
		expect(anchor.headers).toBeUndefined(); // keyless: no static Authorization header
	});

	it('does not construct a vertex-gemini route without a GCP project', () => {
		const primary = { name: 'groq', model: 'llama-3.3-70b-versatile' };
		const chain = buildFallbackChain(primary, {}, new Map());
		expect(chain.find((r) => r.name === 'vertex-gemini')).toBeUndefined();
	});
});
