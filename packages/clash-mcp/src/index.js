#!/usr/bin/env node
// @three-ws/clash-mcp — MCP server entry point.
//
// Exposes Coin Clash — the three.ws community faction war, backed by real
// holdings + pump.fun data — to any AI agent over stdio:
//   • get_clash_state       — the live battle board: who fights whom, power, clock
//   • get_clash_leaderboard — all-time faction war records (+ a faction's soldiers)
//   • enlist_faction        — prove an on-chain holding → get a war pass  (write)
//   • rally_faction         — spend taps as battle power for your faction (write)
//
// Reads are public — point THREE_WS_BASE at a deployment and go. Writes are
// wallet-scoped: enlist signs a challenge with the soldier's Solana key (the
// `secret` arg or SOLANA_SECRET_KEY env) and the backend confirms a live holding
// of the faction coin before issuing a pass. Nothing is mocked.
//
// Run standalone:
//   node packages/clash-mcp/src/index.js
//
// Or wire into Claude Code / Cursor — see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as getClashState } from './tools/get-clash-state.js';
import { def as getClashLeaderboard } from './tools/get-clash-leaderboard.js';
import { def as enlistFaction } from './tools/enlist-faction.js';
import { def as rallyFaction } from './tools/rally-faction.js';

// Single source of truth for the advertised server version — package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [getClashState, getClashLeaderboard, enlistFaction, rallyFaction];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'clash-mcp', title: 'three.ws Coin Clash', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Coin Clash MCP — play the community faction war from an agent. Coin Clash matches ' +
				'two communities each round and the army that rallies more power before the clock runs out wins. ' +
				'get_clash_state reads the live board (matchups, each army\'s power + momentum, the clock, who\'s ' +
				'leading). get_clash_leaderboard ranks factions by all-time war record and can list a faction\'s top ' +
				'soldiers. enlist_faction proves the signer\'s wallet holds the faction coin (it signs a challenge ' +
				'with your Solana key; the backend confirms a live on-chain holding) and returns a war pass. ' +
				'rally_faction spends taps from that pass as battle power for your faction — pass a war pass, or a ' +
				'faction token to auto-enlist and rally in one call. Reads need no key; writes use the `secret` arg ' +
				'or SOLANA_SECRET_KEY env. All data is live — power and standings move between calls.',
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
						...(err?.detail ? { detail: err.detail } : {}),
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
	console.error(`[clash-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
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
		console.error('[clash-mcp] fatal:', err);
		process.exit(1);
	});
}
