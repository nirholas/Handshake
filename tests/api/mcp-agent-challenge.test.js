/**
 * The Agent-wallet MCP endpoint (api/mcp-agent.js) must issue its OWN
 * auth/payment challenge: resource URL /api/mcp-agent, a wallet-and-payments
 * description, and a bazaar discovery example that calls find_services. Before
 * AGENT_CHALLENGE existed it inherited the main /api/mcp envelope, so
 * facilitators indexed it as the avatar/validation server and, worse, every
 * accepts[] entry quoted resource https://three.ws/api/mcp: a paying agent
 * signed a payment scoped to an endpoint it never called.
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
}));

// No Upstash in unit tests: every limiter passes.
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: new Proxy(
		{},
		{ get: () => vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
	),
	clientIp: vi.fn(() => '203.0.113.9'),
}));

// The bazaar client is a live network dependency; keep discovery hermetic.
vi.mock('../../api/_lib/x402/bazaar-client.js', async (orig) => {
	const actual = await orig();
	return { ...actual, searchBazaar: vi.fn(async () => ({ services: [] })) };
});

const { default: handler } = await import('../../api/mcp-agent.js');
const { AGENT_CHALLENGE, RESOURCE_DESCRIPTION } = await import('../../api/_mcpagent/discovery.js');
const { TOOL_CATALOG } = await import('../../api/_mcpagent/catalog.js');

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
	req.url = '/api/mcp-agent';
	req.headers = {
		'content-type': 'application/json',
		'x-forwarded-for': '203.0.113.9',
		...headers,
	};
	return req;
}

const walletStatusCall = {
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'wallet_status', arguments: {} },
};

describe('POST /api/mcp-agent, unauthenticated challenge identity', () => {
	it('plain x402 clients get a 402 naming the Agent-wallet resource', async () => {
		const res = makeRes();
		await handler(makeReq({ body: walletStatusCall }), res);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-agent');
		expect(challenge.resource.description).toContain('pay_and_call');
		expect(challenge.resource.serviceName).toBe('three.ws Agent MCP');
		expect(challenge.resource.tags).toContain('wallet');
		// The payment requirements themselves must be scoped to this endpoint:
		// this is the assertion that would have caught agents paying against
		// https://three.ws/api/mcp for an Agent-wallet call.
		for (const accept of challenge.accepts) {
			expect(accept.resource).toBe('https://three.ws/api/mcp-agent');
		}
	});

	it('advertises a read-only find_services example, never a spending tool', async () => {
		const res = makeRes();
		await handler(makeReq({ body: walletStatusCall }), res);
		const { extensions } = JSON.parse(res.body);
		expect(extensions.bazaar.discoverable).toBe(true);
		expect(extensions.bazaar.info.input.body.params.name).toBe('find_services');
		expect(extensions.bazaar.info.output.example.result.structuredContent.count).toBe(1);
	});

	it('MCP protocol clients get a 401 with the same Agent envelope', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: walletStatusCall,
				headers: { accept: 'application/json, text/event-stream' },
			}),
			res,
		);
		expect(res.statusCode).toBe(401);
		expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-agent');
		expect(challenge.resource.serviceName).toBe('three.ws Agent MCP');
	});

	it('GET (SSE probe) advertises the Agent resource as well', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', body: null }), res);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.resource.url).toBe('https://three.ws/api/mcp-agent');
		expect(challenge.resource.description).toContain('wallet_status');
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

describe('AGENT_CHALLENGE metadata', () => {
	it('names every tool the catalog actually ships', () => {
		const advertised = TOOL_CATALOG.map((t) => t.name).filter((n) => n !== 'getting_started');
		for (const name of advertised) expect(RESOURCE_DESCRIPTION).toContain(name);
	});

	it('stays inside the facilitator metadata limits (32 chars, 5 tags)', () => {
		expect(AGENT_CHALLENGE.serviceName.length).toBeLessThanOrEqual(32);
		expect(AGENT_CHALLENGE.tags.length).toBeLessThanOrEqual(5);
		for (const tag of AGENT_CHALLENGE.tags) expect(tag.length).toBeLessThanOrEqual(32);
		expect(AGENT_CHALLENGE.iconUrl).toMatch(/^https:\/\//);
	});
});
