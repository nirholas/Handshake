#!/usr/bin/env node
// prepare-deploy-worktree.mjs: stage a clean deploy worktree, correctly, in one command.
//
// This is the missing half of the worktree lifecycle. clean-deploy-worktrees.mjs
// reclaims deploy trees after the fact; nothing created them, so every deploy
// re-ran the runbook's five-command ritual by hand. That ritual has three ways
// to go wrong, and each one fails minutes later somewhere that does not name the
// real cause:
//
//   1. `cp -al` of an artifact that does not exist in the source tree. Both
//      nested dependency trees are gitignored, so a machine that has never run
//      a deploy has no chat/node_modules and no character-studio/build. The
//      copy dies with "No such file or directory", and an agent who continues
//      anyway hits the failures in (2).
//   2. Skipping a nested artifact. Missing chat/node_modules fails the chat
//      build with "Cannot find package '@sveltejs/vite-plugin-svelte'"; missing
//      character-studio/build makes ensure:avatar-studio run the real
//      avatar-studio vite build, which gets OOM-killed (exit 144) on a box
//      already hosting concurrent agent builds. Both land several minutes in.
//   3. `cp -al` across a filesystem boundary. Hardlinks cannot span devices, so
//      a worktree staged outside /workspaces silently falls back to nothing at
//      all: cp exits non-zero and the tree is left half-staged.
//
// This script closes all three: it BUILDS a missing artifact instead of failing
// on it, stages every one of them, and verifies the hardlink target shares a
// device with the source before it starts.
//
//   node scripts/prepare-deploy-worktree.mjs            plan only, writes nothing
//   node scripts/prepare-deploy-worktree.mjs --apply    stage the worktree
//   node scripts/prepare-deploy-worktree.mjs --apply --path /workspaces/.deploy-wt-2
//
// --path (default /workspaces/.deploy-wt) lets concurrent agents stage their own
// tree instead of colliding on the shared default. --force replaces an existing
// tree at that path, but only when clean-deploy-worktrees.mjs would have judged
// it reclaimable, so a tree holding uncommitted work is never destroyed.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dirtyCount } from './clean-deploy-worktrees.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const TARGET = (() => {
	const i = process.argv.indexOf('--path');
	const raw = i === -1 ? '/workspaces/.deploy-wt' : process.argv[i + 1];
	if (!raw || raw.startsWith('--')) fail('--path needs a directory argument');
	return path.resolve(raw);
})();

/**
 * The artifacts `build:gcp` needs that git does not carry. Order matters only
 * for readability; each is independent.
 *
 * `build` is how we regenerate the artifact when the source tree lacks it, run
 * from ROOT. A null build means the artifact cannot be regenerated cheaply and
 * its absence is a hard stop.
 */
export const ARTIFACTS = [
	{
		rel: 'node_modules',
		build: null,
		missingHint: 'run `npm install` in the main worktree first',
		why: 'every step of build:gcp',
	},
	{
		rel: 'chat/node_modules',
		build: ['npm', ['run', 'deps:chat']],
		why: "build:chat, which otherwise fails with \"Cannot find package '@sveltejs/vite-plugin-svelte'\"",
	},
	{
		rel: 'character-studio/build',
		build: ['npm', ['run', 'build:avatar-studio']],
		why: 'ensure:avatar-studio, which otherwise runs the real build and gets OOM-killed (exit 144)',
	},
	{
		// Not in the runbook's list, but staging it means a worktree whose
		// character-studio/build is ever invalidated can rebuild in place
		// instead of dying on a missing dependency tree.
		rel: 'character-studio/node_modules',
		build: null,
		optional: true,
		why: 'an in-worktree avatar-studio rebuild',
	},
	{
		// The workspace symlink node_modules/@three-ws/agent-payments resolves to
		// ../../agent-payments-sdk, whose package.json main/module/exports all
		// point into dist/. dist/ is gitignored, so a fresh worktree carries the
		// package source with no entry behind it, and every importer dies with
		// "Failed to resolve entry for package @three-ws/agent-payments" rather
		// than naming the artifact that is actually missing.
		rel: 'agent-payments-sdk/dist',
		build: ['npm', ['run', 'build', '--prefix', 'agent-payments-sdk']],
		why: 'anything importing @three-ws/agent-payments, which otherwise fails to resolve its entry',
	},
	{
		rel: 'agent-payments-sdk/node_modules',
		build: null,
		optional: true,
		why: 'an in-worktree agent-payments-sdk rebuild',
	},
];

/** Env files copied (never hardlinked: a deploy tree must not share their inode). */
const ENV_FILES = ['.env', '.env.local'];

/**
 * Decide what to do with each artifact, given only a presence oracle. Pure, so
 * the rule that a missing REQUIRED artifact is built rather than skipped can be
 * pinned by tests without staging a real worktree.
 *
 * @param {(rel: string) => boolean} present does this artifact exist in the source tree
 * @param {typeof ARTIFACTS} artifacts
 * @returns {{rel:string, action:'stage'|'build'|'skip'|'blocked'}[]}
 */
export function planArtifacts(present, artifacts = ARTIFACTS) {
	return artifacts.map((a) => {
		if (present(a.rel)) return { ...a, action: 'stage' };
		if (a.optional) return { ...a, action: 'skip' };
		return { ...a, action: a.build ? 'build' : 'blocked' };
	});
}

function fail(message) {
	console.error(`[prep:worktree] ${message}`);
	process.exit(1);
}

function git(args, cwd = ROOT, timeoutMs = 600_000) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Same-device check. `cp -al` cannot cross a filesystem boundary. */
function sameDevice(a, b) {
	try {
		return statSync(a).dev === statSync(b).dev;
	} catch {
		return false;
	}
}

function run() {
	const mainTop = path.resolve(git(['rev-parse', '--show-toplevel']).trim());
	if (mainTop !== ROOT) fail(`run this from the main worktree (${ROOT}), not ${mainTop}`);
	if (TARGET === ROOT) fail('--path must not be the main worktree');

	const head = git(['rev-parse', 'HEAD']).trim();
	console.log(`[prep:worktree] target ${TARGET}`);
	console.log(`[prep:worktree] source ${ROOT} at ${head.slice(0, 9)}`);

	// Hardlinks are the whole point: a full copy of node_modules is several GB
	// per tree and is what filled the disk in the first place.
	const parent = path.dirname(TARGET);
	if (!existsSync(parent)) fail(`parent directory ${parent} does not exist`);
	if (!sameDevice(ROOT, parent)) {
		fail(`${parent} is on a different filesystem than ${ROOT}, so cp -al cannot hardlink into it. Pick a --path under the same mount.`);
	}

	const existing = existsSync(TARGET);
	if (existing && !FORCE) {
		fail(`${TARGET} already exists. Another agent may be building there. Pass --force to replace it, or --path to stage your own.`);
	}
	if (existing && FORCE) {
		// Reuse the reclaimability rule rather than inventing a second one:
		// uncommitted work is the one thing here that cannot be regenerated.
		let dirty = 0;
		try {
			dirty = dirtyCount(git(['status', '--porcelain'], TARGET, 180_000));
		} catch (err) {
			fail(`cannot read git status in ${TARGET} (${String(err.message).slice(0, 80)}), refusing to replace it`);
		}
		if (dirty > 0) fail(`${TARGET} holds ${dirty} uncommitted file(s). Refusing to replace it even with --force.`);
	}

	// Plan the artifact work before touching anything, so plan mode is honest.
	const plan = planArtifacts((rel) => existsSync(path.join(ROOT, rel))).map((p) => ({ ...p, src: path.join(ROOT, p.rel) }));
	for (const p of plan.filter((x) => x.action === 'blocked')) {
		fail(`${p.rel} is missing from ${ROOT} and cannot be regenerated here: ${p.missingHint}`);
	}

	console.log('');
	for (const p of plan) {
		const verb = { stage: 'STAGE ', build: 'BUILD ', skip: 'SKIP  ' }[p.action];
		const note = p.action === 'build' ? ' (missing, will be generated first)' : p.action === 'skip' ? ' (absent and optional)' : '';
		console.log(`  ${verb}${p.rel}${note}\n         needed by ${p.why}`);
	}

	const envPlan = ENV_FILES.map((f) => ({ file: f, present: existsSync(path.join(ROOT, f)) }));
	console.log('');
	for (const e of envPlan) {
		console.log(`  ${(e.present ? 'COPY' : 'ABSENT').padEnd(6)} ${e.file}${e.present ? '' : ' (not on this machine; build:gcp does not need it, deploy:gcp does)'}`);
	}

	if (!APPLY) {
		console.log('\nPlan only. Re-run with --apply to stage the worktree.');
		process.exit(0);
	}

	// Build the missing artifacts in the SOURCE tree, not the new one. They are
	// gitignored, so building them here also makes every later deploy fast.
	for (const p of plan.filter((x) => x.action === 'build')) {
		console.log(`\n[prep:worktree] building ${p.rel} in ${ROOT} (this is the slow part, and it happens once)`);
		const [cmd, args] = p.build;
		execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', timeout: 1_800_000 });
		if (!existsSync(p.src)) fail(`${p.rel} still missing after \`${cmd} ${args.join(' ')}\``);
	}

	if (existing && FORCE) {
		console.log(`\n[prep:worktree] removing the existing clean tree at ${TARGET}`);
		git(['worktree', 'remove', '--force', TARGET]);
	}

	console.log(`\n[prep:worktree] git worktree add --detach ${TARGET} ${head.slice(0, 9)}`);
	execFileSync('git', ['worktree', 'add', '--detach', TARGET, head], { cwd: ROOT, stdio: 'inherit', timeout: 900_000 });

	for (const p of plan) {
		if (p.action === 'skip') continue;
		const dest = path.join(TARGET, p.rel);
		if (existsSync(dest)) continue;
		execFileSync('cp', ['-al', p.src, dest], { cwd: ROOT, timeout: 900_000 });
		console.log(`[prep:worktree] hardlinked ${p.rel}`);
	}

	for (const e of envPlan) {
		if (!e.present) continue;
		copyFileSync(path.join(ROOT, e.file), path.join(TARGET, e.file));
		console.log(`[prep:worktree] copied ${e.file}`);
	}

	// Prove the tree is actually usable rather than asserting it.
	const missing = ARTIFACTS.filter((a) => !a.optional).filter((a) => !existsSync(path.join(TARGET, a.rel)));
	if (missing.length) fail(`staged tree is incomplete, missing: ${missing.map((m) => m.rel).join(', ')}`);
	if (!existsSync(path.join(TARGET, 'character-studio/build/index.html'))) {
		fail('character-studio/build/index.html is absent in the staged tree, so ensure:avatar-studio would rebuild and risk exit 144');
	}

	console.log(`\n[prep:worktree] ready at ${TARGET}`);
	console.log('Next:');
	console.log(`  cd ${TARGET} && npm run build:gcp`);
	console.log('  gcloud builds submit --config server/cloudbuild.yaml --region us-central1 --project aerial-vehicle-466722-p5');
	console.log(`\nWhen the deploy lands: git worktree remove --force ${TARGET}`);
	console.log('(or leave it for `npm run clean:worktrees -- --apply` once it is idle past the age floor)');
}

// Importing this file must not stage anything; only a direct invocation acts.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	run();
}
