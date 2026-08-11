// Smoke tests for workers/pump-fun-mcp/worker.js, the Cloudflare Workers mirror
// of /api/pump-fun-mcp.
//
// Nothing here is mocked: the worker's default export is the real module, `env`
// is the real shape Cloudflare hands it (a plain object of bindings), and the
// requests are real Request objects. The two paths that would otherwise reach
// the network are pinned to inputs that fail locally and deterministically: an
// invalid base58 mint (rejected before any RPC call) and an indexer URL on a
// closed local port (connection refused, no DNS, no upstream).

import { describe, it, expect } from 'vitest';
import worker from '../../workers/pump-fun-mcp/worker.js';

const URL_BASE = 'https://pump-fun-mcp.example/';
const PROTOCOL_VERSION = '2025-06-18';

// A port nothing listens on: rawBotCall's fetch is refused immediately, so the
// indexer-configured branch is exercised without an upstream or a mock.
const DEAD_INDEXER = { PUMPFUN_BOT_URL: 'http://127.0.0.1:1' };

// Two unreachable RPCs. Because the worker only falls back to the public
// endpoint when NOTHING is configured, this pins the whole chain to closed local
// ports: the failover runs for real and exhausts without leaving the machine.
const DEAD_RPC_CHAIN = {
	SOLANA_RPC_URL: 'http://127.0.0.1:1',
	SOLANA_RPC_FALLBACKS: 'http://127.0.0.1:2',
};
const REAL_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const ON_CHAIN_TOOLS = ['get_bonding_curve', 'get_token_details', 'get_token_holders'];
const INDEXER_TOOLS = [
	'search_tokens',
	'get_token_trades',
	'get_trending_tokens',
	'get_new_tokens',
	'get_graduated_tokens',
	'get_king_of_the_hill',
	'get_creator_profile',
];

function rpcRequest(body, init = {}) {
	return new Request(URL_BASE, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
		...init,
	});
}

async function rpc(body, env = {}) {
	const res = await worker.fetch(rpcRequest(body), env);
	return { res, json: res.status === 202 ? null : await res.json() };
}

async function callTool(name, args = {}, env = {}) {
	const { json } = await rpc(
		{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
		env,
	);
	return json;
}

describe('pump-fun-mcp worker: transport', () => {
	it('answers the CORS preflight with the MCP methods', async () => {
		const res = await worker.fetch(new Request(URL_BASE, { method: 'OPTIONS' }), {});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('access-control-allow-methods')).toContain('POST');
		expect(res.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
	});

	it('opens an SSE stream on GET and reports the protocol version', async () => {
		const res = await worker.fetch(new Request(URL_BASE), {});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(res.headers.get('mcp-protocol-version')).toBe(PROTOCOL_VERSION);
		expect(await res.text()).toContain('streamable-http');
	});

	it('terminates a session on DELETE', async () => {
		const res = await worker.fetch(new Request(URL_BASE, { method: 'DELETE' }), {});
		expect(res.status).toBe(204);
	});

	it('rejects unsupported methods with an Allow header', async () => {
		const res = await worker.fetch(new Request(URL_BASE, { method: 'PUT' }), {});
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toContain('POST');
	});

	it('returns a parse error for malformed JSON', async () => {
		const res = await worker.fetch(rpcRequest('{not json'), {});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe(-32700);
	});

	it('answers a notification-only POST with 202 and no body', async () => {
		const res = await worker.fetch(
			rpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }),
			{},
		);
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('');
	});

	it('carries the protocol version header on JSON-RPC responses', async () => {
		const { res } = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
		expect(res.headers.get('mcp-protocol-version')).toBe(PROTOCOL_VERSION);
	});
});

describe('pump-fun-mcp worker: JSON-RPC dispatch', () => {
	it('initializes with the protocol version and indexer capability flag', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(json.result.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(json.result.serverInfo.name).toBe('pump-fun-mcp-worker');
		expect(json.result.serverInfo.indexerEnabled).toBe(false);

		const configured = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, DEAD_INDEXER);
		expect(configured.json.result.serverInfo.indexerEnabled).toBe(true);
	});

	it('serves the empty resource and prompt lists MCP clients probe on connect', async () => {
		const resources = await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
		expect(resources.json.result.resources).toEqual([]);
		const templates = await rpc({ jsonrpc: '2.0', id: 2, method: 'resources/templates/list' });
		expect(templates.json.result.resourceTemplates).toEqual([]);
		const prompts = await rpc({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
		expect(prompts.json.result.prompts).toEqual([]);
	});

	it('answers a batch and rejects an empty or oversized one', async () => {
		const { json } = await rpc([
			{ jsonrpc: '2.0', id: 1, method: 'ping' },
			{ jsonrpc: '2.0', id: 2, method: 'ping' },
		]);
		expect(json.map((r) => r.id)).toEqual([1, 2]);

		const empty = await rpc([]);
		expect(empty.json.error.code).toBe(-32600);

		const oversized = await rpc(
			Array.from({ length: 17 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })),
		);
		expect(oversized.json.error.code).toBe(-32600);
		expect(oversized.json.error.message).toContain('batch too large');
	});

	it('rejects an unknown method', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/nope' });
		expect(json.error.code).toBe(-32601);
	});
});

describe('pump-fun-mcp worker: tools/list', () => {
	it('hides indexer-backed tools until the indexer is configured', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const names = json.result.tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining([...ON_CHAIN_TOOLS, 'pumpfun_bot_status']));
		for (const name of INDEXER_TOOLS) expect(names).not.toContain(name);
	});

	it('advertises the full worker subset once the indexer is configured', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, DEAD_INDEXER);
		const names = json.result.tools.map((t) => t.name);
		expect(names.sort()).toEqual(
			[...ON_CHAIN_TOOLS, ...INDEXER_TOOLS, 'pumpfun_bot_status'].sort(),
		);
	});

	it('advertises only canonical snake_case names, each with an input schema', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, DEAD_INDEXER);
		for (const tool of json.result.tools) {
			expect(tool.name).toMatch(/^[a-z0-9_]+$/);
			expect(tool.inputSchema?.type).toBe('object');
			expect(typeof tool.description).toBe('string');
		}
	});

	it('has a dispatch entry for every tool it advertises', async () => {
		const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, DEAD_INDEXER);
		for (const tool of json.result.tools) {
			const result = await callTool(tool.name, {}, DEAD_INDEXER);
			expect(result.error?.code, `${tool.name} has no handler`).not.toBe(-32601);
		}
	});
});

describe('pump-fun-mcp worker: tools/call', () => {
	it('reports indexer capability through pumpfun_bot_status without an indexer', async () => {
		const json = await callTool('pumpfun_bot_status');
		expect(json.result.structuredContent).toMatchObject({ configured: false, healthy: false });
		expect(JSON.parse(json.result.content[0].text).configured).toBe(false);
	});

	it('reports the indexer as unhealthy when it cannot be reached', async () => {
		const json = await callTool('pumpfun_bot_status', {}, DEAD_INDEXER);
		expect(json.result.structuredContent).toMatchObject({ configured: true, healthy: false });
		expect(json.result.structuredContent.error).toBeTruthy();
	});

	it('tells the caller which env var an indexer-backed tool needs', async () => {
		const json = await callTool('search_tokens', { query: 'three' });
		expect(json.error.code).toBe(-32004);
		expect(json.error.message).toContain('PUMPFUN_BOT_URL');
	});

	it('surfaces an indexer transport failure as -32004, not a crash', async () => {
		const json = await callTool('get_trending_tokens', { limit: 5 }, DEAD_INDEXER);
		expect(json.error.code).toBe(-32004);
	});

	it('accepts the legacy camelCase aliases and reaches the on-chain handler', async () => {
		const json = await callTool('getBondingCurve', { mint: 'not-a-mint' });
		// -32602 comes from inside handleGetBondingCurve, so the alias resolved to
		// get_bonding_curve and the real handler ran (the invalid mint stops it
		// before any RPC round-trip).
		expect(json.error.code).toBe(-32602);
		expect(json.error.message).toBe('invalid mint');
	});

	it('validates the mint on every on-chain tool before touching RPC', async () => {
		for (const name of ON_CHAIN_TOOLS) {
			const json = await callTool(name, { mint: 'not-a-mint' });
			expect(json.error.code, name).toBe(-32602);
		}
	});

	it('exhausts the RPC failover chain and reports -32004, never an internal error', async () => {
		// Every configured endpoint is refused, so each tool must surface the
		// upstream-data code its siblings use instead of leaking a -32603.
		for (const name of ON_CHAIN_TOOLS) {
			const json = await callTool(name, { mint: REAL_MINT }, DEAD_RPC_CHAIN);
			expect(json.error.code, name).toBe(-32004);
			expect(json.error.message, name).toMatch(/unavailable/);
		}
	});

	it('rejects an unknown tool name', async () => {
		const json = await callTool('definitely_not_a_tool');
		expect(json.error.code).toBe(-32601);
		expect(json.error.message).toContain('definitely_not_a_tool');
	});

	it('does not resolve inherited object members as tools', async () => {
		for (const name of ['__proto__', 'constructor', 'toString']) {
			const json = await callTool(name);
			expect(json.error.code, name).toBe(-32601);
		}
	});
});
