/**
 * The x402 Bazaar MCP endpoint (api/mcp-bazaar.js) must issue its OWN
 * auth/payment challenge: resource URL /api/mcp-bazaar, a discovery-server
 * description, and a bazaar example that calls search_services. Before
 * BAZAAR_CHALLENGE existed it passed neither resourcePath nor challenge to
 * authenticateRequest, so every 402 and 401 it issued advertised
 * https://three.ws/api/mcp and the main server's avatar/validation envelope.
 * Verified against production on 2026-08-13: the live 402 named /api/mcp on
 * all five accepts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';

// Env the real 402 challenge builder reads. Set before importing the handler.
process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.X402_PAY_TO_BASE ||= '0x0000000000000000000000000000000000000001';
process.env.X402_ASSET_ADDRESS_BASE ||= '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Bearer path is out of scope: no token is ever presented in these tests.
vi.mock('../../api/_lib/auth.js', () => ({
	extractBearer: () => null,
	authenticateBearer: vi.fn(async () => null),
	hasScope: () => true,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpUser: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpBazaar: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
	},
	clientIp: vi.fn(() => '203.0.113.11'),
}));

vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const { default: handler } = await import('../../api/mcp-bazaar.js');

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
	req.url = '/api/mcp-bazaar';
	req.headers = {
		'content-type': 'application/json',
		'x-forwarded-for': '203.0.113.11',
		...headers,
	};
	return req;
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const searchCall = {
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'search_services', arguments: { query: 'weather' } },
};

describe('POST /api/mcp-bazaar: unauthenticated challenge identity', () => {
	it('plain x402 clients get a 402 naming the bazaar resource', async () => {
		const res = makeRes();
		await handler(makeReq({ body: searchCall }), res);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-bazaar');
		expect(challenge.resource.description).toContain('search_services');
		expect(challenge.resource.serviceName).toBe('three.ws x402 Bazaar MCP');
		expect(challenge.resource.tags).toContain('discovery');
		for (const accept of challenge.accepts) {
			expect(accept.resource).toBe('https://three.ws/api/mcp-bazaar');
		}
	});

	it('bazaar discovery example calls search_services, not a main-server tool', async () => {
		const res = makeRes();
		await handler(makeReq({ body: searchCall }), res);
		const { extensions } = JSON.parse(res.body);
		expect(extensions.bazaar.discoverable).toBe(true);
		expect(extensions.bazaar.info.input.body.params.name).toBe('search_services');
		expect(extensions.bazaar.info.output.example.result.structuredContent.count).toBe(1);
	});

	it('MCP protocol clients get a 401 with the same bazaar envelope', async () => {
		const res = makeRes();
		await handler(
			makeReq({ body: searchCall, headers: { accept: 'application/json, text/event-stream' } }),
			res,
		);
		expect(res.statusCode).toBe(401);
		expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-bazaar');
		expect(challenge.resource.serviceName).toBe('three.ws x402 Bazaar MCP');
	});

	it('GET (SSE probe) advertises the bazaar resource as well', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', body: null }), res);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-bazaar');
		expect(challenge.resource.description).toContain('x402 Bazaar');
	});
});

describe('POST /api/mcp-bazaar: free discovery for plain clients', () => {
	it('initialize with no credentials advertises the bazaar server', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).result.serverInfo.name).toBe('three-ws-x402-bazaar');
	});

	it('tools/list with no credentials returns the discovery toolset', async () => {
		const res = makeRes();
		await handler(makeReq({ body: TOOLS_LIST }), res);
		expect(res.statusCode).toBe(200);
		const names = JSON.parse(res.body).result.tools.map((t) => t.name);
		expect(names).toEqual([
			'getting_started',
			'search_services',
			'browse_services',
			'get_service',
			'bazaar_service_details',
		]);
	});

	it('the free public getting_started tool is served with no credentials', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'getting_started', arguments: {} } },
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		const out = JSON.parse(res.body);
		expect(out.error).toBeUndefined();
		expect(out.result.structuredContent.server).toBe('three.ws x402 Bazaar');
	});

	it('a batch mixing discovery with a priced call is NOT free', async () => {
		const res = makeRes();
		await handler(makeReq({ body: [TOOLS_LIST, searchCall] }), res);
		expect(res.statusCode).toBe(402);
	});
});
