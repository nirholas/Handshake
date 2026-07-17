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
 * Run automatically as the last step of `npm run build:gcp`. Safe to run alone.
 * Fail-soft: if git is unavailable (e.g. building from a tarball with no .git),
 * it falls back to CI-provided commit env vars, then to `unknown` — never throws,
 * never fails the build.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a git command from the repo root; return trimmed stdout or '' on any error. */
function git(args) {
	try {
		return execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return '';
	}
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
const dirty = fullSha !== 'unknown' && git('status --porcelain') !== '';

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
