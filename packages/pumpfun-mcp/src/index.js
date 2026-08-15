#!/usr/bin/env node
// @three-ws/pumpfun-mcp — stdio MCP server for pump.fun + Solana read-only data.
//
// A zero-config, free MCP server. It exposes pump.fun token discovery, on-chain
// bonding-curve / holder analysis, creator fee-claim tracking, SNS name
// resolution, KOL radar/leaderboard signals, and read-only swap quotes.
//
// Architecture: this process is a thin stdio <-> HTTP bridge in front of the
// canonical three.ws pump.fun MCP backend (https://three.ws/api/pump-fun-mcp).
// The backend is the single source of truth — it performs every Solana RPC and
// pump.fun API call server-side, so clients need no RPC URL, no API keys, and
// no secrets. All data is live and on-chain; there is no mock or sample path.
//
// Override the backend with PUMPFUN_MCP_URL (e.g. to self-host the handler).
//
// Run standalone:    npx @three-ws/pumpfun-mcp
// Inspect:           npx -y @modelcontextprotocol/inspector npx @three-ws/pumpfun-mcp

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { FALLBACK_TOOLS, TOOL_ANNOTATIONS } from './tools.js';
import { buildNativeRegistry } from './native.js';

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json');

// The bundled offline tool surface, re-exported so an embedder can read the
// advertised tools (and their annotations) without spawning the server.
export { FALLBACK_TOOLS, TOOL_ANNOTATIONS } from './tools.js';

// Resolved per call, not once at import: the bin reads it at startup either way,
// and a lazy read lets an embedder (or a test) repoint the bridge after the module
// is already loaded.
const backendUrl = () => process.env.PUMPFUN_MCP_URL || 'https://three.ws/api/pump-fun-mcp';
const SERVER_NAME = 'three.ws-pumpfun-mcp';

// A monotonically increasing JSON-RPC id for backend calls. Local to this
// process; the backend is stateless so any unique id works.
let rpcId = 0;

// Post a JSON-RPC 2.0 request to the canonical backend and return its parsed
// envelope. Throws on transport-level failure (network, non-2xx, bad JSON) so
// callers surface a real error rather than a fabricated payload.
async function callBackend(method, params, timeoutMs = 30_000) {
	const url = backendUrl();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`backend ${url} answered HTTP ${res.status}`);
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

// Fetch the authoritative tool list from the backend. Falls back to the
// vendored static surface if the backend is unreachable at startup, so a
// fresh install still advertises correct tools offline.
async function loadTools() {
	try {
		const env = await callBackend('tools/list', {}, 10_000);
		const tools = env?.result?.tools;
		if (Array.isArray(tools) && tools.length > 0) return tools;
	} catch (err) {
		process.stderr.write(
			`[pumpfun-mcp] tools/list unreachable (${err.message}); using bundled tool list\n`,
		);
	}
	return FALLBACK_TOOLS;
}

// Invoke a single backend tool and return its unwrapped structuredContent.
// Throws on a JSON-RPC error envelope so native composers can treat an
// individual source as unavailable (Promise.allSettled) without faking data.
async function callTool(name, args) {
	const env = await callBackend('tools/call', { name, arguments: args || {} });
	if (env?.error) {
		const err = new Error(env.error.message || `${name} failed`);
		err.rpcCode = env.error.code;
		throw err;
	}
	return env?.result?.structuredContent ?? null;
}

// Overlay the vendored title + ToolAnnotations onto a tool definition loaded
// from the backend. An up-to-date backend already ships both (its values win);
// an older deployed backend gets them filled in locally so clients always see
// read-only/idempotency hints.
function withLocalAnnotations(tool) {
	const local = TOOL_ANNOTATIONS[tool?.name];
	if (!local) return tool;
	return {
		...tool,
		title: tool.title ?? local.title,
		annotations: tool.annotations ?? local,
	};
}

/**
 * Build the fully-registered MCP server without connecting a transport. Asks the
 * backend for its authoritative tool list, so this is a live call; the bundled
 * FALLBACK_TOOLS cover an unreachable backend. Safe to import (tests, embedding
 * this bridge in another process).
 *
 * @returns {Promise<Server>}
 */
export async function buildServer() {
	const backendTools = await loadTools();
	const native = buildNativeRegistry(backendUrl(), callTool);
	const tools = [...backendTools.map(withLocalAnnotations), ...native.defs];

	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: { tools: { listChanged: false } },
			instructions:
				'Free, read-only pump.fun + Solana tools from three.ws. Token discovery ' +
				'(search_tokens, get_trending_tokens, get_new_tokens, get_graduated_tokens, ' +
				'get_king_of_the_hill), on-chain analysis (get_bonding_curve, get_token_holders, ' +
				'get_token_details, get_token_trades), creator intelligence (get_creator_profile, ' +
				'pumpfun_list_claims, pumpfun_watch_claims, pumpfun_first_claims), Solana Name ' +
				'Service (sns_resolve, sns_reverseLookup), market signals (' +
				'kol_leaderboard, pumpfun_quote_swap, pumpfun_watch_whales, pumpfun_bot_status), ' +
				'and social sentiment (social_cashtag_sentiment, social_x_post_impact). All data ' +
				'is live and on-chain; no API keys required.',
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;

		// Native composed tools run in-process (they orchestrate backend reads).
		if (native.handlers.has(name)) {
			try {
				const data = await native.handlers.get(name)(args || {});
				return {
					content: [{ type: 'text', text: JSON.stringify(data) }],
					structuredContent: data,
				};
			} catch (err) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: `[${err.rpcCode ?? -32603}] ${err.message || 'tool error'}`,
						},
					],
				};
			}
		}

		let env;
		try {
			env = await callBackend('tools/call', { name, arguments: args || {} });
		} catch (err) {
			return {
				isError: true,
				content: [{ type: 'text', text: `Backend request failed: ${err.message}` }],
			};
		}

		// A JSON-RPC error envelope (unknown tool, invalid arg, indexer
		// unavailable, on-chain read failure) becomes an MCP tool error so the
		// client sees the real failure instead of a silent empty result.
		if (env?.error) {
			return {
				isError: true,
				content: [
					{
						type: 'text',
						text: `[${env.error.code}] ${env.error.message || 'tool error'}`,
					},
				],
			};
		}

		const result = env?.result;
		if (result?.content) {
			// Backend already returns MCP content + structuredContent — pass through.
			return {
				content: result.content,
				...(result.structuredContent !== undefined
					? { structuredContent: result.structuredContent }
					: {}),
			};
		}

		// Defensive: a well-formed-but-shapeless result still gets surfaced as text.
		return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
	});

	server.threeWsToolCount = tools.length;
	return server;
}

async function main() {
	const server = await buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(
		`[pumpfun-mcp] ${SERVER_NAME} v${SERVER_VERSION} ready with ${server.threeWsToolCount} tools via ${backendUrl()}\n`,
	);
}

// Connect stdio ONLY when this file is the process entry point. Importing the
// module (tests, embedding) must not grab the transport or the process's stdin
// and stdout. realpath both sides: npm bin shims are symlinks, so argv[1] may
// differ from import.meta.url.
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
		process.stderr.write(`[pumpfun-mcp] fatal: ${err?.stack || err}\n`);
		process.exit(1);
	});
}
