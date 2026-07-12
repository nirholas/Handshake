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
	it('false when no free key and no BYOK key', () => {
		expect(llm.llmConfigured()).toBe(false);
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
		expect(calls.map((c) => c.url.includes(GROQ_HOST) ? 'groq' : 'or')).toEqual(['groq', 'or']);
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
		expect(out.model).toBe('nvidia/nvidia-nemotron-nano-9b-v2');
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
		// The primary key gets a :free rung right behind its paid rung, so an
		// out-of-credits primary account still tries its own free variant (also 402
		// here) before the chain rotates to the fallback key's :free model.
		expect(calls).toEqual([
			{ auth: 'Bearer or-primary', model: 'meta-llama/llama-3.3-70b-instruct' },
			{ auth: 'Bearer or-primary', model: 'meta-llama/llama-3.3-70b-instruct:free' },
			{ auth: 'Bearer or-fallback', model: 'meta-llama/llama-3.3-70b-instruct:free' },
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
		// or-same is deduped to a single key, but the primary key legitimately has
		// two rungs (paid model + its :free variant), then or-extra's :free rung —
		// three fetches. Without dedup or-same would be tried as a fallback too (four).
		expect(n).toBe(3);
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

describe('llmComplete — BYOK Anthropic leads when supplied', () => {
	it('uses Anthropic first when a BYOK key is explicitly supplied', async () => {
		process.env.GROQ_API_KEY = 'g';
		const calls = installFetch({ [ANTHROPIC_HOST]: anthropicShape('claude says hi') });
		const out = await llm.llmComplete({ system: 's', user: 'u', anthropicKey: 'sk-byok' });
		expect(out.provider).toBe('anthropic');
		expect(out.text).toBe('claude says hi');
		expect(out.usage).toEqual({ input: 33, output: 44 });
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
		expect(openaiCall.body.model).toBe('gpt-4o-mini');
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
	it('throws LlmUnavailableError (503) when no provider is configured', async () => {
		installFetch({});
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
			code: 'llm_unavailable',
			status: 503,
		});
	});

	it('throws the last upstream error (502) when every provider fails', async () => {
		process.env.GROQ_API_KEY = 'g';
		process.env.OPENROUTER_API_KEY = 'o';
		installFetch({ [GROQ_HOST]: errResp(500), [OPENROUTER_HOST]: errResp(429) });
		await expect(llm.llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ status: 502 });
	});
});
