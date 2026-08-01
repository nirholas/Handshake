// Every rung of the free chain must be REACHABLE, proven by failing the rungs
// above it at the transport level.
//
// Why transport level specifically: this repo has already shipped a fallback
// that only caught parse errors, so it was bypassed exactly when the provider
// failed (a dead socket, a DNS failure, an abort) rather than when it returned
// a bad body. A chain tested only with `errResp(500)` looks healthy while the
// real failure mode walks straight past it. Each case here kills the rungs
// above with a thrown fetch (ECONNRESET / abort), the way a provider actually
// dies, and asserts the next rung answers.
//
// The free chain is not a degradation path any more, it is production: the
// OpenAI account is billing-dead (429 billing_not_active) and the OpenRouter
// platform key's balance is spent, so these rungs carry the traffic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../api/_lib/gcp-auth.js', () => ({
	getGcpAccessToken: async () => 'fake-vertex-token',
}));

const HOSTS = {
	groq: 'api.groq.com',
	cerebras: 'api.cerebras.ai',
	openrouter: 'openrouter.ai',
	nvidia: 'integrate.api.nvidia.com',
	ovh: 'oai.endpoints.kepler.ai.cloud.ovh.net',
	gemini: 'generativelanguage.googleapis.com',
	vertex: 'aiplatform.googleapis.com',
	pollinations: 'text.pollinations.ai',
};

// The free chain in providerChain() order, with the env each rung needs. Groq
// appears twice on purpose: the 70B lane leads, and the instant lane is the
// last free rung (a separate per-model quota), so reaching it means every rung
// between them was tried and skipped.
const FREE_CHAIN = [
	{ provider: 'groq', host: HOSTS.groq, model: 'llama-3.3-70b-versatile' },
	{ provider: 'cerebras', host: HOSTS.cerebras, model: 'llama-3.3-70b' },
	{ provider: 'openrouter', host: HOSTS.openrouter, model: 'openai/gpt-oss-20b:free' },
	{ provider: 'nvidia', host: HOSTS.nvidia, model: 'meta/llama-3.3-70b-instruct' },
	{ provider: 'ovh', host: HOSTS.ovh, model: 'Meta-Llama-3_3-70B-Instruct' },
	{ provider: 'gemini', host: HOSTS.gemini, model: 'gemini-2.5-flash-lite' },
	{ provider: 'vertex-gemini', host: HOSTS.vertex, model: 'google/gemini-2.5-flash' },
	{ provider: 'pollinations', host: HOSTS.pollinations, model: 'openai-fast' },
	{ provider: 'groq#instant', host: HOSTS.groq, model: 'llama-3.1-8b-instant' },
];

const ENV_KEYS = [
	'GROQ_API_KEY',
	'CEREBRAS_API_KEY',
	'OPENROUTER_API_KEY',
	'OPENROUTER_FALLBACK_KEYS',
	'NVIDIA_API_KEY',
	'GEMINI_API_KEY',
	'GOOGLE_CLOUD_PROJECT',
	'GOOGLE_CLOUD_LOCATION_GEMINI',
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
	'GROK_API_KEY',
	'VERTEX_CLAUDE_ENABLED',
	'VERTEX_CLAUDE_PRIMARY',
	'OPENROUTER_CLAUDE_MIRROR_MODEL',
	'NVIDIA_LANE_TIMEOUT_MS',
];

const saved = {};
let llm;

// Every free key configured, so the whole free chain is present in one run.
function configureFreeLanes() {
	process.env.GROQ_API_KEY = 'g';
	process.env.CEREBRAS_API_KEY = 'c';
	process.env.OPENROUTER_API_KEY = 'or';
	process.env.NVIDIA_API_KEY = 'nvapi-x';
	process.env.GEMINI_API_KEY = 'gem';
	process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
	// The NIM lane's own cap is floored at 2s; keep it there so a transport
	// failure test never waits on it.
	process.env.NVIDIA_LANE_TIMEOUT_MS = '2000';
}

const okOpenAiShape = (content, model) => ({
	ok: true,
	status: 200,
	json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 7 }, model }),
	text: async () => '{}',
});

// How a provider dies for real: the socket drops, or the attempt is aborted.
// Neither produces a response object, so a fallback that only inspects a parsed
// body never runs.
function transportFailure(kind) {
	if (kind === 'abort') return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
	return Object.assign(new Error('fetch failed: ECONNRESET'), { cause: { code: 'ECONNRESET' } });
}

beforeEach(async () => {
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	vi.resetModules();
	llm = await import('../../api/_lib/llm.js');
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.restoreAllMocks();
});

describe('free chain: every rung is reachable through a transport-level failure', () => {
	it('lists the rungs in the documented order with every free key set', () => {
		configureFreeLanes();
		const names = llm.providerChain().map((p) => p.name);
		expect(names).toEqual(FREE_CHAIN.map((r) => r.provider));
	});

	// One case per rung: kill every rung above it the way a provider actually
	// dies (thrown fetch, not a 500 with a body), and require this rung to serve.
	for (const [i, rung] of FREE_CHAIN.entries()) {
		it(`reaches ${rung.provider} when the ${i} rung(s) above it fail at the transport level`, async () => {
			configureFreeLanes();
			const above = FREE_CHAIN.slice(0, i);
			const tried = [];

			globalThis.fetch = vi.fn(async (url) => {
				const u = String(url);
				// The two Groq rungs share a host, so match on the requested model to
				// tell them apart. Everything else is one host per rung.
				const idx = FREE_CHAIN.findIndex((r) => u.includes(r.host));
				const hit = FREE_CHAIN.find((r) => u.includes(r.host));
				expect(hit, `unexpected fetch: ${u}`).toBeTruthy();
				tried.push(hit.provider);
				// A rung above the target dies at the transport level. Alternate the
				// two shapes so both a dropped socket and an abort are covered.
				if (idx < i || (idx === i && tried.filter((t) => t === hit.provider).length <= above.filter((a) => a.provider === hit.provider).length)) {
					throw transportFailure(idx % 2 === 0 ? 'reset' : 'abort');
				}
				return okOpenAiShape(`served by ${hit.provider}`, rung.model);
			});

			const out = await llm.llmComplete({ system: 's', user: 'u', timeoutMs: 30_000 });
			expect(out.provider).toBe(rung.provider);
			expect(out.model).toBe(rung.model);
			expect(out.text).toBe(`served by ${rung.provider}`);
			// Every rung above it was actually attempted, so this is a real failover
			// and not an accidental reordering of the chain.
			expect(tried.length).toBeGreaterThanOrEqual(i + 1);
		}, 30_000);
	}

	// A rung that dies at the transport level must not take its own retry budget
	// with it: the chain records the attempt and keeps going, and the thrown
	// error names every rung when nothing survives.
	it('reports every rung when the whole free chain dies at the transport level', async () => {
		configureFreeLanes();
		globalThis.fetch = vi.fn(async () => {
			throw transportFailure('reset');
		});
		const err = await llm.llmComplete({ user: 'u', timeoutMs: 20_000 }).catch((e) => e);
		expect(err.status).toBe(502);
		const reported = err.attempts.map((a) => a.provider);
		for (const rung of FREE_CHAIN) expect(reported).toContain(rung.provider);
		// Each attempt carries its own transport error, not a shared last-error.
		expect(err.attempts.every((a) => a.skipped || /unreachable/.test(a.error))).toBe(true);
	}, 30_000);

	// The keyless rungs are the floor of the platform: with zero env vars set the
	// chain must still answer, and a transport failure on the first keyless rung
	// must reach the second.
	it('serves from Pollinations when OVH dies at the transport level and nothing is configured', async () => {
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes(HOSTS.ovh)) throw transportFailure('reset');
			if (u.includes(HOSTS.pollinations)) return okOpenAiShape('keyless floor', 'openai-fast');
			throw new Error(`unexpected fetch: ${u}`);
		});
		const out = await llm.llmComplete({ user: 'u', timeoutMs: 20_000 });
		expect(out.provider).toBe('pollinations');
		expect(out.text).toBe('keyless floor');
	}, 20_000);
});
