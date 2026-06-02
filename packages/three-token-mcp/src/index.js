#!/usr/bin/env node
// @three-ws/three-token-mcp — MCP server entry point.
//
// The first MCP server whose actions burn a token. Gives any AI assistant
// three $THREE primitives over stdio:
//   • three_price   — live Jupiter USD price + USD→$THREE quote (read-only)
//   • three_balance — a wallet's $THREE + SOL balance (read-only)
//   • three_burn    — burn $THREE on-chain, split incinerator/treasury
//
// Destinations, decimals, and pricing all come from the PUBLIC three.ws token
// endpoints at runtime — nothing about the money split is baked in.
//
// Run standalone:
//   SOLANA_SECRET_KEY=<base58> node packages/three-token-mcp/src/index.js
//
// Or wire into Claude Desktop / Cursor — see README.md.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as threePrice } from './tools/three-price.js';
import { def as threeBalance } from './tools/three-balance.js';
import { def as threeBurn } from './tools/three-burn.js';

const TOOLS = [threePrice, threeBalance, threeBurn];

async function main() {
	const server = new McpServer(
		{ name: 'three-token-mcp', version: '1.0.0' },
		{
			capabilities: { tools: {} },
			instructions:
				'$THREE token MCP — price, hold, and BURN the three.ws token ($THREE) on Solana. ' +
				'three_price returns the live USD price (Jupiter primary, Birdeye fallback) and, given `usd`, ' +
				'how much $THREE that buys. three_balance reads any wallet\'s $THREE + SOL (defaults to the ' +
				'configured signer). three_burn is an EXECUTION ACTION: it quotes a USD amount to $THREE and ' +
				'sends one Solana transaction splitting it between the incinerator and the three.ws treasury ' +
				'(default 50/50, override with burnBps; 10000 = burn everything). Burning requires a signer ' +
				'(SOLANA_SECRET_KEY or a per-call `secret`) that already holds enough $THREE. Burn destinations ' +
				'and the split come from the live public token config — never hardcoded.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
			},
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
					return { content: [{ type: 'text', text }] };
				} catch (err) {
					const payload = {
						ok: false,
						error: err?.code || 'unhandled',
						message: err?.message || String(err),
						...(err?.signature ? { signature: err.signature } : {}),
					};
					return {
						content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[three-token-mcp] connected over stdio with ${TOOLS.length} tools`);
}

main().catch((err) => {
	console.error('[three-token-mcp] fatal:', err);
	process.exit(1);
});
