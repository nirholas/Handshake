/**
 * The 3D Studio MCP endpoint (api/mcp-3d.js) must issue its OWN auth/payment
 * challenge — resource URL /api/mcp-3d, a text→3D description, and a bazaar
 * discovery example that calls text_to_3d. Before STUDIO_CHALLENGE existed it
 * inherited the main /api/mcp envelope and advertised itself to x402
 * facilitators as the avatar/validation server, so agents indexed (and paid
 * against) the wrong resource.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

// Env the real 402 challenge builder reads. Set before importing the handler.
process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.X402_PAY_TO_BASE ||= '0x0000000000000000000000000000000000000001';
process.env.X402_ASSET_ADDRESS_BASE ||= '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// OKX Agent Payments Protocol rail (specs/okx-agent-payments.md): payTo +
// settlement route configured → the eip155:196 accept is advertised. The
// relayer key is a synthetic, publicly-known test vector.
process.env.X402_PAY_TO_XLAYER ||= '0x75d00a2713565171f33216e5aa2a375e076ecf69';
process.env.X402_XLAYER_RELAYER_KEY ||=
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// Bearer path is out of scope — no token is ever presented in these tests.
vi.mock('../../api/_lib/auth.js', () => ({
	extractBearer: () => null,
	authenticateBearer: vi.fn(async () => null),
}));

// No Upstash in unit tests.
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpUser: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcp3dGenerate: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcp3dStatus: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpInspect: vi.fn(async () => ({ success: true })),
		mcpOptimize: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '203.0.113.9'),
}));

// ── Heavy studio-tool dependencies (imported transitively by the catalog) ────
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../api/_providers/replicate.js', () => ({
	createRegenProvider: vi.fn(() => ({
		submit: vi.fn(async () => ({ extJobId: 'pred_123', eta: 45 })),
		status: vi.fn(async () => ({ status: 'running' })),
	})),
}));
vi.mock('../../api/_mcp3d/text-to-image.js', () => ({
	textToImage: vi.fn(async () => ({ imageUrl: 'https://img.test/a.png', model: 'flux' })),
}));

const { default: handler } = await import('../../api/mcp-3d.js');
const { studioX402Amount, FREE_TOOLS, TOOL_PRICING } = await import('../../api/_mcp3d/pricing.js');
const { TOOL_CATALOG } = await import('../../api/_mcp3d/catalog.js');
const { isDiscoveryOnlyBatch } = await import('../../api/_lib/mcp-batch-price.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

function makeReq({ method = 'POST', headers = {}, body = null } = {}) {
	const payload = body == null ? '' : JSON.stringify(body);
	const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	req.method = method;
	req.url = '/api/mcp-3d';
	req.headers = {
		'content-type': 'application/json',
		'x-forwarded-for': '203.0.113.9',
		...headers,
	};
	return req;
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const textTo3dCall = (args = { prompt: 'a small clay fox sitting upright' }) => ({
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'text_to_3d', arguments: args },
});

describe('POST /api/mcp-3d — unauthenticated challenge identity', () => {
	it('plain x402 clients get a 402 naming the 3D Studio resource', async () => {
		const res = makeRes();
		await handler(makeReq({ body: textTo3dCall() }), res);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-3d');
		expect(challenge.resource.description).toContain('text_to_3d');
		expect(challenge.resource.serviceName).toBe('three.ws 3D Studio MCP');
		expect(challenge.resource.tags).toContain('text-to-3d');
		for (const accept of challenge.accepts) {
			expect(accept.resource).toBe('https://three.ws/api/mcp-3d');
		}
	});

	it('bazaar discovery example calls text_to_3d, not a main-server tool', async () => {
		const res = makeRes();
		await handler(makeReq({ body: textTo3dCall() }), res);
		const { extensions } = JSON.parse(res.body);
		expect(extensions.bazaar.discoverable).toBe(true);
		expect(extensions.bazaar.info.input.body.params.name).toBe('text_to_3d');
		expect(extensions.bazaar.info.output.example.result.structuredContent.job_id).toBeTruthy();
	});

	it('MCP protocol clients get a 401 with the same studio envelope', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: textTo3dCall(),
				headers: { accept: 'application/json, text/event-stream' },
			}),
			res,
		);
		expect(res.statusCode).toBe(401);
		expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-3d');
		expect(challenge.resource.serviceName).toBe('three.ws 3D Studio MCP');
	});

	it('GET (SSE probe) advertises the studio resource as well', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', body: null }), res);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-3d');
		expect(challenge.resource.description).toContain('text_to_3d');
	});

	it('the free public getting_started tool is still served with no credentials', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: {
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'getting_started', arguments: {} },
				},
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		const out = JSON.parse(res.body);
		expect(out.error).toBeUndefined();
		expect(out.result?.content?.[0]?.text).toBeTruthy();
	});
});

describe('POST /api/mcp-3d — free discovery for plain clients', () => {
	it('tools/list with no credentials returns the studio toolset', async () => {
		const res = makeRes();
		await handler(makeReq({ body: TOOLS_LIST }), res);
		expect(res.statusCode).toBe(200);
		const out = JSON.parse(res.body);
		const names = out.result.tools.map((t) => t.name);
		expect(names).toContain('text_to_3d');
		expect(names).toContain('image_to_3d');
		expect(names).toContain('generation_status');
	});

	it('initialize with no credentials advertises the studio server', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: { protocolVersion: '2025-06-18' },
				},
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		const out = JSON.parse(res.body);
		expect(out.result.serverInfo.name).toBe('three-ws-3d-studio');
	});

	it('a batch mixing discovery with a priced call is NOT free', async () => {
		const res = makeRes();
		await handler(makeReq({ body: [TOOLS_LIST, textTo3dCall()] }), res);
		expect(res.statusCode).toBe(402);
	});

	it('MCP protocol clients still get the 401 that starts OAuth on discovery', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: TOOLS_LIST,
				headers: { accept: 'application/json, text/event-stream' },
			}),
			res,
		);
		expect(res.statusCode).toBe(401);
		expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
	});
});

describe('POST /api/mcp-3d — per-tool x402 pricing', () => {
	it('quotes the standard tier price for a default text_to_3d call', async () => {
		const res = makeRes();
		await handler(makeReq({ body: textTo3dCall() }), res);
		expect(res.statusCode).toBe(402);
		const { accepts } = JSON.parse(res.body);
		for (const accept of accepts) expect(accept.amount).toBe('150000');
	});

	it('quotes the high tier price when the caller asks for tier: high', async () => {
		const res = makeRes();
		await handler(makeReq({ body: textTo3dCall({ prompt: 'a fox', tier: 'high' }) }), res);
		const { accepts } = JSON.parse(res.body);
		for (const accept of accepts) expect(accept.amount).toBe('500000');
	});

	it('sums a batch of priced calls into one charge', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: [
					textTo3dCall({ prompt: 'a fox', tier: 'draft' }), // 50000
					{
						jsonrpc: '2.0',
						id: 2,
						method: 'tools/call',
						params: { name: 'stylize_model', arguments: { mesh_url: 'https://x.test/a.glb' } }, // 20000
					},
				],
			}),
			res,
		);
		const { accepts } = JSON.parse(res.body);
		for (const accept of accepts) expect(accept.amount).toBe('70000');
	});
});

describe('studioX402Amount', () => {
	it('prices generation by tier with standard as the fallback', () => {
		expect(studioX402Amount('text_to_3d', { tier: 'draft' })).toBe('50000');
		expect(studioX402Amount('text_to_3d', { tier: 'standard' })).toBe('150000');
		expect(studioX402Amount('image_to_3d', { tier: 'high' })).toBe('500000');
		expect(studioX402Amount('text_to_3d', {})).toBe('150000');
		expect(studioX402Amount('text_to_3d', { tier: 'nonsense' })).toBe('150000');
	});

	it('prices mesh ops flat and leaves read-only tools free', () => {
		expect(studioX402Amount('auto_rig_model', {})).toBe('50000');
		expect(studioX402Amount('stylize_model', {})).toBe('20000');
		expect(studioX402Amount('generate_material', {})).toBe('10000');
		expect(studioX402Amount('generation_status', {})).toBeNull();
		expect(studioX402Amount('preview_3d', {})).toBeNull();
		expect(studioX402Amount('getting_started', {})).toBeNull();
	});
});

// An unpriced tool is served free, so a new GPU-backed tool that lands in the
// catalog without a TOOL_PRICING entry silently gives away generation-grade
// compute — the exact regression api/_mcp3d/pricing.js exists to prevent. These
// assertions force every catalog tool to be a deliberate paid-or-free decision.
describe('studio pricing classification covers the whole catalog', () => {
	const catalogNames = TOOL_CATALOG.map((t) => t.name);

	it('classifies every catalog tool as either priced or deliberately free', () => {
		const unclassified = catalogNames.filter(
			(n) => !FREE_TOOLS.has(n) && studioX402Amount(n, {}) === null,
		);
		expect(unclassified).toEqual([]);
	});

	it('never prices a tool it also declares free', () => {
		const contradictory = catalogNames.filter(
			(n) => FREE_TOOLS.has(n) && studioX402Amount(n, {}) !== null,
		);
		expect(contradictory).toEqual([]);
	});

	it('carries no pricing or free entry for a tool the catalog dropped', () => {
		const known = new Set(catalogNames);
		expect(Object.keys(TOOL_PRICING).filter((n) => !known.has(n))).toEqual([]);
		expect([...FREE_TOOLS].filter((n) => !known.has(n))).toEqual([]);
	});
});

describe('isDiscoveryOnlyBatch', () => {
	it('accepts pure discovery traffic and rejects anything carrying work', () => {
		expect(isDiscoveryOnlyBatch({ method: 'tools/list' })).toBe(true);
		expect(isDiscoveryOnlyBatch({ method: 'initialize' })).toBe(true);
		expect(isDiscoveryOnlyBatch([{ method: 'initialize' }, { method: 'ping' }])).toBe(true);
		expect(isDiscoveryOnlyBatch({ method: 'tools/call', params: { name: 'text_to_3d' } })).toBe(
			false,
		);
		expect(isDiscoveryOnlyBatch([{ method: 'tools/list' }, { method: 'tools/call' }])).toBe(false);
		expect(isDiscoveryOnlyBatch([])).toBe(false);
		expect(isDiscoveryOnlyBatch(null)).toBe(false);
	});
});
