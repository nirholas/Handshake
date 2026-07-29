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

const IMPORT_RE =
	/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\(\s*['"]([^'"]+)['"]\s*\)/g;

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

// ── Seed from what the browser actually loads: every tracked HTML entry ───────
const parent = new Map();
const queue = [];

function enqueue(file, from) {
	if (parent.has(file)) return;
	parent.set(file, from);
	queue.push(file);
}

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
		if (existsSync(abs)) enqueue(abs, label);
	}
	for (const m of src.matchAll(IMPORT_RE)) {
		const spec = m[1] || m[2];
		if (!spec || /^(https?:)?\/\//.test(spec)) continue;
		const abs = spec.startsWith('/')
			? resolve(ROOT, spec.slice(1))
			: resolveLocal(html, spec);
		if (abs && existsSync(abs)) enqueue(abs, label);
	}
}

// ── Walk it ──────────────────────────────────────────────────────────────────
const leaks = [];

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

while (queue.length) {
	const file = queue.shift();
	for (const { spec, dynamic } of specifiersOf(file)) {
		const builtin = builtinName(spec);
		if (builtin) {
			if (!dynamic && !POLYFILLED.has(builtin)) leaks.push({ file, spec, chain: chainTo(file) });
			continue;
		}
		if (!spec.startsWith('.')) continue; // bare package — the bundler's problem, not ours
		const next = resolveLocal(file, spec);
		if (next) enqueue(next, file);
	}
}

if (!leaks.length) {
	console.log(`check:browser-graph — no Node-only imports reachable from ${parent.size} browser modules`);
	process.exit(0);
}

// One report per (module, specifier); the shortest chain is the clearest.
const byKey = new Map();
for (const leak of leaks) {
	const key = `${relative(ROOT, leak.file)}::${leak.spec}`;
	const prev = byKey.get(key);
	if (!prev || leak.chain.length < prev.chain.length) byKey.set(key, leak);
}

console.error(`\ncheck:browser-graph — ${byKey.size} Node-only import(s) reachable from the browser bundle:\n`);
for (const leak of byKey.values()) {
	console.error(`  ${relative(ROOT, leak.file)} imports "${leak.spec}"`);
	console.error(`    ${leak.chain.join('\n      -> ')}\n`);
}
console.error(`This breaks \`npm run build\` (rollup resolves the built-in to
__vite-browser-external and fails on its named exports) — and it fails AFTER the
vite step has wiped dist/.

Fix at the boundary, not with a polyfill: load the server-only module lazily
behind a server check, so the browser keeps correct local-only behaviour.

    let _mod = null;
    function serverOnly() {
      if (typeof window !== 'undefined') return null;
      if (!_mod) _mod = import('./server-only.js').catch(() => null);
      return _mod;
    }
`);
process.exit(1);
