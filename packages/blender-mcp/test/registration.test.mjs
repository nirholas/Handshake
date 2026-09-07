// Tool-surface invariants for @three-ws/blender-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() neither launches
// Blender nor touches the network. These tests run offline and pass on a
// machine with no Blender installed.
//
// Run: node --test packages/blender-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS, buildServer } from '../src/index.js';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const READ_ONLY_TOOLS = new Set(['blender_info', 'blender_scene_info']);

test('exactly the expected tools are registered', () => {
	assert.deepEqual(
		new Set(TOOLS.map((t) => t.name)),
		new Set([
			'blender_info',
			'blender_scene_info',
			'blender_convert',
			'blender_render',
			'blender_forge_import',
			'blender_run_python',
		]),
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

test('the read tools advertise readOnlyHint and stay inside the machine', () => {
	for (const name of READ_ONLY_TOOLS) {
		const tool = TOOLS.find((t) => t.name === name);
		assert.ok(tool, `${name} must exist in the tool registry`);
		assert.equal(tool.annotations.readOnlyHint, true, `${name} should be read-only`);
		assert.equal(tool.annotations.openWorldHint, false, `${name} only drives the local Blender`);
	}
});

test('blender_run_python is the only tool flagged destructive', () => {
	const destructive = TOOLS.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name);
	assert.deepEqual(destructive, ['blender_run_python']);
});

test('blender_forge_import is the only tool that reaches the network', () => {
	const openWorld = TOOLS.filter((t) => t.annotations.openWorldHint === true).map((t) => t.name);
	assert.deepEqual(openWorld, ['blender_forge_import']);
});

test('BLENDER_MCP_ALLOW_PYTHON=0 withdraws the script tool', () => {
	// The gate is read at module load, so it has to be checked in a fresh
	// process: an ESM cache-buster on index.js would still reuse config.js.
	const child = spawnSync(
		process.execPath,
		['--input-type=module', '-e', "import('./src/index.js').then((m) => console.log(m.TOOLS.map((t) => t.name).join(',')))"],
		{ cwd: PACKAGE_ROOT, env: { ...process.env, BLENDER_MCP_ALLOW_PYTHON: '0' }, encoding: 'utf8' },
	);
	assert.equal(child.status, 0, child.stderr);
	const names = child.stdout.trim().split(',');
	assert.ok(!names.includes('blender_run_python'), 'blender_run_python must not be advertised when the gate is off');
	assert.equal(names.length, 5);
});

test('buildServer registers without Blender or network access', () => {
	const server = buildServer();
	assert.ok(server, 'buildServer() must return an McpServer');
});
