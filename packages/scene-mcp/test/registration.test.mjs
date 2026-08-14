// Tool-surface invariants for @three-ws/scene-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only
// connects when the file is the process entry point, and buildServer() needs
// no key or signer. These tests run offline; they never touch the network.
//
// Run: node --test packages/scene-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, buildServer } from '../src/index.js';

const READ_ONLY_TOOLS = new Set(['get_scene', 'list_scenes']);

test('exactly the expected tools are registered', () => {
	assert.equal(TOOLS.length, 5);
	assert.deepEqual(
		new Set(TOOLS.map((t) => t.name)),
		new Set(['compose_scene', 'get_scene', 'list_scenes', 'export_scene', 'build_world']),
	);
});

test('every tool has a title, description, input schema and complete annotations', () => {
	for (const tool of TOOLS) {
		assert.equal(typeof tool.title, 'string', `${tool.name} is missing a title`);
		assert.ok(tool.title.length > 0, `${tool.name} has an empty title`);
		assert.equal(typeof tool.description, 'string', `${tool.name} is missing a description`);
		assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name} is missing inputSchema`);
		assert.equal(typeof tool.handler, 'function', `${tool.name} is missing a handler`);
		assert.ok(tool.annotations, `${tool.name} is missing MCP ToolAnnotations`);
		assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} must set readOnlyHint`);
		assert.equal(typeof tool.annotations.idempotentHint, 'boolean', `${tool.name} must set idempotentHint`);
		assert.equal(typeof tool.annotations.openWorldHint, 'boolean', `${tool.name} must set openWorldHint`);
	}
});

test('non-read-only tools set destructiveHint explicitly (spec default is TRUE when omitted)', () => {
	for (const tool of TOOLS) {
		if (tool.annotations.readOnlyHint === false) {
			assert.equal(
				typeof tool.annotations.destructiveHint,
				'boolean',
				`${tool.name} is not read-only; destructiveHint must be explicit`,
			);
		}
	}
});

test('the read tools advertise readOnlyHint and openWorldHint', () => {
	for (const name of READ_ONLY_TOOLS) {
		const tool = TOOLS.find((t) => t.name === name);
		assert.ok(tool, `${name} must exist in the tool registry`);
		assert.equal(tool.annotations.readOnlyHint, true, `${name} should be read-only`);
		assert.equal(tool.annotations.openWorldHint, true, `${name} talks to a live service`);
	}
});

test('compose_scene is generative (not read-only) but non-destructive', () => {
	const compose = TOOLS.find((t) => t.name === 'compose_scene');
	assert.equal(compose.annotations.readOnlyHint, false);
	assert.equal(compose.annotations.destructiveHint, false);
	assert.equal(compose.annotations.openWorldHint, true);
});

test('export_scene and build_world are generative (not read-only) but non-destructive', () => {
	for (const name of ['export_scene', 'build_world']) {
		const tool = TOOLS.find((t) => t.name === name);
		assert.ok(tool, `${name} must exist in the tool registry`);
		assert.equal(tool.annotations.readOnlyHint, false);
		assert.equal(tool.annotations.destructiveHint, false);
		assert.equal(tool.annotations.openWorldHint, true);
	}
});

test('buildServer registers every tool with its annotations, without a signer', () => {
	const server = buildServer();
	const registered = server._registeredTools;
	assert.ok(registered, 'McpServer should expose its tool registry');
	for (const tool of TOOLS) {
		const entry = registered[tool.name];
		assert.ok(entry, `${tool.name} not registered on the server`);
		assert.deepEqual(entry.annotations, tool.annotations, `${tool.name} annotations must survive registration`);
	}
});
