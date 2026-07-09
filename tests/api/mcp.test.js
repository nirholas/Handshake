import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// ── Env vars (must be set before any lazy env.* access) ──────────────────
process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-secret-mcp';
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
	mcpValidate: { success: true, reset: Date.now() + 60000 },
};
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpIp: vi.fn(async () => rlState.mcpIp),
		mcpUser: vi.fn(async () => rlState.mcpUser),
		mcpValidate: vi.fn(async () => rlState.mcpValidate),
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

// ── x402 ─────────────────────────────────────────────────────────────────
class MockX402Error extends Error {
	constructor(code, message, status = 402) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

const x402State = { verifyOk: false, verifyResult: null };

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
	paymentRequirements: vi.fn(() => [
		{
			scheme: 'exact',
			network: 'eip155:8453',
			payTo: '0xrecipient',
			amount: '1000',
			asset: '0xusdc',
			maxTimeoutSeconds: 60,
		},
	]),
	bazaarExtension: vi.fn(() => ({
		method: 'POST',
		bodyType: 'json',
		input: {},
		inputSchema: {},
		output: { example: {} },
	})),
	verifyPayment: vi.fn(async () => {
		if (!x402State.verifyOk)
			throw new MockX402Error('invalid_payment', 'payment rejected', 402);
		return x402State.verifyResult;
	}),
	settlePayment: vi.fn(async () => ({
		success: true,
		transaction: 'tx123',
		network: 'eip155:8453',
		payer: '0xpayer',
	})),
	encodePaymentResponseHeader: vi.fn(() => 'settlement-b64'),
	send402: vi.fn((res, { resourceUrl, accepts, error } = {}) => {
		res.statusCode = 402;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		const list = Array.isArray(accepts) ? accepts : [accepts];
		res.end(
			JSON.stringify({
				x402Version: 2,
				error: error || 'X-PAYMENT header is required',
				resource: { url: resourceUrl, description: 'MCP', mimeType: 'application/json' },
				accepts: list,
				extensions: { bazaar: { method: 'POST', bodyType: 'json' } },
			}),
		);
	}),
	build402Body: vi.fn(({ resourceUrl, accepts, error } = {}) => {
		const list = Array.isArray(accepts) ? accepts : [accepts];
		return {
			x402Version: 2,
			error: error || 'X-PAYMENT header is required',
			resource: { url: resourceUrl, description: 'MCP', mimeType: 'application/json' },
			accepts: list,
			extensions: { bazaar: { method: 'POST', bodyType: 'json' } },
		};
	}),
	resolveResourceUrl: vi.fn((req, path) => `https://app.test${path}`),
}));

// ── Pump pricing ──────────────────────────────────────────────────────────
const pricingState = { price: null };
vi.mock('../../api/_lib/pump-pricing.js', () => ({
	priceFor: vi.fn(() => pricingState.price),
	findActiveSubscription: vi.fn(async () => null),
	resolveBillingMint: vi.fn(() => null),
	// Per-tool x402 amount (atomic-unit string) derived from the advertised
	// price. mcp.js peeks the called tool and passes this into the 402 challenge
	// so advertised price == charged price. null = free tool (flat default).
	x402AmountForTool: vi.fn(() =>
		pricingState.price ? String(Math.round(pricingState.price.amount_usdc * 1e6)) : null,
	),
}));

// ── Avatars ────────────────────────────────────────────────────────────────
const avatarState = {
	avatar: null,
	avatarUrl: { url: 'https://cdn.test/model.glb' },
	searchResult: { avatars: [] },
};
vi.mock('../../api/_lib/avatars.js', () => ({
	listAvatars: vi.fn(async () => ({ avatars: [] })),
	getAvatar: vi.fn(async () => avatarState.avatar),
	getAvatarBySlug: vi.fn(async () => avatarState.avatar),
	searchPublicAvatars: vi.fn(async () => avatarState.searchResult),
	resolveAvatarUrl: vi.fn(async () => avatarState.avatarUrl),
	deleteAvatar: vi.fn(async () => true),
}));

// ── Model fetch ────────────────────────────────────────────────────────────
class MockFetchModelError extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
	}
}

const fetchModelState = { result: null, error: null };
vi.mock('../../api/_lib/fetch-model.js', () => ({
	FetchModelError: MockFetchModelError,
	fetchModel: vi.fn(async (url) => {
		if (fetchModelState.error) throw fetchModelState.error;
		return fetchModelState.result || { bytes: new Uint8Array(4), url, filename: 'model.glb' };
	}),
}));

// ── gltf-validator ─────────────────────────────────────────────────────────
vi.mock('gltf-validator', () => ({
	validateBytes: vi.fn(async () => ({
		validatorVersion: '2.0.0',
		mimeType: 'model/gltf-binary',
		issues: {
			numErrors: 0,
			numWarnings: 0,
			numInfos: 0,
			numHints: 0,
			truncated: false,
			messages: [],
		},
		info: {},
	})),
}));

// ── Solana attestations ────────────────────────────────────────────────────
vi.mock('../../api/_lib/solana-attestations.js', () => ({
	crawlAgentAttestations: vi.fn(async () => {}),
	KIND_MAP: {},
}));

// ── Pumpfun ────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/pumpfun-mcp.js', () => ({
	pumpfunMcp: {
		recentClaims: vi.fn(async () => ({ ok: true, data: [] })),
		tokenIntel: vi.fn(async () => ({ ok: true, data: {} })),
		creatorIntel: vi.fn(async () => ({ ok: true, data: {} })),
		graduations: vi.fn(async () => ({ ok: true, data: [] })),
	},
	pumpfunBotEnabled: vi.fn(() => false),
}));

// ── Model inspection ────────────────────────────────────────────────────────
vi.mock('../../api/_lib/model-inspect.js', () => ({
	inspectModel: vi.fn(async () => ({
		counts: {
			scenes: 1,
			nodes: 5,
			meshes: 2,
			materials: 1,
			textures: 0,
			animations: 0,
			skins: 0,
			totalVertices: 100,
			totalTriangles: 50,
			indexedPrimitives: 2,
			nonIndexedPrimitives: 0,
		},
		textures: [],
		extensionsUsed: [],
		container: 'glb',
		generator: 'test',
		version: '2.0',
		fileSize: 1024,
	})),
	suggestOptimizations: vi.fn(() => []),
}));

// ── Infrastructure ──────────────────────────────────────────────────────────
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

// ── Import handler AFTER mocks ─────────────────────────────────────────────
const { default: handler } = await import('../../api/mcp.js');

// ── Test helpers ───────────────────────────────────────────────────────────

function makeReq({
	method = 'POST',
	url = '/api/mcp',
	headers = {},
	body = null,
	rawBody = null,
} = {}) {
	let base;
	if (rawBody !== null) {
		base = Readable.from([rawBody]);
	} else if (body !== null) {
		base = Readable.from([Buffer.from(JSON.stringify(body))]);
	} else {
		base = Readable.from([]);
	}
	base.method = method;
	base.url = url;
	base.headers = {
		host: 'app.test',
		...(body !== null || rawBody !== null ? { 'content-type': 'application/json' } : {}),
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

async function invoke(reqOpts = {}) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	const parsed = res.body ? safeJson(res.body) : null;
	return { res, status: res.statusCode, body: parsed };
}

function safeJson(s) {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

// Shorthand for a JSON-RPC POST body with valid auth headers.
function rpc(method, params, extraHeaders = {}) {
	return {
		body: { jsonrpc: '2.0', id: 1, method, params },
		headers: { authorization: 'Bearer valid-token', ...extraHeaders },
	};
}

const FULL_AUTH = {
	userId: 'user-1',
	scope: 'avatars:read avatars:write avatars:delete',
	source: 'oauth',
};

// ── Reset between tests ───────────────────────────────────────────────────
beforeEach(() => {
	authState.extracted = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.mcpIp = { success: true, reset: Date.now() + 60000 };
	rlState.mcpUser = { success: true, reset: Date.now() + 60000 };
	rlState.mcpValidate = { success: true, reset: Date.now() + 60000 };
	avatarState.avatar = null;
	avatarState.searchResult = { avatars: [] };
	fetchModelState.result = null;
	fetchModelState.error = null;
	pricingState.price = null;
	x402State.verifyOk = false;
	x402State.verifyResult = null;
});

// ── Protocol layer ────────────────────────────────────────────────────────

describe('Protocol layer', () => {
	it('initialize returns protocol version, server info, and capabilities', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;

		const { status, body } = await invoke(rpc('initialize', { protocolVersion: '2025-06-18' }));

		expect(status).toBe(200);
		expect(body.jsonrpc).toBe('2.0');
		expect(body.result.protocolVersion).toBe('2025-06-18');
		expect(body.result.serverInfo.name).toBe('3d-agent-mcp');
		expect(body.result.capabilities.tools).toBeDefined();
	});

	it('tools/list returns the full tool catalog', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;

		const { status, body } = await invoke(rpc('tools/list', {}));

		expect(status).toBe(200);
		const names = body.result.tools.map((t) => t.name);
		expect(names).toContain('getting_started');
		expect(names).toContain('search_public_avatars');
		expect(names).toContain('validate_model');
		expect(names).toContain('render_avatar');
		expect(names).toContain('list_my_avatars');
	});

	it('tools/list with no jsonrpc field still succeeds (minimal-client tolerance)', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;

		// Minimal/legacy MCP clients omit the `jsonrpc: "2.0"` envelope on
		// discovery calls. Rejecting those with -32600 broke interop; an absent
		// version must be tolerated (auth/pricing still gate the call).
		const { status, body } = await invoke({
			body: { id: 1, method: 'tools/list', params: {} },
			headers: { authorization: 'Bearer valid-token' },
		});

		expect(status).toBe(200);
		expect(body.result.tools.length).toBeGreaterThan(0);
	});

	it('a present-but-wrong jsonrpc version is still rejected with -32600', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;

		const { status, body } = await invoke({
			body: { jsonrpc: '1.0', id: 1, method: 'tools/list', params: {} },
			headers: { authorization: 'Bearer valid-token' },
		});

		expect(status).toBe(200);
		expect(body.error.code).toBe(-32600);
	});

	it('unknown method returns JSON-RPC -32601 error', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;

		const { status, body } = await invoke(rpc('totally/unknown', {}));

		expect(status).toBe(200);
		expect(body.error.code).toBe(-32601);
	});

	it('malformed JSON body returns HTTP 400', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;

		const { status } = await invoke({
			rawBody: Buffer.from('{ not valid json !!'),
			headers: { authorization: 'Bearer valid-token' },
		});

		expect(status).toBe(400);
	});

	it('DELETE returns 204 (stateless session termination)', async () => {
		const { status } = await invoke({ method: 'DELETE' });

		expect(status).toBe(204);
	});

	it('GET without bearer returns 401 + WWW-Authenticate (OAuth discovery) with x402 envelope attached', async () => {
		// MCP protocol clients (mcp-protocol-version header) get 401 per the MCP
		// authorization spec; bare x402 agents get 402 (covered in Authentication).
		const { status, body, res } = await invoke({
			method: 'GET',
			headers: { 'mcp-protocol-version': '2025-03-26' },
		});

		expect(status).toBe(401);
		expect(res.headers['www-authenticate']).toMatch(/resource_metadata=/);
		// x402 price discovery still rides along in the body + PAYMENT-REQUIRED header.
		expect(body.x402Version).toBe(2);
		expect(Array.isArray(body.accepts)).toBe(true);
		expect(res.headers['payment-required']).toBeTruthy();
	});

	it('GET with valid bearer returns 405 (SSE not yet implemented)', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;

		const { status, res } = await invoke({
			method: 'GET',
			headers: { authorization: 'Bearer valid-token' },
		});

		expect(status).toBe(405);
		expect(res.headers['allow']).toMatch(/POST/);
	});
});

// ── Authentication ────────────────────────────────────────────────────────

describe('Authentication', () => {
	it('POST with no bearer and no X-PAYMENT returns 401 (OAuth challenge) for MCP protocol clients', async () => {
		// no bearer, no payment, MCP protocol header → sendAuthChallenge → 401 + WWW-Authenticate
		const { status, body, res } = await invoke({
			headers: { 'mcp-protocol-version': '2025-03-26' },
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'search_public_avatars' },
			},
		});

		expect(status).toBe(401);
		expect(res.headers['www-authenticate']).toMatch(/resource_metadata=/);
		expect(body.x402Version).toBe(2);
	});

	it('POST with no bearer, no X-PAYMENT, and no MCP headers returns 402 (x402 agent challenge)', async () => {
		// Bare x402 agents/crawlers (no MCP protocol headers) key on a proper
		// 402 Payment Required carrying the same envelope.
		const { status, body, res } = await invoke({
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'search_public_avatars' },
			},
		});

		expect(status).toBe(402);
		expect(body.x402Version).toBe(2);
		expect(res.headers['payment-required']).toBeTruthy();
	});

	it('POST getting_started with no bearer and no X-PAYMENT succeeds (free public tool)', async () => {
		// no bearer, no payment → allowFree bypass → 200 with the server overview,
		// while a scoped tool on the same path still 401s (test above).
		const { status, body } = await invoke({
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'getting_started', arguments: {} },
			},
		});

		expect(status).toBe(200);
		expect(body.result.structuredContent.server).toBe('three.ws');
		expect(body.result.structuredContent.tools.length).toBeGreaterThan(0);
		expect(body.result.content[0].text).toContain('Getting Started');
	});

	it('POST with a bearer that fails authentication returns 401', async () => {
		authState.extracted = 'bad-token';
		authState.bearer = null; // authenticateBearer returns null → invalid token

		const { status, body } = await invoke({
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'search_public_avatars' },
			},
			headers: { authorization: 'Bearer bad-token' },
		});

		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect((res) => res).toBeDefined(); // www-authenticate header is set
	});

	it('POST with valid bearer succeeds for a scope-free tool', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = { userId: 'user-1', scope: '', source: 'oauth' };
		avatarState.searchResult = { avatars: [] };

		const { status, body } = await invoke(rpc('tools/call', { name: 'search_public_avatars' }));

		expect(status).toBe(200);
		expect(body.result.content[0].type).toBe('text');
	});

	it('list_my_avatars without avatars:read scope returns -32002', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = { userId: 'user-1', scope: '', source: 'oauth' }; // no scope

		const { status, body } = await invoke(rpc('tools/call', { name: 'list_my_avatars' }));

		expect(status).toBe(200);
		expect(body.error.code).toBe(-32002);
		expect(body.error.message).toMatch(/avatars:read/);
	});
});

// ── Tool: search_public_avatars ───────────────────────────────────────────

describe('Tool: search_public_avatars', () => {
	beforeEach(() => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;
	});

	it('returns a list of avatars when the DB has results', async () => {
		avatarState.searchResult = {
			avatars: [
				{ id: 'a1', name: 'Warrior', slug: 'warrior', model_url: 'https://cdn.test/w.glb' },
				{ id: 'a2', name: 'Mage', slug: 'mage', model_url: 'https://cdn.test/m.glb' },
			],
		};

		const { body } = await invoke(
			rpc('tools/call', { name: 'search_public_avatars', arguments: { q: 'warrior' } }),
		);

		expect(body.result.content[0].text).toContain('Warrior');
		expect(body.result.structuredContent.avatars).toHaveLength(2);
	});

	it('returns "No avatars found." text when results are empty', async () => {
		avatarState.searchResult = { avatars: [] };

		const { body } = await invoke(
			rpc('tools/call', { name: 'search_public_avatars', arguments: {} }),
		);

		expect(body.result.content[0].text).toBe('No avatars found.');
	});
});

// ── Tool: validate_model ──────────────────────────────────────────────────

describe('Tool: validate_model', () => {
	beforeEach(() => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;
	});

	it('returns structured validation report for a valid model URL', async () => {
		const { body } = await invoke(
			rpc('tools/call', {
				name: 'validate_model',
				arguments: { url: 'https://cdn.test/model.glb' },
			}),
		);

		expect(body.result).toBeDefined();
		expect(body.error).toBeUndefined();
		expect(body.result.content[0].text).toContain('Errors: 0');
		expect(body.result.structuredContent.numErrors).toBe(0);
	});

	it('returns isError result when the model fetch fails (e.g. SSRF / blocked URL)', async () => {
		fetchModelState.error = new MockFetchModelError('private IP blocked', 'SSRF');

		const { body } = await invoke(
			rpc('tools/call', {
				name: 'validate_model',
				arguments: { url: 'https://cdn.test/blocked.glb' },
			}),
		);

		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toContain('fetch failed');
		expect(body.result.content[0].text).toContain('SSRF');
	});
});

// ── Tool: render_avatar ───────────────────────────────────────────────────

describe('Tool: render_avatar', () => {
	it('returns an HTML snippet containing <model-viewer>', async () => {
		authState.extracted = 'valid-token';
		authState.bearer = FULL_AUTH;
		// render_avatar's inputSchema requires id to match uuid format — real
		// avatar ids are uuids, so the fixture must be one too.
		const avatarId = '11111111-1111-4111-8111-111111111111';
		avatarState.avatar = {
			id: avatarId,
			name: 'Test Avatar',
			slug: 'test',
			visibility: 'public',
			owner_id: 'user-1',
		};
		// sql returns [] by default → _readMcpPolicyByAvatar returns null (no restriction)

		const { body } = await invoke(
			rpc('tools/call', { name: 'render_avatar', arguments: { id: avatarId } }),
		);

		expect(body.result).toBeDefined();
		expect(body.error).toBeUndefined();
		const resource = body.result.content.find((c) => c.type === 'resource');
		expect(resource).toBeDefined();
		expect(resource.resource.mimeType).toBe('text/html');
		expect(resource.resource.text).toContain('<model-viewer');
		expect(resource.resource.text).toContain('https://cdn.test/model.glb');
	});
});

// ── x402 payment flow ─────────────────────────────────────────────────────

describe('x402 payment flow', () => {
	it('request with no auth and no X-PAYMENT returns 401 carrying the x402 payment body', async () => {
		const { status, body } = await invoke({
			headers: { 'mcp-protocol-version': '2025-03-26' },
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'search_public_avatars' },
			},
		});

		expect(status).toBe(401);
		expect(body.x402Version).toBe(2);
		expect(body.resource.url).toMatch(/\/api\/mcp$/);
		expect(body.resource.mimeType).toBe('application/json');
		expect(body.accepts[0].network).toBe('eip155:8453');
		expect(body.accepts[0].amount).toBe('1000');
		expect(body.extensions.bazaar).toBeDefined();
	});

	it('valid X-PAYMENT header passes payment verification and executes the tool', async () => {
		// No bearer — will enter x402 path
		authState.extracted = null;
		x402State.verifyOk = true;
		x402State.verifyResult = {
			paymentPayload: { network: 'base' },
			requirement: { network: 'base' },
			payer: '0xpayer',
		};
		avatarState.searchResult = { avatars: [] };

		const { status, body, res } = await invoke({
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'search_public_avatars', arguments: {} },
			},
			headers: {
				'x-payment': Buffer.from(JSON.stringify({ network: 'base' })).toString('base64'),
			},
		});

		expect(status).toBe(200);
		expect(body.result.content[0].type).toBe('text');
		expect(res.headers['x-payment-response']).toBe('settlement-b64');
	});
});
