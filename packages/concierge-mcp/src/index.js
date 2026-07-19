#!/usr/bin/env node
// @three-ws/concierge-mcp, MCP server entry point.
//
// Gives any AI assistant the three.ws Concierge over stdio:
//   • concierge_ask     , ask a website's AI concierge a question; fetches +
//                          grounds the answer in the page (or in text you pass)
//   • concierge_embed   , generate copy-paste embed code to add a Concierge
//                          (an AI chat widget with a 3D avatar) to a website
//   • concierge_avatars , list the rigged 3D avatars a Concierge can wear
//
// concierge_ask hits the PUBLIC, free three.ws answer lane (POST /api/concierge)
// and fetches caller-supplied URLs; concierge_embed and concierge_avatars are
// pure/offline. No keys, no signer, no payment, point THREE_WS_BASE at a
// deployment and go.
//
// Run standalone:
//   node packages/concierge-mcp/src/index.js
//
// Or wire into Claude Code / Cursor, see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as conciergeAsk } from './tools/ask.js';
import { def as conciergeEmbed } from './tools/embed.js';
import { def as conciergeAvatars } from './tools/avatars.js';

// Single source of truth for the advertised server version, package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [conciergeAsk, conciergeEmbed, conciergeAvatars];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'concierge-mcp', title: 'three.ws Concierge', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Concierge MCP, the embeddable AI chat widget with a 3D face, exposed to agents. ' +
				'concierge_ask asks a website\'s concierge a question: give it a url and it fetches that page and ' +
				'answers grounded in the real content, or pass knowledge/content to answer from text you already ' +
				'have, the model is told not to invent facts it cannot see. concierge_embed generates the ' +
				'copy-paste code (one <script> tag, the <three-concierge> web component, or an npm snippet) that ' +
				'adds a Concierge to any site, configured with an accent color, avatar, greeting, curated ' +
				'knowledge and suggested prompts. concierge_avatars lists the rigged 3D avatars it can wear. The ' +
				'ask lane runs on the free three.ws answer endpoint (no key); embed and avatars are offline.',
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
	console.error(`[concierge-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
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
		console.error('[concierge-mcp] fatal:', err);
		process.exit(1);
	});
}
