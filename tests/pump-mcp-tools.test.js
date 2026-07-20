import { describe, it, expect } from 'vitest';
import { TOOLS, TOOL_ANNOTATIONS, rpcError, rpcEnvelope } from '../src/pump/mcp-tools.js';

// Tool names that must be present in both the Vercel and Worker runtimes.
// Both import TOOLS from the same shared module, so parity is structural.
// Canonical names are snake_case; the legacy camelCase forms are accepted on
// tools/call via TOOL_NAME_ALIASES but never advertised in TOOLS.
const EXPECTED_TOOL_NAMES = [
	'search_tokens',
	'get_token_details',
	'get_bonding_curve',
	'get_token_trades',
	'get_trending_tokens',
	'get_new_tokens',
	'get_graduated_tokens',
	'get_king_of_the_hill',
	'get_creator_profile',
	'get_token_holders',
	'pumpfun_bot_status',
];

describe('src/pump/mcp-tools — shared tool registry', () => {
	it('exports TOOLS as a non-empty array', () => {
		expect(Array.isArray(TOOLS)).toBe(true);
		expect(TOOLS.length).toBeGreaterThan(0);
	});

	it('contains all baseline pump.fun tools', () => {
		const names = TOOLS.filter(Boolean).map((t) => t.name);
		for (const name of EXPECTED_TOOL_NAMES) {
			expect(names).toContain(name);
		}
	});

	it('every tool entry has name, description, and inputSchema', () => {
		for (const tool of TOOLS.filter(Boolean)) {
			expect(typeof tool.name).toBe('string');
			expect(tool.name.length).toBeGreaterThan(0);
			expect(typeof tool.description).toBe('string');
			expect(tool.inputSchema).toBeDefined();
			expect(tool.inputSchema.type).toBe('object');
		}
	});

	it('tool names are unique', () => {
		const names = TOOLS.filter(Boolean).map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('every tool carries a title and read-only MCP annotations', () => {
		for (const tool of TOOLS.filter(Boolean)) {
			expect(typeof tool.title, `${tool.name}: title`).toBe('string');
			expect(tool.title.length).toBeGreaterThan(0);
			const a = tool.annotations;
			expect(a, `${tool.name}: annotations`).toBeTypeOf('object');
			// Most tools are pure reads; pumpfun_upload_metadata writes to IPFS (not a tx).
			expect(typeof a.readOnlyHint, `${tool.name}: readOnlyHint type`).toBe('boolean');
			// destructiveHint defaults to TRUE in the MCP spec when omitted — it
			// must be explicitly false here, never true.
			expect(a.destructiveHint, `${tool.name}: destructiveHint`).toBe(false);
			expect(typeof a.idempotentHint, `${tool.name}: idempotentHint`).toBe('boolean');
			expect(typeof a.openWorldHint, `${tool.name}: openWorldHint`).toBe('boolean');
		}
	});

	it('TOOL_ANNOTATIONS map covers every tool name', () => {
		for (const tool of TOOLS.filter(Boolean)) {
			expect(
				Object.hasOwn(TOOL_ANNOTATIONS, tool.name),
				`${tool.name}: missing from TOOL_ANNOTATIONS`,
			).toBe(true);
		}
	});

	it('rpcError attaches rpcCode to the error', () => {
		const err = rpcError(-32602, 'invalid param');
		expect(err).toBeInstanceOf(Error);
		expect(err.rpcCode).toBe(-32602);
		expect(err.message).toBe('invalid param');
	});

	it('rpcEnvelope wraps a result', () => {
		const env = rpcEnvelope(1, { tools: [] });
		expect(env).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
	});

	it('rpcEnvelope wraps an error object', () => {
		const env = rpcEnvelope(2, null, { code: -32601, message: 'not found' });
		expect(env).toEqual({
			jsonrpc: '2.0',
			id: 2,
			error: { code: -32601, message: 'not found' },
		});
	});

	it('rpcEnvelope uses null id when id is undefined', () => {
		const env = rpcEnvelope(undefined, { ok: true });
		expect(env.id).toBeNull();
	});

	// PumpSwap prices on effective quote reserves (vault + Pool.virtual_quote_reserves).
	// The MCP surface is the contract a model reads, so it has to (a) hand back the
	// reserves a quote was priced from, and (b) keep the two identically-named
	// virtual_quote_reserves fields apart. Getting (b) wrong is how a model ends up
	// applying AMM pool math to a bonding curve.
	describe('PumpSwap effective-reserve contract', () => {
		const tool = (name) => TOOLS.filter(Boolean).find((t) => t.name === name);

		it('pumpfun_quote_swap declares reserve provenance so a quote can be reproduced', () => {
			const props = tool('pumpfun_quote_swap')?.outputSchema?.properties ?? {};
			for (const field of [
				'base_reserve',
				'quote_reserve',
				'virtual_quote_reserves',
				'effective_quote_reserve',
			]) {
				expect(props[field]?.type, `${field} must be declared`).toBe('string');
			}
			// Reserves are u64/i128 on chain and exceed Number.MAX_SAFE_INTEGER, so
			// they must stay strings. A number here would silently lose precision.
			expect(props.amountOut.type).toBe('string');
		});

		it('pumpfun_quote_swap describes the effective quote reserve, not the raw vault', () => {
			const t = tool('pumpfun_quote_swap');
			expect(t.description).toMatch(/effective/i);
			expect(t.description).toMatch(/virtual_quote_reserves/);
			// The base side did NOT change; saying otherwise sends callers hunting
			// for a virtual base reserve that does not exist.
			expect(t.description).toMatch(/base/i);
			expect(t.outputSchema.properties.base_reserve.description).toMatch(
				/unaffected|unchanged/i,
			);
		});

		it('keeps the bonding-curve and pool virtual_quote_reserves distinguishable', () => {
			const curve = tool('get_bonding_curve');
			// The curve tool must scope itself to pre-graduation and point onward,
			// or a model will call it for a graduated coin and read zeros.
			expect(curve.description).toMatch(/pre-graduation/i);
			expect(curve.description).toMatch(/pumpfun_quote_swap/);
			// And it must name the on-chain rename, since the response key
			// (virtualSolReserves) no longer matches the on-chain field.
			expect(curve.outputSchema.properties.virtualSolReserves.description).toMatch(
				/virtual_quote_reserves/,
			);
			expect(curve.outputSchema.properties.solReserves.description).toMatch(
				/real_quote_reserves/,
			);
		});
	});

	it('Vercel and Worker runtimes share the same TOOLS source (structural parity)', async () => {
		// Both api/pump-fun-mcp.js and workers/pump-fun-mcp/worker.js import TOOLS
		// from this module, so the tool list is identical by construction.
		// Re-import to confirm the module is stable and exportable.
		const mod = await import('../src/pump/mcp-tools.js');
		expect(mod.TOOLS).toBe(TOOLS); // same reference — single module instance
		expect(mod.TOOLS.filter(Boolean).map((t) => t.name)).toEqual(
			TOOLS.filter(Boolean).map((t) => t.name),
		);
	});
});
