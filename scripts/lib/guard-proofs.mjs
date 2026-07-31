// Shared vocabulary for guard proofs: the sandbox, the fixture applier, and the
// verdict model. scripts/prove-guards.mjs drives it, scripts/audit-guards.mjs
// validates the declarations against it, and tests/prove-guards.test.js
// exercises it without touching the real repository.
//
// A "proof" answers a question the guard registry could not: does this guard
// still catch the thing it claims to catch? A registry entry is a claim. A
// proof is evidence. The difference matters because a guard can rot into a
// no-op (a renamed directory it no longer scans, a regex that stopped matching,
// an exclusion list that grew until it excluded everything) and still exit 0
// forever, which reads exactly like success.
//
// Every proof is TWO-SIDED, and that is the whole point:
//
//   control    the sandbox is arranged so the guard MUST pass (exit 0)
//   violation  one surgical mutation is applied and the guard MUST fail,
//              with a failure message that names the right reason
//
// A one-sided proof is worthless. "The guard exited non-zero" also happens when
// the sandbox is broken, when a dependency is missing, or when an unrelated
// pre-existing violation is sitting in the tree. Requiring exit 0 first pins
// the guard to a known-clean baseline, so the non-zero exit afterwards is
// attributable to the mutation and nothing else. Requiring the output to
// contain an expected fragment closes the last hole: a guard that fails for the
// wrong reason is not a working guard.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Verdicts a proof run can produce, worst first. Order is the report order. */
export const VERDICTS = {
	CONTROL_FAILED: 'control-failed',
	NOT_CAUGHT: 'not-caught',
	WRONG_REASON: 'wrong-reason',
	PROVEN: 'proven',
	DECLARED_LIVE: 'declared-live',
};

/** Verdicts that mean the guard is not demonstrably working. */
export const FAILING_VERDICTS = new Set([
	VERDICTS.CONTROL_FAILED,
	VERDICTS.NOT_CAUGHT,
	VERDICTS.WRONG_REASON,
]);

/**
 * Normalize a declared proof into the shape the runner executes.
 * Throws on a malformed declaration so the auditor can report it precisely.
 */
export function normalizeProof(guard) {
	const proof = guard.proof;
	if (!proof || typeof proof !== 'object') {
		throw new Error(`guard "${guard.id}" has no proof block`);
	}
	if (proof.kind === 'live') {
		if (!proof.reason || typeof proof.reason !== 'string') {
			throw new Error(`guard "${guard.id}" declares kind:"live" without a reason`);
		}
		return { kind: 'live', reason: proof.reason };
	}
	if (!proof.summary || typeof proof.summary !== 'string') {
		throw new Error(`guard "${guard.id}" proof needs a summary`);
	}
	const violation = proof.violation;
	if (!violation || typeof violation !== 'object') {
		throw new Error(`guard "${guard.id}" proof needs a violation block`);
	}
	const writes = violation.write ?? {};
	const appends = violation.append ?? {};
	const deletes = violation.delete ?? [];
	const links = violation.link ?? {};
	const jsonOps = violation.json ?? [];
	if (!Array.isArray(deletes)) {
		throw new Error(`guard "${guard.id}" violation.delete must be an array`);
	}
	if (!Array.isArray(jsonOps)) {
		throw new Error(`guard "${guard.id}" violation.json must be an array`);
	}
	const mutations =
		Object.keys(writes).length +
		Object.keys(appends).length +
		Object.keys(links).length +
		deletes.length +
		jsonOps.length;
	if (!mutations) throw new Error(`guard "${guard.id}" violation mutates nothing`);
	for (const op of jsonOps) {
		if (!op || typeof op.file !== 'string' || typeof op.pointer !== 'string') {
			throw new Error(`guard "${guard.id}" json op needs file + pointer`);
		}
		const kinds = ['insert', 'set', 'removeWhere'].filter((k) => k in op);
		if (kinds.length !== 1) {
			throw new Error(`guard "${guard.id}" json op needs exactly one of insert/set/removeWhere`);
		}
	}
	if (!proof.expect || typeof proof.expect !== 'string') {
		throw new Error(`guard "${guard.id}" proof needs an expect fragment`);
	}
	return {
		kind: 'mutation',
		summary: proof.summary,
		setup: proof.setup ?? {},
		stage: proof.stage === true,
		violation: { write: writes, append: appends, delete: deletes, link: links, json: jsonOps },
		expect: proof.expect,
	};
}

/** Every sandbox path a proof reads or writes, for snapshot and restore. */
export function touchedPaths(proof) {
	if (proof.kind === 'live') return [];
	return [
		...Object.keys(proof.setup),
		...Object.keys(proof.violation.write),
		...Object.keys(proof.violation.append),
		...Object.keys(proof.violation.link),
		...proof.violation.json.map((op) => op.file),
		...proof.violation.delete,
	];
}

/** Capture the current bytes of each path (null when absent). */
export function snapshot(root, paths) {
	const saved = new Map();
	for (const rel of paths) {
		if (saved.has(rel)) continue;
		const abs = path.join(root, rel);
		// lstat, not existsSync: a proof may replace a path with a symlink, and
		// following it would snapshot the target's bytes and then restore them
		// over the link's location.
		let stat = null;
		try {
			stat = lstatSync(abs);
		} catch {
			stat = null;
		}
		saved.set(rel, stat?.isFile() ? readFileSync(abs) : null);
	}
	return saved;
}

/** Put every captured path back exactly as it was. */
export function restore(root, saved) {
	for (const [rel, bytes] of saved) {
		const abs = path.join(root, rel);
		if (bytes === null) {
			rmSync(abs, { force: true });
		} else {
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, bytes);
		}
	}
}

/**
 * Render a fixture body.
 *
 * Two escapes exist because the alternative is a fixture that rots:
 *   {{pkg.version}}  the repo's current version. check-dist compares
 *                    dist/agent-3d/versions.json against package.json, so a
 *                    hardcoded version would make the proof fail on the next
 *                    release rather than when the guard breaks.
 *   { fill: n }      n bytes of filler. Two guards assert a minimum artifact
 *                    size, and a megabyte of literal text does not belong in a
 *                    registry a human reads.
 */
export function renderFixture(body, context = {}) {
	if (body && typeof body === 'object' && Number.isInteger(body.fill)) {
		return Buffer.alloc(body.fill, body.byte ?? 'x');
	}
	return String(body).replace(/\{\{pkg\.version\}\}/g, context.pkgVersion ?? '0.0.0');
}

/** Write a file, creating parent directories. */
export function writeInto(root, rel, contents, context) {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, renderFixture(contents, context));
}

/** Apply a set of files verbatim. */
export function applyFiles(root, files, context) {
	for (const [rel, contents] of Object.entries(files)) writeInto(root, rel, contents, context);
}

/**
 * Resolve a dot-path pointer inside a parsed JSON document.
 * `routes`, `sections.2.pages` — numeric segments index arrays.
 */
export function resolvePointer(doc, pointer) {
	let node = doc;
	for (const segment of pointer.split('.').filter(Boolean)) {
		if (node == null) return undefined;
		node = node[/^\d+$/.test(segment) ? Number(segment) : segment];
	}
	return node;
}

/** Shallow "every listed key matches" predicate, for removeWhere. */
function matchesWhere(candidate, where) {
	if (!candidate || typeof candidate !== 'object') return false;
	return Object.entries(where).every(([k, v]) => candidate[k] === v);
}

/**
 * Edit a JSON file in place.
 *
 * Some guards can only be violated by changing a large committed registry
 * (vercel.json, a golden fixture, a server manifest). Pasting the whole file
 * into a fixture would make the proof unreadable and would rot the moment the
 * real file changed, so proofs describe the edit instead of the result.
 */
export function applyJsonOp(root, op) {
	const abs = path.join(root, op.file);
	const doc = JSON.parse(readFileSync(abs, 'utf8'));
	if ('set' in op) {
		const segments = op.pointer.split('.').filter(Boolean);
		const leaf = segments.pop();
		const parent = segments.length ? resolvePointer(doc, segments.join('.')) : doc;
		if (parent == null) throw new Error(`json op: ${op.file} has no ${op.pointer}`);
		parent[/^\d+$/.test(leaf) ? Number(leaf) : leaf] = op.set;
	} else {
		const target = resolvePointer(doc, op.pointer);
		if (!Array.isArray(target)) throw new Error(`json op: ${op.file}#${op.pointer} is not an array`);
		if ('insert' in op) {
			target.splice(Number.isInteger(op.at) ? op.at : 0, 0, op.insert);
		} else {
			const index = target.findIndex((entry) => matchesWhere(entry, op.removeWhere));
			if (index === -1) throw new Error(`json op: nothing in ${op.file}#${op.pointer} matches ${JSON.stringify(op.removeWhere)}`);
			target.splice(index, 1);
		}
	}
	writeFileSync(abs, `${JSON.stringify(doc, null, '\t')}\n`);
}

/** Apply the violation: writes, appends, JSON edits, symlinks, then deletes. */
export function applyViolation(root, violation) {
	applyFiles(root, violation.write);
	for (const [rel, tail] of Object.entries(violation.append)) {
		const abs = path.join(root, rel);
		const head = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
		writeInto(root, rel, head + tail);
	}
	for (const op of violation.json) applyJsonOp(root, op);
	for (const [rel, target] of Object.entries(violation.link)) {
		const abs = path.join(root, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		rmSync(abs, { force: true });
		symlinkSync(target, abs);
	}
	for (const rel of violation.delete) rmSync(path.join(root, rel), { force: true, recursive: true });
}

/**
 * Run a guard's command inside the sandbox.
 * The command is the literal package.json script, so a proof exercises exactly
 * what the gate runs and never a paraphrase of it.
 */
export function runGuard(command, cwd, timeoutMs = 180_000) {
	const started = process.hrtime.bigint();
	const res = spawnSync('sh', ['-c', command], {
		cwd,
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', GUARD_PROOF_SANDBOX: '1' },
	});
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
	return {
		code: res.status === null ? 124 : res.status,
		output,
		timedOut: res.status === null,
		ms: Math.round(ms),
	};
}

/** Trim guard output to the lines that carry the verdict. */
export function excerpt(output, limit = 6) {
	const lines = output
		.split('\n')
		.map((l) => l.replace(/\s+$/, ''))
		.filter((l) => l.trim().length);
	if (lines.length <= limit) return lines.join('\n');
	return `${lines.slice(0, limit).join('\n')}\n... ${lines.length - limit} more line(s)`;
}

/**
 * Execute one proof against a prepared sandbox and return its verdict.
 * Pure with respect to the sandbox: whatever it touched is restored on the way
 * out, so proofs run back to back in a single checkout without contaminating
 * each other.
 */
/**
 * Stage the sandbox worktree.
 *
 * Two guards read the git INDEX rather than the filesystem (`git grep` over
 * tracked files; `git ls-files -s` for committed symlinks), so an unstaged
 * fixture is invisible to them and the proof would report NOT CAUGHT for a
 * guard that works perfectly. Staging is opt-in per proof for that reason.
 */
export function stageSandbox(root) {
	spawnSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
}

/** Drop everything staging added, back to the sandbox baseline commit. */
export function unstageSandbox(root) {
	spawnSync('git', ['reset', '--quiet'], { cwd: root, stdio: 'ignore' });
}

export function proveGuard(guard, proof, sandbox, { run = runGuard, stage = stageSandbox, unstage = unstageSandbox } = {}) {
	if (proof.kind === 'live') {
		return {
			id: guard.id,
			verdict: VERDICTS.DECLARED_LIVE,
			reason: proof.reason,
			ms: 0,
		};
	}

	const saved = snapshot(sandbox, touchedPaths(proof));
	try {
		applyFiles(sandbox, proof.setup);
		const control = run(guard.command, sandbox);
		if (control.code !== 0) {
			return {
				id: guard.id,
				verdict: VERDICTS.CONTROL_FAILED,
				summary: proof.summary,
				controlCode: control.code,
				output: excerpt(control.output),
				ms: control.ms,
			};
		}

		applyViolation(sandbox, proof.violation);
		if (proof.stage) stage(sandbox);
		const violated = run(guard.command, sandbox);
		if (violated.code === 0) {
			return {
				id: guard.id,
				verdict: VERDICTS.NOT_CAUGHT,
				summary: proof.summary,
				controlCode: 0,
				violationCode: 0,
				output: excerpt(violated.output),
				ms: control.ms + violated.ms,
			};
		}
		if (!violated.output.includes(proof.expect)) {
			return {
				id: guard.id,
				verdict: VERDICTS.WRONG_REASON,
				summary: proof.summary,
				expect: proof.expect,
				controlCode: 0,
				violationCode: violated.code,
				output: excerpt(violated.output),
				ms: control.ms + violated.ms,
			};
		}
		return {
			id: guard.id,
			verdict: VERDICTS.PROVEN,
			summary: proof.summary,
			controlCode: 0,
			violationCode: violated.code,
			evidence: firstMatchingLine(violated.output, proof.expect),
			ms: control.ms + violated.ms,
		};
	} finally {
		if (proof.stage) unstage(sandbox);
		restore(sandbox, saved);
	}
}

/** The single output line that carries the expected fragment. */
export function firstMatchingLine(output, fragment) {
	for (const line of output.split('\n')) {
		if (line.includes(fragment)) return line.trim().slice(0, 240);
	}
	return '';
}
