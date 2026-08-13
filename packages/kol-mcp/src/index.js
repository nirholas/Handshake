#!/usr/bin/env node
// @three-ws/kol-mcp — MCP server entry point.
//
// The "track one smart trader" surface. Where intel-mcp ranks the whole KOL set
// (kol_leaderboard) and shows everyone's trades on a mint (kol_trades), this
// server is the per-wallet deep dive: one tracked trader's portfolio P&L and
// their own trades on a given token, for copy/analysis decisions.
//   • get_wallet_portfolio — a KOL wallet's holdings + real on-chain P&L card
//   • get_wallet_trades    — that wallet's recent trades on a given mint
//
// A thin wrapper over the PUBLIC three.ws KOL API. No keys, no signer, no
// payment on the client — the Birdeye key that backs the holdings half lives
// server-side on three.ws. Point THREE_WS_BASE at a deployment and go.
//
// Run standalone:
//   node packages/kol-mcp/src/index.js
//
// Or wire into Claude Code / Cursor — see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as getWalletPortfolio } from './tools/get-wallet-portfolio.js';
import { def as getWalletTrades } from './tools/get-wallet-trades.js';

// Single source of truth for the advertised server version — package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [getWalletPortfolio, getWalletTrades];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'kol-mcp', title: 'three.ws KOL', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws KOL MCP — track one smart trader. get_wallet_portfolio pulls a single ' +
				"tracked KOL wallet's live portfolio card: current holdings value and largest holding, " +
				'plus 30d realized P&L, win rate and trade count computed from its own on-chain trades ' +
				'(null where there is no trade history to measure, never a fabricated zero). ' +
				'get_wallet_trades returns that ' +
				"same wallet's recent buys/sells of a specific mint — side, SOL size, price, USD value, " +
				'and timing, newest first. This is the per-wallet deep dive; to rank the whole KOL set or ' +
				'see every wallet\'s trades on a mint, use the intel-mcp server (kol_leaderboard, ' +
				'kol_trades). All data comes live from the public three.ws KOL API — no API key, signer, ' +
				'or payment required on the client. Every tool is read-only.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
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
						...(err?.status ? { status: err.status } : {}),
					};
					return {
						content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}

async function main() {
	const server = buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[kol-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
}

// Connect stdio ONLY when this file is the process entry point. Importing the
// module (tests, embedding) must not grab the transport. realpath both sides:
// npm bin shims are symlinks, so argv[1] may differ from import.meta.url.
function isProcessEntryPoint() {
	if (!process.argv[1]) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isProcessEntryPoint()) {
	main().catch((err) => {
		console.error('[kol-mcp] fatal:', err);
		process.exit(1);
	});
}
