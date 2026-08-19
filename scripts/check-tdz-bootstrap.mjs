#!/usr/bin/env node
/**
 * Refuse to ship a browser module whose bootstrap runs BEFORE the state it touches.
 *
 * Why this exists
 * ---------------
 * A module that calls its own entry point at top level, above the `let`s that
 * entry point writes, is reading bindings that are still in their temporal dead
 * zone. Whether that throws depends on the engine, so it ships green and breaks
 * in the field:
 *
 *   init();                                  // runs during module evaluation
 *   async function init() {
 *     avatar = await fetchAvatar(id);        // `avatar` is still uninitialized
 *   }
 *   let avatar = null;                       // ...declared down here
 *
 * JavaScriptCore checks an assignment target's dead zone EAGERLY, before it
 * evaluates the right-hand side, so Safari throws before the `await` is even
 * reached. V8 defers the same check until after the await, by which point module
 * evaluation has finished and the binding exists, so Chrome never notices.
 *
 * That exact shape shipped in src/avatar-page.js and took every /avatars/:id page
 * down in Safari on both iOS and macOS, rendering the engine's raw
 * "Cannot access uninitialized variable." into the page where the 3D stage
 * belongs. Chrome, Edge and Firefox were all fine, so it survived review, the
 * page audit, and a production smoke sweep.
 *
 * A synchronous READ of a later-declared binding is worse: that one throws in
 * every engine. src/three-tier-page.js (`_styled`) and public/forever.js
 * (`BTC_USD`) both hit it and both carry a hand-written comment begging the next
 * person not to reorder the file. This check enforces what those comments ask.
 *
 * The rule
 * --------
 * For every call made during module evaluation, walk the callee's SYNCHRONOUS
 * prefix (everything up to its first `await`) and flag any reference to a
 * module-level `let`/`const`/`class` declared after that call site. `var` and
 * function declarations are hoisted and initialized, so they are exempt.
 *
 * The fix is always ordering, never a try/catch: move the bootstrap call below
 * the declarations (see the "bootstrap (must run last)" blocks in
 * src/avatar-page.js and src/three-tier-page.js), or move the declarations above
 * the call. Do not rely on which engine checks when.
 *
 * Usage:
 *   node scripts/check-tdz-bootstrap.mjs                 # exits 1 on any finding
 *   node scripts/check-tdz-bootstrap.mjs --paths a.js b.js
 */

import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'acorn';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

// How deep to follow calls out of the bootstrap before giving up. The real
// regression in src/three-tier-page.js was three frames down
// (mount -> boot -> injectStyles), so a depth of 1 would have missed it.
const MAX_CALL_DEPTH = 4;

// Tracked files AND new ones git does not know about yet (`--others`), minus
// anything gitignored (`--exclude-standard`). A bare `git ls-files` cannot see a
// module that was just written, which is precisely when a new page is most
// likely to carry this ordering bug.
export function tracked(dirs) {
	// Directory pathspecs, not globs: git's `src/**/*.js` does NOT match a direct
	// child like src/avatar-page.js, so a glob silently skipped every top-level
	// page module, which is exactly where this bug class lives. Filter by
	// extension here instead, where the semantics are ours.
	return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs], { cwd: ROOT, encoding: 'utf8' })
		.split('\n')
		.filter((p) => p.endsWith('.js') || p.endsWith('.mjs'))
		.map((p) => resolve(ROOT, p));
}

// ── AST helpers ───────────────────────────────────────────────────────

/** Direct child nodes, in source order, so a traversal sees `a` before `await b` in `a = await b`. */
function childNodes(node) {
	const out = [];
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const val = node[key];
		if (Array.isArray(val)) {
			for (const v of val) if (v && typeof v.type === 'string') out.push(v);
		} else if (val && typeof val.type === 'string') {
			out.push(val);
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Every identifier a pattern binds (params, destructured locals). */
function patternNames(node, into) {
	if (!node) return into;
	switch (node.type) {
		case 'Identifier': into.add(node.name); break;
		case 'ObjectPattern': for (const p of node.properties) patternNames(p.value || p.argument, into); break;
		case 'ArrayPattern': for (const e of node.elements) patternNames(e, into); break;
		case 'AssignmentPattern': patternNames(node.left, into); break;
		case 'RestElement': patternNames(node.argument, into); break;
		default: break;
	}
	return into;
}

/**
 * Names declared inside a function body (its own scope). Approximated at
 * function granularity rather than block granularity: a local that shadows a
 * module binding suppresses the finding, which errs toward silence rather than
 * toward a false accusation.
 */
function localNames(fn) {
	const names = new Set();
	for (const p of fn.params || []) patternNames(p, names);
	if (fn.id?.name) names.add(fn.id.name);
	const walk = (n) => {
		for (const c of childNodes(n)) {
			if (FN_TYPES.has(c.type)) {
				if (c.id?.name) names.add(c.id.name);
				continue; // a nested function's own locals belong to its scope
			}
			if (c.type === 'VariableDeclarator') patternNames(c.id, names);
			if (c.type === 'ClassDeclaration' && c.id?.name) names.add(c.id.name);
			walk(c);
		}
	};
	walk(fn.body || fn);
	return names;
}

/** True when this identifier is a name rather than a value reference (`o.avatar`, `{avatar: 1}`). */
function isNonReference(node, parent) {
	if (!parent) return false;
	if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return true;
	if (parent.type === 'Property' && parent.key === node && !parent.computed) return true;
	if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return true;
	if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return true;
	if (FN_TYPES.has(parent.type) && parent.id === node) return true;
	return false;
}

// ── the check ─────────────────────────────────────────────────────────

export function analyze(file, src) {
	let ast;
	try {
		ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	} catch {
		return []; // not an ES module we can read; other checks own syntax errors
	}

	// Module-level lexical bindings (`let`/`const`/`class`). `var` and function
	// declarations are hoisted AND initialized, so they can never be in a dead zone.
	const lexical = new Map(); // name -> { start, line, kind }
	// Module-level functions, so a bootstrap call can be followed into its body.
	const functions = new Map(); // name -> fn node
	for (const stmt of ast.body) {
		const node = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
			? stmt.declaration
			: stmt;
		if (!node) continue;
		if (node.type === 'VariableDeclaration' && node.kind !== 'var') {
			for (const d of node.declarations) {
				for (const name of patternNames(d.id, new Set())) {
					lexical.set(name, { start: node.start, line: node.loc.start.line, kind: node.kind });
				}
			}
			for (const d of node.declarations) {
				if (d.init && FN_TYPES.has(d.init.type) && d.id.type === 'Identifier') functions.set(d.id.name, d.init);
			}
		}
		if (node.type === 'ClassDeclaration' && node.id?.name) {
			lexical.set(node.id.name, { start: node.start, line: node.loc.start.line, kind: 'class' });
		}
		if (node.type === 'FunctionDeclaration' && node.id?.name) functions.set(node.id.name, node);
	}
	if (!lexical.size || !functions.size) return [];

	const findings = [];

	/**
	 * Walk a function's synchronous prefix: everything evaluated before its first
	 * `await`. Returns once an await is reached, because module evaluation has
	 * completed by the time the continuation runs and every binding is live.
	 */
	function scanSync(fn, callSite, depth, seen, chain) {
		if (depth > MAX_CALL_DEPTH || seen.has(fn)) return;
		seen.add(fn);
		const locals = localNames(fn);
		let stopped = false;

		const walk = (node, parent) => {
			if (stopped) return;
			if (node.type === 'AwaitExpression') { stopped = true; return; }
			// A nested function body is not part of this synchronous prefix; it runs
			// whenever its callback fires, long after module evaluation.
			if (FN_TYPES.has(node.type) && node !== fn) return;

			if (node.type === 'Identifier' && !isNonReference(node, parent) && !locals.has(node.name)) {
				const decl = lexical.get(node.name);
				if (decl && decl.start > callSite.start) {
					const write = parent?.type === 'AssignmentExpression' && parent.left === node;
					findings.push({
						file,
						name: node.name,
						kind: decl.kind,
						useLine: node.loc.start.line,
						declLine: decl.line,
						callLine: callSite.loc.start.line,
						callName: callSite.name,
						write,
						chain: chain.join(' -> '),
					});
				}
			}

			for (const c of childNodes(node)) {
				if (stopped) return;
				walk(c, node);
				// Follow a synchronous call into a module-level function.
				if (c.type === 'CallExpression' && c.callee.type === 'Identifier' && !locals.has(c.callee.name)) {
					const target = functions.get(c.callee.name);
					if (target) scanSync(target, callSite, depth + 1, seen, [...chain, c.callee.name]);
				}
			}
		};
		walk(fn.body || fn, null);
		seen.delete(fn);
	}

	// Every call made during module evaluation, i.e. at the top level of the
	// module body rather than inside a function.
	for (const stmt of ast.body) {
		if (FN_TYPES.has(stmt.type) || stmt.type === 'ImportDeclaration') continue;
		const collect = (node) => {
			if (FN_TYPES.has(node.type)) return; // deferred, not module-evaluation time
			if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
				const fn = functions.get(node.callee.name);
				if (fn) {
					scanSync(fn, { start: node.start, loc: node.loc, name: node.callee.name }, 1, new Set(), [node.callee.name]);
				}
			}
			for (const c of childNodes(node)) collect(c);
		};
		collect(stmt);
	}

	// One finding per binding per file; the first use is the one to fix.
	const byName = new Map();
	for (const f of findings) if (!byName.has(f.name)) byName.set(f.name, f);
	return [...byName.values()];
}

// ── run ───────────────────────────────────────────────────────────────

// Importable for tests (`analyze` above); the sweep runs only as a command.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();

function main() {
const argv = process.argv.slice(2);
const pathsFlag = argv.indexOf('--paths');
const files = pathsFlag !== -1
	? argv.slice(pathsFlag + 1).filter((a) => !a.startsWith('--')).map((p) => resolve(ROOT, p))
	: tracked(['src', 'public']);

const all = [];
for (const file of files) {
	let src;
	try { src = readFileSync(file, 'utf8'); } catch { continue; }
	if (!src.includes('let ') && !src.includes('const ')) continue;
	all.push(...analyze(relative(ROOT, file), src));
}

if (!all.length) {
	console.log(`check:tdz-bootstrap: no bootstrap-before-state ordering in ${files.length} browser module(s)`);
	process.exit(0);
}

console.error(`\ncheck:tdz-bootstrap: ${all.length} module-evaluation reference(s) to a binding declared later:\n`);
for (const f of all) {
	const how = f.write ? 'assigns' : 'reads';
	console.error(`  ${f.file}:${f.useLine}  ${how} \`${f.name}\` (${f.kind} declared at line ${f.declLine})`);
	console.error(`    reached synchronously from ${f.callName}() at line ${f.callLine}  [${f.chain}]`);
}
console.error(`
Each of these runs during module evaluation, while the binding is still in its
temporal dead zone. A synchronous READ throws in every engine. An ASSIGNMENT
throws only in JavaScriptCore, which checks the target's dead zone before it
evaluates the right-hand side, so the page dies in Safari on iOS and macOS while
Chrome and Firefox stay green.

Fix by ordering, not by catching. Move the bootstrap call below the
declarations, as src/avatar-page.js and src/three-tier-page.js both do:

    let avatar = null;            // every binding the entry point writes

    // ── bootstrap (must run last) ──
    init().catch(renderError);
`);
process.exit(1);
}
