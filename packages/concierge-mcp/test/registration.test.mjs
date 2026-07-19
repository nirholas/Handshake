// Tool-surface invariants for @three-ws/concierge-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no key.
// These tests run offline, they never touch the network.
//
// Run: node --test packages/concierge-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, buildServer } from '../src/index.js';

const EXPECTED_NAMES = ['concierge_ask', 'concierge_embed', 'concierge_avatars'];

test('exactly the expected tools are registered', () => {
	assert.equal(TOOLS.length, 3);
	assert.deepEqual(new Set(TOOLS.map((t) => t.name)), new Set(EXPECTED_NAMES));
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

test('concierge_ask requires a question and is read-only + open-world', () => {
	const tool = TOOLS.find((t) => t.name === 'concierge_ask');
	assert.ok(tool);
	assert.equal(tool.annotations.readOnlyHint, true);
	assert.equal(tool.annotations.openWorldHint, true);
	assert.ok(tool.inputSchema.question, 'concierge_ask must accept a question');
	assert.match(tool.description, /grounded/i);
});

test('concierge_embed is a pure offline generator (idempotent, not open-world)', () => {
	const tool = TOOLS.find((t) => t.name === 'concierge_embed');
	assert.ok(tool);
	assert.equal(tool.annotations.readOnlyHint, true);
	assert.equal(tool.annotations.idempotentHint, true);
	assert.equal(tool.annotations.openWorldHint, false);
	assert.match(tool.description, /embed|snippet|<script>/i);
});

test('concierge_avatars is a pure offline lister', () => {
	const tool = TOOLS.find((t) => t.name === 'concierge_avatars');
	assert.ok(tool);
	assert.equal(tool.annotations.readOnlyHint, true);
	assert.equal(tool.annotations.idempotentHint, true);
	assert.equal(tool.annotations.openWorldHint, false);
});

test('no read-only tool sets destructiveHint (it is meaningless for reads)', () => {
	for (const tool of TOOLS) {
		assert.equal(
			Object.prototype.hasOwnProperty.call(tool.annotations, 'destructiveHint'),
			false,
			`${tool.name} is read-only, destructiveHint must not be set`,
		);
	}
});

test('buildServer registers every tool with its annotations', () => {
	const server = buildServer();
	const registered = server._registeredTools;
	assert.ok(registered, 'McpServer should expose its tool registry');
	for (const tool of TOOLS) {
		const entry = registered[tool.name];
		assert.ok(entry, `${tool.name} not registered on the server`);
		assert.deepEqual(entry.annotations, tool.annotations, `${tool.name} annotations must survive registration`);
	}
});

test('concierge_avatars executes offline and returns the catalog', async () => {
	const tool = TOOLS.find((t) => t.name === 'concierge_avatars');
	const result = await tool.handler({});
	assert.equal(result.ok, true);
	assert.ok(Array.isArray(result.avatars) && result.avatars.length >= 5);
	assert.ok(result.avatars.every((a) => a.id && a.name && a.tagline));
	assert.ok(result.avatars.some((a) => a.id === result.default));
});
