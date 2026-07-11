import { describe, it, expect } from 'vitest';

import { buildToolResult, toolError } from '../mcp-server/src/payments.js';
import { buildTools, buildServer } from '../mcp-server/src/index.js';

// Guards the MCP result envelope that EVERY paid tool funnels through
// (mcp-server/src/payments.js → buildToolResult). The contract:
//   - text content is always present (back-compat for text-only clients)
//   - plain-object returns are surfaced as MCP structuredContent (2025-06-18)
//   - only the explicit toolError() envelope flips isError (which also tells the
//     x402 wrapper to cancel — not settle — the payment, so failures don't bill)
describe('buildToolResult — MCP CallToolResult envelope', () => {
	it('surfaces a plain object as both text and structuredContent', () => {
		const out = { seed: 'abc', presetId: 'wave', match: { score: 3 } };
		const res = buildToolResult(out);

		expect(res.content).toEqual([{ type: 'text', text: JSON.stringify(out) }]);
		// Structured output: the exact object, not a re-parsed copy.
		expect(res.structuredContent).toBe(out);
		// A successful call must NOT be flagged as an error.
		expect(res.isError).toBeUndefined();
	});

	it('flags the toolError() envelope with isError so the payment is cancelled, not settled', () => {
		const err = toolError('invalid_mint', 'token must be a base58 Solana pubkey', {
			token: 'nope',
		});
		const res = buildToolResult(err);

		expect(res.isError).toBe(true);
		expect(res.structuredContent).toEqual({
			ok: false,
			error: 'invalid_mint',
			message: 'token must be a base58 Solana pubkey',
			token: 'nope',
		});
		// Text mirror still carries the full error envelope for text-only clients.
		expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
	});

	it('does NOT flag a partial-data success (embedded sub-field error, no top-level ok:false)', () => {
		// pump_snapshot returns this shape when one upstream (Jupiter) is down but
		// the overall call succeeded — the caller should still pay and not see isError.
		const partial = {
			token: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
			price: { error: 'jupiter timeout' },
			volume24h: { volume24hUsd: 1000 },
		};
		const res = buildToolResult(partial);

		expect(res.isError).toBeUndefined();
		expect(res.structuredContent).toBe(partial);
	});

	it('keeps string returns text-only (structuredContent must be an object)', () => {
		const res = buildToolResult('plain text result');
		expect(res.content).toEqual([{ type: 'text', text: 'plain text result' }]);
		expect(res.structuredContent).toBeUndefined();
		expect(res.isError).toBeUndefined();
	});

	it('does not promote arrays to structuredContent (spec requires an object)', () => {
		const arr = [{ a: 1 }, { b: 2 }];
		const res = buildToolResult(arr);
		expect(res.content).toEqual([{ type: 'text', text: JSON.stringify(arr) }]);
		expect(res.structuredContent).toBeUndefined();
	});
});

// The tool surface must be enumerable WITHOUT any payment env — tool
// registration is secret-free; only an actual paid invocation needs a pay-to.
describe('MCP tool surface', () => {
	// Tools the platform offers at zero cost — exempt from the paid-price
	// assertion below, and asserted to advertise their free-ness instead.
	// (crypto_news_archive is freemium: its description quotes the over-quota
	// $ price, so it stays under the paid assertion.)
	const FREE_TOOLS = new Set(['forge_free', 'crypto_news', 'crypto_news_digest']);

	it('builds every tool descriptor with a complete, unique contract', async () => {
		const tools = await buildTools();
		expect(tools.length).toBeGreaterThanOrEqual(16);

		const names = new Set();
		for (const t of tools) {
			expect(typeof t.name).toBe('string');
			expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(typeof t.title).toBe('string');
			expect(t.title.length).toBeGreaterThan(0);
			expect(typeof t.description).toBe('string');
			if (FREE_TOOLS.has(t.name)) {
				// A free tool must say so plainly and must NOT quote a USDC price.
				expect(t.description.toLowerCase()).toContain('free');
			} else {
				// Every paid tool must quote its USDC price in its description.
				expect(t.description).toMatch(/\$[0-9]/);
			}
			expect(t.inputSchema).toBeTypeOf('object');
			expect(t.handler).toBeTypeOf('function');
			expect(names.has(t.name)).toBe(false);
			names.add(t.name);
		}
	});

	it('constructs the MCP server with no payment env set', async () => {
		const server = await buildServer();
		expect(server).toBeTruthy();
	});

	// MCP ToolAnnotations contract: every tool declares behavior hints so
	// clients can scope confirmation prompts. Per spec, destructiveHint
	// DEFAULTS TO TRUE when omitted on a non-read-only tool — so every
	// non-read-only tool here must set it to false explicitly (nothing this
	// server ships destroys state).
	it('declares MCP ToolAnnotations on every tool, and none are destructive', async () => {
		const tools = await buildTools();
		for (const t of tools) {
			expect(t.annotations, `${t.name} missing annotations`).toBeTypeOf('object');
			expect(typeof t.annotations.readOnlyHint, `${t.name}.readOnlyHint`).toBe('boolean');
			expect(typeof t.annotations.idempotentHint, `${t.name}.idempotentHint`).toBe('boolean');
			expect(typeof t.annotations.openWorldHint, `${t.name}.openWorldHint`).toBe('boolean');
			// destructiveHint must be present AND explicitly boolean: the spec
			// defaults it to TRUE when omitted, so an absent hint silently marks
			// even a read-only tool destructive. `.not.toBe(true)` alone passed for
			// undefined and let read-only tools ship without it.
			expect(typeof t.annotations.destructiveHint, `${t.name}.destructiveHint`).toBe('boolean');
			// No tool on this server is destructive.
			expect(t.annotations.destructiveHint, `${t.name}.destructiveHint`).not.toBe(true);
			if (t.annotations.readOnlyHint === false) {
				// Non-read-only tools MUST opt out of the spec's destructive default.
				expect(
					t.annotations.destructiveHint,
					`${t.name} must set destructiveHint:false`,
				).toBe(false);
			}
		}
	});

	it('marks only the local-compute tools as closed-world, and the deterministic one as idempotent', async () => {
		const tools = await buildTools();
		const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));

		// Pure local compute — no external interaction.
		expect(byName.get_pose_seed).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(byName.vanity_grinder).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false, // random keypair every call
			openWorldHint: false,
		});

		// Everything else talks to the outside world.
		for (const [name, a] of Object.entries(byName)) {
			if (name === 'get_pose_seed' || name === 'vanity_grinder') continue;
			expect(a.openWorldHint, `${name}.openWorldHint`).toBe(true);
			// Live feeds / fresh artifacts — never claim idempotence.
			expect(a.idempotentHint, `${name}.idempotentHint`).toBe(false);
		}

		// Generation + delegation tools are writes (they create hosted artifacts
		// or dispatch actions); everything else is a pure read. agent_hire spends
		// USDC + runs a remote agent (a write); agent_hire_discover only reads the
		// registry + reputation, so it stays a read.
		const writes = [
			'text_to_avatar',
			'mesh_forge',
			'forge_free',
			'rig_mesh',
			'forge_avatar',
			'refine_model',
			'restyle_material',
			'agent_delegate_action',
			'agent_hire',
		];
		for (const [name, a] of Object.entries(byName)) {
			expect(a.readOnlyHint, `${name}.readOnlyHint`).toBe(!writes.includes(name));
		}
	});
});
