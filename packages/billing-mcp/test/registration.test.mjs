// Tool-surface invariants for @three-ws/billing-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no session.
// These tests run offline — they never touch the network.
//
// Run: node --test packages/billing-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, buildServer } from '../src/index.js';

const EXPECTED_NAMES = [
	'get_billing_summary',
	'query_usage',
	'export_billing_history',
	'get_receipt',
	'get_fee_info',
];

// This server is read-only by design: it exposes private billing data but never
// signs or moves funds. Adding a write tool? Add it here deliberately, same
// commit, and give it readOnlyHint:false.
const WRITE_TOOLS = new Set();

test('exactly the expected tools are registered', () => {
	assert.equal(TOOLS.length, EXPECTED_NAMES.length);
	assert.deepEqual(new Set(TOOLS.map((t) => t.name)), new Set(EXPECTED_NAMES));
	assert.equal(new Set(TOOLS.map((t) => t.name)).size, EXPECTED_NAMES.length, 'tool names must be unique');
});

test('every tool has a title, description, input schema and complete annotations', () => {
	for (const tool of TOOLS) {
		assert.equal(typeof tool.title, 'string', `${tool.name} is missing a title`);
		assert.ok(tool.title.length > 0, `${tool.name} has an empty title`);
		assert.equal(typeof tool.description, 'string', `${tool.name} is missing a description`);
		assert.ok(tool.description.length > 0, `${tool.name} has an empty description`);
		assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name} is missing inputSchema`);
		assert.equal(typeof tool.handler, 'function', `${tool.name} is missing a handler`);
		assert.ok(tool.annotations, `${tool.name} is missing MCP ToolAnnotations`);
		assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} must set readOnlyHint`);
		assert.equal(typeof tool.annotations.idempotentHint, 'boolean', `${tool.name} must set idempotentHint`);
		assert.equal(typeof tool.annotations.openWorldHint, 'boolean', `${tool.name} must set openWorldHint`);
	}
});

test('every tool is a read-only live query', () => {
	for (const tool of TOOLS) {
		const isWrite = WRITE_TOOLS.has(tool.name);
		assert.equal(tool.annotations.readOnlyHint, !isWrite, `${tool.name} readOnlyHint should be ${!isWrite}`);
		// Everything talks to the live three.ws API; nothing is idempotent — plan
		// usage, invoices, and earnings all move between calls.
		assert.equal(tool.annotations.openWorldHint, true, `${tool.name} talks to a live service`);
		assert.equal(tool.annotations.idempotentHint, false, `${tool.name} is never idempotent`);
	}
});

test('read-only tools omit destructiveHint (spec ignores it when readOnlyHint is true)', () => {
	for (const tool of TOOLS) {
		if (tool.annotations.readOnlyHint === true) {
			assert.equal(
				tool.annotations.destructiveHint,
				undefined,
				`${tool.name} is read-only — destructiveHint should be omitted`,
			);
		}
	}
});

test('no write tools on this server (it never signs or moves funds)', () => {
	assert.equal(WRITE_TOOLS.size, 0, 'billing-mcp is read-only by design');
	for (const tool of TOOLS) {
		assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
	}
});

test('buildServer registers every tool with its annotations, without a session', () => {
	const server = buildServer();
	const registered = server._registeredTools;
	assert.ok(registered, 'McpServer should expose its tool registry');
	for (const tool of TOOLS) {
		const entry = registered[tool.name];
		assert.ok(entry, `${tool.name} not registered on the server`);
		assert.deepEqual(entry.annotations, tool.annotations, `${tool.name} annotations must survive registration`);
	}
});
