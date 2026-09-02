// Tests for the deploy-worktree stager (scripts/prepare-deploy-worktree.mjs).
//
// The script exists because staging a deploy tree by hand failed in three ways
// that all surface minutes later, disguised as something else. Two things are
// worth pinning: that a missing REQUIRED artifact is BUILT rather than quietly
// skipped (skipping is exactly what produced the exit-144 and missing-svelte
// dead builds), and that the hardlink target is rejected up front when it
// cannot possibly hardlink.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTIFACTS, planArtifacts } from '../scripts/prepare-deploy-worktree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/prepare-deploy-worktree.mjs');

/** Run the script in plan mode. It writes nothing, so this is safe in CI. */
function plan(args) {
	try {
		const stdout = execFileSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
		return { code: 0, out: stdout };
	} catch (err) {
		return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

describe('ARTIFACTS', () => {
	it('covers every artifact a fresh worktree cannot produce, none of them optional', () => {
		const required = ARTIFACTS.filter((a) => !a.optional).map((a) => a.rel);
		expect(required).toEqual([
			'node_modules',
			'chat/node_modules',
			'character-studio/build',
			// Gitignored, so a fresh worktree has agent-payments-sdk/ source with
			// no entry behind its package.json main/module/exports.
			'agent-payments-sdk/dist',
		]);
	});

	it('can regenerate every required artifact except the root dependency tree', () => {
		for (const a of ARTIFACTS.filter((x) => !x.optional && x.rel !== 'node_modules')) {
			expect(a.build, `${a.rel} needs a build command`).toBeTruthy();
		}
		// node_modules cannot be rebuilt from inside a deploy prep step without
		// re-resolving the lockfile, so its absence must stop the run instead.
		expect(ARTIFACTS.find((a) => a.rel === 'node_modules').build).toBe(null);
	});
});

describe('planArtifacts', () => {
	it('stages everything when the source tree is fully populated', () => {
		const p = planArtifacts(() => true);
		expect(p.every((x) => x.action === 'stage')).toBe(true);
	});

	it('builds a missing nested artifact rather than skipping it', () => {
		const p = planArtifacts((rel) => rel !== 'character-studio/build' && rel !== 'chat/node_modules');
		const byRel = Object.fromEntries(p.map((x) => [x.rel, x.action]));
		expect(byRel['character-studio/build']).toBe('build');
		expect(byRel['chat/node_modules']).toBe('build');
	});

	it('blocks, never builds, when the root dependency tree is absent', () => {
		const p = planArtifacts((rel) => rel !== 'node_modules');
		expect(p.find((x) => x.rel === 'node_modules').action).toBe('blocked');
	});

	it('skips an absent optional artifact without blocking the run', () => {
		const p = planArtifacts((rel) => !rel.startsWith('character-studio/node_modules'));
		expect(p.find((x) => x.rel === 'character-studio/node_modules').action).toBe('skip');
		expect(p.some((x) => x.action === 'blocked')).toBe(false);
	});
});

describe('guards (plan mode, writes nothing)', () => {
	it('refuses a target on another filesystem, where cp -al cannot hardlink', () => {
		const r = plan(['--path', '/tmp/deploy-wt-vitest-probe']);
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/different filesystem/);
	});

	it('refuses a --path with no argument instead of staging somewhere unintended', () => {
		const r = plan(['--path', '--apply']);
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/--path needs a directory argument/);
	});

	it('refuses to stage over the main worktree', () => {
		const r = plan(['--path', ROOT]);
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/must not be the main worktree/);
	});

	it('plans without applying by default, and says so', () => {
		const r = plan(['--path', '/workspaces/.deploy-wt-vitest-unused']);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/Plan only\. Re-run with --apply/);
		for (const a of ARTIFACTS.filter((x) => !x.optional)) expect(r.out).toContain(a.rel);
	});
});
