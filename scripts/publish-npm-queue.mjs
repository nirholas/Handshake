#!/usr/bin/env node
// Publishes the queued npm package releases that the 2026-08-02 registry audit
// found ready: local source is ahead of the published version and the build or
// test gate for each has already been verified in-tree. Safe to re-run; any
// package whose local version already exists on the registry is skipped, so a
// partial run (rate limit, network drop) just resumes where it stopped.
//
// Usage:
//   node scripts/publish-npm-queue.mjs           # dry run: report what would publish
//   node scripts/publish-npm-queue.mjs --publish # actually publish (needs npm login)
//
// Auth: `npm whoami` must resolve to an account with publish rights on the
// three-ws scope (npm login, or an automation token in ~/.npmrc).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// Ordered by monthly downloads: the most-used packages ship first.
const QUEUE = [
	'walk-sdk', // @three-ws/walk 0.3.0: emote rail + playground picker
	'avatar-sdk', // @three-ws/avatar 0.2.2: AR launch, draco decode, react avatar-id fix
	'packages/pumpfun-mcp', // @three-ws/pumpfun-mcp 0.2.5: tool-name casing + bot_status in server description
	'page-agent-sdk', // @three-ws/page-agent 0.2.1: photographic HDRI environment
	'packages/viewer-presets', // @three-ws/viewer-presets 0.4.0
	'packages/reputation', // @three-ws/reputation 0.1.1: dead solana/... endpoint paths fixed
];

const publish = process.argv.includes('--publish');

function registryVersion(name) {
	try {
		const res = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8' });
		return res.trim();
	} catch {
		return null; // unpublished
	}
}

let failures = 0;
for (const dir of QUEUE) {
	const pkgPath = resolve(ROOT, dir, 'package.json');
	if (!existsSync(pkgPath)) {
		console.error(`SKIP ${dir}: no package.json`);
		failures++;
		continue;
	}
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	const current = registryVersion(pkg.name);
	if (current === pkg.version) {
		console.log(`ok   ${pkg.name}@${pkg.version} already on the registry`);
		continue;
	}
	console.log(`${publish ? 'PUB ' : 'PLAN'} ${pkg.name}: ${current ?? 'unpublished'} -> ${pkg.version}`);
	if (!publish) continue;
	try {
		execFileSync('npm', ['publish', '--access', 'public'], {
			cwd: resolve(ROOT, dir),
			stdio: 'inherit',
		});
	} catch (err) {
		console.error(`FAIL ${pkg.name}: ${err.message}`);
		failures++;
	}
}

if (!publish) console.log('\nDry run only. Re-run with --publish after npm login.');
process.exit(failures ? 1 : 0);
