#!/usr/bin/env node
// One command to verify every three.ws MCP surface end to end:
//   1. manifest consistency (audit-mcp-manifests.mjs)
//   2. each stdio package's own test suite (node --test)
//   3. live health of all 6 remote endpoints (smoke-mcp-remotes.mjs)
//
//   node scripts/test-mcp-all.mjs              # remote smoke against https://three.ws
//   node scripts/test-mcp-all.mjs http://localhost:3000
//   node scripts/test-mcp-all.mjs --no-remote  # skip the live layer (offline)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noRemote = args.includes('--no-remote');
const base = args.find((a) => !a.startsWith('--')) || 'https://three.ws';

const PACKAGES = [
	'packages/pumpfun-mcp',
	'packages/ibm-watsonx-mcp',
	'packages/ibm-x402-mcp',
	'packages/avatar-agent-mcp',
	'packages/threews-avatar-mcp',
	'packages/three-token-mcp',
	'mcp-bridge',
	// The worked example for paid MCP tools. It is not published, but it is a real
	// MCP surface with a real test suite, and it breaks the same way the packages do.
	'examples/paid-mcp-server',
];

const rows = [];
function record(name, ok, detail) {
	rows.push({ name, ok, detail });
	console.log(`${ok ? '✓' : '✗'} ${name.padEnd(34)} ${detail}`);
}

function run(cmd, cmdArgs, cwd) {
	try {
		const out = execFileSync(cmd, cmdArgs, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true, out };
	} catch (e) {
		return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
	}
}

console.log('\n── MCP verification ──\n');

console.log('[1] manifest consistency');
const audit = run('node', ['scripts/audit-mcp-manifests.mjs'], root);
record('audit:mcp', audit.ok, audit.out.trim().split('\n').pop() || '');

console.log('\n[2] stdio package test suites');
for (const dir of PACKAGES) {
	if (!existsSync(resolve(root, dir, 'package.json'))) {
		record(dir, false, 'no package.json');
		continue;
	}
	const r = run('npm', ['test'], resolve(root, dir));
	const tests = (r.out.match(/^ℹ tests (\d+)/m) || [])[1] || '?';
	const fail = (r.out.match(/^ℹ fail (\d+)/m) || [])[1] || '?';
	const ok = r.ok && fail === '0';
	record(dir, ok, `${tests} tests, ${fail} failing`);
}

if (!noRemote) {
	console.log('\n[3] live remote endpoints');
	const r = run('node', ['scripts/smoke-mcp-remotes.mjs', base], root);
	const line =
		r.out
			.trim()
			.split('\n')
			.filter((l) => l.includes('remotes'))
			.pop() || r.out.trim().split('\n').pop();
	record('smoke:mcp remotes', r.ok, line || '');
}

const failed = rows.filter((r) => !r.ok);
console.log(
	`\n${failed.length === 0 ? '✓ ALL MCP CHECKS PASSED' : `✗ ${failed.length} CHECK(S) FAILED: ${failed.map((r) => r.name).join(', ')}`}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
