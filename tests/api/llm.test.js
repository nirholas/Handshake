// Tests for api/_lib/llm.js — the canonical server-side LLM helper.
// Focus: the platform provider policy — the free providers (Groq → OpenRouter
// keys → NVIDIA NIM) always lead, the paid server keys (Anthropic, OpenAI) are
// an automatic last resort, BYOK Anthropic leads only when the caller supplies
// their own key, and a failing provider falls over to the next.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// env.js reads process.env lazily through getters, so setting/clearing keys
// here is reflected on the next llmComplete() call without re-importing.
function clearKeys() {
	delete process.env.GROQ_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_FALLBACK_KEYS;
	delete process.env.NVIDIA_API_KEY;
	delete process.env.LLM7_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
}

// Route a mocked fetch by host so each provider returns its own wire shape.
function installFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts) => {
		const u = String(url);
		const body = opts?.body ? JSON.parse(opts.body) : null;
		calls.push({ url: u, headers: opts?.headers || {}, body });
		const match = Object.keys(routes).find((host) => u.includes(host));
		if (!match) throw new Error(`unexpected fetch: ${u}`);
		return routes[match];
	});
	return calls;
}

function okJson(payload) {
	return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}
function errResp(status, text = 'upstream boom') {
	return { ok: false, status, json: async () => ({}), text: async () => text };
}

const GROQ_HOST = 'api.groq.com';
const OPENROUTER_HOST = 'openrouter.ai';
const NVIDIA_HOST = 'integrate.api.nvidia.com';
const ANTHROPIC_HOST = 'api.anthropic.com';
const OPENAI_HOST = 'api.openai.com';
const OVH_HOST = 'oai.endpoints.kepler.ai.cloud.ovh.net';
const POLLINATIONS_HOST = 'text.pollinations.ai';
const LLM7_HOST = 'api.llm7.io';

const openaiShape = (content) => okJson({
	choices: [{ message: { content } }],
	usage: { prompt_tokens: 11, completion_tokens: 22 },
});
const anthropicShape = (text) => okJson({
	content: [{ type: 'text', text }],
	usage: { input_tokens: 33, output_tokens: 44 },
});

let llm;
beforeEach(async () => {
	clearKeys();
	vi.resetModules();
	llm = await import('../../api/_lib/llm.js');
});
afterEach(() => {
	vi.restoreAllMocks();
	clearKeys();
});

describe('llmConfigured', () => {
	it('true even with no free key and no BYOK key — OVH/Pollinations keyless lanes are unconditional', () => {
		expect(llm.llmConfigured()).toBe(true);
	});
	it('true when GROQ_API_KEY is set', () => {
		process.env.GROQ_API_KEY = 'g';
		expect(llm.llmConfigured()).toBe(true);
	});
	it('true when only a BYOK Anthropic key is supplied (no free keys)', () => {
		expect(llm.llmConfigured({ anthropicKey: 'sk-byok' })).toBe(true);
	});
});

describe('llmComplete — free platform providers', () => {
	it('uses Groq (OpenAI-compat) when GROQ_API_KEY is set', async () => {
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({ [GROQ_HOST]: openaiShape('hello from groq') });
		const out = await llm.llmComplete({ system: 'sys', user: 'hi', maxTokens: 64 });
		expect(out.provider).toBe('groq');
		expect(out.text).toBe('hello from groq');
		expect(out.usage).toEqual({ input: 11, output: 22 });
		// OpenAI-compat body: system+user as messages, bearer auth.
		expect(calls[0].body.messages).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'hi' },
		]);
		expect(calls[0].headers.authorization).toBe('Bearer g');
	});

	it('falls back to OpenRouter when Groq errors', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		const calls = installFetch({
			[GROQ_HOST]: errResp(500),
			[OPENROUTER_HOST]: openaiShape('from openrouter'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('openrouter');
		expect(out.text).toBe('from openrouter');
		// Groq contributes TWO rungs (per-model token buckets: qwen3.8-27b, then
		// gpt-oss-120b), so a host-level 500 costs two attempts before OpenRouter.
		expect(calls.map((c) => c.url.includes(GROQ_HOST) ? 'groq' : 'or')).toEqual(['groq', 'groq', 'or']);
	});

	it('falls back to NVIDIA NIM when Groq and OpenRouter both fail', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		const calls = installFetch({
			[GROQ_HOST]: errResp(500),
			[OPENROUTER_HOST]: errResp(429),
			[NVIDIA_HOST]: openaiShape('from nvidia'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('nvidia');
		expect(out.text).toBe('from nvidia');
		const nvidiaCall = calls.find((c) => c.url.includes(NVIDIA_HOST));
		expect(nvidiaCall.headers.authorization).toBe('Bearer nvapi-x');
	});

	it('preferNvidia leads with the Nemotron NIM before Groq', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		const calls = installFetch({
			[NVIDIA_HOST]: openaiShape('from nemotron'),
			[GROQ_HOST]: openaiShape('from groq'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u', preferNvidia: true });
		expect(out.provider).toBe('nvidia');
		expect(out.text).toBe('from nemotron');
		expect(out.model).toBe('nvidia/nemotron-3-nano-30b-a3b');
		// NVIDIA was hit first; Groq never needed.
		expect(calls[0].url).toContain(NVIDIA_HOST);
		expect(calls.some((c) => c.url.includes(GROQ_HOST))).toBe(false);
	});

	it('preferNvidia still falls back to Groq when the NIM lane errors', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		const calls = installFetch({
			[NVIDIA_HOST]: errResp(503),
			[GROQ_HOST]: openaiShape('from groq'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u', preferNvidia: true });
		expect(out.provider).toBe('groq');
		expect(out.text).toBe('from groq');
		expect(calls[0].url).toContain(NVIDIA_HOST);
	});

	it('serves from OVH (keyless, no Authorization header) when no provider keys are configured at all', async () => {
		const calls = installFetch({ [OVH_HOST]: openaiShape('from ovh anonymous') });
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('ovh');
		expect(out.text).toBe('from ovh anonymous');
		// No key configured anywhere → no Authorization header sent at all, not
		// "Bearer undefined" — the keyless tiers reject a bogus auth header.
		expect(calls[0].headers.authorization).toBeUndefined();
	});

	it('falls back to Pollinations (also keyless) when OVH errors and nothing else is configured', async () => {
		const calls = installFetch({
			[OVH_HOST]: errResp(429, 'API rate limit exceeded'),
			[POLLINATIONS_HOST]: openaiShape('from pollinations'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('pollinations');
		expect(out.text).toBe('from pollinations');
		expect(calls.map((c) => (c.url.includes(OVH_HOST) ? 'ovh' : 'pollinations'))).toEqual(['ovh', 'pollinations']);
	});
});

describe('llmComplete — multiple OpenRouter keys', () => {
	it('rotates to the fallback key with the :free model when the primary key 402s', async () => {
		process.env.OPENROUTER_API_KEY = 'or-primary';
		process.env.OPENROUTER_FALLBACK_KEYS = 'or-fallback';
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			const body = JSON.parse(opts.body);
			calls.push({ auth: opts.headers.authorization, model: body.model });
			// Primary account is out of credits; fallback serves.
			if (opts.headers.authorization === 'Bearer or-primary') {
				return errResp(402, 'insufficient credits');
			}
			return openaiShape('served by fallback key');
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('openrouter#2');
		expect(out.text).toBe('served by fallback key');
		// Every OpenRouter key runs the :free model (the host key never bills a paid
		// model). The primary key's :free rung 402s here, so the chain rotates to the
		// fallback key's :free model.
		expect(calls).toEqual([
			{ auth: 'Bearer or-primary', model: 'google/gemma-4-31b-it:free' },
			{ auth: 'Bearer or-fallback', model: 'google/gemma-4-31b-it:free' },
		]);
	});

	it('dedupes a fallback key that repeats the primary', async () => {
		process.env.OPENROUTER_API_KEY = 'or-same';
		process.env.OPENROUTER_FALLBACK_KEYS = 'or-same, or-extra';
		let n = 0;
		globalThis.fetch = vi.fn(async () => {
			n += 1;
			return errResp(500);
		});
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ status: 502 });
		// or-same is deduped to a single key (one :free rung), then or-extra's :free
		// rung, two OpenRouter fetches (without dedup or-same would be tried again as
		// a fallback too). The chain then falls through the two unconditional keyless
		// lanes (OVH, Pollinations) before giving up: four fetches total. LLM7 is not
		// among them any more; llm7.io retired its anonymous tier, so that rung is
		// gated on LLM7_API_KEY (see api/_lib/llm.js).
		expect(n).toBe(4);
	});

	it('llmConfigured is true with only fallback keys set', () => {
		process.env.OPENROUTER_FALLBACK_KEYS = 'or-only-fallback';
		expect(llm.llmConfigured()).toBe(true);
	});
});

describe('llmComplete — a hung provider fails over within the cap, not the whole budget', () => {
	// Live regression (diorama composer, 2026-07-12): the per-fetch timeout was the
	// WHOLE budget (timeoutMs), so one free lane that stopped responding held the
	// request for ~30s while the reliable Vertex anchor two rungs later would have
	// answered in ~1s. The chain must cap each attempt so a stall fails over fast.
	it('aborts a stalled lead provider at the per-provider cap and serves from the next', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		// The cap is floored at 4s so a fat-fingered env value can't strangle a
		// legitimately-slow completion; use the floor here so the stalled lane
		// aborts at ~4s — far below the 30s budget it used to consume whole.
		process.env.LLM_PER_PROVIDER_TIMEOUT_MS = '4000';

		const order = [];
		globalThis.fetch = vi.fn((url, opts) => {
			const u = String(url);
			if (u.includes(GROQ_HOST)) {
				order.push('groq');
				// Hang until the request's own AbortSignal fires, then reject like a
				// real aborted fetch — exactly what a stalled upstream looks like.
				return new Promise((_, reject) => {
					opts.signal?.addEventListener('abort', () => {
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
					});
				});
			}
			if (u.includes(NVIDIA_HOST)) {
				order.push('nvidia');
				return Promise.resolve(openaiShape('served after failover'));
			}
			throw new Error(`unexpected fetch: ${u}`);
		});

		const t0 = Date.now();
		// 30s budget — the prod value that a single stalled lane used to eat whole.
		const out = await llm.llmComplete({ system: 's', user: 'u', timeoutMs: 30_000 });
		const elapsed = Date.now() - t0;

		expect(out.provider).toBe('nvidia');
		expect(out.text).toBe('served after failover');
		expect(order).toEqual(['groq', 'nvidia']); // tried the stalled lane, then failed over
		// Bounded by the per-provider cap (~4s), nowhere near the 30s budget.
		expect(elapsed).toBeLessThan(9_000);

		delete process.env.LLM_PER_PROVIDER_TIMEOUT_MS;
	}, 15_000);

	// The NVIDIA free NIM lane queues under load and was observed hanging 25s while
	// the reliable Vertex anchor sat one rung later. It carries a tight per-lane cap
	// so the chain fails over fast, independent of the (looser) chain-wide cap.
	it('the NVIDIA lane honors its tight per-provider cap and fails over fast', async () => {
		// openrouter (402, fast) → nvidia (hangs) → … → openai (paid tail, serves).
		process.env.OPENROUTER_API_KEY = 'or';
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		process.env.OPENAI_API_KEY = 'sk-openai';
		process.env.NVIDIA_LANE_TIMEOUT_MS = '2000'; // its own tight cap

		const order = [];
		globalThis.fetch = vi.fn((url, opts) => {
			const u = String(url);
			if (u.includes(OPENROUTER_HOST)) {
				order.push('openrouter');
				return Promise.resolve(errResp(402, 'insufficient credits'));
			}
			if (u.includes(NVIDIA_HOST)) {
				order.push('nvidia');
				return new Promise((_, reject) => {
					opts.signal?.addEventListener('abort', () => {
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
					});
				});
			}
			if (u.includes(OPENAI_HOST)) {
				order.push('openai');
				return Promise.resolve(openaiShape('served by the tail'));
			}
			throw new Error(`unexpected fetch: ${u}`);
		});

		const t0 = Date.now();
		// 30s budget; the NVIDIA lane's own 2s cap must bound its hang, not the budget.
		const out = await llm.llmComplete({ system: 's', user: 'u', timeoutMs: 30_000 });
		const elapsed = Date.now() - t0;

		expect(order).toContain('nvidia'); // it was tried
		expect(out.provider).toBe('openai'); // …and the chain failed over past it
		expect(out.text).toBe('served by the tail');
		// NVIDIA hung, but its 2s cap (read per-call from env, not the 30s budget)
		// bounded the stall.
		expect(elapsed).toBeLessThan(5_000);

		delete process.env.NVIDIA_LANE_TIMEOUT_MS;
	}, 15_000);
});

describe('llmComplete — a stalled HOST is not retried once per key', () => {
	// Live regression (paid fact-check 502s, 2026-07-29): the chain holds one rung
	// PER OpenRouter key, all pointing at the same host. When openrouter.ai
	// accepted the POST, returned 200 headers and then never finished the body,
	// every key behind it stalled identically — three rungs x the 12s cap = 36s,
	// more than the whole 30s budget, so the healthy lanes further down were never
	// reached and the caller got a 502. A stall is a property of the HOST, so the
	// siblings are skipped.
	it('skips sibling rungs on a host that already stalled, reaching the next distinct provider', async () => {
		process.env.OPENROUTER_API_KEY = 'or-1';
		process.env.OPENROUTER_FALLBACK_KEYS = 'or-2,or-3';
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		process.env.LLM_PER_PROVIDER_TIMEOUT_MS = '4000';

		const hits = [];
		globalThis.fetch = vi.fn((url, opts) => {
			const u = String(url);
			if (u.includes(OPENROUTER_HOST)) {
				hits.push('openrouter');
				return new Promise((_, reject) => {
					opts.signal?.addEventListener('abort', () => {
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
					});
				});
			}
			if (u.includes(NVIDIA_HOST)) {
				hits.push('nvidia');
				return Promise.resolve(openaiShape('served after the stalled host'));
			}
			throw new Error(`unexpected fetch: ${u}`);
		});

		const out = await llm.llmComplete({ user: 'u', timeoutMs: 30_000 });

		expect(out.provider).toBe('nvidia');
		// The host was tried ONCE, not once per key.
		expect(hits.filter((h) => h === 'openrouter')).toHaveLength(1);
		expect(hits).toEqual(['openrouter', 'nvidia']);

		delete process.env.LLM_PER_PROVIDER_TIMEOUT_MS;
	}, 15_000);

	// An HTTP status is key-scoped, not host-scoped: a 402 means THIS key is out of
	// credit, and the next key on the same host may be fine. Those siblings must
	// still be tried, or key rotation stops working.
	it('still rotates sibling keys on the same host after an HTTP failure', async () => {
		process.env.OPENROUTER_API_KEY = 'or-1';
		process.env.OPENROUTER_FALLBACK_KEYS = 'or-2';

		let seen = 0;
		globalThis.fetch = vi.fn(async (url) => {
			if (!String(url).includes(OPENROUTER_HOST)) throw new Error(`unexpected fetch: ${url}`);
			seen += 1;
			return seen === 1 ? errResp(402, 'out of credit') : openaiShape('second key served');
		});

		const out = await llm.llmComplete({ user: 'u', timeoutMs: 30_000 });
		expect(out.text).toBe('second key served');
		expect(seen).toBe(2);
	});

	// The chain reserves budget for the rungs behind the current one, so a caller
	// on a tight stage budget still reaches its reliability anchor. Without this a
	// single slow lane consumed the caller's whole allowance.
	it('caps one attempt to a share of the budget so later rungs still get a turn', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.NVIDIA_API_KEY = 'nvapi-x';

		const hits = [];
		globalThis.fetch = vi.fn((url, opts) => {
			const u = String(url);
			if (u.includes(GROQ_HOST)) {
				hits.push('groq');
				return new Promise((_, reject) => {
					opts.signal?.addEventListener('abort', () => {
						reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
					});
				});
			}
			if (u.includes(NVIDIA_HOST)) {
				hits.push('nvidia');
				return Promise.resolve(openaiShape('anchor answered'));
			}
			throw new Error(`unexpected fetch: ${u}`);
		});

		// 9s budget with a stalling lead: the old code handed the lead the full
		// per-provider cap and left nothing behind it.
		const t0 = Date.now();
		const out = await llm.llmComplete({ user: 'u', timeoutMs: 9_000 });
		const elapsed = Date.now() - t0;

		expect(out.provider).toBe('nvidia');
		expect(out.text).toBe('anchor answered');
		expect(hits).toEqual(['groq', 'nvidia']);
		// The stalled lead was cut at roughly a third of the budget, not all of it.
		expect(elapsed).toBeLessThan(8_000);
	}, 15_000);

	// Every rung reports itself, not just the last one: a chain that died because a
	// slow lead ate the budget used to surface only the tail provider's message,
	// which is how a starved chain got filed as a billing problem on the last rung.
	it('attaches a per-provider attempt record to the thrown error', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.NVIDIA_API_KEY = 'nvapi-x';

		globalThis.fetch = vi.fn(async (url) => {
			if (String(url).includes(GROQ_HOST)) return errResp(429, 'rate limited');
			if (String(url).includes(NVIDIA_HOST)) return errResp(503, 'down');
			throw new Error(`unexpected fetch: ${url}`);
		});

		await expect(llm.llmComplete({ user: 'u', timeoutMs: 20_000 })).rejects.toMatchObject({
			attempts: expect.arrayContaining([
				expect.objectContaining({ provider: 'groq', error: 'http 429' }),
				expect.objectContaining({ provider: 'nvidia', error: 'http 503' }),
			]),
		});
	});
});

describe('llmComplete — BYOK Anthropic leads when supplied', () => {
	it('uses Anthropic first when a BYOK key is explicitly supplied', async () => {
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({ [ANTHROPIC_HOST]: anthropicShape('claude says hi') });
		const out = await llm.llmComplete({ system: 's', user: 'u', anthropicKey: 'sk-byok' });
		expect(out.provider).toBe('anthropic');
		expect(out.text).toBe('claude says hi');
		// Anthropic usage also carries the prompt-cache counters (0 when the
		// response reports no caching), because `input_tokens` is only the
		// UNCACHED remainder once a cache breakpoint is in play — see
		// tests/anthropic-prompt-cache-pricing.test.js.
		expect(out.usage).toEqual({ input: 33, output: 44, cacheWrite: 0, cacheRead: 0 });
		expect(calls[0].headers['x-api-key']).toBe('sk-byok');
		// Anthropic body: top-level system + user-only messages.
		expect(calls[0].body.system).toBe('s');
		expect(calls[0].body.messages).toEqual([{ role: 'user', content: 'u' }]);
	});

	it('degrades from a failing BYOK key to the free providers', async () => {
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({
			[ANTHROPIC_HOST]: errResp(401, 'bad byok key'),
			[GROQ_HOST]: openaiShape('groq rescues'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u', anthropicKey: 'sk-bad' });
		expect(out.provider).toBe('groq');
		expect(calls.map((c) => (c.url.includes(ANTHROPIC_HOST) ? 'anthropic' : 'groq'))).toEqual(['anthropic', 'groq']);
	});
});

describe('llmComplete — paid server keys are the automatic last resort', () => {
	it('never touches a paid key while a free provider can serve', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-server';
		process.env.OPENAI_API_KEY = 'sk-oai';
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({ [GROQ_HOST]: openaiShape('groq wins') });
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('groq');
		expect(calls.every((c) => !c.url.includes(ANTHROPIC_HOST) && !c.url.includes(OPENAI_HOST))).toBe(true);
	});

	it('falls through to server Anthropic when every free provider fails', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		process.env.NVIDIA_API_KEY = 'nvapi-x';
		process.env.ANTHROPIC_API_KEY = 'sk-server';
		const calls = installFetch({
			[GROQ_HOST]: errResp(500),
			[OPENROUTER_HOST]: errResp(429),
			[NVIDIA_HOST]: errResp(503),
			[ANTHROPIC_HOST]: anthropicShape('paid backstop'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('anthropic');
		expect(out.text).toBe('paid backstop');
		expect(calls[calls.length - 1].headers['x-api-key']).toBe('sk-server');
		// Every free provider was tried before any platform money was spent.
		expect(calls.slice(0, -1).every((c) => !c.url.includes(ANTHROPIC_HOST))).toBe(true);
	});

	it('falls through to OpenAI when Anthropic also fails', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.ANTHROPIC_API_KEY = 'sk-server';
		process.env.OPENAI_API_KEY = 'sk-oai';
		const calls = installFetch({
			[GROQ_HOST]: errResp(500),
			[ANTHROPIC_HOST]: errResp(529),
			[OPENAI_HOST]: openaiShape('openai backstop'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('openai');
		expect(out.text).toBe('openai backstop');
		const openaiCall = calls.find((c) => c.url.includes(OPENAI_HOST));
		expect(openaiCall.headers.authorization).toBe('Bearer sk-oai');
		expect(openaiCall.body.model).toBe('gpt-5.4-nano');
	});

	it('does not add server Anthropic when a BYOK key already leads', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-server';
		let anthropicCalls = 0;
		globalThis.fetch = vi.fn(async (url) => {
			if (String(url).includes(ANTHROPIC_HOST)) {
				anthropicCalls += 1;
				return errResp(401, 'bad key');
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		await expect(llm.llmComplete({ system: 's', user: 'u', anthropicKey: 'sk-byok' })).rejects.toMatchObject({ status: 502 });
		expect(anthropicCalls).toBe(1); // BYOK only — platform key never re-buys Claude
	});

	it('llmConfigured is true with only a paid server key (gates stay open)', () => {
		process.env.ANTHROPIC_API_KEY = 'sk-server';
		expect(llm.llmConfigured()).toBe(true);
		clearKeys();
		process.env.OPENAI_API_KEY = 'sk-oai';
		expect(llm.llmConfigured()).toBe(true);
	});
});

describe('llmComplete — failure modes', () => {
	// LlmUnavailableError is now effectively unreachable in practice — OVH and
	// Pollinations are unconditional keyless rungs, so providerChain() is never
	// empty. What used to be "no provider configured" now degrades to the last
	// upstream error from those keyless lanes instead.
	it('throws the last upstream error (502), not LlmUnavailableError, when no keys are configured and the keyless lanes also fail', async () => {
		installFetch({
			[OVH_HOST]: errResp(429, 'rate limited'),
			[POLLINATIONS_HOST]: errResp(503, 'overloaded'),
			[LLM7_HOST]: errResp(502, 'bad gateway'),
		});
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
			status: 502,
			code: 'upstream_error',
		});
	});

	it('throws the last upstream error (502) when every provider fails', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		installFetch({ [GROQ_HOST]: errResp(500), [OPENROUTER_HOST]: errResp(429) });
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ status: 502 });
	});

	// A provider can answer HTTP 200 with a body that isn't JSON — an edge/proxy
	// HTML error page, a truncated stream, an empty body. Parsing it used to throw
	// OUT of llmComplete, killing the request even though a healthy provider sat
	// next in the chain. It must fail over instead.
	it('fails over past a provider that returns a 200 with an unparseable body', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		const badBody = {
			ok: true,
			status: 200,
			// A real edge/proxy 200 that isn't the expected JSON shape.
			json: async () => {
				throw new SyntaxError('Unexpected token < in JSON at position 0');
			},
			text: async () => '<html>502 Bad Gateway</html>',
		};
		const calls = installFetch({
			[GROQ_HOST]: badBody,
			[OPENROUTER_HOST]: openaiShape('openrouter rescues'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('openrouter');
		expect(out.text).toBe('openrouter rescues');
		// Both Groq rungs serve the HTML error page before OpenRouter rescues.
		expect(calls.map((c) => (c.url.includes(GROQ_HOST) ? 'groq' : 'or'))).toEqual(['groq', 'groq', 'or']);
	});

	it('surfaces upstream_bad_body as the last error when every provider returns an unparseable 200', async () => {
		process.env.GROQ_API_KEY = 'g';
		const badBody = {
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError('bad json');
			},
			text: async () => 'not json',
		};
		// Every reachable lane (groq + the two keyless rungs) returns garbage.
		installFetch({ [GROQ_HOST]: badBody, [OVH_HOST]: badBody, [POLLINATIONS_HOST]: badBody, [LLM7_HOST]: badBody });
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
			status: 502,
			code: 'upstream_bad_body',
		});
	});

	// A 200 with empty content (content filter, a lane that returns nothing under
	// load) is not a real answer — the chain fails over so a healthy provider can
	// respond.
	it('fails over past a provider that returns an empty completion', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		const calls = installFetch({
			[GROQ_HOST]: openaiShape('   '), // whitespace only → trims to empty
			[OPENROUTER_HOST]: openaiShape('a real answer'),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.provider).toBe('openrouter');
		expect(out.text).toBe('a real answer');
		// Both Groq rungs return the empty completion before OpenRouter serves.
		expect(calls.map((c) => (c.url.includes(GROQ_HOST) ? 'groq' : 'or'))).toEqual(['groq', 'groq', 'or']);
	});

	// When EVERY provider only yields empty text, returning that empty-but-valid
	// 200 still beats throwing — the caller got a real HTTP success, just no words.
	it('returns the empty-but-valid result when no provider yields any text', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		installFetch({
			[GROQ_HOST]: openaiShape(''),
			[OPENROUTER_HOST]: openaiShape(''),
			[OVH_HOST]: openaiShape(''),
			[POLLINATIONS_HOST]: openaiShape(''),
			[LLM7_HOST]: openaiShape(''),
		});
		const out = await llm.llmComplete({ system: 's', user: 'u' });
		expect(out.text).toBe('');
		// The first empty result is held as the last-resort return value.
		expect(out.provider).toBe('groq');
	});
});
