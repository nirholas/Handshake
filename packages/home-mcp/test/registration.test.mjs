// Tool-surface invariants for @three-ws/home-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no house.
// These tests run offline and never open a socket.
//
// Run: node --test packages/home-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, INSTRUCTIONS, buildServer } from '../src/index.js';

const EXPECTED = {
	home_overview: { write: false },
	list_entities: { write: false },
	list_macros: { write: false },
	call_service: { write: true },
	run_macro: { write: true },
};

test('exactly the expected tools are registered', () => {
	assert.equal(TOOLS.length, Object.keys(EXPECTED).length);
	assert.deepEqual(new Set(TOOLS.map((t) => t.name)), new Set(Object.keys(EXPECTED)));
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

test('the read tools are marked read-only and the write tools are not', () => {
	for (const tool of TOOLS) {
		const expected = EXPECTED[tool.name];
		assert.equal(tool.annotations.readOnlyHint, !expected.write, `${tool.name} readOnlyHint is wrong`);
		assert.equal(tool.annotations.openWorldHint, true, `${tool.name} talks to a live house`);
		if (expected.write) {
			assert.equal(tool.annotations.destructiveHint, true, `${tool.name} moves a physical object`);
		} else {
			// The spec ignores destructiveHint when readOnlyHint is true.
			assert.equal(tool.annotations.destructiveHint, undefined, `${tool.name} is read-only`);
		}
	}
});

test('no tool takes a confirmation argument, on any transport', () => {
	// The gate decision in src/lib/gate.js: `confirmed: true` is a human saying
	// yes, and this transport has no human in it. A schema that accepted one
	// would be model output wearing a person's clothes.
	for (const tool of TOOLS) {
		for (const key of Object.keys(tool.inputSchema)) {
			assert.ok(
				!/^confirm/i.test(key),
				`${tool.name} must not expose a confirmation argument, and exposes "${key}"`,
			);
		}
	}
});

test('the server instructions state the gate, so a client cannot claim it was not told', () => {
	assert.match(INSTRUCTIONS, /refused/i);
	assert.match(INSTRUCTIONS, /no argument overrides/i);
	assert.match(INSTRUCTIONS, /untrusted data/i);
});

test('buildServer registers every tool with its annotations, without a house', () => {
	const server = buildServer();
	const registered = server._registeredTools;
	assert.ok(registered, 'McpServer should expose its tool registry');
	for (const tool of TOOLS) {
		const entry = registered[tool.name];
		assert.ok(entry, `${tool.name} not registered on the server`);
		assert.deepEqual(entry.annotations, tool.annotations, `${tool.name} annotations must survive registration`);
	}
});
