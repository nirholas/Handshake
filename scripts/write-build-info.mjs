#!/usr/bin/env node
/**
 * Build-info stamp — the missing traceability link between a running production
 * revision and the exact commit it was built from.
 *
 * Why this exists: the Cloud Run image tags to `:latest` and the container ships
 * WITHOUT a `.git` dir (`.gcloudignore` excludes it), so at runtime there is no
 * way to ask "which commit is live?" — you have to cross-reference the revision
 * creation timestamp against `git log` by hand. This script captures the commit
 * identity AT BUILD TIME and writes it into `dist/build-info.json`, which ships
 * in the image (the Dockerfile `COPY . .` includes dist) and is both served as a
 * static file (`/build-info.json`) and read by the `/api/version` handler.
 *
 * Two modes:
 *   --snapshot : record ONLY whether the working tree is dirty, into a sidecar
 *                in the git dir. Run this FIRST in build:gcp, before the site
 *                build mutates tracked files (inject-seo-meta/theme-boot rewrite
 *                pages/*.html in place; build-page-index regenerates public/*).
 *                Without it, the stamp would always read `dirty: true` because
 *                the build itself dirties the tree — making the flag useless.
 *   (default)  : write the full stamp. If a snapshot sidecar exists, trust its
 *                dirty value (the pre-build truth) and consume it; otherwise fall
 *                back to a live `git status` (correct for a standalone run).
 *
 * Fail-soft everywhere: if git is unavailable (e.g. building from a tarball with
 * no .git), commit fields fall back to CI-provided env vars, then to `unknown`.
 * Never throws, never fails the build.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_ONLY = process.argv.includes('--snapshot');

/** Run a git command from the repo root; return trimmed stdout or '' on any error. */
function git(args) {
	try {
		return execSync(`git ${args}`, {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 64 * 1024 * 1024,
		})
			.toString()
			.trim();
	} catch {
		return '';
	}
}

/** Absolute path to the dirty-state sidecar, inside this worktree's git dir. */
function sidecarPath() {
	const gitDir = git('rev-parse --absolute-git-dir');
	if (!gitDir) return null;
	return join(gitDir, 'three-ws-build-dirty');
}

/** True if the working tree has uncommitted changes right now. */
function treeIsDirty() {
	return git('rev-parse HEAD') !== '' && git('status --porcelain') !== '';
}

// --- snapshot mode: stamp the pre-build dirty state and exit ---
if (SNAPSHOT_ONLY) {
	const p = sidecarPath();
	if (p) {
		try {
			writeFileSync(p, treeIsDirty() ? '1' : '0');
		} catch {
			/* best-effort — a missing snapshot just means the stamp computes dirty live */
		}
	}
	console.log(
		`[build-info] snapshot: working tree ${treeIsDirty() ? 'dirty' : 'clean'} pre-build`,
	);
	process.exit(0);
}

function packageVersion() {
	try {
		return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version || 'unknown';
	} catch {
		return 'unknown';
	}
}

// Prefer live git; fall back to CI-injected commit env vars (Vercel/Cloud Build);
// finally 'unknown'. Never let a missing .git break the build.
const fullSha =
	git('rev-parse HEAD') ||
	process.env.VERCEL_GIT_COMMIT_SHA ||
	process.env.COMMIT_SHA ||
	'unknown';
const shortSha = fullSha === 'unknown' ? 'unknown' : fullSha.slice(0, 9);
const commitTime = git('show -s --format=%cI HEAD') || null; // committer date, ISO 8601
const branch =
	git('rev-parse --abbrev-ref HEAD') ||
	process.env.VERCEL_GIT_COMMIT_REF ||
	process.env.BRANCH_NAME ||
	'unknown';
const subject = git('show -s --format=%s HEAD') || null;

// Dirty: prefer the pre-build snapshot (the build mutates tracked files, so a
// live read here would almost always be `true` and meaningless). Consume the
// sidecar so it never leaks into a later build.
let dirty = false;
if (fullSha !== 'unknown') {
	const p = sidecarPath();
	if (p && existsSync(p)) {
		try {
			dirty = readFileSync(p, 'utf8').trim() === '1';
			rmSync(p, { force: true });
		} catch {
			dirty = treeIsDirty();
		}
	} else {
		dirty = treeIsDirty();
	}
}

const info = {
	version: packageVersion(),
	commit: fullSha,
	commitShort: shortSha,
	commitTime,
	commitSubject: subject,
	branch,
	dirty,
	builtAt: new Date().toISOString(),
	node: process.version,
};

const outDir = resolve(ROOT, 'dist');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'build-info.json');
writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n');

console.log(
	`[build-info] ${info.commitShort}${info.dirty ? '-dirty' : ''} (${info.branch}) v${info.version} → dist/build-info.json`,
);
