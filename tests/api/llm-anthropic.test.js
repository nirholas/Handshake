// Tests for /api/llm/anthropic — we-pay LLM proxy.
// Focus: monthly token budgeting (input+output), embed-policy enforcement
// (origin, surface, brain mode), upstream error sanitization, model allowlist.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-secret-llm';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-key';
process.env.UPSTASH_REDIS_REST_URL ||= 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'redis-token';

// ── Mocks ─────────────────────────────────────────────────────────────────

const policyState = { policy: null };
const avatarPolicyState = { policy: null };
const avatarState = { avatar: null };

vi.mock('../../api/_lib/embed-policy.js', () => ({
	readEmbedPolicy: vi.fn(async () => policyState.policy),
	readEmbedPolicyByAvatarId: vi.fn(async () => avatarPolicyState.policy),
	defaultEmbedPolicy: () => JSON.parse(JSON.stringify(DEFAULT_POLICY)),
}));

vi.mock('../../api/_lib/avatars.js', () => ({
	getAvatar: vi.fn(async () => avatarState.avatar),
}));

const rlState = {
	ip: { success: true },
	agent: { success: true },
	hostKeyGlobal: { success: true },
};

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		embedLlmIp: vi.fn(async () => rlState.ip),
		embedLlmAgent: vi.fn(async () => rlState.agent),
		chatHostKeyGlobal: vi.fn(async () => rlState.hostKeyGlobal),
	},
	clientIp: () => '203.0.113.1',
}));

// Identity for the header-less (non-browser) lane. Null means anonymous, which
// is what every browser-shaped test wants.
const authState = { user: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getRequestUser: vi.fn(async () => authState.user),
}));

const usageEvents = [];
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: (evt) => usageEvents.push(evt),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// In-memory Redis stub backing the @upstash/redis client. Token + quota
// counters are kept here so tests can prime initial usage and assert deltas.
const redisStore = new Map();
const redisCalls = [];
class FakeRedis {
	constructor(_opts) {}
	async incr(key) {
		const next = (redisStore.get(key) ?? 0) + 1;
		redisStore.set(key, next);
		redisCalls.push({ op: 'incr', key, value: next });
		return next;
	}
	async incrby(key, delta) {
		const next = (redisStore.get(key) ?? 0) + delta;
		redisStore.set(key, next);
		redisCalls.push({ op: 'incrby', key, delta, value: next });
		return next;
	}
	async get(key) {
		return redisStore.get(key) ?? null;
	}
	async expire(key, ttl) {
		redisCalls.push({ op: 'expire', key, ttl });
		return 1;
	}
}

vi.mock('@upstash/redis', () => ({ Redis: FakeRedis }));

// The Vertex Gemini credits anchor mints a GCP OAuth token per request; stub
// the token exchange so anchor-lane tests need no real GCP credentials.
vi.mock('../../api/_lib/gcp-auth.js', () => ({
	getGcpAccessToken: vi.fn(async () => 'gcp-test-token'),
	gcpAuthConfigured: () => true,
	parseServiceAccount: vi.fn(),
}));

// Default upstream mock — overridden per-test as needed.
const fetchState = {
	response: () => upstreamOk({ ok: true, usage: { input_tokens: 10, output_tokens: 20 } }),
	calls: [],
};

function upstreamOk(json) {
	return {
		ok: true,
		status: 200,
		headers: new Map([['content-type', 'application/json']]),
		text: async () => JSON.stringify(json),
	};
}

function upstreamErr(status, body) {
	return {
		ok: false,
		status,
		headers: new Map([['content-type', 'application/json']]),
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	};
}

// Map.get is case-sensitive but the handler reads via headers.get('content-type')
// — patch Headers-like objects to mimic native fetch Headers behavior.
function patchHeaders(map) {
	return { get: (k) => map.get(k.toLowerCase()) ?? map.get(k) ?? null };
}

globalThis.fetch = vi.fn(async (url, init) => {
	fetchState.calls.push({ url, init });
	const r = await fetchState.response();
	r.headers = patchHeaders(
		r.headers instanceof Map ? r.headers : new Map(Object.entries(r.headers || {})),
	);
	return r;
});

const {
	default: handler,
	modelFallbackChain,
	resolveModelRoute,
} = await import('../../api/llm/anthropic.js');

// Upstream that answers with an SSE body, the shape both streaming lanes read
// (`upstream.body.getReader()`); one reader chunk per array entry.
function upstreamSse(chunks) {
	const encoder = new TextEncoder();
	let i = 0;
	return {
		ok: true,
		status: 200,
		headers: new Map([['content-type', 'text/event-stream']]),
		body: {
			getReader: () => ({
				read: async () =>
					i < chunks.length
						? { done: false, value: encoder.encode(chunks[i++]) }
						: { done: true, value: undefined },
			}),
		},
		text: async () => chunks.join(''),
	};
}

// ── Helpers ───────────────────────────────────────────────────────────────

// Requests default to a first-party localhost Origin, the shape a real browser
// embed sends, so tests that aren't about the origin gate exercise the lane a
// browser actually takes. Pass `noOrigin: true` for the header-less machine lane.
function makeReq({
	url = '/api/llm/anthropic?agent=agent-1',
	headers = {},
	body = null,
	noOrigin = false,
} = {}) {
	const base = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	const hasOrigin = 'origin' in headers || 'referer' in headers;
	base.method = 'POST';
	base.url = url;
	base.headers = {
		host: 'app.test',
		'content-type': 'application/json',
		...(hasOrigin || noOrigin ? {} : { origin: 'http://localhost:3000' }),
		...headers,
	};
	return base;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		write(chunk) {
			this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
			return true;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(opts = {}) {
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res);
	const json = res.body ? safeJson(res.body) : null;
	return { res, status: res.statusCode, body: json };
}

function safeJson(s) {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

const VALID_BODY = {
	messages: [{ role: 'user', content: 'hello' }],
	max_tokens: 100,
};

const WE_PAY_POLICY = {
	version: 1,
	origins: { mode: 'allowlist', hosts: ['client.test'] },
	surfaces: { script: true, iframe: true, widget: true, mcp: false },
	brain: {
		mode: 'we-pay',
		proxy_url: null,
		monthly_quota: null,
		rate_limit_per_min: null,
		model: 'claude-opus-4-6',
		cost_limit_cents: null,
	},
	storage: { primary: 'r2', pinned_ipfs: false, onchain_attested: false },
};

// Mirrors embed-policy.js defaultEmbedPolicy() — the we-pay free-model policy
// granted to bare public-avatar embeds that have no agent_identity row.
const DEFAULT_POLICY = {
	version: 1,
	origins: { mode: 'allowlist', hosts: [] },
	surfaces: { script: true, iframe: true, widget: true, mcp: false },
	brain: {
		mode: 'we-pay',
		proxy_url: null,
		monthly_quota: 1000,
		rate_limit_per_min: 10,
		model: 'google/gemma-4-31b-it:free',
	},
	storage: { primary: 'r2', pinned_ipfs: false, onchain_attested: false },
};

// ── Reset between tests ───────────────────────────────────────────────────

beforeEach(() => {
	// The Vertex Gemini credits anchor joins the fallback chain whenever
	// GOOGLE_CLOUD_PROJECT is set; clear it so chain-shape assertions here are
	// deterministic on GCP-configured machines. The anchor's own coverage lives
	// in tests/api/llm-vertex-anchor-surfaces.test.js.
	delete process.env.GOOGLE_CLOUD_PROJECT;
	policyState.policy = JSON.parse(JSON.stringify(WE_PAY_POLICY));
	avatarPolicyState.policy = null;
	avatarState.avatar = null;
	rlState.ip = { success: true };
	rlState.agent = { success: true };
	rlState.hostKeyGlobal = { success: true };
	authState.user = null;
	usageEvents.length = 0;
	redisStore.clear();
	redisCalls.length = 0;
	fetchState.calls.length = 0;
	fetchState.response = () =>
		upstreamOk({ ok: true, usage: { input_tokens: 10, output_tokens: 20 } });
});

// ── agent + policy gating ─────────────────────────────────────────────────

describe('/api/llm/anthropic — agent + policy gating', () => {
	it('rejects when no agent query param supplied', async () => {
		const { status, body } = await invoke({ url: '/api/llm/anthropic', body: VALID_BODY });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns 404 when no agent, avatar-agent, or public avatar matches', async () => {
		policyState.policy = null;
		avatarPolicyState.policy = null;
		avatarState.avatar = null;
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('falls back to the agent_identity linked by avatar_id', async () => {
		policyState.policy = null;
		avatarPolicyState.policy = JSON.parse(JSON.stringify(WE_PAY_POLICY));
		const { status } = await invoke({ body: VALID_BODY });
		expect(status).toBe(200);
	});

	it('grants the default we-pay policy to a bare public avatar embed', async () => {
		policyState.policy = null;
		avatarPolicyState.policy = null;
		avatarState.avatar = { id: 'avatar-uuid', visibility: 'public' };
		// The default policy serves the free OpenRouter model.
		process.env.OPENROUTER_API_KEY = 'sk-or-test';
		try {
			const { status } = await invoke({ body: VALID_BODY });
			expect(status).toBe(200);
		} finally {
			delete process.env.OPENROUTER_API_KEY;
		}
	});

	it('does not grant a policy to a private avatar', async () => {
		policyState.policy = null;
		avatarPolicyState.policy = null;
		avatarState.avatar = { id: 'avatar-uuid', visibility: 'private' };
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns 402 payment_required when brain.mode is not we-pay', async () => {
		policyState.policy.brain.mode = 'wallet-gated';
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(402);
		expect(body.error).toBe('payment_required');
	});

	it('returns 403 embed_denied_surface when script surface is disabled', async () => {
		policyState.policy.surfaces.script = false;
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(403);
		expect(body.error).toBe('embed_denied_surface');
	});
});

// ── origin enforcement ───────────────────────────────────────────────────

describe('/api/llm/anthropic — origin / referer policy', () => {
	it('rejects an origin not on the allowlist', async () => {
		const { status, body } = await invoke({
			body: VALID_BODY,
			headers: { origin: 'https://attacker.test' },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('embed_denied_origin');
	});

	// The header's absence used to mean "allowed", which made the allowlist
	// advisory: any script could strip Origin and spend the host's provider keys
	// against a public agent id. Anonymous header-less callers are now denied.
	it('rejects an anonymous request that sends no Origin header', async () => {
		authState.user = null;
		const { status, body } = await invoke({ body: VALID_BODY, noOrigin: true });
		expect(status).toBe(403);
		expect(body.error).toBe('embed_denied_origin');
		expect(body.error_description).toMatch(/authenticate/i);
	});

	it('allows a server-to-server request that authenticates', async () => {
		authState.user = { id: 'user-1', source: 'bearer' };
		const { status } = await invoke({
			body: VALID_BODY,
			noOrigin: true,
			headers: { authorization: 'Bearer platform-key' },
		});
		expect(status).toBe(200);
	});

	// An authenticated caller still cannot launder a denied browser origin: the
	// escape hatch is only for requests that carry no Origin at all.
	it('does not let a signed-in caller override a denied Origin', async () => {
		authState.user = { id: 'user-1', source: 'bearer' };
		const { status, body } = await invoke({
			body: VALID_BODY,
			headers: { origin: 'https://attacker.test', authorization: 'Bearer platform-key' },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('embed_denied_origin');
	});

	it('allows first-party localhost origin without policy entry', async () => {
		policyState.policy.origins.hosts = []; // explicitly empty
		const { status } = await invoke({
			body: VALID_BODY,
			headers: { origin: 'http://localhost:3000' },
		});
		expect(status).toBe(200);
	});
});

// ── rate limiting ────────────────────────────────────────────────────────

describe('/api/llm/anthropic — rate limiting', () => {
	it('returns 429 on per-IP rate limit', async () => {
		rlState.ip = { success: false };
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(429);
		expect(body.error_description).toMatch(/IP/);
	});

	it('returns 429 on per-agent rate limit when policy declares one', async () => {
		policyState.policy.brain.rate_limit_per_min = 5;
		rlState.agent = { success: false };
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(429);
		expect(body.error_description).toMatch(/agent rate limit/);
	});
});

// ── monthly call-count quota ─────────────────────────────────────────────

describe('/api/llm/anthropic — monthly call quota', () => {
	it('returns 429 quota_exceeded once monthly_quota is reached', async () => {
		policyState.policy.brain.monthly_quota = 2;
		// Pre-seed the call counter so the next incr crosses the quota.
		const monthKey = new Date().toISOString().slice(0, 7);
		redisStore.set(`llm:quota:agent-1:${monthKey}`, 2);
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(429);
		expect(body.error).toBe('quota_exceeded');
		expect(body.error_description).toMatch(/monthly quota of 2/);
	});

	it('passes through when under monthly_quota', async () => {
		policyState.policy.brain.monthly_quota = 100;
		const { status } = await invoke({ body: VALID_BODY });
		expect(status).toBe(200);
	});
});

// ── monthly token budget ────────────────────────────────────────────────

describe('/api/llm/anthropic — monthly token budget', () => {
	it('returns 429 quota_exceeded when token budget already met (default budget)', async () => {
		const monthKey = new Date().toISOString().slice(0, 7);
		// Default budget is 1_000_000 — pre-seed at the cap.
		redisStore.set(`llm:tokens:agent-1:${monthKey}`, 1_000_000);
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(429);
		expect(body.error).toBe('quota_exceeded');
		expect(body.error_description).toMatch(/monthly token budget/);
	});

	it('derives a smaller token budget from policy.brain.cost_limit_cents', async () => {
		// 15 cents @ 1.5¢/1k tokens = 10_000-token budget.
		policyState.policy.brain.cost_limit_cents = 15;
		const monthKey = new Date().toISOString().slice(0, 7);
		redisStore.set(`llm:tokens:agent-1:${monthKey}`, 10_000);
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(429);
		expect(body.error_description).toMatch(/10000/);
	});

	it('debits actual token usage to the per-agent counter on success', async () => {
		fetchState.response = () =>
			upstreamOk({ ok: true, usage: { input_tokens: 123, output_tokens: 456 } });
		const { status } = await invoke({ body: VALID_BODY });
		expect(status).toBe(200);
		const monthKey = new Date().toISOString().slice(0, 7);
		expect(redisStore.get(`llm:tokens:agent-1:${monthKey}`)).toBe(579);
	});

	it('does NOT debit tokens when upstream fails', async () => {
		fetchState.response = () => upstreamErr(500, { error: 'overloaded' });
		await invoke({ body: VALID_BODY });
		const monthKey = new Date().toISOString().slice(0, 7);
		expect(redisStore.get(`llm:tokens:agent-1:${monthKey}`)).toBeUndefined();
	});
});

// ── request body validation + model allowlist ───────────────────────────

describe('/api/llm/anthropic — request body + model', () => {
	it('rejects empty messages array', async () => {
		const { status, body } = await invoke({ body: { messages: [] } });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects model not on allowlist', async () => {
		const { status, body } = await invoke({
			body: { ...VALID_BODY, model: 'gpt-4' },
		});
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/not in allowlist/);
	});

	it('uses the model from the policy when caller omits one', async () => {
		policyState.policy.brain.model = 'claude-sonnet-4-6';
		await invoke({ body: VALID_BODY });
		const sentBody = JSON.parse(fetchState.calls[0].init.body);
		expect(sentBody.model).toBe('claude-sonnet-4-6');
	});

	it('honours a paid model the owner configured on the policy', async () => {
		policyState.policy.brain.model = 'claude-opus-4-6';
		await invoke({ body: { ...VALID_BODY, model: 'claude-opus-4-6' } });
		const sentBody = JSON.parse(fetchState.calls[0].init.body);
		expect(sentBody.model).toBe('claude-opus-4-6');
	});
});

// ── caller-chosen model vs. the owner's policy ──────────────────────────
//
// Which host-billed model an embed runs is the agent owner's decision, taken in
// the dashboard and stored on the policy. A visitor may switch between free
// lanes; asking for a pricier host-keyed model returns the configured one.
// The free lanes need their provider keys present, or the fallback chain
// degrades past them and the assertion reads the wrong upstream call.

describe('/api/llm/anthropic: paid-model clamp', () => {
	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = 'sk-or-test';
		process.env.GROQ_API_KEY = 'gsk-test';
	});

	afterEach(() => {
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.GROQ_API_KEY;
	});

	it('caller-supplied free model overrides the policy default', async () => {
		policyState.policy.brain.model = 'google/gemma-4-31b-it:free';
		await invoke({ body: { ...VALID_BODY, model: 'llama-3.3-70b-versatile' } });
		const sentBody = JSON.parse(fetchState.calls[0].init.body);
		expect(sentBody.model).toBe('llama-3.3-70b-versatile');
	});

	it('clamps a caller-requested paid model back to the policy model', async () => {
		policyState.policy.brain.model = 'google/gemma-4-31b-it:free';
		await invoke({ body: { ...VALID_BODY, model: 'claude-opus-5' } });
		const sentBody = JSON.parse(fetchState.calls[0].init.body);
		expect(sentBody.model).toBe('google/gemma-4-31b-it:free');
	});

	it('clamps a paid model on the free default policy too', async () => {
		delete policyState.policy.brain.model;
		await invoke({ body: { ...VALID_BODY, model: 'grok-4.5' } });
		const sentBody = JSON.parse(fetchState.calls[0].init.body);
		expect(sentBody.model).toBe('google/gemma-4-31b-it:free');
	});
});

// ── platform-wide host-key ceiling ──────────────────────────────────────

describe('/api/llm/anthropic: host-key global ceiling', () => {
	it('returns 429 when the shared host-key budget is saturated', async () => {
		rlState.hostKeyGlobal = { success: false, reset: Date.now() + 1000 };
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(429);
		expect(body.error_description).toMatch(/capacity/i);
	});
});

// ── upstream response handling ──────────────────────────────────────────

describe('/api/llm/anthropic — upstream behaviour', () => {
	it('proxies a successful upstream response unchanged', async () => {
		const upstreamPayload = {
			ok: true,
			id: 'msg_123',
			content: [{ type: 'text', text: 'hi' }],
			usage: { input_tokens: 5, output_tokens: 7 },
		};
		fetchState.response = () => upstreamOk(upstreamPayload);
		const { res, status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(200);
		expect(body).toEqual(upstreamPayload);
		expect(res.headers['content-type']).toMatch(/application\/json/);
	});

	it('sanitizes upstream errors into a generic 502 envelope (no leaking)', async () => {
		fetchState.response = () =>
			upstreamErr(429, {
				error: { type: 'rate_limit', message: 'slow down', secret: 'leaked' },
			});
		const { status, body } = await invoke({ body: VALID_BODY });
		expect(status).toBe(502);
		expect(body.error).toBe('upstream_error');
		// The original Anthropic body must NOT be forwarded.
		expect(JSON.stringify(body)).not.toContain('leaked');
		expect(JSON.stringify(body)).not.toContain('rate_limit');
	});

	it('records a usage event with input/output token counts', async () => {
		fetchState.response = () =>
			upstreamOk({ ok: true, usage: { input_tokens: 11, output_tokens: 22 } });
		await invoke({ body: VALID_BODY });
		// recordEvent runs synchronously (queueMicrotask in production code is in
		// usage.js; the mock here pushes immediately).
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]).toMatchObject({
			kind: 'llm',
			tool: 'anthropic.messages',
			agentId: 'agent-1',
			status: 'ok',
		});
		expect(usageEvents[0].meta.input_tokens).toBe(11);
		expect(usageEvents[0].meta.output_tokens).toBe(22);
	});
});

// ── free-provider routing (Groq / OpenRouter) ──────────────────────────
//
// The browser sends Anthropic-shape bodies for every model; the proxy
// inspects `model`, picks the upstream URL + key, and translates request
// + response shapes both ways. These tests pin that translation contract.

describe('/api/llm/anthropic — free-provider routing', () => {
	const SYSTEM = 'you are a helpful agent';

	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = 'sk-or-test';
		process.env.GROQ_API_KEY = 'gsk-test';
		// OpenAI-shape response by default; individual tests can override.
		fetchState.response = () =>
			upstreamOk({
				id: 'gen-1',
				choices: [
					{
						message: { role: 'assistant', content: 'hi from free model' },
						finish_reason: 'stop',
					},
				],
				usage: { prompt_tokens: 7, completion_tokens: 9 },
			});
	});

	it('routes free OpenRouter models to OpenRouter with bearer auth', async () => {
		await invoke({
			body: {
				...VALID_BODY,
				system: SYSTEM,
				model: 'google/gemma-4-31b-it:free',
			},
		});
		const call = fetchState.calls[0];
		expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
		expect(call.init.headers.authorization).toBe('Bearer sk-or-test');
		expect(call.init.headers['HTTP-Referer']).toBe('https://three.ws');
	});

	it('routes Groq model ids to api.groq.com', async () => {
		await invoke({
			body: { ...VALID_BODY, model: 'llama-3.3-70b-versatile' },
		});
		const call = fetchState.calls[0];
		expect(call.url).toBe('https://api.groq.com/openai/v1/chat/completions');
		expect(call.init.headers.authorization).toBe('Bearer gsk-test');
	});

	it('degrades through the fallback chain when the requested model has no key', async () => {
		// The requested OpenRouter lane is unkeyed; the request must NOT 503 —
		// it walks the chain and serves from the next configured lane.
		delete process.env.OPENROUTER_API_KEY;
		const { status } = await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' },
		});
		expect(status).toBe(200);
		// Every attempted call skipped the unkeyed OpenRouter lane.
		expect(fetchState.calls.every((c) => !c.url.includes('openrouter.ai'))).toBe(true);
	});

	it('degrades to a free lane when the keyed upstream rejects with 401 (dead key)', async () => {
		// Account-level 4xx (dead/revoked key) must fall through to the next
		// lane, not surface as a terminal error.
		let first = true;
		fetchState.response = () => {
			if (first) {
				first = false;
				return upstreamErr(401, 'invalid x-api-key');
			}
			return upstreamOk({
				id: 'gen-2',
				choices: [
					{ message: { role: 'assistant', content: 'rescued by free lane' }, finish_reason: 'stop' },
				],
				usage: { prompt_tokens: 3, completion_tokens: 4 },
			});
		};
		const { status } = await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' },
		});
		expect(status).toBe(200);
		expect(fetchState.calls.length).toBeGreaterThan(1);
	});

	it('returns 503 only when no lane in the chain is configured', async () => {
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.GROQ_API_KEY;
		delete process.env.NVIDIA_API_KEY;
		const savedAnthropic = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const { status, body } = await invoke({
				body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' },
			});
			expect(status).toBe(503);
			expect(body.error).toBe('provider_unavailable');
			expect(fetchState.calls).toHaveLength(0);
		} finally {
			process.env.ANTHROPIC_API_KEY = savedAnthropic;
		}
	});

	it('serves from the Vertex Gemini credits anchor when every keyed lane is unconfigured', async () => {
		// Prod repro of the 2026-07-21 diagnosis: free keys dead/absent, paid keys
		// dead/absent; the keyless GCP-credits anchor must answer instead of 503.
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.GROQ_API_KEY;
		delete process.env.NVIDIA_API_KEY;
		const savedAnthropic = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		try {
			const { status, body } = await invoke({
				body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' },
			});
			expect(status).toBe(200);
			const call = fetchState.calls[0];
			expect(call.url).toContain('aiplatform.googleapis.com');
			expect(call.url).toContain('test-project');
			expect(call.init.headers.authorization).toBe('Bearer gcp-test-token');
			// OpenAI-shape upstream translated back to the Anthropic shape the
			// embed client parses.
			expect(body.role).toBe('assistant');
			expect(body.content?.[0]?.text).toBe('hi from free model');
		} finally {
			process.env.ANTHROPIC_API_KEY = savedAnthropic;
			delete process.env.GOOGLE_CLOUD_PROJECT;
		}
	});

	it('translates Anthropic body shape → OpenAI body shape', async () => {
		await invoke({
			body: {
				system: SYSTEM,
				model: 'google/gemma-4-31b-it:free',
				max_tokens: 256,
				temperature: 0.4,
				messages: [
					{ role: 'user', content: 'how are you?' },
					{
						role: 'assistant',
						content: [
							{ type: 'text', text: 'let me check' },
							{
								type: 'tool_use',
								id: 'toolu_01',
								name: 'getTime',
								input: { tz: 'UTC' },
							},
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'toolu_01', content: '12:00' },
						],
					},
				],
				tools: [
					{
						name: 'getTime',
						description: 'returns the current time',
						input_schema: {
							type: 'object',
							properties: { tz: { type: 'string' } },
							required: ['tz'],
						},
					},
				],
			},
		});
		const sent = JSON.parse(fetchState.calls[0].init.body);
		expect(sent.model).toBe('google/gemma-4-31b-it:free');
		expect(sent.max_tokens).toBe(256);
		expect(sent.temperature).toBe(0.4);
		// System collapses into the first message.
		expect(sent.messages[0]).toEqual({ role: 'system', content: SYSTEM });
		expect(sent.messages[1]).toEqual({ role: 'user', content: 'how are you?' });
		// Assistant turn with a tool_use → OpenAI tool_calls array.
		expect(sent.messages[2]).toMatchObject({
			role: 'assistant',
			content: 'let me check',
			tool_calls: [
				{
					id: 'toolu_01',
					type: 'function',
					function: { name: 'getTime', arguments: JSON.stringify({ tz: 'UTC' }) },
				},
			],
		});
		// tool_result block → role:"tool" message.
		expect(sent.messages[3]).toEqual({
			role: 'tool',
			tool_call_id: 'toolu_01',
			content: '12:00',
		});
		// Tool schema converted to OpenAI function-tool shape.
		expect(sent.tools[0]).toEqual({
			type: 'function',
			function: {
				name: 'getTime',
				description: 'returns the current time',
				parameters: {
					type: 'object',
					properties: { tz: { type: 'string' } },
					required: ['tz'],
				},
			},
		});
		expect(sent.tool_choice).toBe('auto');
	});

	it('translates OpenAI-shape upstream response → Anthropic-shape body', async () => {
		const { status, body } = await invoke({
			body: { ...VALID_BODY, model: 'llama-3.3-70b-versatile' },
		});
		expect(status).toBe(200);
		expect(body).toMatchObject({
			type: 'message',
			role: 'assistant',
			model: 'llama-3.3-70b-versatile',
			content: [{ type: 'text', text: 'hi from free model' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 7, output_tokens: 9 },
		});
	});

	it('translates upstream tool_calls into Anthropic tool_use blocks', async () => {
		fetchState.response = () =>
			upstreamOk({
				id: 'gen-2',
				choices: [
					{
						message: {
							role: 'assistant',
							content: '',
							tool_calls: [
								{
									id: 'call_1',
									type: 'function',
									function: { name: 'getTime', arguments: '{"tz":"UTC"}' },
								},
							],
						},
						finish_reason: 'tool_calls',
					},
				],
				usage: { prompt_tokens: 4, completion_tokens: 5 },
			});
		const { body } = await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' },
		});
		expect(body.content).toEqual([
			{ type: 'tool_use', id: 'call_1', name: 'getTime', input: { tz: 'UTC' } },
		]);
		expect(body.stop_reason).toBe('tool_use');
	});

	it('debits OpenAI-shape token usage (prompt + completion) onto the agent', async () => {
		await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' },
		});
		const monthKey = new Date().toISOString().slice(0, 7);
		expect(redisStore.get(`llm:tokens:agent-1:${monthKey}`)).toBe(16);
	});

	it('records usage with the upstream provider tag', async () => {
		await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' },
		});
		expect(usageEvents[0]).toMatchObject({
			kind: 'llm',
			tool: 'openrouter.chat',
			agentId: 'agent-1',
		});
	});
});

// ── fallback-chain integrity ───────────────────────────────────────────────
//
// A rung the attempt loop cannot resolve is skipped in silence: the chain looks
// four deep in the comments and runs three deep in production. Pin every rung
// to the allowlist so the next edit cannot reintroduce a phantom step.

describe('/api/llm/anthropic: fallback chain integrity', () => {
	it('resolves every rung it lists to a real upstream route', () => {
		process.env.OPENROUTER_API_KEY = 'sk-or-test';
		process.env.GROQ_API_KEY = 'gsk-test';
		process.env.NVIDIA_API_KEY = 'nv-test';
		process.env.SAMBANOVA_API_KEY = 'sn-test';
		const chain = modelFallbackChain('google/gemma-4-31b-it:free');
		expect(chain.length).toBeGreaterThan(1);
		for (const rung of chain) {
			expect(resolveModelRoute(rung), `rung "${rung}" is not routable`).toBeTruthy();
		}
	});

	it('keeps the paid Anthropic rung last among the keyed lanes', () => {
		const chain = modelFallbackChain('google/gemma-4-31b-it:free');
		expect(chain[chain.length - 1]).toBe('claude-haiku-4-5-20251001');
	});
});

// ── Anthropic request shaping ──────────────────────────────────────────────

describe('/api/llm/anthropic: Anthropic request shaping', () => {
	it('supplies max_tokens when the caller omits it (the Messages API requires it)', async () => {
		await invoke({ body: { messages: [{ role: 'user', content: 'hello' }] } });
		const sent = JSON.parse(fetchState.calls[0].init.body);
		expect(sent.max_tokens).toBe(4096);
	});

	it('keeps a caller-supplied max_tokens', async () => {
		await invoke({ body: { ...VALID_BODY, max_tokens: 512 } });
		const sent = JSON.parse(fetchState.calls[0].init.body);
		expect(sent.max_tokens).toBe(512);
	});
});

// ── streaming ──────────────────────────────────────────────────────────────
//
// Streaming is the lane every browser embed takes, and it was the untested one.
// The OpenAI-shape upstreams are rewritten into Anthropic SSE on the fly, and
// the token counters that enforce the monthly budget are fed from that stream.

describe('/api/llm/anthropic: streaming, OpenAI-shape lanes', () => {
	const monthKey = () => new Date().toISOString().slice(0, 7);

	beforeEach(() => {
		process.env.OPENROUTER_API_KEY = 'sk-or-test';
		process.env.GROQ_API_KEY = 'gsk-test';
	});

	it('asks OpenAI-compatible providers for streaming usage', async () => {
		fetchState.response = () => upstreamSse(['data: [DONE]\n\n']);
		await invoke({ body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free', stream: true } });
		const sent = JSON.parse(fetchState.calls[0].init.body);
		expect(sent.stream).toBe(true);
		expect(sent.stream_options).toEqual({ include_usage: true });
	});

	it('does not send stream_options on a non-streaming request', async () => {
		await invoke({ body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free' } });
		const sent = JSON.parse(fetchState.calls[0].init.body);
		expect(sent.stream_options).toBeUndefined();
	});

	it('rewrites OpenAI deltas into Anthropic SSE and debits the usage chunk', async () => {
		fetchState.response = () =>
			upstreamSse([
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
				'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n',
				'data: [DONE]\n\n',
			]);
		const { res } = await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free', stream: true },
		});
		expect(res.headers['content-type']).toBe('text/event-stream');
		expect(res.headers['x-llm-transport']).toBe('openrouter');
		expect(res.body).toContain('event: message_start');
		expect(res.body).toContain('"text_delta","text":"Hel"');
		expect(res.body).toContain('"text_delta","text":"lo"');
		expect(res.body).toContain('event: message_stop');
		expect(res.writableEnded).toBe(true);
		// The budget the handler enforces is fed from that usage chunk.
		expect(redisStore.get(`llm:tokens:agent-1:${monthKey()}`)).toBe(17);
		expect(usageEvents[0]).toMatchObject({ provider: 'openrouter', outputTokens: 5 });
	});

	it("reads Groq's x_groq.usage, which sits outside the OpenAI usage field", async () => {
		fetchState.response = () =>
			upstreamSse([
				'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":8,"completion_tokens":3}}}\n\n',
				'data: [DONE]\n\n',
			]);
		await invoke({ body: { ...VALID_BODY, model: 'llama-3.3-70b-versatile', stream: true } });
		expect(redisStore.get(`llm:tokens:agent-1:${monthKey()}`)).toBe(11);
	});

	it('converts a streamed tool call into an Anthropic tool_use block', async () => {
		fetchState.response = () =>
			upstreamSse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"getTime","arguments":""}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"tz\\":"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"UTC\\"}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				'data: [DONE]\n\n',
			]);
		const { res } = await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free', stream: true },
		});
		expect(res.body).toContain('"type":"tool_use","id":"call_1","name":"getTime"');
		expect(res.body).toContain('"input_json_delta","partial_json":"{\\"tz\\":"');
		expect(res.body).toContain('"input_json_delta","partial_json":"\\"UTC\\"}"');
		expect(res.body).toContain('event: content_block_stop');
		expect(res.body).toContain('"stop_reason":"tool_use"');
	});

	it('keeps a tool name that streams in fragments ahead of its id', async () => {
		fetchState.response = () =>
			upstreamSse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"Time"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				'data: [DONE]\n\n',
			]);
		const { res } = await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free', stream: true },
		});
		expect(res.body).toContain('"name":"getTime"');
		expect(res.body).not.toContain('"name":"get"');
		expect(res.body).toContain('"input_json_delta","partial_json":"{}"');
	});

	it('emits a tool call whose id never arrived instead of dropping it', async () => {
		fetchState.response = () =>
			upstreamSse([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"getTime"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				'data: [DONE]\n\n',
			]);
		const { res } = await invoke({
			body: { ...VALID_BODY, model: 'google/gemma-4-31b-it:free', stream: true },
		});
		expect(res.body).toContain('"type":"tool_use"');
		expect(res.body).toContain('"name":"getTime"');
		expect(res.body).toContain('event: content_block_stop');
	});
});

describe('/api/llm/anthropic: streaming, Anthropic lane', () => {
	it('passes upstream Anthropic SSE through byte for byte and debits cache tokens', async () => {
		const chunks = [
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30,"cache_creation_input_tokens":100,"cache_read_input_tokens":200}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
		];
		fetchState.response = () => upstreamSse(chunks);
		const { res } = await invoke({ body: { ...VALID_BODY, stream: true } });
		expect(res.body).toBe(chunks.join(''));
		expect(res.headers['x-llm-transport']).toBe('anthropic');
		const monthKey = new Date().toISOString().slice(0, 7);
		// 30 uncached + 100 cache-write + 200 cache-read prompt tokens, 9 output.
		expect(redisStore.get(`llm:tokens:agent-1:${monthKey}`)).toBe(339);
		expect(usageEvents[0].meta).toMatchObject({
			input_tokens: 330,
			output_tokens: 9,
			cache_write_tokens: 100,
			cache_read_tokens: 200,
		});
	});
});
