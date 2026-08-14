#!/usr/bin/env node
// @three-ws/brain-mcp — MCP server entry point.
//
// "Any model, one interface." Gives any AI assistant the three.ws multi-provider
// LLM router over stdio:
//   • list_providers — discover the providers/models the router can reach
//   • chat           — run a chat completion through whichever one fits
//
// A thin wrapper over the three.ws API (POST /api/brain/chat). The route fronts
// Claude, GPT-5, o3, Grok, Qwen, DeepSeek, NVIDIA Nemotron, IBM Granite, and more, and
// auto-falls-back across mirrors/free tiers on an upstream outage. The free
// open-weight tiers need no key; paid first-party flagships unlock with a
// three.ws API key (THREE_WS_API_KEY).
//
// Run standalone:
//   node packages/brain-mcp/src/index.js
//
// Or wire into Claude Code / Cursor — see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as listProviders } from './tools/list-providers.js';
import { def as chat } from './tools/chat.js';

// Single source of truth for the advertised server version — package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [listProviders, chat];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'brain-mcp', title: 'three.ws Brain', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Brain MCP — any model, one interface. list_providers discovers every LLM the router can ' +
				'run a completion through (Claude, GPT-5, o3, Grok, Qwen, DeepSeek, NVIDIA Nemotron, IBM Granite, and ' +
				'more), each with its key, network, tier, max output, live availability, and whether it needs auth. ' +
				'chat runs a completion through the chosen provider and returns the full reply as one message, plus ' +
				'the route actually taken, token usage, and timing — the router transparently falls back across ' +
				'mirrors and free tiers if the requested model is briefly down. Free open-weight tiers (GPT-OSS ' +
				'120B, NVIDIA NIM models) need no key; paid first-party flagships need a three.ws API key set as ' +
				'THREE_WS_API_KEY. Call list_providers first to choose a provider key. Both tools are read-only.',
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
	console.error(`[brain-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
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
		console.error('[brain-mcp] fatal:', err);
		process.exit(1);
	});
}
