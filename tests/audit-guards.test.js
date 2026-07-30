import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the guard. audit-guards is the only thing standing between
// data/guards.json and quiet fiction, and it is rendered in two public places
// (docs/guards.md and /guards), so a false claim there misleads every reader
// rather than just failing a build.
//
// The claim most likely to rot is the stage column. A guard can be dropped from
// the gate chain in a one-word edit while its registry entry still says "gate",
// and nothing about the repo looks wrong afterwards: the script exists, the npm
// script exists, the docs render. Only comparing the claim against the real npm
// chain catches it, so that case is covered from both directions here.
//
// Each test builds a complete miniature repo rather than mutating the real one,
// because the real registry is supposed to stay green and a test that edits it
// would race every other agent working in this worktree.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auditor = join(repoRoot, 'scripts', 'audit-guards.mjs');

let sandbox;

/**
 * Build a miniature repo: the auditor, a package.json, a data/guards.json, and
 * a stub file for every script the registry mentions.
 */
function makeRepo(name, { guards, exempt = [], stages, scripts, extraScripts = [], hookTemplate }) {
	const dir = join(sandbox, name);
	mkdirSync(join(dir, 'scripts'), { recursive: true });
	mkdirSync(join(dir, 'data'), { recursive: true });
	copyFileSync(auditor, join(dir, 'scripts', 'audit-guards.mjs'));

	for (const g of guards) {
		if (g.script && g.__skipFile !== true) {
			writeFileSync(join(dir, g.script), '#!/usr/bin/env node\n');
		}
	}
	for (const rel of extraScripts) writeFileSync(join(dir, rel), '#!/usr/bin/env node\n');
	if (hookTemplate !== undefined) writeFileSync(join(dir, 'scripts', 'setup-git-hooks.mjs'), hookTemplate);

	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }, null, 2));
	writeFileSync(
		join(dir, 'data', 'guards.json'),
		JSON.stringify(
			{
				updated: '2026-07-30',
				summary: 'fixture',
				stages: stages ?? [
					{ id: 'prebuild', title: 'Prebuild', when: 'x', description: 'y' },
					{ id: 'gate', title: 'Gate', when: 'x', description: 'y' },
					{ id: 'build:gcp', title: 'Deploy build', when: 'x', description: 'y' },
					{ id: 'pre-push', title: 'Pre-push', when: 'x', description: 'y' },
					{ id: 'manual', title: 'On demand', when: 'x', description: 'y' },
				],
				guards: guards.map(({ __skipFile, ...g }) => g),
				// Every fixture necessarily contains a copy of the auditor, which the
				// reverse check would otherwise report as an unregistered guard. The
				// real repo registers it properly instead of exempting it.
				exempt: [...exempt, { pattern: 'scripts/audit-guards.mjs', reason: 'the auditor under test' }],
			},
			null,
			2,
		),
	);
	return dir;
}

function run(dir) {
	try {
		return { code: 0, out: execFileSync('node', [join(dir, 'scripts', 'audit-guards.mjs')], { encoding: 'utf8' }) };
	} catch (err) {
		return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

/** A registry entry that passes every check, used as the baseline to break. */
const goodGuard = {
	id: 'check-thing',
	script: 'scripts/check-thing.mjs',
	npm: 'check:thing',
	title: 'A thing',
	protects: 'The thing.',
	why: 'Because the thing broke once.',
	stages: ['gate'],
	needs: 'none',
};
const goodScripts = { 'check:thing': 'node scripts/check-thing.mjs', gate: 'npm run check:thing' };

beforeAll(() => {
	sandbox = mkdtempSync(join(tmpdir(), 'guard-registry-'));
});

afterAll(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe('audit-guards', () => {
	it('passes on a registry that tells the truth', () => {
		const dir = makeRepo('good', { guards: [goodGuard], scripts: goodScripts });
		const { code, out } = run(dir);
		expect(code).toBe(0);
		expect(out).toContain('1 guards registered');
		expect(out).toContain('gate:1');
	});

	it('fails when a registered script does not exist', () => {
		const dir = makeRepo('missing-script', {
			guards: [{ ...goodGuard, __skipFile: true }],
			scripts: goodScripts,
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('does not exist');
	});

	it('fails when the npm script it claims is missing', () => {
		const dir = makeRepo('missing-npm', {
			guards: [goodGuard],
			scripts: { gate: 'npm run check:thing' },
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('missing from package.json');
	});

	it('fails when the npm script does not actually run the guard', () => {
		// The subtle one: the name exists, so a naive check passes, but it was
		// repointed at a different script during a rename.
		const dir = makeRepo('npm-mismatch', {
			guards: [goodGuard],
			scripts: { 'check:thing': 'node scripts/check-other.mjs', gate: 'npm run check:thing' },
			extraScripts: ['scripts/check-other.mjs'],
			exempt: [{ pattern: 'scripts/check-other.mjs', reason: 'fixture' }],
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('does not actually run');
	});

	it('fails when a guard claims a stage it is not wired into', () => {
		// The claim most likely to rot: dropped from the chain, still advertised.
		const dir = makeRepo('stage-lie', {
			guards: [goodGuard],
			scripts: { 'check:thing': 'node scripts/check-thing.mjs', gate: 'npm run something-else' },
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('claims it runs in `gate`');
		expect(out).toContain('not in the gate chain');
	});

	it('does not confuse a prefix for a real gate entry', () => {
		// `npm run check:thing-extra` must not satisfy a claim for `check:thing`.
		const dir = makeRepo('prefix-trap', {
			guards: [goodGuard],
			scripts: {
				'check:thing': 'node scripts/check-thing.mjs',
				'check:thing-extra': 'node scripts/check-thing.mjs',
				gate: 'npm run check:thing-extra',
			},
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('claims it runs in `gate`');
	});

	it('verifies a prebuild claim against the raw node call, not an npm name', () => {
		const base = { ...goodGuard, stages: ['prebuild'] };
		const wired = makeRepo('prebuild-ok', {
			guards: [base],
			scripts: { 'check:thing': 'node scripts/check-thing.mjs', prebuild: 'node scripts/check-thing.mjs' },
		});
		expect(run(wired).code).toBe(0);

		const unwired = makeRepo('prebuild-lie', {
			guards: [base],
			scripts: { 'check:thing': 'node scripts/check-thing.mjs', prebuild: 'node scripts/build-something.mjs' },
		});
		const { code, out } = run(unwired);
		expect(code).toBe(1);
		expect(out).toContain('the prebuild chain');
	});

	it('verifies a pre-push claim against the installed hook template', () => {
		const base = { ...goodGuard, stages: ['pre-push'] };
		const wired = makeRepo('hook-ok', {
			guards: [base],
			scripts: goodScripts,
			hookTemplate: 'node scripts/check-thing.mjs --base "$remote_sha"',
		});
		expect(run(wired).code).toBe(0);

		const unwired = makeRepo('hook-lie', {
			guards: [base],
			scripts: goodScripts,
			hookTemplate: 'echo "no guards here"',
		});
		const { code, out } = run(unwired);
		expect(code).toBe(1);
		expect(out).toContain('the pre-push hook template');
	});

	it('accepts an alias name when the gate runs the variant', () => {
		// check-cron-drift is registered under its primary name but the gate runs
		// its --offline variant, which is a different npm script.
		const dir = makeRepo('alias', {
			guards: [{ ...goodGuard, npmAliases: ['check:thing-offline'] }],
			scripts: {
				'check:thing': 'node scripts/check-thing.mjs',
				'check:thing-offline': 'node scripts/check-thing.mjs --offline',
				gate: 'npm run check:thing-offline',
			},
		});
		expect(run(dir).code).toBe(0);
	});

	it('fails when a guard on disk is not registered at all', () => {
		const dir = makeRepo('unregistered', {
			guards: [goodGuard],
			scripts: goodScripts,
			extraScripts: ['scripts/audit-secret.mjs'],
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('audit-secret.mjs');
		expect(out).toContain('not in data/guards.json');
	});

	it('accepts an unregistered script that matches an exempt pattern', () => {
		const dir = makeRepo('exempt-ok', {
			guards: [goodGuard],
			scripts: goodScripts,
			extraScripts: ['scripts/verify-vendor.mjs', 'scripts/audit-thing.mjs'],
			exempt: [
				{ pattern: 'scripts/verify-*.mjs', reason: 'vendor integration check' },
				{ pattern: 'scripts/audit-thing.mjs', reason: 'fixture' },
			],
		});
		expect(run(dir).code).toBe(0);
	});

	it('does not let an exempt glob leak across directories', () => {
		// `scripts/*` must not match `scripts/nested/x.mjs`; the auditor only reads
		// the top level, but the pattern itself must stay tight.
		const dir = makeRepo('glob-tight', {
			guards: [goodGuard],
			scripts: goodScripts,
			extraScripts: ['scripts/audit-loose.mjs'],
			exempt: [{ pattern: 'scripts/check-*.mjs', reason: 'only checks' }],
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('audit-loose.mjs');
	});

	it('rejects an exempt pattern with no reason', () => {
		const dir = makeRepo('exempt-no-reason', {
			guards: [goodGuard],
			scripts: goodScripts,
			extraScripts: ['scripts/audit-thing.mjs'],
			exempt: [{ pattern: 'scripts/audit-thing.mjs', reason: '' }],
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('gives no reason');
	});

	it('requires the fields the docs and the page render', () => {
		const dir = makeRepo('missing-copy', {
			guards: [{ ...goodGuard, why: '' }],
			scripts: goodScripts,
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('missing `why`');
	});

	it('rejects an unknown stage rather than silently ignoring it', () => {
		const dir = makeRepo('bad-stage', {
			guards: [{ ...goodGuard, stages: ['someday'] }],
			scripts: goodScripts,
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('unknown stage');
	});

	it('flags a verifiable stage the registry never describes for readers', () => {
		const dir = makeRepo('undescribed-stage', {
			guards: [goodGuard],
			scripts: goodScripts,
			stages: [{ id: 'gate', title: 'Gate', when: 'x', description: 'y' }],
		});
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('never describes it for readers');
	});
});

describe('this repository', () => {
	it('has a registry that passes its own audit', () => {
		const { code, out } = (() => {
			try {
				return { code: 0, out: execFileSync('node', [auditor], { cwd: repoRoot, encoding: 'utf8' }) };
			} catch (err) {
				return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
			}
		})();
		expect(code, out).toBe(0);
	});

	it('registers every guard the gate actually runs', () => {
		// The gate is the chain a human is told to run before calling work done,
		// so anything in it must be explainable from the registry.
		const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
		const registry = JSON.parse(readFileSync(join(repoRoot, 'data', 'guards.json'), 'utf8'));
		const known = new Set(registry.guards.flatMap((g) => [g.npm, ...(g.npmAliases || [])].filter(Boolean)));
		// Test stages are covered by the test files themselves, not by this registry.
		const notGuards = new Set(['test:gate', 'test:gate-3d']);
		const gateSteps = [...pkg.scripts.gate.matchAll(/npm run ([a-z0-9:._-]+)/g)].map((m) => m[1]);
		const unexplained = gateSteps.filter((s) => !known.has(s) && !notGuards.has(s));
		expect(unexplained, `gate steps missing from data/guards.json: ${unexplained.join(', ')}`).toEqual([]);
	});
});
