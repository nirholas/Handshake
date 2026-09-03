#!/usr/bin/env node
// Publish three.ws npm library packages (not MCP servers - see
// publish-mcp-servers.mjs for those), idempotently.
//
// The package list is DISCOVERED from the filesystem, not hand-maintained. A
// hardcoded list is how 19 finished packages sat unpublished for weeks: they
// were written, tested, documented, and then never added to an array nobody
// remembered existed. Discovery means shipping a package is the same act as
// creating its directory.
//
// A package is in this lane when packages/<name>/package.json exists, is not
// `private`, and the directory has NO server.json (a server.json means it is an
// MCP server and publishes through publish-mcp-servers.mjs, which also handles
// its MCP-registry manifest). EXTRA_DIRS adds library packages that live
// outside packages/.
//
// For each package it:
//   1. reads the local version from package.json;
//   2. runs a preflight (readme, license, entry points, publishConfig) and
//      refuses to publish a package that would ship broken;
//   3. checks that version against npm - if already published, skips;
//   4. otherwise runs the package build (prepublishOnly handles this too) and
//      `npm publish --access public`.
//
// Requires `npm whoami` to succeed (or NPM_TOKEN in the environment).
//
// Usage:
//   node scripts/publish-packages.mjs --dry-run        # report only
//   node scripts/publish-packages.mjs                  # publish what's missing
//   node scripts/publish-packages.mjs --only react     # one package by key
//   node scripts/publish-packages.mjs --new            # only never-published ones

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Library packages that live outside packages/. Keyed by dir, same shape as a
// discovered entry.
const EXTRA_DIRS = [
	// Assistant widget SDK - the one-tag / npm loader for the 3D avatar
	// assistant. Has a real build (build.mjs, run via prepublishOnly) that also
	// mirrors the one-tag bundle to public/assistant/v1.js.
	'assistant-sdk',
];

// Publish order for the packages a first-time reader is most likely to install.
// Everything discovered outside this list follows, alphabetically. Order only
// affects which package goes first in a run; the script is idempotent either way.
const PRIORITY = [
	'react',
	'forge',
	'names',
	'voice',
	'pose',
	'glb-tools',
	'mocap',
	'intel',
	'vanity',
	'reputation',
	'agenc',
	'agent-memory',
	'guardian',
	'agent-guards',
	'x402-server',
	'skill-license',
	'strategies',
	'pumpfun-skills',
	'irl',
];

/**
 * Every library package in the repo, in publish order.
 *
 * Skips `private` manifests and any directory carrying a server.json, which is
 * the MCP lane's marker.
 */
function discoverPackages() {
	const found = [];
	for (const entry of readdirSync(resolve(root, 'packages'), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = `packages/${entry.name}`;
		if (!existsSync(resolve(root, dir, 'package.json'))) continue;
		if (existsSync(resolve(root, dir, 'server.json'))) continue; // MCP lane
		if (readPkg(dir).private) continue;
		found.push({ key: entry.name, dir });
	}
	for (const dir of EXTRA_DIRS) {
		if (!existsSync(resolve(root, dir, 'package.json'))) continue;
		if (readPkg(dir).private) continue;
		found.push({ key: dir.replace(/-sdk$/, ''), dir });
	}
	const rank = (key) => {
		const i = PRIORITY.indexOf(key);
		return i === -1 ? PRIORITY.length : i;
	};
	return found.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

/**
 * Reasons this package would publish something broken.
 *
 * npm accepts a tarball with a dangling `main`, a scoped package with no
 * `publishConfig.access` (which publishes restricted and 402s on a free plan),
 * or a bin whose file is excluded by `files[]`. Each of those is only visible
 * to whoever installs it next, so catch them here.
 */
function preflight(dir, pkg) {
	const problems = [];
	if (pkg.name?.startsWith('@') && pkg.publishConfig?.access !== 'public') {
		problems.push('scoped package without publishConfig.access "public"');
	}
	if (!pkg.description) problems.push('no description');
	if (!pkg.license) problems.push('no license field');
	if (!existsSync(resolve(root, dir, 'README.md'))) problems.push('no README.md');
	if (!existsSync(resolve(root, dir, 'LICENSE'))) problems.push('no LICENSE file');

	const targets = new Set([pkg.main, pkg.module, pkg.types].filter(Boolean));
	const walk = (node) => {
		if (typeof node === 'string') targets.add(node);
		else if (node && typeof node === 'object') Object.values(node).forEach(walk);
	};
	walk(pkg.exports);
	Object.values(pkg.bin || {}).forEach((b) => targets.add(b));
	for (const target of targets) {
		if (typeof target !== 'string' || !target.startsWith('.')) continue;
		if (!existsSync(resolve(root, dir, target))) problems.push(`entry point missing on disk: ${target}`);
	}
	for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
		if (/^(workspace|file|link):/.test(String(spec))) {
			problems.push(`dependency ${name}@${spec} does not resolve from npm`);
		}
	}
	return problems;
}

const PACKAGES = discoverPackages();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const newOnly = args.includes('--new');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] || '').split(',').filter(Boolean) : null;

function readPkg(dir) {
	return JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8'));
}

function publishedVersions(name) {
	try {
		const out = execFileSync('npm', ['view', name, 'versions', '--json'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const parsed = JSON.parse(out);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return []; // 404 → never published
	}
}

let published = 0;
let skipped = 0;
let failed = 0;
let blocked = 0;

console.log(`${PACKAGES.length} library packages discovered.\n`);

for (const entry of PACKAGES) {
	if (only && !only.includes(entry.key)) continue;
	const pkg = readPkg(entry.dir);
	const { name, version } = pkg;
	const existing = publishedVersions(name);
	const isNew = existing.length === 0;

	if (existing.includes(version)) {
		console.log(`• ${name}@${version} already on npm, skipping`);
		skipped++;
		continue;
	}
	if (newOnly && !isNew) {
		skipped++;
		continue;
	}

	const problems = preflight(entry.dir, pkg);
	if (problems.length) {
		console.error(`• ${name}@${version}: BLOCKED by preflight`);
		problems.forEach((p) => console.error(`    ✗ ${p}`));
		blocked++;
		continue;
	}

	const label = isNew ? 'first publish' : `update over ${existing[existing.length - 1]}`;
	if (dryRun) {
		console.log(`• ${name}@${version} would publish (${label}, dry run)`);
		continue;
	}

	console.log(`• ${name}@${version} publishing (${label})...`);
	try {
		execFileSync('npm', ['publish', '--access', 'public'], {
			cwd: resolve(root, entry.dir),
			stdio: 'inherit',
		});
		console.log(`  ✓ published ${name}@${version}`);
		published++;
	} catch (err) {
		console.error(`  ✗ failed to publish ${name}@${version}: ${err.message}`);
		failed++;
	}
}

console.log(
	`\nDone. ${published} published, ${skipped} skipped, ${blocked} blocked by preflight, ${failed} failed.`,
);
process.exit(failed || blocked ? 1 : 0);
