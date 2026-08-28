// Tool-surface invariants for @three-ws/herald-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no
// credential to advertise the tool surface. These tests run offline: they never
// touch the network.
//
// Run: node --test packages/herald-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, buildServer } from '../src/index.js';

const EXPECTED_NAMES = ['announce', 'announce_result', 'check_rail'];
// Anything that queues a real interruption is a write.
const WRITE_NAMES = new Set(['announce', 'announce_result']);

test('registers exactly the advertised tools', () => {
	assert.deepEqual(
		TOOLS.map((t) => t.name),
		EXPECTED_NAMES,
	);
});

test('every tool carries a title, a description and a schema', () => {
	for (const tool of TOOLS) {
		assert.ok(tool.title, `${tool.name} needs a title`);
		assert.ok(tool.description?.length > 80, `${tool.name} needs a real description`);
		assert.equal(typeof tool.inputSchema, 'object', `${tool.name} needs an input schema`);
		assert.equal(typeof tool.handler, 'function', `${tool.name} needs a handler`);
	}
});

test('write tools never claim to be read-only, and the probe does', () => {
	for (const tool of TOOLS) {
		const readOnly = tool.annotations?.readOnlyHint === true;
		if (WRITE_NAMES.has(tool.name)) {
			assert.equal(readOnly, false, `${tool.name} queues a real interruption`);
		} else {
			assert.equal(readOnly, true, `${tool.name} should be marked read-only`);
		}
	}
});

test('announce constrains the line the way the API does', () => {
	const schema = TOOLS.find((t) => t.name === 'announce').inputSchema;
	assert.equal(schema.text.safeParse('').success, false);
	assert.equal(schema.text.safeParse('x'.repeat(281)).success, false);
	assert.equal(schema.text.safeParse('Deploy is green').success, true);
	assert.equal(schema.importance.safeParse(101).success, false);
	assert.equal(schema.importance.safeParse(80).success, true);
});

test('announce_result only accepts the three outcomes it maps', () => {
	const schema = TOOLS.find((t) => t.name === 'announce_result').inputSchema;
	for (const outcome of ['succeeded', 'failed', 'needs_input']) {
		assert.equal(schema.outcome.safeParse(outcome).success, true);
	}
	assert.equal(schema.outcome.safeParse('maybe').success, false);
});

test('buildServer constructs without a credential', () => {
	assert.ok(buildServer());
});
