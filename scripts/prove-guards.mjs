#!/usr/bin/env node
// Prove that every guard in data/guards.json still catches what it claims to.
//
// The registry (and the /guards page it feeds) is a list of CLAIMS: "this guard
// stops that failure". Nothing tested the claims. A guard that has rotted into
// a no-op (a directory it no longer scans, a regex that stopped matching, an
// exclusion list that grew until it excluded everything) exits 0 forever, and
// exit 0 is indistinguishable from "the tree is clean". The gate stays green
// while the protection is gone, which is the worst failure mode a safety net
// has: loudest exactly when it works, silent when it dies.
//
// This run found two of those on its first pass. `audit:pages` and
// `audit:routes` were both wired into the gate WITHOUT the flag that makes them
// exit non-zero, so both printed their findings and returned 0. They had been
// structurally incapable of failing a build.
//
// So each guard carries a `proof`: a violation it MUST reject. This runner
// executes them, two-sided, in a throwaway checkout:
//
//   1. Build a sandbox: a detached git worktree at HEAD, overlaid with the
//      current working tree, with node_modules symlinked in.
//   2. CONTROL   arrange the sandbox so the guard passes. A clean exit pins a
//                known baseline; a red one downgrades the proof to a
//                differential (see proveGuard) instead of faking a pass.
//   3. VIOLATION apply one surgical mutation. The guard must now exit non-zero
//                AND say the expected thing.
//   4. Restore every touched path, move to the next guard.
//
// Both sides are required. "Exited non-zero" also happens when the sandbox is
// broken; establishing the baseline first makes the failure attributable to the
// mutation. Matching an expected fragment closes the last hole, because a guard
// that fails for the wrong reason is not a working guard.
//
// Guards that cannot be proven offline (they need gcloud, a browser, live
// credentials, or the network) declare `proof.kind: "live"` with a reason. They
// are reported as such rather than quietly counted as passing: an honest gap
// beats a fake green.
//
// Usage:
//   node scripts/prove-guards.mjs                 prove everything, write results
//   node scripts/prove-guards.mjs --only <id,id>  prove a subset
//   node scripts/prove-guards.mjs --stage gate    prove one stage
//   node scripts/prove-guards.mjs --no-write      do not touch public/guard-proofs.json
//   node scripts/prove-guards.mjs --keep          leave the sandbox for inspection
//
// Exit 1 if any proof fails. Wired as `npm run prove:guards`.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAILING_VERDICTS, VERDICTS, normalizeProof, proveGuard } from './lib/guard-proofs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const flag = (name) => argv.includes(`--${name}`);
function value(name) {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? null : argv[i + 1];
}

const only = (value('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const stageFilter = value('stage');
const write = !flag('no-write');
const keep = flag('keep');
const sandboxDir = value('sandbox') ?? path.resolve(root, '..', '.guard-proof-wt');

const registry = JSON.parse(readFileSync(path.join(root, 'data/guards.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const pkgScripts = pkg.scripts ?? {};
const context = { pkgVersion: pkg.version };

const selected = registry.guards.filter((g) => {
	if (only.length && !only.includes(g.id)) return false;
	if (stageFilter && !(g.stages ?? []).includes(stageFilter)) return false;
	return true;
});

if (!selected.length) {
	console.error('[prove-guards] no guards selected');
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * A detached worktree at HEAD, overlaid with the live working tree.
 *
 * A worktree rather than a copy because the guards read git itself (git grep
 * for conflict markers, git ls-files for committed symlinks, git diff for the
 * diff-scoped rules check) and a plain directory has no history to read.
 * Detached because this must never move a branch: concurrent agents commit on
 * main in this same repository.
 *
 * The overlay matters more than it looks. HEAD is not what the gate runs; the
 * gate runs the working tree, including the guard you just edited. Proving HEAD
 * would prove the last commit, which is precisely the version you are not
 * asking about.
 */
function buildSandbox() {
	if (existsSync(sandboxDir)) {
		spawnSync('git', ['worktree', 'remove', '--force', sandboxDir], { cwd: root });
		rmSync(sandboxDir, { recursive: true, force: true });
	}
	execFileSync('git', ['worktree', 'add', '--detach', '--quiet', sandboxDir, 'HEAD'], {
		cwd: root,
		stdio: 'inherit',
	});

	// node_modules is symlinked, never copied: Node resolves from the importing
	// file's directory upward, so a link at the sandbox root satisfies every
	// guard's imports at zero cost and with no risk of writing into the real
	// dependency tree.
	const linked = path.join(sandboxDir, 'node_modules');
	if (!existsSync(linked)) symlinkSync(path.join(root, 'node_modules'), linked, 'dir');

	const dirty = execFileSync('git', ['status', '--porcelain', '-uall', '-z'], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	let overlaid = 0;
	for (const entry of dirty.split('\0')) {
		if (!entry) continue;
		const status = entry.slice(0, 2);
		const rel = entry.slice(3);
		if (!rel || rel.startsWith('node_modules/')) continue;
		const src = path.join(root, rel);
		const dest = path.join(sandboxDir, rel);
		if (status.includes('D') && !existsSync(src)) {
			rmSync(dest, { force: true });
			overlaid += 1;
			continue;
		}
		if (!existsSync(src)) continue;
		mkdirSync(path.dirname(dest), { recursive: true });
		copyFileSync(src, dest);
		overlaid += 1;
	}

	// The overlay leaves the sandbox index disagreeing with its files, which
	// would make the diff-scoped guards read the overlay as "your change".
	// Commit it, so HEAD in the sandbox IS the working tree and a proof that
	// wants a diff can create its own commit on top.
	execFileSync('git', ['add', '-A'], { cwd: sandboxDir, stdio: 'ignore' });
	spawnSync(
		'git',
		['-c', 'user.email=proofs@three.ws', '-c', 'user.name=guard-proofs', 'commit', '--quiet', '--no-verify', '-m', 'guard proof sandbox baseline'],
		{ cwd: sandboxDir },
	);

	return overlaid;
}

function tearDownSandbox() {
	if (keep) return;
	rmSync(path.join(sandboxDir, 'node_modules'), { force: true });
	spawnSync('git', ['worktree', 'remove', '--force', sandboxDir], { cwd: root });
	rmSync(sandboxDir, { recursive: true, force: true });
	spawnSync('git', ['worktree', 'prune'], { cwd: root });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const LABEL = {
	[VERDICTS.PROVEN]: 'PROVEN      ',
	[VERDICTS.DECLARED_LIVE]: 'LIVE-ONLY   ',
	[VERDICTS.NOT_CAUGHT]: 'NOT CAUGHT  ',
	[VERDICTS.WRONG_REASON]: 'WRONG REASON',
	[VERDICTS.CONTROL_FAILED]: 'INCONCLUSIVE',
};

const indent = (text) => String(text).split('\n').map((l) => `      | ${l}`).join('\n');

const results = [];
let sandboxUp = false;

try {
	// Normalize first, so a malformed declaration fails in milliseconds rather
	// than after a worktree checkout.
	const proofs = new Map();
	for (const guard of selected) proofs.set(guard.id, normalizeProof(guard));

	if ([...proofs.values()].some((p) => p.kind !== 'live')) {
		const overlaid = buildSandbox();
		sandboxUp = true;
		console.log(`[prove-guards] sandbox ${sandboxDir} (${overlaid} working-tree file(s) overlaid)\n`);
	}

	for (const guard of selected) {
		const proof = proofs.get(guard.id);
		const command = pkgScripts[guard.npm];
		let result;
		if (!command && proof.kind !== 'live') {
			result = {
				id: guard.id,
				verdict: VERDICTS.CONTROL_FAILED,
				output: `package.json has no script "${guard.npm}"`,
				ms: 0,
			};
		} else {
			result = proveGuard({ id: guard.id, command }, proof, sandboxDir, { context });
		}
		result.npm = guard.npm;
		result.title = guard.title;
		result.stages = guard.stages;
		results.push(result);
		const baseline = result.baseline === 'red' ? '  [baseline already red]' : '';
		console.log(
			`${LABEL[result.verdict]}  ${guard.id.padEnd(26)} ${String(result.ms).padStart(6)}ms  ${result.summary ?? result.reason ?? ''}${baseline}`,
		);
		if (FAILING_VERDICTS.has(result.verdict)) {
			if (result.note) console.log(indent(result.note));
			console.log(indent(result.output ?? ''));
			if (result.verdict === VERDICTS.WRONG_REASON) console.log(indent(`expected output to contain: ${result.expect}`));
		}
	}
} finally {
	if (sandboxUp) tearDownSandbox();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failed = results.filter((r) => FAILING_VERDICTS.has(r.verdict));
const proven = results.filter((r) => r.verdict === VERDICTS.PROVEN);
const live = results.filter((r) => r.verdict === VERDICTS.DECLARED_LIVE);
const redBaseline = results.filter((r) => r.baseline === 'red');

console.log('');
console.log(`[prove-guards] ${proven.length} proven, ${live.length} live-only, ${failed.length} failing (of ${results.length})`);

if (redBaseline.length) {
	console.log(
		`[prove-guards] ${redBaseline.length} guard(s) are ALREADY FAILING on this tree, so their proof ran differentially:`,
	);
	for (const r of redBaseline) console.log(`[prove-guards]   ${r.id}  (npm run ${r.npm})`);
	console.log('[prove-guards] A guard that fails on its own repository is a real finding. Fix the tree, not the proof.');
}

if (write && !only.length && !stageFilter) {
	const payload = {
		$comment:
			'Generated by scripts/prove-guards.mjs. Each result is the outcome of running the guard twice in a sandbox: once on a clean baseline, once after a declared violation. The fixtures live in data/guards.json.',
		generator: 'scripts/prove-guards.mjs',
		commit: safeGit(['rev-parse', 'HEAD']),
		guardCount: registry.guards.length,
		summary: {
			proven: proven.length,
			liveOnly: live.length,
			failing: failed.length,
			redBaseline: redBaseline.length,
		},
		results: results.map((r) => ({
			id: r.id,
			npm: r.npm ?? null,
			verdict: r.verdict,
			baseline: r.baseline ?? null,
			summary: r.summary ?? null,
			reason: r.reason ?? null,
			evidence: r.evidence ?? null,
			ms: r.ms,
		})),
	};
	const out = path.join(root, 'public/guard-proofs.json');
	// Guard summaries quote page copy and commit subjects, and the repo bans
	// em/en dashes in committed bytes, so scrub them at the boundary.
	const body = `${JSON.stringify(payload, null, '\t').replace(/ [\u2013\u2014] /g, ': ').replace(/[\u2013\u2014]/g, '-')}\n`;
	if ((existsSync(out) ? readFileSync(out, 'utf8') : null) !== body) {
		writeFileSync(out, body);
		console.log('[prove-guards] wrote public/guard-proofs.json');
	} else {
		console.log('[prove-guards] public/guard-proofs.json already current');
	}
}

function safeGit(args) {
	const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	return (res.stdout ?? '').trim() || null;
}

process.exit(failed.length ? 1 : 0);
