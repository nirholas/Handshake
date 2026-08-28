#!/usr/bin/env node
/**
 * Refuse to build when a Node-only module has leaked into the BROWSER bundle.
 *
 * Why this exists
 * ---------------
 * `api/` is server code and `src/` is browser code, but a handful of `src/`
 * modules legitimately reuse a shared helper from `api/_lib/` (SNS resolution,
 * BNB chain clients, vault message signing). That shortcut is only safe while
 * the helper it reaches stays free of Node built-ins — and nothing enforced it.
 *
 * On 2026-07-29 `api/_lib/solana/connection.js` gained a top-level
 * `import { cacheGet, cacheSet } from '../cache.js'` for a fleet-wide RPC
 * breaker. `api/_lib/cache.js` statically imports `node:zlib` and `node:util`,
 * and connection.js is reachable from a real browser entry:
 *
 *   public/agent/index.html
 *     → src/agent-skills.js → src/agent-skills-pumpfun.js
 *     → src/solana/sns.js → api/_lib/solana/connection.js → api/_lib/cache.js
 *
 * `npm run build` died with `"promisify" is not exported by
 * "__vite-browser-external"` after four minutes — AFTER the vite step had
 * already wiped `dist/`. Every deploy was blocked until it was traced by hand.
 *
 * This walks the same graph the bundler does, starting from the HTML entries,
 * and fails with the exact import chain the moment a `node:` built-in becomes
 * reachable. It runs in milliseconds, before anything is built or destroyed.
 *
 * The fix at the other end is usually not "make the helper browser-safe" but
 * "do not reach L2 from a browser at all": load the server-only piece lazily
 * behind a `typeof window === 'undefined'` check, so the browser keeps a
 * correct local-only behaviour and the bundler never sees the built-in.
 *
 * Usage:
 *   node scripts/check-browser-graph.mjs          # exits 1 on any leak
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

// Built-ins that have no browser implementation. `node:`-prefixed specifiers are
// unambiguous; bare 'fs'/'path' style imports are caught by the same list.
const NODE_BUILTINS = new Set([
	'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram',
	'dns', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks',
	'process', 'readline', 'repl', 'stream', 'string_decoder', 'tls', 'tty', 'url',
	'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

// `node:crypto`, `node:buffer` and `node:process` have real browser shims that
// vite/rollup substitute cleanly (vite-plugin-node-polyfills is configured), so
// they are not build breakers. Everything else is.
const POLYFILLED = new Set(['crypto', 'buffer', 'process', 'stream', 'util/types']);

function tracked(patterns) {
	return execFileSync('git', ['ls-files', ...patterns], { cwd: ROOT, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean)
		.map((f) => resolve(ROOT, f))
		.filter((f) => existsSync(f)); // a tracked-but-deleted path is not our problem
}

// Three shapes, in order: a static `import`/`export ... from '...'` (the name
// clause may span lines, so newlines are allowed between the keyword and
// `from`. A `[^'"\n]` class here silently skipped every multi-line import,
// which is most of them in this repo and hid 44 real edges), a dynamic
// `import('...')`, and a bare side-effect `import '...'`.
const IMPORT_RE =
	/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/**
 * Every specifier `file` imports, tagged static vs dynamic.
 *
 * The distinction is the whole point for built-ins. A STATIC
 * `import { promisify } from 'node:util'` is what breaks the build: rollup
 * swaps the module for __vite-browser-external and then rejects the named
 * export. A DYNAMIC `await import('node:util')` is the sanctioned escape hatch
 * — it stays an external dynamic import with no module-level named bindings to
 * check, and it only evaluates on the server path that actually calls it. So
 * dynamic built-in imports are deliberately NOT leaks.
 */
function specifiersOf(file) {
	let src;
	try { src = readFileSync(file, 'utf8'); } catch { return []; }
	const out = [];
	for (const m of src.matchAll(IMPORT_RE)) {
		if (m[1]) out.push({ spec: m[1], dynamic: false });
		else if (m[2]) out.push({ spec: m[2], dynamic: true });
		else if (m[3]) out.push({ spec: m[3], dynamic: false });
	}
	return out;
}

function resolveLocal(fromFile, spec) {
	let p = resolve(dirname(fromFile), spec);
	if (existsSync(p) && !p.endsWith('.js') && existsSync(resolve(p, 'index.js'))) return resolve(p, 'index.js');
	if (!existsSync(p) && existsSync(`${p}.js`)) p = `${p}.js`;
	return existsSync(p) ? p : null;
}

function builtinName(spec) {
	const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
	const root = bare.split('/')[0];
	return NODE_BUILTINS.has(root) ? root : null;
}

// ── Two browser targets, two graphs ──────────────────────────────────────────
// The APP target (vite build → dist/) code-splits, so a dynamic import stays a
// separate chunk that only the server branch ever fetches. The LIB target
// (dist-lib/agent-3d.js, the <agent-3d> CDN embed) builds with
// `rollupOptions.output.inlineDynamicImports` so CDN consumers get one file,
// and that flattens EVERY dynamic import into the bundle. A `import()` behind a
// `typeof window === 'undefined'` guard is therefore safe in the app and a hard
// build break in the lib: on 2026-08-28 `src/shared/failover-fetch.js` reached
// api/_lib/brownout/ that way and killed build:lib:full with
// `"AsyncLocalStorage" is not exported by "__vite-browser-external"`, three
// steps before the app build this script had already cleared.
//
// So each target is walked under its own rule for dynamic edges.

/**
 * @param {{label: string, seeds: () => Array<[string, string]>, inlineDynamic: boolean}} target
 *   seeds() yields [absolute file, human-readable origin] pairs.
 */
function walk(target) {
	const parent = new Map();
	const queue = [];
	const leaks = [];

	function enqueue(file, from) {
		if (parent.has(file)) return;
		parent.set(file, from);
		queue.push(file);
	}

	function chainTo(file) {
		const chain = [];
		let cur = file;
		while (cur && typeof cur === 'string' && cur.startsWith('/')) {
			chain.unshift(relative(ROOT, cur));
			cur = parent.get(cur);
		}
		if (cur) chain.unshift(cur);
		return chain;
	}

	for (const [file, from] of target.seeds()) enqueue(file, from);

	while (queue.length) {
		const file = queue.shift();
		for (const { spec, dynamic } of specifiersOf(file)) {
			// A dynamic edge is followed only where the bundler inlines it.
			const followed = !dynamic || target.inlineDynamic;
			const builtin = builtinName(spec);
			if (builtin) {
				if (followed && !POLYFILLED.has(builtin)) {
					leaks.push({ file, spec, chain: chainTo(file) });
				}
				continue;
			}
			if (!followed) continue;
			if (!spec.startsWith('.')) continue; // bare package, the bundler's problem and not ours
			const next = resolveLocal(file, spec);
			if (next) enqueue(next, file);
		}
	}

	return { parent, leaks };
}

function htmlSeeds() {
	const out = [];
	for (const html of tracked(['pages/*.html', 'public/**/*.html', '*.html'])) {
		let src;
		try { src = readFileSync(html, 'utf8'); } catch { continue; }
		const label = relative(ROOT, html);
		for (const m of src.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
			const spec = m[1];
			if (/^(https?:)?\/\//.test(spec)) continue;
			const abs = spec.startsWith('/')
				? resolve(ROOT, spec.slice(1))
				: resolve(dirname(html), spec);
			if (existsSync(abs)) out.push([abs, label]);
		}
		for (const m of src.matchAll(IMPORT_RE)) {
			const spec = m[1] || m[2] || m[3];
			if (!spec || /^(https?:)?\/\//.test(spec)) continue;
			const abs = spec.startsWith('/')
				? resolve(ROOT, spec.slice(1))
				: resolveLocal(html, spec);
			if (abs && existsSync(abs)) out.push([abs, label]);
		}
	}
	return out;
}

// build.lib.entry in vite.config.js. Kept as a check, not a silent skip: if the
// entry is ever renamed, this script must fail loudly rather than quietly stop
// covering the CDN bundle.
const LIB_ENTRY = resolve(ROOT, 'src/lib.js');
if (!existsSync(LIB_ENTRY)) {
	console.error(`check:browser-graph: lib entry ${relative(ROOT, LIB_ENTRY)} is missing.
It is build.lib.entry in vite.config.js; update this script if it moved.`);
	process.exit(1);
}

const TARGETS = [
	{ label: 'app (dist/)', seeds: htmlSeeds, inlineDynamic: false },
	{ label: 'lib (dist-lib/agent-3d.js)', seeds: () => [[LIB_ENTRY, 'build.lib.entry']], inlineDynamic: true },
];

const results = TARGETS.map((t) => ({ target: t, ...walk(t) }));
const failures = results.filter((r) => r.leaks.length);

if (!failures.length) {
	const seen = new Set();
	for (const r of results) for (const f of r.parent.keys()) seen.add(f);
	console.log(`check:browser-graph: no Node-only imports reachable from ${seen.size} browser modules across ${TARGETS.length} targets`);
	process.exit(0);
}

for (const { target, leaks } of failures) {
	// One report per (module, specifier); the shortest chain is the clearest.
	const byKey = new Map();
	for (const leak of leaks) {
		const key = `${relative(ROOT, leak.file)}::${leak.spec}`;
		const prev = byKey.get(key);
		if (!prev || leak.chain.length < prev.chain.length) byKey.set(key, leak);
	}

	console.error(`\ncheck:browser-graph: ${byKey.size} Node-only import(s) reachable from the ${target.label} bundle:\n`);
	for (const leak of byKey.values()) {
		console.error(`  ${relative(ROOT, leak.file)} imports "${leak.spec}"`);
		console.error(`    ${leak.chain.join('\n      -> ')}\n`);
	}
	if (target.inlineDynamic) {
		console.error(`  (this target inlines dynamic imports, so a server-only \`import()\`
  behind a window check counts here even though the app target tolerates it)\n`);
	}
}

console.error(`This breaks the build (rollup resolves the built-in to
__vite-browser-external and fails on its named exports), and for the app target
it fails AFTER the vite step has wiped dist/.

Fix at the boundary, not with a polyfill: load the server-only module lazily
behind a server check, so the browser keeps correct local-only behaviour.

    let _mod = null;
    function serverOnly() {
      if (typeof window !== 'undefined') return null;
      if (!_mod) _mod = import('./server-only.js').catch(() => null);
      return _mod;
    }

If the leak is in the lib graph, that is not enough on its own: the specifier
must also be unreadable to rollup, because inlineDynamicImports follows a
literal one anyway. Build it at runtime, as src/shared/failover-fetch.js does:

    const SPEC = ['.', 'server-only.js'].join('/');
    _mod = import(/* @vite-ignore */ SPEC).catch(() => null);
`);
process.exit(1);
