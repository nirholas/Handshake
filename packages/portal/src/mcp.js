#!/usr/bin/env node
// Portal MCP: let an agent walk a website.
//
// An agent that fetches a page gets a wall of text. This server gives it the
// page's SHAPE instead: how many districts it has, which sections are the tall
// ones, where the doors lead, and a link a human can walk. That turns "read
// this site" into something an agent can summarize spatially and hand back as a
// place, which is the whole point of three.ws.
//
// Tools
//   walk_site    build the world for a URL and return its structure + links
//   site_shape   the layout only (no links, no images): a cheap structural read
//
// Run it standalone:
//   npx -y @three-ws/portal-mcp        (or: node packages/portal/src/mcp.js)
//
// Wire it into Claude Code:
//   claude mcp add portal -- npx -y @three-ws/portal portal-mcp
//
// No key, no account. It reads the public three.ws Portal API; point it
// somewhere else with PORTAL_API=https://your-host/api/portal.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { fetchWorld, fetchOutline, describeWorld, PORTAL_API, PORTAL_PAGE, PortalError } from './index.js';

const endpoint = process.env.PORTAL_API || PORTAL_API;
const page = process.env.PORTAL_PAGE || PORTAL_PAGE;

/** One shape for every tool result, so a host never has to guess. */
function ok(summary, extra = {}) {
	const structuredContent = {
		...summary,
		walk_url: `${page}?url=${encodeURIComponent(summary.source)}`,
		glb_url: `${endpoint}?url=${encodeURIComponent(summary.source)}&format=glb`,
		...extra,
	};
	return {
		content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
		structuredContent,
	};
}

function fail(err) {
	const code = err instanceof PortalError ? err.code : 'portal_error';
	const message = err?.message || 'Portal could not build that world.';
	return {
		content: [{ type: 'text', text: `${code}: ${message}` }],
		structuredContent: { error: code, error_description: message },
		isError: true,
	};
}

export function createServer() {
	const server = new McpServer({ name: 'three-ws-portal', version: '0.1.0' });

	server.registerTool(
		'walk_site',
		{
			title: 'Walk a website in 3D',
			description:
				'Turn any public web page into a walkable 3D world and return its structure: districts (one per section, sized by how much it says), doors (one per link), billboards (one per image), plus a link a human can walk and a GLB download. Honours robots.txt and reads each page once, cached for an hour.',
			inputSchema: {
				url: z.string().min(3).describe('The page to explore, e.g. "example.com" or "https://example.com/docs".'),
				include_links: z.boolean().optional().describe('Include every door target (default true).'),
			},
		},
		async ({ url, include_links = true }) => {
			try {
				const { world, cached } = await fetchWorld(url, { endpoint, include: 'world' });
				const summary = describeWorld(world);
				return ok(
					{ source: url, cached, ...summary },
					include_links
						? {
								doors_detail: world.doors.map((d) => ({ label: d.label, href: d.href, internal: d.internal })),
							}
						: {},
				);
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		'site_shape',
		{
			title: 'Read a page as structure',
			description:
				'The cheap read: a page reduced to its heading spine with the weight of each section (words, paragraphs, code blocks, links, images). No world, no links list. Use it to compare pages, find the thin sections of a site, or decide what to read in full.',
			inputSchema: {
				url: z.string().min(3).describe('The page to read.'),
			},
		},
		async ({ url }) => {
			try {
				const { outline, cached } = await fetchOutline(url, { endpoint });
				return ok({
					source: url,
					cached,
					host: outline.host,
					title: outline.title,
					description: outline.description,
					words: outline.words,
					sections: outline.sections.map((s) => ({
						heading: s.heading,
						level: s.level,
						words: s.words,
						paragraphs: s.paragraphs,
						code_blocks: s.codeBlocks,
						links: s.links.length,
						images: s.images.length,
						summary: s.summary,
					})),
				});
			} catch (err) {
				return fail(err);
			}
		},
	);

	return server;
}

async function main() {
	const server = createServer();
	await server.connect(new StdioServerTransport());
}

// Only run when executed directly, so importing this module in a test or in a
// host that mounts the server itself does not open stdio.
const invokedDirectly = (() => {
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '')).href;
	} catch {
		return false;
	}
})();
if (invokedDirectly) {
	main().catch((err) => {
		process.stderr.write(`portal-mcp failed to start: ${err?.message || err}\n`);
		process.exit(1);
	});
}
