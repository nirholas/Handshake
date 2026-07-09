import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Env vars (must be set before any lazy env.* access) ──────────────────
process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-secret-mcp-memory';
process.env.UPSTASH_REDIS_REST_URL ||= 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'redis-token';

// ── Auth ──────────────────────────────────────────────────────────────────
const authState = { extracted: null, bearer: null };

vi.mock('../../api/_lib/auth.js', () => ({
	extractBearer: vi.fn(() => authState.extracted),
	authenticateBearer: vi.fn(async () => authState.bearer),
	hasScope: vi.fn((granted, required) => {
		const g = new Set((granted || '').split(/\s+/).filter(Boolean));
		return required.split(/\s+/).every((s) => g.has(s));
	}),
}));

// ── DB ────────────────────────────────────────────────────────────────────
// Each sql`...` call shifts the next queued result, so a test queues one result
// per query the handler will run, in order.
const sqlState = { queue: [], calls: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// ── Rate limits ───────────────────────────────────────────────────────────
const rlState = {
	mcpIp: { success: true, reset: Date.now() + 60000 },
	mcpUser: { success: true, reset: Date.now() + 60000 },
};
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpIp: vi.fn(async () => rlState.mcpIp),
		mcpUser: vi.fn(async () => rlState.mcpUser),
		mcpValidate: vi.fn(async () => ({ success: true })),
		mcpInspect: vi.fn(async () => ({ success: true })),
		mcpOptimize: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '203.0.113.1'),
}));

// ── Usage ─────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// ── x402 (memory tools are free; keep the surface inert) ────────────────────
class MockX402Error extends Error {
	constructor(code, message, status = 402) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
vi.mock('../../api/_lib/x402-spec.js', () => ({
	X402Error: MockX402Error,
	X402_VERSION: 2,
	// Network constants + pure helpers bound at import time by the wider graph
	// (a2a-server, paid-endpoint, dev-tools). Values mirror the real module;
	// payment behavior stays inert via the function overrides below.
	NETWORK_BASE_MAINNET: 'eip155:8453',
	NETWORK_BASE_SEPOLIA: 'eip155:84532',
	NETWORK_ARBITRUM_MAINNET: 'eip155:42161',
	NETWORK_BSC_MAINNET: 'eip155:56',
	NETWORK_XLAYER_MAINNET: 'eip155:196',
	NETWORK_SOLANA_MAINNET: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	NETWORK_SOLANA_DEVNET: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
	BUILDER_CODE: 'builder-code',
	permit2VariantOf: vi.fn(() => null),
	baseSettleable: vi.fn(() => false),
	solanaSettleable: vi.fn(() => false),
	buildExactRequirements: vi.fn(() => []),
	decodePaymentHeader: vi.fn(() => null),
	decodeSignedAmount: vi.fn(() => null),
	decodeSignedRecipient: vi.fn(() => null),
	probeFacilitators: vi.fn(async () => ({})),
	buildBazaarSchema: vi.fn(() => ({})),
	paymentRequirements: vi.fn(() => [{ scheme: 'exact', network: 'eip155:8453', amount: '1000' }]),
	bazaarExtension: vi.fn(() => ({})),
	verifyPayment: vi.fn(async () => {
		throw new MockX402Error('invalid_payment', 'payment rejected', 402);
	}),
	settlePayment: vi.fn(async () => ({ success: true })),
	encodePaymentResponseHeader: vi.fn(() => 'settlement-b64'),
	send402: vi.fn(),
	build402Body: vi.fn(({ resourceUrl, accepts } = {}) => ({
		x402Version: 2,
		resource: { url: resourceUrl },
		accepts: Array.isArray(accepts) ? accepts : [accepts],
	})),
	resolveResourceUrl: vi.fn((req, path) => `https://app.test${path}`),
}));

// ── Pump pricing (memory tools are unpriced → free) ─────────────────────────
vi.mock('../../api/_lib/pump-pricing.js', () => ({
	priceFor: vi.fn(() => null),
	findActiveSubscription: vi.fn(async () => null),
	resolveBillingMint: vi.fn(() => null),
	x402AmountForTool: vi.fn(() => null),
}));

// ── Sibling tool deps (only needed so the catalog's imports resolve) ─────────
vi.mock('../../api/_lib/avatars.js', () => ({
	listAvatars: vi.fn(async () => ({ avatars: [] })),
	getAvatar: vi.fn(async () => null),
	getAvatarBySlug: vi.fn(async () => null),
	searchPublicAvatars: vi.fn(async () => ({ avatars: [] })),
	resolveAvatarUrl: vi.fn(async () => ({ url: 'https://cdn.test/model.glb' })),
	deleteAvatar: vi.fn(async () => true),
}));
class MockFetchModelError extends Error {}
vi.mock('../../api/_lib/fetch-model.js', () => ({
	FetchModelError: MockFetchModelError,
	fetchModel: vi.fn(async () => ({ bytes: new Uint8Array(4), url: 'x', filename: 'm.glb' })),
}));
vi.mock('gltf-validator', () => ({ validateBytes: vi.fn(async () => ({ issues: {} })) }));
vi.mock('../../api/_lib/solana-attestations.js', () => ({
	crawlAgentAttestations: vi.fn(async () => {}),
	KIND_MAP: {},
}));
vi.mock('../../api/_lib/pumpfun-mcp.js', () => ({
	pumpfunMcp: {
		recentClaims: vi.fn(async () => ({ ok: true, data: [] })),
		tokenIntel: vi.fn(async () => ({ ok: true, data: {} })),
		creatorIntel: vi.fn(async () => ({ ok: true, data: {} })),
		graduations: vi.fn(async () => ({ ok: true, data: [] })),
	},
	pumpfunBotEnabled: vi.fn(() => false),
}));
vi.mock('../../api/_lib/model-inspect.js', () => ({
	inspectModel: vi.fn(async () => ({ counts: {}, textures: [], extensionsUsed: [] })),
	suggestOptimizations: vi.fn(() => []),
}));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

// ── Import handler AFTER mocks ─────────────────────────────────────────────
const { default: handler } = await import('../../api/mcp.js');

// ── Test helpers ───────────────────────────────────────────────────────────
function makeReq({ method = 'POST', url = '/api/mcp', headers = {}, body = null } = {}) {
	const base =
		body !== null ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'app.test',
		...(body !== null ? { 'content-type': 'application/json' } : {}),
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
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
	};
}

async function call(name, args, { scope = 'memory:read memory:write' } = {}) {
	authState.extracted = 'valid-token';
	authState.bearer = { userId: 'user-1', scope, source: 'oauth' };
	const req = makeReq({
		body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
		headers: { authorization: 'Bearer valid-token' },
	});
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const MEM_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
	authState.extracted = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.mcpIp = { success: true, reset: Date.now() + 60000 };
	rlState.mcpUser = { success: true, reset: Date.now() + 60000 };
});

// ── Catalog wiring ──────────────────────────────────────────────────────────
describe('catalog', () => {
	it('exposes remember, recall, and forget', async () => {
		const m = await import('../../api/_mcp/catalog.js');
		const names = m.TOOL_CATALOG.map((t) => t.name);
		expect(names).toContain('remember');
		expect(names).toContain('recall');
		expect(names).toContain('forget');
	});
});

// ── Scope enforcement ───────────────────────────────────────────────────────
describe('scope enforcement', () => {
	it('remember without memory:write returns -32002', async () => {
		const { body } = await call(
			'remember',
			{ agent_id: AGENT_ID, content: 'hi' },
			{ scope: '' },
		);
		expect(body.error.code).toBe(-32002);
		expect(body.error.message).toMatch(/memory:write/);
	});

	it('recall without memory:read returns -32002', async () => {
		const { body } = await call('recall', { agent_id: AGENT_ID, query: 'hi' }, { scope: '' });
		expect(body.error.code).toBe(-32002);
		expect(body.error.message).toMatch(/memory:read/);
	});
});

// ── Schema validation ───────────────────────────────────────────────────────
describe('schema validation', () => {
	it('remember rejects a non-uuid agent_id with -32602', async () => {
		const { body } = await call('remember', { agent_id: 'not-a-uuid', content: 'hi' });
		expect(body.error.code).toBe(-32602);
	});

	it('remember rejects missing content with -32602', async () => {
		const { body } = await call('remember', { agent_id: AGENT_ID });
		expect(body.error.code).toBe(-32602);
	});

	it('recall rejects an over-long query with -32602', async () => {
		const { body } = await call('recall', { agent_id: AGENT_ID, query: 'x'.repeat(1001) });
		expect(body.error.code).toBe(-32602);
	});
});

// ── Ownership ────────────────────────────────────────────────────────────────
describe('ownership', () => {
	it('remember on an agent the caller does not own returns a designed error', async () => {
		sqlState.queue = [[]]; // ownsAgent → no matching row
		const { body } = await call('remember', { agent_id: AGENT_ID, content: 'secret' });
		expect(body.error).toBeUndefined();
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toMatch(/sign in with three\.ws oauth/i);
	});

	it('recall on a foreign agent returns a designed error, not stored rows', async () => {
		sqlState.queue = [[{ user_id: 'someone-else' }]];
		const { body } = await call('recall', { agent_id: AGENT_ID, query: 'anything' });
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toMatch(/account-scoped/i);
	});

	it('forget refuses a memory owned by another user', async () => {
		sqlState.queue = [[{ id: MEM_ID, user_id: 'someone-else' }]];
		const { body } = await call('forget', { memory_id: MEM_ID });
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toMatch(/does not belong to you/i);
	});
});

// ── Empty recall ─────────────────────────────────────────────────────────────
describe('empty recall', () => {
	it('returns an empty list with a helpful message when nothing is stored', async () => {
		sqlState.queue = [
			[{ user_id: 'user-1' }], // ownsAgent
			[], // candidates
		];
		const { body } = await call('recall', { agent_id: AGENT_ID, query: 'pumpfun' });
		expect(body.result.isError).toBeUndefined();
		expect(body.result.structuredContent.memories).toEqual([]);
		expect(body.result.content[0].text).toMatch(/no memories stored/i);
	});
});

// ── Happy-path round trip: remember → recall → forget ───────────────────────
describe('round trip', () => {
	it('remembers a memory and echoes the stored row', async () => {
		const stored = {
			id: MEM_ID,
			agent_id: AGENT_ID,
			type: 'project',
			content: 'Ship the memory MCP tools',
			tags: ['mcp'],
			context: {},
			salience: 0.7,
			created_at: '2026-06-08T00:00:00.000Z',
			expires_at: null,
		};
		sqlState.queue = [
			[{ user_id: 'user-1' }], // ownsAgent
			[stored], // INSERT ... RETURNING *
		];
		const { body } = await call('remember', {
			agent_id: AGENT_ID,
			content: 'Ship the memory MCP tools',
			type: 'project',
			tags: ['mcp'],
			salience: 0.7,
		});
		expect(body.error).toBeUndefined();
		expect(body.result.structuredContent.memory.id).toBe(MEM_ID);
		expect(body.result.structuredContent.memory.type).toBe('project');
		expect(body.result.content[0].text).toContain('Ship the memory MCP tools');
	});

	it('recalls the stored memory ranked first by query relevance', async () => {
		const rows = [
			{
				id: 'mem-unrelated',
				agent_id: AGENT_ID,
				type: 'reference',
				content: 'A note about something else entirely',
				tags: [],
				salience: 0.9,
				created_at: '2026-06-08T00:00:00.000Z',
				expires_at: null,
			},
			{
				id: MEM_ID,
				agent_id: AGENT_ID,
				type: 'project',
				content: 'Ship the memory MCP tools for pumpfun',
				tags: ['mcp', 'pumpfun'],
				salience: 0.5,
				created_at: '2026-06-08T00:00:00.000Z',
				expires_at: null,
			},
		];
		sqlState.queue = [
			[{ user_id: 'user-1' }], // ownsAgent
			rows, // candidates
		];
		const { body } = await call('recall', { agent_id: AGENT_ID, query: 'pumpfun mcp tools' });
		const mems = body.result.structuredContent.memories;
		expect(mems[0].id).toBe(MEM_ID); // lexical relevance beats the higher-salience unrelated note
		expect(mems[0].score).toBeGreaterThan(mems[1].score);
	});

	it('forgets a memory the caller owns', async () => {
		sqlState.queue = [
			[{ id: MEM_ID, user_id: 'user-1' }], // ownership join
			[], // DELETE
		];
		const { body } = await call('forget', { memory_id: MEM_ID });
		expect(body.error).toBeUndefined();
		expect(body.result.structuredContent).toEqual({ ok: true, id: MEM_ID });
		expect(body.result.content[0].text).toContain(MEM_ID);
	});
});
