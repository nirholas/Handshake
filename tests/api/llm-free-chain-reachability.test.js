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
	sambanova: 'api.sambanova.ai',
	mistral: 'api.mistral.ai',
	zai: 'api.z.ai',
	cloudflare: 'api.cloudflare.com',
	ovh: 'oai.endpoints.kepler.ai.cloud.ovh.net',
	gemini: 'generativelanguage.googleapis.com',
	vertex: 'aiplatform.googleapis.com',
	pollinations: 'text.pollinations.ai',
	llm7: 'api.llm7.io',
	siliconflow: 'api.siliconflow.com',
};

// The free chain in providerChain() order, with the env each rung needs. Groq
// appears THREE times on purpose: Groq meters tokens per model id, so each id is
// an independent 8k-tokens/minute bucket. The 27B lane leads, the 120B lane sits
// right behind it to widen the burst Groq absorbs, and the 20B instant lane is
// the last free rung, so reaching it means every rung between was tried and
// skipped.
const FREE_CHAIN = [
	{ provider: 'groq', host: HOSTS.groq, model: 'qwen/qwen3.8-27b' },
	{ provider: 'groq#120b', host: HOSTS.groq, model: 'openai/gpt-oss-120b' },
	{ provider: 'cerebras', host: HOSTS.cerebras, model: 'llama-3.3-70b' },
	{ provider: 'openrouter', host: HOSTS.openrouter, model: 'google/gemma-4-31b-it:free' },
	{ provider: 'nvidia', host: HOSTS.nvidia, model: 'nvidia/nemotron-3-super-120b-a12b' },
	{ provider: 'sambanova', host: HOSTS.sambanova, model: 'Meta-Llama-3.3-70B-Instruct' },
	{ provider: 'mistral', host: HOSTS.mistral, model: 'mistral-small-latest' },
	{ provider: 'zai', host: HOSTS.zai, model: 'glm-4.7-flash' },
	{ provider: 'cloudflare', host: HOSTS.cloudflare, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
	{ provider: 'ovh', host: HOSTS.ovh, model: 'Meta-Llama-3_3-70B-Instruct' },
	{ provider: 'gemini', host: HOSTS.gemini, model: 'gemini-2.5-flash-lite' },
	{ provider: 'vertex-gemini', host: HOSTS.vertex, model: 'google/gemini-2.5-flash' },
	{ provider: 'pollinations', host: HOSTS.pollinations, model: 'openai-fast' },
	{ provider: 'llm7', host: HOSTS.llm7, model: 'gemini-3.1-flash-lite' },
	{ provider: 'siliconflow', host: HOSTS.siliconflow, model: 'Qwen/Qwen3-8B' },
	{ provider: 'groq#instant', host: HOSTS.groq, model: 'openai/gpt-oss-20b' },
];

const ENV_KEYS = [
	'GROQ_API_KEY',
	'CEREBRAS_API_KEY',
	'OPENROUTER_API_KEY',
	'OPENROUTER_FALLBACK_KEYS',
	'NVIDIA_API_KEY',
	'SAMBANOVA_API_KEY',
	'MISTRAL_API_KEY',
	'ZAI_API_KEY',
	'CLOUDFLARE_ACCOUNT_ID',
	'CLOUDFLARE_AI_API_TOKEN',
	'SILICONFLOW_API_KEY',
	'LLM7_API_KEY',
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
	process.env.SAMBANOVA_API_KEY = 'sn';
	process.env.MISTRAL_API_KEY = 'mi';
	process.env.ZAI_API_KEY = 'z';
	process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-acct';
	process.env.CLOUDFLARE_AI_API_TOKEN = 'cf-token';
	process.env.SILICONFLOW_API_KEY = 'sf';
	process.env.LLM7_API_KEY = 'l7';
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
			const tried = [];

			globalThis.fetch = vi.fn(async (url, opts) => {
				const u = String(url);
				// The two Groq rungs share a host, so a rung is identified by
				// host AND requested model. Matching on host alone would make the 70B
				// lane and the instant lane indistinguishable, which is exactly the
				// pair this suite has to tell apart.
				const requested = JSON.parse(opts.body).model;
				const idx = FREE_CHAIN.findIndex((r) => u.includes(r.host) && r.model === requested);
				expect(idx, `unexpected fetch: ${u} (${requested})`).toBeGreaterThanOrEqual(0);
				tried.push(FREE_CHAIN[idx].provider);
				// A rung above the target dies at the transport level. Alternate the
				// two shapes so both a dropped socket and an abort are covered.
				if (idx < i) throw transportFailure(idx % 2 === 0 ? 'reset' : 'abort');
				return okOpenAiShape(`served by ${FREE_CHAIN[idx].provider}`, rung.model);
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

	// LLM7 was the third keyless rung until llm7.io retired its anonymous tier
	// (401 invalid_api_key on every unauthenticated call, measured 2026-09-02),
	// so it is key-gated now: with nothing configured it must NOT be dialled,
	// because the answer cannot arrive and the round trip is pure latency on a
	// chain that has already exhausted itself.
	it('does not dial LLM7 with nothing configured, and reports the two keyless rungs it did try', async () => {
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes(HOSTS.llm7)) throw new Error('llm7 must not be dialled without a key');
			throw transportFailure('reset');
		});
		await expect(llm.llmComplete({ user: 'u', timeoutMs: 20_000 })).rejects.toThrow(/ovh|pollinations/);
		const dialled = globalThis.fetch.mock.calls.map(([u]) => String(u));
		expect(dialled.some((u) => u.includes(HOSTS.ovh))).toBe(true);
		expect(dialled.some((u) => u.includes(HOSTS.pollinations))).toBe(true);
		expect(dialled.some((u) => u.includes(HOSTS.llm7))).toBe(false);
	}, 20_000);

	// With the key present it is a normal rung again, behind the other two.
	it('serves from LLM7 when OVH and Pollinations both die and the key is set', async () => {
		process.env.LLM7_API_KEY = 'l7';
		globalThis.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes(HOSTS.ovh)) throw transportFailure('reset');
			if (u.includes(HOSTS.pollinations)) throw transportFailure('abort');
			if (u.includes(HOSTS.llm7)) return okOpenAiShape('keyed step-down', 'gemini-3.1-flash-lite');
			throw new Error(`unexpected fetch: ${u}`);
		});
		const out = await llm.llmComplete({ user: 'u', timeoutMs: 20_000 });
		expect(out.provider).toBe('llm7');
		expect(out.text).toBe('keyed step-down');
	}, 20_000);
});
