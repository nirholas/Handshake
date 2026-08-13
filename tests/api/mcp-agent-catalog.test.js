// api/_mcpagent/catalog.js — the wire contract + argument validators behind the
// agent-wallet MCP server (/api/mcp-agent). The catalog module is what turns a
// tool definition into (a) the tools/list payload external agents integrate
// against and (b) the compiled Ajv validator every tools/call argument set has
// to pass before a handler can touch a wallet. Both are asserted here directly;
// handler behaviour lives in mcp-agent.test.js.

import { describe, it, expect } from 'vitest';

import { TOOL_CATALOG, TOOLS } from '../../api/_mcpagent/catalog.js';

describe('agent-wallet MCP catalog', () => {
	it('leads with the free getting_started tool, then the wallet toolset', () => {
		expect(TOOL_CATALOG.map((t) => t.name)).toEqual([
			'getting_started',
			'wallet_status',
			'find_services',
			'pay_and_call',
			'provision_wallet',
			'monetize_endpoint',
		]);
	});

	it('gives every catalog entry a handler in the dispatch map', () => {
		for (const tool of TOOL_CATALOG) {
			expect(typeof TOOLS[tool.name]?.handler).toBe('function');
		}
		// And nothing extra: the dispatch map and the wire catalog are one list.
		expect(Object.keys(TOOLS).sort()).toEqual(TOOL_CATALOG.map((t) => t.name).sort());
	});

	it('compiles a validator for each tool that declares an input schema', () => {
		for (const tool of TOOL_CATALOG) {
			if (!tool.inputSchema) continue;
			expect(typeof TOOLS[tool.name].validate).toBe('function');
		}
	});

	// ── validators: the accept path ──────────────────────────────────────────
	it('fills schema defaults into the arguments the handler will read', () => {
		const args = { query: 'weather' };
		expect(TOOLS.find_services.validate(args)).toBe(true);
		// Ajv runs with useDefaults, so the handler sees the declared defaults
		// instead of having to re-derive them.
		expect(args).toMatchObject({ query: 'weather', type: 'http', limit: 15 });

		const monetize = {
			agent_id: '11111111-1111-1111-1111-111111111111',
			name: 'Weather API',
			description: 'Live weather',
			price_usdc: 0.01,
			target_url: 'https://api.example.com/weather',
		};
		expect(TOOLS.monetize_endpoint.validate(monetize)).toBe(true);
		// Base is the default payout rail; a solana default here would have sent
		// every default-network call down the wrong payout path.
		expect(monetize).toMatchObject({ method: 'POST', network: 'base' });
	});

	// ── validators: the reject path ──────────────────────────────────────────
	it('rejects arguments that would otherwise reach a wallet', () => {
		// Unknown property: additionalProperties is closed on every tool.
		expect(TOOLS.pay_and_call.validate({ resource_url: 'https://a.test/x', evil: 1 })).toBe(
			false,
		);
		// Missing the one required argument.
		expect(TOOLS.pay_and_call.validate({})).toBe(false);
		// Not a URI.
		expect(TOOLS.pay_and_call.validate({ resource_url: 'not a url' })).toBe(false);
		// Not a uuid: provision_wallet would otherwise query agent_identities with junk.
		expect(TOOLS.provision_wallet.validate({ agent_id: 'nope' })).toBe(false);
		// A price the atomic conversion cannot express in integer notation.
		expect(TOOLS.find_services.validate({ query: 'x', max_price_usdc: 1e21 })).toBe(false);
		// A free service is not a service: price must be above zero.
		expect(
			TOOLS.monetize_endpoint.validate({
				agent_id: '11111111-1111-1111-1111-111111111111',
				name: 'Svc',
				description: 'desc',
				price_usdc: 0,
				target_url: 'https://api.example.com/x',
			}),
		).toBe(false);
	});

	it('reports why an argument set failed so the dispatcher can quote it', () => {
		TOOLS.pay_and_call.validate({ resource_url: 123 });
		expect(TOOLS.pay_and_call.validate.errors?.[0]).toMatchObject({
			instancePath: '/resource_url',
		});
	});
});
