#!/usr/bin/env node
// @three-ws/blender-mcp: MCP server entry point.
//
// Gives any AI assistant a local Blender over stdio:
//   • blender_info:          what this Blender build is and can do
//   • blender_scene_info:    read a 3D file and describe what is inside it
//   • blender_convert:       import one format, export another
//   • blender_render:        render a still preview, auto-framed and auto-lit
//   • blender_run_python:    run a bpy script against a scene
//   • blender_forge_import:  three.ws text-to-3D, brought into Blender
//
// Blender runs headless (`blender -b`), one process per call, so this works on
// a server, in CI, and in a container. Nothing is mocked: every tool drives the
// real Blender on this machine, and blender_forge_import calls the live public
// three.ws Forge pipeline.
//
// Run standalone:
//   node packages/blender-mcp/src/index.js
//
// Or wire into Claude Code / Cursor (see README.md).

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ALLOW_PYTHON } from './config.js';
import { def as blenderInfo } from './tools/info.js';
import { def as sceneInfo } from './tools/scene-info.js';
import { def as convert } from './tools/convert.js';
import { def as render } from './tools/render.js';
import { def as runPython } from './tools/run-python.js';
import { def as forgeImport } from './tools/forge-import.js';

// Single source of truth for the advertised server version: package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

// blender_run_python executes caller-supplied code. It is advertised by default
// because scripted scene edits are most of what an agent needs Blender for, and
// withdrawn entirely when BLENDER_MCP_ALLOW_PYTHON=0.
export const TOOLS = [blenderInfo, sceneInfo, convert, render, forgeImport, ...(ALLOW_PYTHON ? [runPython] : [])];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration touches neither Blender nor the network, so this is safe to
 * import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'blender-mcp', title: 'three.ws Blender', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Blender MCP: drive the Blender install on THIS machine, headless. blender_info reports the ' +
				'executable, version, render engines, and supported formats, and is the right first call when anything ' +
				'fails. blender_scene_info opens a 3D file and describes it (objects, evaluated triangle counts, ' +
				'materials, armature bones, animations, world bounds). blender_convert bridges formats in both ' +
				'directions (.glb .gltf .fbx .obj .stl .ply .dae .abc .usd .x3d .blend), applying modifiers and an ' +
				'optional unit scale. blender_render produces a still PNG, adding a framed camera and a key light when ' +
				'the file has none, so a bare asset previews with no setup. blender_run_python runs a bpy script for ' +
				'edits the other tools do not cover and can export the result in the same call. blender_forge_import ' +
				'generates a model from a text prompt on the free public three.ws Forge lane and brings it in. Blender ' +
				'must be installed locally (3.0+); set BLENDER_PATH if it is not on PATH.',
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
					// A tool may return extra MCP content blocks alongside its JSON
					// payload. blender_render uses this to hand back the rendered
					// image itself, so the caller can SEE the model in the same call
					// instead of needing filesystem access it may not have.
					const attachments = tool.attachments ? await tool.attachments(result) : [];
					return { content: [{ type: 'text', text }, ...attachments] };
				} catch (err) {
					const payload = {
						ok: false,
						error: err?.code || 'unhandled',
						message: err?.message || String(err),
						...(err?.status ? { status: err.status } : {}),
						...(err?.diagnostics ? { diagnostics: err.diagnostics } : {}),
						...(err?.traceback ? { traceback: err.traceback } : {}),
						...(err?.log ? { blender_log: err.log } : {}),
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
	console.error(`[blender-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
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
		console.error('[blender-mcp] fatal:', err);
		process.exit(1);
	});
}
