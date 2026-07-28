#!/usr/bin/env node
// Assert CLAUDE.md tells the truth about this repository.
//
// CLAUDE.md is the operating brain for every agent in this workspace: it names
// npm scripts, file paths, and runbook steps that agents execute verbatim. When
// the repo moves and CLAUDE.md doesn't, agents follow instructions into dead
// ends (a renamed script, a moved runbook, a deleted directory) and burn a
// session discovering the drift. This check makes that drift a red build
// instead of a wasted session.
//
// Three assertions:
//   1. Every `npm run <script>` and backticked script-name (build:gcp,
//      check:dist, ...) referenced in CLAUDE.md exists in package.json.
//   2. Every concrete repo path referenced in CLAUDE.md exists on disk.
//      Placeholders (<name>), globs (*), brace sets ({a,b}), URLs, and build
//      artifacts are skipped; the check only fails on paths an agent would
//      try to open and not find.
//   3. CLAUDE.md honors its own typography rule: no em/en-dashes outside the
//      Tone paragraph that names the banned characters.
//
// Run: node scripts/check-claude-md.mjs   (wired as `npm run check:claude`)

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

const failures = [];

// 1. npm scripts: `npm run x` prose plus bare backticked script names.
const referenced = new Set();
for (const m of md.matchAll(/npm run ([a-z0-9:._-]+)/g)) referenced.add(m[1]);
for (const m of md.matchAll(/`([a-z][a-z0-9-]*(?::[a-z0-9-]+)+)`/g)) referenced.add(m[1]);
for (const name of [...referenced].sort()) {
	if (!scripts[name]) failures.push(`npm script \`${name}\` is referenced but missing from package.json`);
}

// 2. Repo paths: backticked tokens and markdown link targets that contain a
// slash. Anything an agent could not literally open is skipped, not guessed.
const artifactPaths = new Set([
	'dist/',
	'node_modules',
	'chat/node_modules',
	'character-studio/build',
	'.github/workflows/', // named only to be forbidden; must not be required to exist
]);
const candidates = new Set();
for (const m of md.matchAll(/`([^`\n]+)`/g)) candidates.add(m[1]);
for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) candidates.add(m[1]);
for (const raw of [...candidates].sort()) {
	if (!raw.includes('/')) continue;
	if (!/^[A-Za-z0-9_./-]+$/.test(raw)) continue; // placeholders, globs, braces, spaces, @scopes
	if (raw.startsWith('/') || raw.startsWith('-') || raw.includes('://')) continue; // routes, flags, URLs
	if (raw.startsWith('three.ws/') || raw.startsWith('pump.fun/')) continue; // domains in prose
	if (artifactPaths.has(raw)) continue;
	if (!existsSync(path.join(root, raw))) failures.push(`path \`${raw}\` is referenced but does not exist`);
}

// 3. Typography: the ban applies to the file that declares it. Only the lines
// that name the banned characters may contain them.
md.split('\n').forEach((line, i) => {
	if (/[—–]/.test(line) && !/em-dash|en-dash/.test(line)) {
		failures.push(`line ${i + 1} contains an em/en-dash, which CLAUDE.md itself bans`);
	}
});

if (failures.length) {
	console.error(`[check-claude] ${failures.length} drift issue(s) between CLAUDE.md and the repo:`);
	for (const f of failures) console.error(`[check-claude]   ${f}`);
	console.error('[check-claude] Fix CLAUDE.md (or the repo) so agents are never handed a dead instruction.');
	process.exit(1);
}
console.log('[check-claude] OK: every script, path, and typography rule in CLAUDE.md matches the repo');
