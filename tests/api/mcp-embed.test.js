import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Env (before any lazy env.* access) ──────────────────────────────────────
process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';
process.env.JWT_SECRET ||= 'test-secret-embed';
process.env.UPSTASH_REDIS_REST_URL ||= 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'redis-token';

// ── Auth ────────────────────────────────────────────────────────────────────
const authState = { extracted: null, bearer: null };
vi.mock('../../api/_lib/auth.js', () => ({
	extractBearer: vi.fn(() => authState.extracted),
	authenticateBearer: vi.fn(async () => authState.bearer),
	hasScope: vi.fn((granted, required) => {
		const g = new Set((granted || '').split(/\s+/).filter(Boolean));
		return required.split(/\s+/).every((s) => g.has(s));
	}),
}));

// ── DB — the embed tool issues one SELECT per call; queue the row(s). ────────
const sqlState = { queue: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: Array.isArray(strings) ? strings.join('?') : String(strings), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// ── Rate limits ──────────────────────────────────────────────────────────────
const ok = { success: true, reset: Date.now() + 60000 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpIp: vi.fn(async () => ok),
		mcpUser: vi.fn(async () => ok),
		mcpValidate: vi.fn(async () => ok),
		mcpInspect: vi.fn(async () => ({ success: true })),
		mcpOptimize: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '203.0.113.7'),
}));

// ── Usage ─────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// ── Pump pricing (embed tool is free → null price) ──────────────────────────
vi.mock('../../api/_lib/pump-pricing.js', () => ({
	priceFor: vi.fn(() => null),
	findActiveSubscription: vi.fn(async () => null),
	resolveBillingMint: vi.fn(() => null),
	x402AmountForTool: vi.fn(() => null),
}));

// ── On-chain resolver ────────────────────────────────────────────────────────
const onchainState = { result: { name: 'Onchain Hero' } };
vi.mock('../../api/_lib/onchain.js', () => ({
	resolveOnChainAgent: vi.fn(async () => onchainState.result),
	// Minimal chain table: only Base (8453) is needed by the tests.
	SERVER_CHAIN_META: { 8453: { name: 'Base', short: 'BASE', testnet: false } },
}));

// ── Embed policy (iframe surface enabled by default) ─────────────────────────
const policyState = { policy: null };
vi.mock('../../api/_lib/embed-policy.js', () => ({
	readEmbedPolicy: vi.fn(async () => policyState.policy),
}));

// ── Infra ────────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

// ── Import handler AFTER mocks ───────────────────────────────────────────────
const { default: handler } = await import('../../api/mcp.js');

// ── HTTP harness ─────────────────────────────────────────────────────────────
function makeReq({ method = 'POST', url = '/api/mcp', headers = {}, body = null } = {}) {
	const base = body !== null ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = { host: 'three.ws', ...(body !== null ? { 'content-type': 'application/json' } : {}), ...headers };
	return base;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true; },
	};
}
async function invoke(reqOpts = {}) {
	const res = makeRes();
	await handler(makeReq(reqOpts), res);
	let parsed = null;
	try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
	return { res, status: res.statusCode, body: parsed };
}
function call(args, extraHeaders = {}) {
	return {
		body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_embed_code', arguments: args } },
		headers: { authorization: 'Bearer valid-token', ...extraHeaders },
	};
}

const FULL_AUTH = { userId: 'user-1', scope: 'avatars:read', source: 'oauth' };
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const CREATION_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
	authState.extracted = 'valid-token';
	authState.bearer = FULL_AUTH;
	sqlState.queue = [];
	sqlState.calls = [];
	onchainState.result = { name: 'Onchain Hero' };
	policyState.policy = null;
});

// ── Catalog assembly ─────────────────────────────────────────────────────────
describe('catalog', () => {
	it('tools/list advertises get_embed_code', async () => {
		const { body } = await invoke({
			body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
			headers: { authorization: 'Bearer valid-token' },
		});
		const names = body.result.tools.map((t) => t.name);
		expect(names).toContain('get_embed_code');
	});
});

// ── Agent embed ──────────────────────────────────────────────────────────────
describe('agent embed', () => {
	it('returns a public agent embed snippet with the /embed URL and dimensions', async () => {
		sqlState.queue = [[{ id: AGENT_ID, user_id: 'someone-else', name: 'Nova', is_public: true }]];

		const { body } = await invoke(call({ agent_id: AGENT_ID, width: 640, height: 480 }));

		expect(body.error).toBeUndefined();
		const sc = body.result.structuredContent;
		expect(sc.ok).toBe(true);
		expect(sc.embed_html).toContain(`https://three.ws/agents/${AGENT_ID}/embed`);
		expect(sc.embed_html).toContain('width="640"');
		expect(sc.embed_html).toContain('height="480"');
		expect(sc.share_url).toBe(`https://three.ws/agents/${AGENT_ID}`);
		expect(sc.oembed_url).toContain('/api/oembed?url=');
		expect(sc.thumbnail_url).toBe(`https://three.ws/api/agent/${AGENT_ID}/og`);
		// Live-preview artifact for HTML-rendering clients.
		const resource = body.result.content.find((c) => c.type === 'resource');
		expect(resource.resource.mimeType).toBe('text/html');
		expect(resource.resource.text).toContain('<iframe');
	});

	it('clamps an out-of-range width instead of erroring', async () => {
		sqlState.queue = [[{ id: AGENT_ID, user_id: 'user-1', name: 'Nova', is_public: true }]];
		const { body } = await invoke(call({ agent_id: AGENT_ID, width: 99999 }));
		expect(body.error).toBeUndefined();
		expect(body.result.structuredContent.width).toBe(1920);
		expect(body.result.structuredContent.embed_html).toContain('width="1920"');
	});

	it('rejects a private agent embed for a non-owner with a designed error', async () => {
		sqlState.queue = [[{ id: AGENT_ID, user_id: 'owner-9', name: 'Secret', is_public: false }]];

		const { body } = await invoke(call({ agent_id: AGENT_ID }));

		expect(body.error).toBeUndefined(); // designed isError result, not a JSON-RPC fault
		expect(body.result.isError).toBe(true);
		expect(body.result.structuredContent.ok).toBe(false);
		expect(body.result.structuredContent.reason).toBe('private');
		expect(body.result.content[0].text).toMatch(/public|unlisted/i);
	});

	it('lets the owner embed their own private agent', async () => {
		sqlState.queue = [[{ id: AGENT_ID, user_id: 'user-1', name: 'Mine', is_public: false }]];
		const { body } = await invoke(call({ agent_id: AGENT_ID }));
		expect(body.result.structuredContent.ok).toBe(true);
		expect(body.result.structuredContent.embed_html).toContain('/embed');
	});
});

// ── On-chain agent embed ─────────────────────────────────────────────────────
describe('on-chain agent embed', () => {
	it('returns an on-chain agent embed with the /a/<chain>/<id>/embed URL', async () => {
		const { body } = await invoke(call({ chain_id: 8453, onchain_agent_id: '42' }));
		const sc = body.result.structuredContent;
		expect(sc.ok).toBe(true);
		expect(sc.embed_html).toContain('https://three.ws/a/8453/42/embed');
		expect(sc.share_url).toBe('https://three.ws/a/8453/42');
		expect(sc.thumbnail_url).toBe('https://three.ws/api/a-og?chain=8453&id=42');
	});
});

// ── Forge creation embed ─────────────────────────────────────────────────────
describe('forge creation embed', () => {
	it('returns a forge embed snippet for a finished creation', async () => {
		sqlState.queue = [[{ id: CREATION_ID, status: 'done', glb_url: 'https://cdn.test/m.glb', prompt: 'a robot' }]];
		const { body } = await invoke(call({ creation_id: CREATION_ID, height: 540 }));
		const sc = body.result.structuredContent;
		expect(sc.ok).toBe(true);
		// The lightweight /forge/embed viewer (AR-capable, zero-dependency) — not
		// the full /forge app — so an <iframe src=embed_html> stays small.
		expect(sc.embed_html).toContain('https://three.ws/forge/embed?src=');
		expect(sc.embed_html).toContain(encodeURIComponent('https://cdn.test/m.glb'));
		expect(sc.embed_html).toContain('height="540"');
		expect(sc.share_url).toBe(`https://three.ws/forge/share/${CREATION_ID}`);
		// /api/oembed now resolves /forge/share/:id (extractForgeId), so Forge
		// creations get a real oEmbed URL like every other embeddable target.
		expect(sc.oembed_url).toBe(
			`https://three.ws/api/oembed?url=${encodeURIComponent(`https://three.ws/forge/share/${CREATION_ID}`)}`,
		);
	});

	it('rejects a still-generating creation with a designed error', async () => {
		sqlState.queue = [[{ id: CREATION_ID, status: 'generating', glb_url: null }]];
		const { body } = await invoke(call({ creation_id: CREATION_ID }));
		expect(body.result.isError).toBe(true);
		expect(body.result.structuredContent.reason).toBe('not_ready');
	});
});

// ── Target validation ────────────────────────────────────────────────────────
describe('target validation', () => {
	it('rejects when no target is provided', async () => {
		const { body } = await invoke(call({}));
		expect(body.error.code).toBe(-32602);
		expect(body.error.message).toMatch(/exactly one target/i);
	});

	it('rejects when more than one target is provided', async () => {
		const { body } = await invoke(call({ agent_id: AGENT_ID, creation_id: CREATION_ID }));
		expect(body.error.code).toBe(-32602);
		expect(body.error.message).toMatch(/exactly one target/i);
	});
});
