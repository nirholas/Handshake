// Entry-point invariants for @three-ws/pumpfun-mcp.
//
// package.json declares src/index.js as BOTH the `bin` and the `main`/`exports`
// entry. Those two roles pull in opposite directions: running it must connect a
// stdio MCP server, and importing it must not. Until this was guarded, the module
// called main() unconditionally, so `import '@three-ws/pumpfun-mcp'` seized the
// process's stdin and stdout and printed a server banner in any host that merely
// read the package's exports.
//
// These tests run offline: importing the module must reach neither the network
// nor the transport.
//
// Run: node --test packages/pumpfun-mcp/test/entrypoint.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { buildServer, FALLBACK_TOOLS, TOOL_ANNOTATIONS } from '../src/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const run = promisify(execFile);
const ENTRY = new URL('../src/index.js', import.meta.url).href;

test('importing the entry point never connects a transport', async () => {
	// A connected StdioServerTransport attaches a stdin reader and keeps the event
	// loop alive forever. Asserted in a CHILD process: this test file has already
	// imported the module, and the test runner touches stdin itself, so only a
	// clean process can answer the question honestly. A regression here does not
	// fail an assertion, it hangs: hence the timeout.
	const { stdout, stderr } = await run(
		process.execPath,
		['-e', `import(${JSON.stringify(ENTRY)}).then(() => { console.log(process.stdin.listenerCount('data')); });`],
		{ timeout: 20_000 },
	);
	assert.equal(stdout.trim(), '0', 'import attached a stdin reader');
	assert.doesNotMatch(stderr, /ready with \d+ tools/, 'import printed the server banner');
});

test('the declared exports resolve to the documented surface', () => {
	assert.equal(typeof buildServer, 'function');
	assert.ok(Array.isArray(FALLBACK_TOOLS) && FALLBACK_TOOLS.length > 0);
	assert.ok(TOOL_ANNOTATIONS && typeof TOOL_ANNOTATIONS === 'object');
});

test('package.json points bin, main and exports at the same real entry file', () => {
	assert.equal(pkg.main, './src/index.js');
	assert.equal(pkg.exports['.'], './src/index.js');
	assert.equal(pkg.bin['pumpfun-mcp'], 'src/index.js');
	// `files` must ship everything those entries reach at install time.
	for (const required of ['src', 'README.md', 'LICENSE']) {
		assert.ok(pkg.files.includes(required), `package.json files is missing ${required}`);
	}
});

test('buildServer registers the bundled tool surface without a key or a transport', async () => {
	// PUMPFUN_MCP_URL is pointed at an unroutable address so the backend tools/list
	// fails fast and the bundled FALLBACK_TOOLS are what get registered. No network
	// dependency, and the offline path is exactly the one a fresh install hits.
	const prior = process.env.PUMPFUN_MCP_URL;
	process.env.PUMPFUN_MCP_URL = 'http://127.0.0.1:1/pump-fun-mcp';
	try {
		const server = await buildServer();
		assert.ok(server, 'buildServer returned nothing');
		assert.ok(server.threeWsToolCount >= FALLBACK_TOOLS.length);
		assert.equal(process.stdin.listenerCount('data'), 0, 'buildServer connected a transport');
	} finally {
		if (prior === undefined) delete process.env.PUMPFUN_MCP_URL;
		else process.env.PUMPFUN_MCP_URL = prior;
	}
});
