/**
 * Agora life-engine container: does the image actually carry everything the
 * worker imports? (Task 11 hardening.)
 *
 * The worker runs OUTSIDE api/, but reaches across that boundary anyway
 * (api/_lib/env.js, api/_lib/feed.js, api/_lib/r2.js, packages/forge). The
 * Dockerfile has to COPY each of those explicitly, and nothing about adding a
 * new cross-boundary import reminds you to.
 *
 * This is not a theoretical worry: workers/agora-citizens/config.js grew an
 * `import { resolveDatabaseUrl } from '../../api/_lib/env.js'` while the
 * Dockerfile still copied only `workers/agora-citizens` and `solana-agent-sdk`.
 * The image BUILT clean and then died on boot with
 * "Cannot find module '/app/api/_lib/env.js'" - a failure a build-time check
 * cannot see, because the build genuinely succeeds.
 *
 * So: resolve every path the worker imports from outside its own directory and
 * assert the Dockerfile copies a directory that contains it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = join(ROOT, 'workers', 'agora-citizens');
const DOCKERFILE = join(WORKER_DIR, 'Dockerfile');

/** Every .js file under the worker directory. */
function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (name.endsWith('.js')) out.push(full);
	}
	return out;
}

/** Repo-relative targets the worker imports from outside its own directory. */
function crossBoundaryImports() {
	const found = new Set();
	// Static `from '...'` and dynamic `import('...')`, relative specifiers only.
	const re = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;
	for (const file of walk(WORKER_DIR)) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(re)) {
			const target = resolve(dirname(file), m[1]);
			const rel = relative(WORKER_DIR, target);
			if (rel.startsWith('..')) found.add(relative(ROOT, target));
		}
	}
	return [...found].sort();
}

/** Paths the Dockerfile COPYs out of the build context. */
function dockerfileCopies() {
	const copies = [];
	for (const line of readFileSync(DOCKERFILE, 'utf8').split('\n')) {
		const m = line.match(/^COPY\s+(.+)$/i);
		if (!m) continue;
		const parts = m[1].trim().split(/\s+/);
		// Last token is the destination; everything before it is a source.
		for (const src of parts.slice(0, -1)) copies.push(src.replace(/^\.\//, ''));
	}
	return copies;
}

describe('agora-citizens image carries the worker dependencies', () => {
	const imports = crossBoundaryImports();
	const copies = dockerfileCopies();

	it('finds the cross-boundary imports it is meant to guard', () => {
		// A sanity check on the scanner itself: if this ever goes empty, the test
		// above would vacuously pass and guard nothing.
		expect(imports.length).toBeGreaterThan(0);
		expect(imports).toContain('api/_lib/env.js');
	});

	it.each(crossBoundaryImports())('Dockerfile COPYs the source for %s', (target) => {
		const covered = copies.some((c) => target === c || target.startsWith(`${c}/`));
		expect(
			covered,
			`workers/agora-citizens imports ${target}, but no COPY in workers/agora-citizens/Dockerfile ` +
				`brings it into the image. The build will still succeed and the container will crash on boot ` +
				`with "Cannot find module". Add a COPY for it.\nCurrent COPY sources: ${copies.join(', ')}`,
		).toBe(true);
	});
});
