#!/usr/bin/env node
/**
 * One-command dev setup for fresh clones: `npm run setup`.
 *
 * `npm install` alone leaves two gaps that break `npm test` and parts of the
 * API surface on a cold clone:
 *
 *   1. solana-agent-sdk is linked as the file: dependency
 *      `@three-ws/solana-agent`, but its dist/ is not checked in — it needs
 *      its own `npm install` + `npm run build` once.
 *   2. `data/_generated/*` (news routes, skill metadata, local skill packs,
 *      page index) is gitignored and only produced by the prebuild pipeline.
 *
 * This script closes both gaps. It is idempotent: SDK builds are skipped via
 * build-cache stamps when sources haven't changed, and the generators
 * re-derive their output from checked-in data. Vercel builds do not run this —
 * scripts/build-vercel.mjs ensures SDK dists itself (ensureSDKDist).
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCached, writeStamp } from './build-cache.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function run(cmd, cwd = ROOT) {
	console.log(`[setup] $ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit' });
}

function buildSdk(name, dir, distEntry) {
	const cacheInputs = [`${dir}/src`, `${dir}/package.json`];
	const distOk = existsSync(resolve(ROOT, distEntry));
	if (distOk && isCached(name, cacheInputs)) {
		console.log(`[setup] ${name}: up to date, skipping`);
		return;
	}
	if (!existsSync(resolve(ROOT, dir, 'node_modules'))) {
		run(`npm install --prefix ${dir} --prefer-offline --no-audit --no-fund`);
	}
	run(`npm run build --prefix ${dir}`);
	writeStamp(name, cacheInputs);
	console.log(`[setup] ${name}: built`);
}

console.log('[setup] Preparing dev environment…');

// 1. SDK dists required at import time by api/ code and tests.
buildSdk('setup-solana-agent-sdk', 'solana-agent-sdk', 'solana-agent-sdk/dist/index.js');
// postinstall normally covers agent-payments-sdk; rebuild here only if its
// dist is missing (e.g. install ran with scripts disabled).
if (!existsSync(resolve(ROOT, 'agent-payments-sdk/dist/index.js'))) {
	buildSdk('setup-agent-payments-sdk', 'agent-payments-sdk', 'agent-payments-sdk/dist/index.js');
}

// 2. Git hooks. The pre-push hook lives in .git/hooks and is installed by
// scripts/setup-git-hooks.mjs (postinstall runs it too); it enforces the
// CLAUDE.md hard rules and the no-credentials rule on exactly the commits
// being pushed. An earlier version of this script pointed core.hooksPath at a
// separate .githooks/ directory, which silently REPLACED that hook with a
// typecheck-only one on every machine that ran setup, so the mandated checks
// never fired for anyone who followed the contributor docs. Undo that
// redirect where it is still set, then (re)install the real hook.
const hooksPath = run('git config --get core.hooksPath', { allowFail: true }).trim();
if (hooksPath === '.githooks') run('git config --unset core.hooksPath');
run('node scripts/setup-git-hooks.mjs');

// 3. Generated data consumed by the app, sitemap, and tests.
run('node scripts/build-news.mjs');
run('node scripts/build-skill-metadata.mjs');
run('node scripts/build-local-skill-packs.mjs');
run('node scripts/build-page-index.mjs');

console.log('[setup] Done. Next steps:');
console.log('[setup]   npm run dev        # app on http://localhost:3000');
console.log('[setup]   npm run test:core  # unit tests');
