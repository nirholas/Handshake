// AST analysis of every outbound call in the repo.
//
// Regex cannot answer the question this file exists to answer. "Does this call
// have a deadline" is not a property of the line the call is written on: the
// options object may be built three statements earlier, the deadline may arrive
// through a wrapper, and a `signal,` shorthand looks nothing like `signal:`.
// An earlier regex sweep of this same repo reported one unguarded call and was
// wrong twice over, in both directions. Parsing is what makes the audit
// trustworthy enough to gate a deploy on.
//
// What it produces, per call site: which upstream is being talked to, and which
// of the five protections are present (deadline, retry, failover, lastGood,
// breaker). Everything downstream of this module (the grade, the ratchet, the
// generated map) is a projection of that one table.

import { readFileSync } from 'node:fs';
import { relative, resolve, dirname, join } from 'node:path';
import * as acorn from 'acorn';

// A local walker rather than acorn-walk. This module gates a deploy, so it is
// deliberately free of dependencies beyond the parser itself: the traversal it
// needs is a generic descent that carries the ancestor chain, which is shorter
// than the code that would justify pulling a package in for it.
function walkWithAncestors(node, visit, ancestors = []) {
	if (node === null || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) walkWithAncestors(child, visit, ancestors);
		return;
	}
	if (typeof node.type !== 'string') return;
	visit(node, ancestors);
	ancestors.push(node);
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
		walkWithAncestors(node[key], visit, ancestors);
	}
	ancestors.pop();
}

// Helpers whose use IS the protection: calling one of these is what a guarded
// call site looks like in this repo, so the analyzer resolves them by name
// rather than re-deriving their internals at every call site. Adding a new
// shared helper means adding it here, which is the one maintenance cost.
export const GUARDS = {
	fetchUpstream: ['deadline', 'retry', 'breaker'],
	fetchUpstreamJson: ['deadline', 'retry', 'breaker'],
	fetchAnyJson: ['deadline', 'retry', 'failover'],
	lastGood: ['lastGood'],
	lastGoodValue: ['lastGood'],
	cacheWrapLastGood: ['lastGood'],
	fetchFirst: ['deadline', 'failover'],
	fetchFirstOrNull: ['deadline', 'failover'],
	pumpFetchJson: ['deadline', 'retry'],
	geckoFetch: ['deadline', 'lastGood'],
	paprikaGet: ['deadline'],
	withRetry: ['retry'],
	withBreaker: ['breaker'],
	withRetryAndBreaker: ['retry', 'breaker'],
	makeRotatingFetch: ['deadline', 'failover'],
	// The rotating RPC clients bound each attempt themselves (see
	// makeRotatingFetch in api/_lib/solana/connection.js), so using one is a
	// bounded call even though no deadline is written at the call site.
	solanaConnection: ['deadline', 'failover'],
	evmFallbackProvider: ['deadline', 'failover'],
	evmTransport: ['deadline', 'failover'],
	resolveURI: ['deadline', 'failover'],
	fetchWithFallback: ['deadline', 'failover'],
	loadModule: ['deadline', 'failover'],
	loadScript: ['deadline', 'failover'],
};

// Guards whose first argument is a LIST of providers rather than one URL. Their
// whole point is that several hosts back one read, so each entry is recorded as
// its own call site: that is what makes a failover chain visible per upstream
// instead of collapsing to a single anonymous row.
export const LIST_GUARDS = new Set(['fetchFirst', 'fetchFirstOrNull', 'fetchAnyJson']);

export const PROTECTIONS = ['deadline', 'retry', 'failover', 'lastGood', 'breaker'];

// A relative URL, or one aimed at this machine, is our own origin: covered by
// the same-origin client rather than by upstream failover, so it is out of scope.
const INTERNAL_URL_RE = /^(?:\/|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|(?:[a-z0-9-]+\.)*three\.ws))/i;

// Marks the position of a `${...}` hole in a reconstructed template literal.
const HOLE = '__EXPR__';

/** Hostname for a URL-ish string, or null when it is relative or unknowable. */
export function hostOf(raw) {
	if (typeof raw !== 'string') return null;
	const m = raw.match(/^https?:\/\/([^/?#]+)/i);
	return m ? m[1].toLowerCase() : null;
}

// A template literal's static skeleton: `${BASE}/coins/${mint}` becomes
// "<HOLE>/coins/<HOLE>", which is enough to recognise an absolute URL and to
// name the upstream whenever the host half is written literally.
function staticText(node, consts = null) {
	if (!node) return '';
	if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : '';
	if (node.type === 'TemplateLiteral') {
		// Substitute a known module-level constant into its hole so
		// `${PUMP_BASE}/coins/x` is attributed to the host PUMP_BASE holds,
		// instead of collapsing into an anonymous "dynamic" row.
		return node.quasis
			.map((q, i) => {
				if (i >= node.expressions.length) return q.value.cooked;
				const filled = staticText(node.expressions[i], consts);
				return q.value.cooked + (filled && filled !== HOLE ? filled : HOLE);
			})
			.join('');
	}
	if (node.type === 'BinaryExpression' && node.operator === '+') {
		return staticText(node.left, consts) + staticText(node.right, consts);
	}
	if (node.type === 'Identifier') {
		const known = consts?.get(node.name);
		return known !== undefined ? known : HOLE;
	}
	if (node.type === 'MemberExpression') return HOLE;
	return '';
}

/** Does this options-object AST node carry a deadline? */
function objectHasDeadline(node) {
	if (!node || node.type !== 'ObjectExpression') return false;
	return node.properties.some((p) => {
		if (p.type === 'SpreadElement') return false;
		const key = p.key?.name ?? p.key?.value;
		// `signal: x`, the `signal` shorthand, and an explicit timeout all count.
		return key === 'signal' || key === 'timeout' || key === 'timeoutMs';
	});
}

function calleeName(node) {
	if (!node) return null;
	if (node.type === 'Identifier') return node.name;
	if (node.type === 'MemberExpression') return node.property?.name ?? null;
	return null;
}

function displayUrl(text) {
	return text.split(HOLE).join('${}');
}

/**
 * Analyze one source file.
 *
 * @param {string} code
 * @param {string} file  path used for reporting
 * @returns {{ callSites: Array<object>, parseError: string | null }}
 */
export function analyzeSource(code, file, resolveImported = null) {
	let ast;
	try {
		ast = acorn.parse(code, {
			ecmaVersion: 'latest',
			sourceType: 'module',
			allowAwaitOutsideFunction: true,
			allowHashBang: true,
			allowReturnOutsideFunction: true,
			locations: true,
		});
	} catch (err) {
		return { callSites: [], parseError: err.message };
	}

	// Which guard helpers this file imports, so a bare call to one is
	// attributable to the shared implementation rather than to a local function
	// that happens to share its name.
	// Module-level `const X = 'https://...'` (and simple concatenations of them)
	// are the base URLs nearly every call site is written against, so resolving
	// them is what turns a wall of "dynamic" rows into named upstreams.
	const consts = new Map();
	// Provider chains are frequently hoisted to a module constant
	// (`export const PROVIDERS = [...]`) and passed to fetchFirst by name, so the
	// array node has to be resolvable from the identifier or the entire chain is
	// invisible to the audit.
	const arrayConsts = new Map();
	for (const stmt of ast.body || []) {
		const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
		if (!decl || decl.type !== 'VariableDeclaration') continue;
		for (const d of decl.declarations) {
			if (d.id?.type !== 'Identifier' || !d.init) continue;
			if (d.init.type === 'ArrayExpression') arrayConsts.set(d.id.name, d.init);
			const text = staticText(d.init, consts);
			if (text && !text.includes(HOLE)) consts.set(d.id.name, text);
		}
	}

	const imported = new Set();
	// local binding name -> { from, name }, so a URL built on an imported base
	// constant can be resolved against the module that exports it.
	const importBindings = new Map();
	walkWithAncestors(ast, (n) => {
		if (n.type !== 'ImportDeclaration') return;
		const from = typeof n.source?.value === 'string' ? n.source.value : null;
		for (const spec of n.specifiers || []) {
			const name = spec.imported?.name ?? spec.local?.name;
			if (name) imported.add(name);
			if (from && spec.local?.name) {
				importBindings.set(spec.local.name, { from, name: spec.imported?.name ?? spec.local.name });
			}
		}
	});

	// Imported constants resolve through the caller-supplied resolver, which the
	// two-pass driver backs with every exported string constant in the repo.
	if (resolveImported) {
		for (const [local, ref] of importBindings) {
			const value = resolveImported(file, ref.from, ref.name);
			if (typeof value === 'string' && value && !consts.has(local)) consts.set(local, value);
		}
	}

	const callSites = [];

	// A guard call anywhere up the ancestor chain puts its protections in scope
	// for the raw fetch it wraps: `withRetry(() => fetch(url))` is one guarded
	// site, not a guard plus a naked fetch. Tracking ancestors is what tells
	// those two shapes apart.
	walkWithAncestors(ast, (node, ancestors) => {
		if (node.type !== 'CallExpression') return;
		{
			const name = calleeName(node.callee);
			if (!name) return;

			const inherited = new Set();
			for (const a of ancestors) {
				if (a === node || a.type !== 'CallExpression') continue;
				const outer = calleeName(a.callee);
				if (outer && GUARDS[outer] && imported.has(outer)) {
					for (const g of GUARDS[outer]) inherited.add(g);
				}
			}

			const isGuard = Boolean(GUARDS[name]) && imported.has(name);
			if (!isGuard && name !== 'fetch') return;

			// A provider-list guard: unpack the array so every host in the chain is
			// counted, each carrying the chain's protections.
			if (isGuard && LIST_GUARDS.has(name)) {
				let arr = node.arguments[0];
				if (arr?.type === 'Identifier') arr = arrayConsts.get(arr.name) ?? arr;
				if (arr?.type !== 'ArrayExpression') return;
				const chainProtections = new Set(inherited);
				for (const g of GUARDS[name]) chainProtections.add(g);
				for (const el of arr.elements) {
					if (!el) continue;
					// Either a bare URL string or a { name, url, parse } provider object.
					let entryUrl = '';
					if (el.type === 'ObjectExpression') {
						const urlProp = el.properties.find(
							(pr) => pr.type !== 'SpreadElement' && (pr.key?.name ?? pr.key?.value) === 'url',
						);
						entryUrl = urlProp ? staticText(urlProp.value, consts) : '';
					} else {
						entryUrl = staticText(el, consts);
					}
					if (!entryUrl || !entryUrl.includes('://')) continue;
					callSites.push({
						file,
						line: (el.loc ?? node.loc).start.line,
						via: name,
						host: hostOf(entryUrl) ?? 'dynamic',
						url: displayUrl(entryUrl).slice(0, 120),
						protections: [...chainProtections].sort(),
					});
				}
				return;
			}

			const urlText = staticText(node.arguments[0], consts);
			if (!urlText || INTERNAL_URL_RE.test(urlText)) return;
			// Only grade calls we can PROVE leave this origin. A bare `fetch(path)`
			// or a `${base}/api/x` is same-origin or unknowable, and counting those
			// as unguarded upstreams buries the real ones: an earlier pass of this
			// analyzer reported 513 unbounded calls, of which 507 were same-origin.
			// A scheme in the resolved text is the proof; anything else is skipped.
			if (!urlText.includes('://')) return;
			const host = hostOf(urlText);

			const protections = new Set(inherited);
			if (isGuard) for (const g of GUARDS[name]) protections.add(g);
			// An explicit per-call deadline counts wherever it appears.
			for (const arg of node.arguments.slice(1)) {
				if (objectHasDeadline(arg)) protections.add('deadline');
			}

			callSites.push({
				file,
				line: node.loc.start.line,
				via: isGuard ? name : 'fetch',
				host: host ?? 'dynamic',
				url: displayUrl(urlText).slice(0, 120),
				protections: [...protections].sort(),
			});
		}
	});

	return { callSites, parseError: null };
}

/**
 * Every module-level string constant a file defines, exported or not, resolved
 * as far as literal concatenation allows. Pass 1 of the two-pass analysis.
 * @returns {Map<string, string>}
 */
export function collectStringConstants(code) {
	const out = new Map();
	let ast;
	try {
		ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
	} catch {
		return out;
	}
	for (const stmt of ast.body || []) {
		const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
		if (!decl || decl.type !== 'VariableDeclaration') continue;
		for (const d of decl.declarations) {
			if (d.id?.type !== 'Identifier' || !d.init) continue;
			const text = staticText(d.init, out);
			if (text && !text.includes(HOLE)) out.set(d.id.name, text);
		}
	}
	return out;
}

/**
 * Analyze a list of absolute paths, reported relative to `root`.
 * @returns {{ callSites: Array<object>, parseErrors: Array<object> }}
 */
export function analyzeFiles(files, root) {
	const callSites = [];
	const parseErrors = [];

	// Pass 1: every module's string constants. Base URLs in this repo are
	// overwhelmingly `export const PUMP_FRONTEND_BASE = 'https://...'` in one
	// module and imported everywhere else, so without this pass the majority of
	// call sites cannot be attributed to the host they actually talk to.
	const sources = new Map();
	const constsByFile = new Map();
	for (const abs of files) {
		let code;
		try {
			code = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		sources.set(abs, code);
		constsByFile.set(abs, collectStringConstants(code));
	}

	const byRel = new Map([...sources.keys()].map((abs) => [relative(root, abs), abs]));

	// Resolve `import { NAME } from './x.js'` against pass 1, trying the
	// extensions and index forms Node would.
	const resolveImported = (fromRel, spec, name) => {
		if (!spec.startsWith('.')) return undefined;
		const baseDir = dirname(resolve(root, fromRel));
		const target = resolve(baseDir, spec);
		const candidates = [
			target,
			`${target}.js`,
			`${target}.mjs`,
			join(target, 'index.js'),
			join(target, 'index.mjs'),
		];
		for (const cand of candidates) {
			const consts = constsByFile.get(cand);
			if (consts?.has(name)) return consts.get(name);
		}
		return undefined;
	};

	// Pass 2: grade every call site with imported constants resolved.
	for (const [abs, code] of sources) {
		const rel = relative(root, abs);
		const { callSites: found, parseError } = analyzeSource(code, rel, resolveImported);
		if (parseError) parseErrors.push({ file: rel, error: parseError });
		callSites.push(...found);
	}
	return { callSites, parseErrors, filesScanned: sources.size, byRel };
}

/**
 * A call site's grade. `deadline` is the floor, because without one a single
 * stalled socket outlives the request that opened it and no other protection
 * ever gets a turn. Above the floor, what earns a grade is having somewhere else
 * to go (failover) or something to serve (lastGood).
 *
 *   A  bounded, and survives the upstream being down
 *   B  bounded, with one way to survive
 *   C  bounded, and re-tries or trips, but has no second source
 *   D  bounded only
 *   F  unbounded: can hang the request
 */
export function gradeOf(site) {
	const p = new Set(site.protections);
	if (!p.has('deadline')) return 'F';
	if (p.has('failover') && (p.has('lastGood') || p.has('retry'))) return 'A';
	if (p.has('failover') || p.has('lastGood')) return 'B';
	if (p.has('retry') || p.has('breaker')) return 'C';
	return 'D';
}

/** Roll call sites up per upstream host, worst grade first. */
export function byHost(callSites) {
	const order = { F: 0, D: 1, C: 2, B: 3, A: 4 };
	const hosts = new Map();
	for (const site of callSites) {
		let h = hosts.get(site.host);
		if (!h) {
			h = { host: site.host, sites: 0, worst: 'A', grades: { A: 0, B: 0, C: 0, D: 0, F: 0 } };
			hosts.set(site.host, h);
		}
		const g = gradeOf(site);
		h.sites += 1;
		h.grades[g] += 1;
		if (order[g] < order[h.worst]) h.worst = g;
	}
	return [...hosts.values()].sort(
		(a, b) => order[a.worst] - order[b.worst] || b.sites - a.sites,
	);
}
