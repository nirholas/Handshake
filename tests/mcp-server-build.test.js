import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Core-path coverage for the published @three-ws/mcp-server main export.
//
// mcp-server-annotations.test.js asserts on buildTools() (the descriptor list).
// This file asserts on buildServer(), the export the `3d-agent-mcp` bin
// actually boots, by connecting a real MCP Client over an in-memory transport
// pair and driving the same tools/list, resources/list, and resources/read
// round-trips a Claude Desktop or Cursor client makes. No stubs: it is the real
// McpServer with every tool registered, minus only the stdio pipe.
//
// It also pins the README to the registered tool surface. Six tools
// (forge_avatar, refine_model, restyle_material, vanity_premium,
// agent_hire_discover, agent_hire) shipped registered but undocumented, which
// is invisible to every other check in the repo, the catalog builder reads the
// source, not the README.
import { buildServer, buildTools } from '../mcp-server/src/index.js';
import {
	UI_RESOURCE_URI,
	UI_MIME_TYPE,
	UI_RESOURCE_META,
} from '../mcp-server/src/commerce-ui.js';

const PKG = JSON.parse(
	readFileSync(fileURLToPath(new URL('../mcp-server/package.json', import.meta.url)), 'utf8'),
);
const README = readFileSync(
	fileURLToPath(new URL('../mcp-server/README.md', import.meta.url)),
	'utf8',
);

// Pinned literally: the URI is a wire contract with hosts that cached it, so a
// rename must fail here rather than silently follow the module constant.
const RECEIPT_URI = 'ui://three-ws-commerce/hire-receipt.html';

let client;
let descriptors;
let listed;

beforeAll(async () => {
	descriptors = await buildTools();
	const server = await buildServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: 'mcp-server-build-test', version: '1.0.0' });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	listed = (await client.listTools()).tools;
}, 60_000);

afterAll(async () => {
	await client?.close();
});

describe('buildServer(), the published stdio entry point', () => {
	it('advertises the package version and the 3d-agent-mcp identity', () => {
		expect(client.getServerVersion()).toEqual({
			name: '3d-agent-mcp',
			version: PKG.version,
		});
	});

	it('declares both the tools and resources capabilities', () => {
		const caps = client.getServerCapabilities();
		expect(caps).toMatchObject({ tools: {}, resources: {} });
		// No logging API is shipped, so the capability must stay undeclared.
		expect(caps.logging).toBeUndefined();
	});

	it('ships instructions that orient a client with no prior context', () => {
		const instructions = client.getInstructions();
		expect(instructions).toBeTruthy();
		expect(instructions).toContain('forge_free');
	});

	it('registers every built tool over the wire, with no extras', () => {
		expect(listed.map((t) => t.name).sort()).toEqual(descriptors.map((t) => t.name).sort());
	});

	it('serves each tool with a title, description, and object input schema', () => {
		for (const tool of listed) {
			expect(tool.title, `${tool.name} title`).toBeTruthy();
			expect(tool.description, `${tool.name} description`).toBeTruthy();
			expect(tool.inputSchema?.type, `${tool.name} inputSchema`).toBe('object');
		}
	});

	it('exposes the agent_hire provenance receipt as a readable UI resource', async () => {
		expect(UI_RESOURCE_URI).toBe(RECEIPT_URI);
		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri)).toContain(RECEIPT_URI);

		const { contents } = await client.readResource({ uri: RECEIPT_URI });
		expect(contents).toHaveLength(1);
		expect(contents[0].mimeType).toBe(UI_MIME_TYPE);
		expect(contents[0]._meta).toEqual(UI_RESOURCE_META);
		// The real built card, not a placeholder: doctype plus the inlined bundle.
		expect(contents[0].text.startsWith('<!doctype html>')).toBe(true);
		expect(contents[0].text).toContain('<script>');
	});

	it('links agent_hire to that resource through tool _meta', () => {
		const hire = listed.find((t) => t.name === 'agent_hire');
		expect(hire?._meta?.['openai/outputTemplate'] ?? hire?._meta?.ui?.resourceUri).toBe(
			RECEIPT_URI,
		);
	});
});

describe('README documents the registered tool surface', () => {
	it('gives every tool a table row', () => {
		const documented = new Set(
			[...README.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1]),
		);
		const missing = descriptors.map((t) => t.name).filter((name) => !documented.has(name));
		expect(missing).toEqual([]);
	});

	it('quotes a price for every documented tool row', () => {
		const rows = [...README.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|([^|]*)\|/gm)];
		const names = new Set(descriptors.map((t) => t.name));
		const unpriced = rows
			.filter(([, name]) => names.has(name))
			.filter(([, , price]) => !/\$|free/i.test(price))
			.map(([, name]) => name);
		expect(unpriced).toEqual([]);
	});
});
