#!/usr/bin/env node
// Audit: which api/** handlers are routed but can never execute?
//
// scripts/verify-routes.mjs proves the same property for catalog PAGES. This
// script covers the other half of the surface, the ~1,900 handlers under api/,
// which is where the failure actually bites: a broad rule such as
// "/api/agents/([^/]+)(?:/.*)?" placed above the narrow ones silently swallows
// every endpoint below it, and the swallowed handlers stay in the tree looking
// perfectly healthy. Both scripts share one matcher
// (scripts/lib/vercel-routes.mjs), which mirrors server/index.mjs, so there is
// no second copy of the routing rules to drift.
//
// A handler is REACHABLE if at least one concrete request path resolves to it.
// Two families of path can do that, and both are modeled here, because checking
// only the first produces mostly false positives:
//
//   1. Its own filesystem path: /api/pump/balances for api/pump/balances.js,
//      with [param] segments filled in by several probe values (a rule regex may
//      accept one id shape and reject another).
//   2. Any route-table rule that REWRITES to it: /api/agents/x/memory/seed/x
//      lands on api/agents/[id]/memory-seed-x.js, whose own filesystem path is
//      swallowed by the /api/agents catch-all. The handler is alive; only its
//      literal path is not.
//
// For (2) a concrete sample path is synthesised from each rule's `src` regex and
// then re-tested against the same regex AND pushed through the real matcher, so
// a rule only counts as delivering traffic when a request provably reaches its
// own dest. A rule that cannot deliver to its own dest is itself reported as a
// shadowed rule, which is how the /api/agents catch-all incident presents.
//
// Usage:
//   node scripts/audit-route-shadowing.mjs            # human-readable report
//   node scripts/audit-route-shadowing.mjs --all      # also list reachable-via-rule
//   node scripts/audit-route-shadowing.mjs --json     # machine-readable
//
// Exit code 1 when a handler has no reachable path, or a rule cannot reach its
// own destination.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRoutable, loadRouteTable, resolveApiPath, resolveRequest } from './lib/vercel-routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.join(ROOT, 'api');
const rel = (f) => path.relative(ROOT, f);

const table = loadRouteTable(JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')));

// Probe values for a dynamic segment. A rule regex may accept one shape and
// reject another (`([^/.]+)` vs `(\d+)` vs a base58 mint), so a dynamic handler
// is tested against all of them and a rule capture takes the first that fits.
const PROBES = [
	'probehandler1',
	'1234567890',
	'Probe-Test_9',
	'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	'probe/sub',
	'a',
];

// ---------------------------------------------------------------------------
// Synthesise a concrete request path from a route's `src` regex.
// ---------------------------------------------------------------------------

function closingParen(src, open) {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '\\') {
			i++;
			continue;
		}
		if (src[i] === '[') {
			while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
			continue;
		}
		if (src[i] === '(') depth++;
		else if (src[i] === ')' && --depth === 0) return i;
	}
	return -1;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABZ';

function accepts(pattern, value) {
	try {
		return new RegExp(`^(?:${pattern})$`).test(value);
	} catch {
		return false;
	}
}

// A character class (with its quantifier) is satisfied by the first probe it
// accepts; failing that, by the first single character it accepts.
function sampleCharClass(pattern) {
	for (const probe of PROBES) if (accepts(pattern, probe)) return probe;
	for (const ch of ALPHABET) if (accepts(pattern, ch)) return ch;
	return null;
}

// A group is satisfied by the first probe its own pattern accepts; failing that
// (nested groups, alternations) its first alternative is sampled recursively.
function sampleGroup(inner, depth) {
	let body = inner;
	if (body.startsWith('?:')) body = body.slice(2);
	else if (body.startsWith('?!') || body.startsWith('?=') || body.startsWith('?<')) return '';
	for (const probe of PROBES) if (accepts(body, probe)) return probe;
	const alt = body.split('|')[0];
	if (alt === inner && !/[([]/.test(alt)) return sampleCharClass(alt);
	return sampleFromSrc(alt, depth + 1);
}

/** @returns {string|null} a path matching `src`, or null when it cannot be built. */
function sampleFromSrc(src, depth = 0) {
	if (depth > 8) return null;
	let out = '';
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\\') {
			const next = src[i + 1];
			// \d, \w and friends stand for a character, not a literal.
			if (next === 'd') out += '1';
			else if (next === 'w') out += 'a';
			else if (next === 's') out += ' ';
			else out += next;
			i += 2;
			continue;
		}
		if (ch === '^' || ch === '$') {
			i++;
			continue;
		}
		if (ch === '(') {
			const end = closingParen(src, i);
			if (end === -1) return null;
			const inner = src.slice(i + 1, end);
			let j = end + 1;
			let quant = '';
			while (j < src.length && '?*+'.includes(src[j])) quant += src[j++];
			i = j;
			// An optional or starred group contributes nothing to the shortest path.
			if (quant.startsWith('?') || quant.startsWith('*')) continue;
			const piece = sampleGroup(inner, depth);
			if (piece === null) return null;
			out += piece;
			continue;
		}
		if (ch === '[') {
			let j = i + 1;
			while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
			if (j >= src.length) return null;
			const cls = src.slice(i, j + 1);
			let k = j + 1;
			let quant = '';
			while (k < src.length && '?*+'.includes(src[k])) quant += src[k++];
			i = k;
			if (quant.startsWith('?') || quant.startsWith('*')) continue;
			const piece = sampleCharClass(`${cls}${quant || ''}`);
			if (piece === null) return null;
			out += piece;
			continue;
		}
		if (ch === '.') {
			i++;
			let quant = '';
			while (i < src.length && '?*+'.includes(src[i])) quant += src[i++];
			if (quant.startsWith('?') || quant.startsWith('*')) continue;
			out += 'a';
			continue;
		}
		// A quantifier on a plain literal: `/?` drops the char, `+` keeps one.
		if (ch === '?') {
			out = out.slice(0, -1);
			i++;
			continue;
		}
		if (ch === '*') {
			out = out.slice(0, -1);
			i++;
			continue;
		}
		if (ch === '+') {
			i++;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

// Only trust a sample the route's own regex accepts.
function sampleForRoute(route) {
	const sample = sampleFromSrc(route.src);
	if (sample === null || !sample.startsWith('/')) return null;
	return route.re.test(sample) ? sample : null;
}

// ---------------------------------------------------------------------------
// Handler inventory
// ---------------------------------------------------------------------------

function collectHandlers(dir, urlSegments, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!isRoutable(entry.name)) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectHandlers(abs, [...urlSegments, entry.name], out);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
		if (/\.(test|spec)\.js$/.test(entry.name)) continue;
		const base = entry.name.slice(0, -3);
		if (base === 'index') out.push({ file: abs, segments: [...urlSegments] });
		else out.push({ file: abs, segments: [...urlSegments, base] });
	}
	return out;
}

function canonicalPaths(segments) {
	const dynamic = segments.some((s) => s.startsWith('['));
	const probes = dynamic ? PROBES.filter((p) => !p.includes('/')) : PROBES.slice(0, 1);
	return probes.map((probe) => {
		const parts = [];
		for (const s of segments) {
			if (s.startsWith('[...') && s.endsWith(']')) parts.push(probe, 'sub');
			else if (s.startsWith('[') && s.endsWith(']')) parts.push(probe);
			else parts.push(s);
		}
		return `/api/${parts.join('/')}`;
	});
}

function describe(result) {
	switch (result.outcome) {
		case 'handler':
			return result.file ? `handler ${rel(result.file)}` : `rewritten to ${result.dest}`;
		case 'api-missing':
			return `404 (rewritten to ${result.dest}, no handler resolves)`;
		case 'file':
		case 'notfound':
			return `static ${result.dest} (HTTP ${result.status})`;
		case 'status':
			return `HTTP ${result.status}`;
		case 'external':
			return `external proxy ${result.to}`;
		case 'redirect':
			return `HTTP ${result.status} redirect to ${result.to}`;
		default:
			return result.outcome;
	}
}

// ---------------------------------------------------------------------------
// Pass 1: which rules actually deliver traffic to their own destination?
// ---------------------------------------------------------------------------

const reachableVia = new Map(); // handler file -> [{ via, path }]
const addReach = (file, entry) => {
	if (!reachableVia.has(file)) reachableVia.set(file, []);
	reachableVia.get(file).push(entry);
};

const deadRules = [];
const unsampledRules = [];

for (const route of table.phase1Routes) {
	if (route.continue) continue;
	const touchesApi = route.src.startsWith('/api/') || (route.dest || '').startsWith('/api/');
	if (!touchesApi) continue;
	const sample = sampleForRoute(route);
	if (!sample) {
		unsampledRules.push({ index: route.index, src: route.src, dest: route.dest ?? null });
		continue;
	}
	const result = resolveRequest(table, sample, { apiRoot: API_ROOT });
	const wanted = (route.dest || '').startsWith('/api/')
		? resolveApiPath(API_ROOT, route.dest.split('?')[0])
		: null;
	if (result.outcome === 'handler' && result.file) {
		addReach(result.file, { via: route.src, path: sample, ruleIndex: route.index });
	}
	// The rule is dead when a request that matches it does not end up where the
	// rule points: an earlier rule claimed the path first.
	if (wanted && (result.outcome !== 'handler' || result.file !== wanted.file)) {
		deadRules.push({
			index: route.index,
			src: route.src,
			dest: route.dest,
			sample,
			wanted: rel(wanted.file),
			got: describe(result),
			winner: result.rule ? { index: result.rule.index, src: result.rule.src } : null,
		});
	}
}

// ---------------------------------------------------------------------------
// Pass 2: which handlers have no reachable path at all?
// ---------------------------------------------------------------------------

const handlers = collectHandlers(API_ROOT, [], []);
const unreachable = [];
const ruleOnly = [];

for (const h of handlers) {
	const direct = [];
	const diverted = [];
	for (const p of canonicalPaths(h.segments)) {
		const result = resolveRequest(table, p, { apiRoot: API_ROOT });
		if (result.outcome === 'handler' && result.file === h.file) direct.push(p);
		else diverted.push({ path: p, to: describe(result), rule: result.rule ?? null });
	}
	if (direct.length === canonicalPaths(h.segments).length) continue;
	const viaRules = reachableVia.get(h.file) || [];
	const record = {
		handler: rel(h.file),
		canonical: canonicalPaths(h.segments)[0],
		directPaths: direct,
		divertedTo: diverted.map((d) => ({ path: d.path, to: d.to })),
		blockingRule: diverted[0]?.rule
			? { index: diverted[0].rule.index, src: diverted[0].rule.src, dest: diverted[0].rule.dest ?? null }
			: null,
		reachableVia: viaRules.map((v) => v.path),
	};
	if (direct.length === 0 && viaRules.length === 0) unreachable.push(record);
	else if (direct.length === 0) ruleOnly.push(record);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const asJson = process.argv.includes('--json');
const showAll = process.argv.includes('--all');

if (asJson) {
	console.log(
		JSON.stringify(
			{ scanned: handlers.length, unreachable, ruleOnly, deadRules, unsampledRules },
			null,
			2,
		),
	);
} else {
	console.log(
		`Route shadowing audit: ${handlers.length} routable handlers under api/, ` +
			`${table.phase1Routes.length} pre-filesystem rules.\n`,
	);

	console.log(`UNREACHABLE handlers (no request path resolves to them): ${unreachable.length}`);
	for (const r of unreachable) {
		console.log(`\n  ${r.handler}`);
		for (const d of r.divertedTo) console.log(`    ${d.path}  ->  ${d.to}`);
		if (r.blockingRule)
			console.log(`    blocked by rule #${r.blockingRule.index}: ${r.blockingRule.src} -> ${r.blockingRule.dest}`);
	}

	console.log(`\nDEAD route rules (rule never reaches its own dest): ${deadRules.length}`);
	for (const r of deadRules) {
		console.log(`\n  rule #${r.index}: ${r.src}  ->  ${r.dest}`);
		console.log(`    ${r.sample}  ->  ${r.got}   (wanted ${r.wanted})`);
		if (r.winner) console.log(`    claimed first by rule #${r.winner.index}: ${r.winner.src}`);
	}

	console.log(
		`\nReachable only through a rewrite (literal path shadowed, endpoint alive): ${ruleOnly.length}`,
	);
	if (showAll) {
		for (const r of ruleOnly) console.log(`  ${r.handler}  <-  ${r.reachableVia.join(', ')}`);
	} else if (ruleOnly.length) {
		console.log('  (re-run with --all to list them)');
	}

	if (unsampledRules.length) {
		console.log(`\nRules whose src could not be sampled (not verified): ${unsampledRules.length}`);
		for (const r of unsampledRules) console.log(`  #${r.index}: ${r.src} -> ${r.dest}`);
	}

	if (!unreachable.length && !deadRules.length) {
		console.log('\n✓ every api/** handler is reachable and every API rule reaches its own dest.');
	}
}

process.exit(unreachable.length || deadRules.length ? 1 : 0);
