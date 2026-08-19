// Tool-surface invariants for @three-ws/metaplex-agent-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no signer.
// These tests run offline: they never touch the network or sign anything.
//
// Run: node --test packages/metaplex-agent-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, buildServer } from '../src/index.js';

const READ_ONLY_TOOLS = new Set([
	'prepare_agent_mint',
	'get_onchain_agent',
	'agent_wallet',
	'build_registration',
	'list_onchain_agents',
	'three_status',
]);
const EXECUTION_TOOLS = new Set(['mint_onchain_agent', 'send_signed_transaction', 'register_agent_identity']);

test('exactly the expected tools are registered', () => {
	assert.equal(TOOLS.length, 9);
	assert.deepEqual(new Set(TOOLS.map((t) => t.name)), new Set([...READ_ONLY_TOOLS, ...EXECUTION_TOOLS]));
});

test('every tool has a title, description, input schema and complete annotations', () => {
	for (const tool of TOOLS) {
		assert.equal(typeof tool.title, 'string', `${tool.name} is missing a title`);
		assert.ok(tool.title.length > 0, `${tool.name} has an empty title`);
		assert.equal(typeof tool.description, 'string', `${tool.name} is missing a description`);
		assert.ok(tool.description.length >= 20, `${tool.name} has a thin description`);
		assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name} is missing inputSchema`);
		assert.equal(typeof tool.handler, 'function', `${tool.name} is missing a handler`);
		assert.ok(tool.annotations, `${tool.name} is missing MCP ToolAnnotations`);
		assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} must set readOnlyHint`);
		assert.equal(typeof tool.annotations.idempotentHint, 'boolean', `${tool.name} must set idempotentHint`);
		assert.equal(typeof tool.annotations.openWorldHint, 'boolean', `${tool.name} must set openWorldHint`);
	}
});

test('the read tools advertise readOnlyHint', () => {
	for (const name of READ_ONLY_TOOLS) {
		const tool = TOOLS.find((t) => t.name === name);
		assert.ok(tool, `${name} must exist`);
		assert.equal(tool.annotations.readOnlyHint, true, `${name} should be read-only`);
	}
});

test('the execution tools spend SOL and say so', () => {
	const destructive = TOOLS.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name);
	assert.deepEqual(new Set(destructive), EXECUTION_TOOLS);
	for (const name of EXECUTION_TOOLS) {
		const tool = TOOLS.find((t) => t.name === name);
		assert.equal(tool.annotations.readOnlyHint, false, `${name} must not claim read-only`);
	}
});

test('non-read-only tools set destructiveHint explicitly (spec default is TRUE when omitted)', () => {
	for (const tool of TOOLS) {
		if (tool.annotations.readOnlyHint === false) {
			assert.equal(typeof tool.annotations.destructiveHint, 'boolean', `${tool.name} must set destructiveHint`);
		}
	}
});

test('build_registration is the only offline tool', () => {
	for (const tool of TOOLS) {
		const expectOpenWorld = tool.name !== 'build_registration';
		assert.equal(tool.annotations.openWorldHint, expectOpenWorld, `${tool.name} openWorldHint`);
	}
});

test('buildServer registers without env or network', () => {
	const server = buildServer();
	assert.ok(server, 'buildServer must return a server');
});
