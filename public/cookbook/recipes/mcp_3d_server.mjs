#!/usr/bin/env node
/**
 * An MCP server that gives any MCP client a text-to-3D tool.
 *
 * Wraps the free, keyless three.ws 3D API as two Model Context Protocol tools,
 * so Claude Code, Claude Desktop, Cursor, or any other MCP client can generate
 * real GLB models mid-conversation. No API key, no account.
 *
 *   npm install @modelcontextprotocol/sdk zod
 *   node mcp_3d_server.mjs            # speaks MCP over stdio
 *
 * Register it with Claude Code:
 *
 *   claude mcp add three-ws-3d -- node /absolute/path/to/mcp_3d_server.mjs
 *
 * Or add it to a client's config by hand:
 *
 *   { "mcpServers": { "three-ws-3d": { "command": "node",
 *       "args": ["/absolute/path/to/mcp_3d_server.mjs"] } } }
 *
 * Recipe: https://three.ws/cookbook/mcp-3d-tool
 * API reference: https://three.ws/docs/3d-api
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GENERATE_API = 'https://three.ws/api/3d/generate';
const RENDER_API = 'https://three.ws/api/render/glb';
const USER_AGENT = 'three.ws-cookbook/mcp_3d_server';

// The free lane is a shared GPU pool. These bounds only ever clamp a server
// hint that is missing or absurd; the server's own retryAfter wins inside them.
const MIN_POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pollDelay(payload) {
	const seconds = Number(payload?.retryAfter);
	if (!Number.isFinite(seconds)) return MIN_POLL_MS;
	return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, seconds * 1000));
}

async function callJson(url, body) {
	const res = await fetch(url, {
		method: body ? 'POST' : 'GET',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json',
			'user-agent': USER_AGENT,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
	}
	if (!res.ok) {
		throw new Error(
			`HTTP ${res.status} from ${url}: ${payload.error_description || payload.error || text.slice(0, 200)}`,
		);
	}
	return payload;
}

/**
 * Generate one model. The API answers inline when the draft finishes fast and
 * hands back a job handle when the lane is busy; both paths end at the same
 * `{ status: 'done', glbUrl, viewerUrl, arUrl }` shape.
 */
async function generate(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const startedAt = Date.now();
	let payload = await callJson(GENERATE_API, { prompt, format: 'glb' });

	while (payload.status === 'pending') {
		if (!payload.job) throw new Error("the API reported 'pending' without a job handle");
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`gave up after ${Math.round((Date.now() - startedAt) / 1000)}s`);
		}
		await sleep(pollDelay(payload));
		const query = new URLSearchParams({ job: payload.job, title: prompt });
		payload = await callJson(`${GENERATE_API}?${query}`);
	}

	if (payload.status === 'error') throw new Error(payload.error || 'the generation lane failed');
	if (!payload.glbUrl) throw new Error(`unexpected response: ${JSON.stringify(payload).slice(0, 200)}`);
	return payload;
}

const server = new McpServer(
	{ name: 'three-ws-3d', version: '1.0.0' },
	{ instructions: 'Generate real 3D models (GLB) from text prompts. Free and keyless.' },
);

server.registerTool(
	'generate_3d_model',
	{
		title: 'Text to 3D model',
		description:
			'Turn a text prompt into a real, textured 3D model (GLB) and return its URL. ' +
			'Free draft tier: single-subject prompts work best ("a wooden treasure chest"), ' +
			'no rigging. Takes roughly 60 to 120 seconds.',
		inputSchema: {
			prompt: z
				.string()
				.min(3)
				.max(1000)
				.describe('What to build. One subject, described concretely.'),
		},
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
	},
	async ({ prompt }) => {
		const result = await generate(prompt);
		return {
			content: [
				{
					type: 'text',
					text: [
						`Generated "${prompt}"`,
						`GLB: ${result.glbUrl}`,
						result.viewerUrl ? `Viewer: ${result.viewerUrl}` : '',
						result.arUrl ? `AR (open on a phone): ${result.arUrl}` : '',
					]
						.filter(Boolean)
						.join('\n'),
				},
			],
			structuredContent: {
				glbUrl: result.glbUrl,
				viewerUrl: result.viewerUrl ?? '',
				arUrl: result.arUrl ?? '',
				tier: result.tier ?? 'draft',
			},
		};
	},
);

server.registerTool(
	'render_3d_model',
	{
		title: 'Render a 3D model to an image',
		description:
			'Render any public GLB URL to a PNG still, returned inline as an image. ' +
			'Use it to look at a model you just generated before showing it to the user.',
		inputSchema: {
			glbUrl: z.string().url().describe('A public URL to a .glb file.'),
			size: z.number().int().min(256).max(2048).default(1024).describe('Square pixel size.'),
		},
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
	},
	async ({ glbUrl, size }) => {
		const res = await fetch(RENDER_API, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'image/png',
				'user-agent': USER_AGENT,
			},
			body: JSON.stringify({ glbUrl, width: size, height: size }),
		});
		const contentType = res.headers.get('content-type') ?? '';
		if (!res.ok || !contentType.startsWith('image/')) {
			const detail = (await res.text()).slice(0, 200);
			throw new Error(`renderer returned HTTP ${res.status} ${contentType}: ${detail}`);
		}
		const bytes = Buffer.from(await res.arrayBuffer());
		return {
			content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
		};
	},
);

await server.connect(new StdioServerTransport());
