/**
 * No STATIC `node:` builtin import may be reachable from a browser entry point.
 *
 * Why this exists
 * ---------------
 * `api/_lib/*` is server code by intent, but parts of it are legitimately
 * reachable from the browser bundle: the isomorphic SNS resolver imports the
 * shared Solana connection, which imports the shared cache.
 *
 *   pages/app.html → src/app.js → src/agent-skills-scene.js → src/agent-skills.js
 *   → src/agent-skills-pumpfun.js → src/solana/sns.js
 *   → api/_lib/solana/connection.js → api/_lib/cache.js
 *
 * On 2026-07-29 a gzip wire codec landed in `api/_lib/cache.js` with a static
 * `import { promisify } from 'node:util'`. Vite externalizes `node:*` for the
 * browser, so that named binding resolves against `__vite-browser-external`,
 * which exports nothing — and the ENTIRE frontend build died with
 * `"promisify" is not exported by "__vite-browser-external"`.
 *
 * Nothing caught it. The browser never reaches the codec at RUNTIME, so no test
 * exercised it; only the bundler sees it, at parse time. The failure therefore
 * surfaced during a production deploy, after `build:gcp` had already wiped
 * `dist/` — the most expensive possible moment.
 *
 * The fix is always the same: load the builtin lazily (`await import('node:…')`)
 * inside the function that needs it. That keeps the module graph browser-safe
 * and leaves the server path unchanged.
 *
 * This walks the real import graph offline — no network, no bundler, no flake.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Browser entry points. Anything reachable from here is bundled by Vite.
const ENTRIES = [
	'src/app.js',
	'src/agent-skills.js',
	'src/i18n.js',
	'src/notifications.js',
	'src/footer-bot.js',
	'src/walk-companion.js',
	'src/feature-tour.js',
];

// Static `import ... from 'x'` / `export ... from 'x'` only. A bare
// `import('x')` is deliberately NOT matched: a dynamic import is exactly the
// approved escape hatch, since the bundler emits it as a separate chunk that
// the browser never has to resolve.
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)(?:["'\s]*[\w*{}\n\r\t, $]+from\s*)?\s*['"]([^'"]+)['"]/g;

function resolveSpec(fromFile, spec) {
	if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // bare pkg
	const base = spec.startsWith('/') ? join(ROOT, spec.slice(1)) : resolve(dirname(fromFile), spec);
	for (const cand of [base, `${base}.js`, join(base, 'index.js')]) {
		if (existsSync(cand)) return cand;
	}
	return null;
}

/** Walk the static graph from `entries`, returning file → shortest chain from an entry. */
function reachable(entries) {
	const chains = new Map();
	const queue = [];
	for (const e of entries) {
		const abs = join(ROOT, e);
		if (!existsSync(abs)) continue;
		chains.set(abs, [e]);
		queue.push(abs);
	}
	while (queue.length) {
		const file = queue.shift();
		let src;
		try {
			src = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		for (const m of src.matchAll(STATIC_IMPORT)) {
			const target = resolveSpec(file, m[1]);
			if (!target || chains.has(target)) continue;
			chains.set(target, [...chains.get(file), target.replace(`${ROOT}/`, '')]);
			queue.push(target);
		}
	}
	return chains;
}

/** Node builtins imported STATICALLY by a file, with the specifier as written. */
function staticNodeImports(file) {
	let src;
	try {
		src = readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	return [...src.matchAll(STATIC_IMPORT)]
		.map((m) => m[1])
		.filter((spec) => spec.startsWith('node:'));
}

describe('browser bundle: no static node: builtin imports', () => {
	const graph = reachable(ENTRIES);

	it('reaches a meaningful slice of the codebase (guards the walker itself)', () => {
		// If the walker silently stopped resolving, every other assertion here
		// would pass vacuously. The real graph is thousands of files.
		expect(graph.size).toBeGreaterThan(200);
	});

	it('resolves multi-hop transitive imports, not just direct ones', () => {
		// The leak was four hops deep. If the walker only ever resolved an
		// entry's direct imports, the assertion below would pass vacuously and
		// the guard would be worthless. agent-skills.js -> agent-skills-pumpfun.js
		// is a plain static edge two hops from an entry.
		expect(graph.has(join(ROOT, 'src/agent-skills-pumpfun.js'))).toBe(true);
	});

	it('has no browser-reachable file statically importing a node: builtin', () => {
		const offenders = [];
		for (const [file, chain] of graph) {
			const builtins = staticNodeImports(file);
			if (!builtins.length) continue;
			offenders.push(
				`${file.replace(`${ROOT}/`, '')} statically imports ${builtins.join(', ')}\n` +
					`      reached via: ${chain.join(' -> ')}\n` +
					`      fix: load it lazily inside the function that needs it — await import('${builtins[0]}')`,
			);
		}
		expect(offenders, `\n\n${offenders.join('\n\n')}\n`).toEqual([]);
	});
});
