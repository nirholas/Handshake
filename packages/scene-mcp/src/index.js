#!/usr/bin/env node
// @three-ws/scene-mcp: MCP server entry point.
//
// Gives any AI assistant the three.ws diorama pipeline over stdio:
//   • compose_scene: one sentence → a placed 3D diorama plan (LLM-composed)
//   • get_scene:     fetch a saved world by id
//   • list_scenes:   browse the recent / featured gallery
//   • export_scene:  merge an already-forged diorama into one GLB scene
//   • build_world:   one sentence → a fully forged, exported world (no browser)
//
// A thin wrapper over the PUBLIC three.ws API (/api/diorama). No keys, no
// signer, no payment: point THREE_WS_BASE at a deployment and go.
//
// Run standalone:
//   node packages/scene-mcp/src/index.js
//
// Or wire into Claude Code / Cursor (see README.md).

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as composeScene } from './tools/compose-scene.js';
import { def as getScene } from './tools/get-scene.js';
import { def as listScenes } from './tools/list-scenes.js';
import { def as exportScene } from './tools/export-scene.js';
import { def as buildWorld } from './tools/build-world.js';

// Single source of truth for the advertised server version: package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [composeScene, getScene, listScenes, exportScene, buildWorld];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'scene-mcp', title: 'three.ws Scenes', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Scene MCP: speak 3D worlds into being. compose_scene turns one short sentence ' +
				'into a diorama PLAN (title, mood, palette, ground, and 2-8 placed single-object forge prompts) ' +
				'using the platform free-first LLM chain; nothing is saved and no meshes are forged yet. ' +
				'get_scene fetches a previously saved world by id (with GLB URLs and an orbitable viewer link). ' +
				'list_scenes browses the recent or featured gallery. export_scene merges an already-forged ' +
				'diorama into ONE glTF 2.0 binary (every object a named, selectable node, plus a real ground ' +
				'disc and mood-tuned lighting), ready to open in Scene Studio. build_world runs the whole ' +
				'pipeline (compose → forge every object → export) server-side from one sentence, for callers ' +
				'with no browser to drive the progressive flow; it can take a couple of minutes. All data comes ' +
				'live from the public three.ws /api/diorama endpoint; no API key, signer, or payment required.',
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
	console.error(`[scene-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
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
		console.error('[scene-mcp] fatal:', err);
		process.exit(1);
	});
}
