#!/usr/bin/env node
/**
 * Guard the vendored worker modules.
 *
 * Each worker's Docker build context is its own directory, so `../` is
 * unreachable and shared code lives as a byte-identical copy in every worker
 * that needs it (worker_security.py, oin.py, gltf_meshopt.py and their vendored
 * tests). Nothing enforced that, so a fix applied to one copy could silently
 * leave the other seventeen on the old behaviour: the exact shape of bug this
 * repo has already paid for once.
 *
 * This compares every copy of every vendored file against the copy with the
 * most instances (the de-facto canonical one) and fails on any divergence,
 * naming the file, the workers that differ, and how to resync them.
 *
 *   node scripts/check-vendored-workers.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Files that MUST be identical wherever they appear under workers/.
const VENDORED = [
	'worker_security.py',
	'oin.py',
	'oin_upload.py',
	'gltf_meshopt.py',
	'test_gltf_meshopt.py',
];

const WORKERS_DIR = 'workers';

function digest(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function workerDirs() {
	return readdirSync(WORKERS_DIR)
		.filter((name) => {
			try {
				return statSync(join(WORKERS_DIR, name)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

const dirs = workerDirs();
const failures = [];
let checked = 0;

for (const file of VENDORED) {
	const copies = [];
	for (const dir of dirs) {
		const path = join(WORKERS_DIR, dir, file);
		try {
			statSync(path);
		} catch {
			continue;
		}
		copies.push({ dir, path, sha: digest(path) });
	}
	if (copies.length < 2) continue;
	checked += copies.length;

	const counts = new Map();
	for (const copy of copies) counts.set(copy.sha, (counts.get(copy.sha) || 0) + 1);
	const [canonicalSha] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
	const canonical = copies.find((c) => c.sha === canonicalSha);
	const drifted = copies.filter((c) => c.sha !== canonicalSha);

	if (drifted.length) {
		failures.push(
			`${file}: ${drifted.length} of ${copies.length} copies differ from ${canonical.path}\n` +
				drifted.map((c) => `    ${c.path}   (resync: cp ${canonical.path} ${c.path})`).join('\n'),
		);
	}
}

if (failures.length) {
	console.error('[check-vendored-workers] vendored worker files have drifted:\n');
	for (const failure of failures) console.error(`  ${failure}\n`);
	console.error('Fix the canonical copy, mirror it to every worker, and rerun.');
	process.exit(1);
}

console.log(
	`[check-vendored-workers] OK: ${checked} vendored file copies across ${dirs.length} workers are byte-identical`,
);
