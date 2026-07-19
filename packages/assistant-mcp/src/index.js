#!/usr/bin/env node
// @three-ws/assistant-mcp: MCP server entry point.
//
// Gives any AI assistant a paste-ready three.ws assistant widget over stdio:
//   • build_assistant_widget: a config → an embeddable <script> tag, a frame
//     URL, and a ThreeAssistant.init() snippet for a floating 3D avatar chatbot
//   • list_assistant_options: every avatar, background, mode, chat lane and
//     data-* attribute you can set
//
// Both tools are PURE and OFFLINE: building an embed is deterministic string
// logic over local validators, no key, no signer, no payment, no network.
// THREE_WS_BASE only changes which origin the generated URLs point at.
//
// Run standalone:
//   node packages/assistant-mcp/src/index.js
//
// Or wire into Claude Code / Cursor, see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as buildAssistantWidget } from './tools/build-assistant-widget.js';
import { def as listAssistantOptions } from './tools/list-assistant-options.js';

// Single source of truth for the advertised server version, package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [buildAssistantWidget, listAssistantOptions];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'assistant-mcp', title: 'three.ws Assistant Widget', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Assistant Widget MCP: generate a paste-ready embed for the three.ws assistant ' +
				'widget, a floating 3D avatar chatbot for any website. build_assistant_widget turns a config ' +
				'(avatar, background, mode, name, greeting, context, accent, position, voice, badge) into a ' +
				'ready-to-paste <script> tag carrying only the non-default settings as data-* attributes, ' +
				'plus a standalone frame URL for <iframe> embedding, an equivalent ThreeAssistant.init({...}) ' +
				'JavaScript-API snippet, the visual builder link, and the fully-normalized config. ' +
				'list_assistant_options enumerates every built-in avatar, background preset and grammar, ' +
				'interaction mode, chat lane (free vs bring-your-own-key), and the full data-* attribute ' +
				'reference table, call it first to learn the vocabulary. Both tools are pure and offline: ' +
				'every field is validated and clamped locally, so a bad value falls back to a safe default and ' +
				'the generated HTML is always well-formed. No API key, signer, payment, or network call.',
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
	console.error(`[assistant-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
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
		console.error('[assistant-mcp] fatal:', err);
		process.exit(1);
	});
}
