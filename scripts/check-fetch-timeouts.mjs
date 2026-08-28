#!/usr/bin/env node
/**
 * Guard every outbound call to a third-party host against hanging forever.
 *
 * A `fetch()` with no signal has no deadline. Node's undici defaults run to
 * minutes, so one upstream that accepts a connection and then stalls holds a
 * request open until the platform kills the whole invocation. In production
 * that does not read as "an upstream was slow": it reads as a dead endpoint, a
 * dead cron, or a page that spins forever, and it takes the request budget of
 * every fallback behind it with it. That is the failure this repo has paid for
 * repeatedly, and it is trivially preventable at review time, which is exactly
 * what a mechanical check is for.
 *
 * The rule: any fetch to a literal external URL must be bounded. It counts as
 * bounded when it passes a `signal`, or goes through one of the shared wrappers
 * that supplies one (fetchUpstream, fetchFirst, pumpFetchJson, ...). Retries,
 * provider ladders and last-good tiers are the RIGHT thing to add on top, but
 * they are judgement calls per call site; a deadline is not, so only the
 * deadline is enforced here.
 *
 * Same-origin calls (three.ws, localhost, relative paths) are out of scope: a
 * browser call to our own API is bounded by the page's own lifecycle and by
 * src/api.js, and a server call to itself is a different kind of bug.
 *
 *   node scripts/check-fetch-timeouts.mjs           # report and exit non-zero on a violation
 *   node scripts/check-fetch-timeouts.mjs --json    # machine-readable
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOTS = ['api', 'src', 'public', 'workers'];

// Wrappers that always supply a deadline of their own.
const BOUNDED_BY = [
	'fetchUpstream', 'fetchUpstreamJson', 'fetchAnyJson', 'fetchFirst', 'fetchFirstOrNull',
	'pumpFetchJson', 'fetchPumpBoard', 'fetchPumpTrades', 'fetchPumpCoin', 'fetchTokenMarketData',
	'fetchTokenPriceUsd', 'solPriceUsd', 'fetchFromGateways', 'fetchSafePublicUrl', 'apiFetch',
	'importFromCdn', 'loadModule', 'makeRotatingFetch',
];
const BOUNDED_RE = new RegExp(`\\b(${BOUNDED_BY.join('|')})\\s*\\(`);
const SIGNAL_RE = /signal\s*[:,)]|AbortSignal\.timeout|controller\.signal|\.signal\b/;

// Built bundles, vendored third-party code, and minified files are not ours to
// edit; a violation there belongs to whatever produced them.
const SKIP_PATH = /\/vendor\/|node_modules|public\/chat\/assets\/|\.min\.js$|\/dist\//;

const OWN_HOST = /three\.ws|localhost|127\.0\.0\.1/;

function listFiles() {
	const cmd = `grep -rl 'fetch(' ${ROOTS.join(' ')} --include=*.js --include=*.mjs 2>/dev/null || true`;
	return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		.split('\n')
		.filter(Boolean)
		.filter((f) => !SKIP_PATH.test(f));
}

/** Names of consts in `src` bound to a literal external URL. */
function externalConsts(lines) {
	const names = new Set();
	for (const l of lines) {
		const m = /^\s*(?:export\s+)?const\s+([A-Za-z_0-9]+)\s*=\s*[`'"](https?:\/\/[^`'"]+)/.exec(l);
		if (m && !OWN_HOST.test(m[2])) names.add(m[1]);
	}
	return names;
}

/**
 * The source text of the fetch call starting on line `start`, from `fetch(` to
 * its matching close paren (capped, so an unbalanced file cannot run away).
 * Includes the six lines above it, which is where a wrapper or an
 * already-declared signal usually lives.
 */
function callExtent(lines, start) {
	const from = Math.max(0, start - 6);
	const head = lines.slice(from, start).join('\n');
	const idx = lines[start].indexOf('fetch(');
	let depth = 0;
	let started = false;
	const out = [];
	for (let i = start; i < Math.min(lines.length, start + 60); i++) {
		const line = lines[i];
		out.push(line);
		for (let c = i === start ? idx : 0; c < line.length; c++) {
			const ch = line[c];
			if (ch === '(') { depth++; started = true; } else if (ch === ')') depth--;
			if (started && depth === 0) return `${head}\n${out.join('\n')}`;
		}
	}
	return `${head}\n${out.join('\n')}`;
}

export function scanFile(file, src) {
	const lines = src.split('\n');
	const consts = externalConsts(lines);
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!/\bfetch\(/.test(line)) continue;
		if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
		// Definitions, stubs and re-assignments are not call sites.
		if (/function fetch|globalThis\.fetch\s*=|global\.fetch\s*=|vi\.fn|fetchImpl\b|=\s*fetch\s*[;,)]/.test(line)) continue;

		const call = lines.slice(i, i + 4).join(' ');
		const urlLiteral = call.match(/[`'"]https?:\/\/[^`'"]*/)?.[0] || '';
		const inlineExternal = !!urlLiteral && !OWN_HOST.test(urlLiteral);
		const constExternal = [...consts].some((c) => new RegExp(`\\b${c}\\b`).test(call));
		if (!inlineExternal && !constExternal) continue;

		// Read the ACTUAL extent of the call by balancing parentheses from `fetch(`
		// rather than guessing a window: an options object can run for thirty
		// lines, and `signal` is conventionally its last key, so a fixed window
		// reports a bounded call as unbounded exactly when the options are long.
		const win = callExtent(lines, i);
		if (BOUNDED_RE.test(win) || SIGNAL_RE.test(win)) continue;
		out.push({ file, line: i + 1, code: line.trim().slice(0, 100) });
	}
	return out;
}

function main() {
	const json = process.argv.includes('--json');
	const violations = [];
	for (const file of listFiles()) {
		let src;
		try { src = readFileSync(file, 'utf8'); } catch { continue; }
		violations.push(...scanFile(file, src));
	}

	if (json) {
		console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
		process.exit(violations.length ? 1 : 0);
	}

	if (!violations.length) {
		console.log('check:fetch-timeouts: every external fetch is bounded by a deadline');
		process.exit(0);
	}

	console.error(`check:fetch-timeouts: ${violations.length} external fetch(es) with no deadline\n`);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}`);
		console.error(`    ${v.code}`);
	}
	console.error(`
Every one of these can hang until the platform kills the request. Fix by either:
  - routing it through a shared wrapper that already bounds it and adds a retry,
    e.g. fetchUpstream / fetchUpstreamJson (api/_lib/upstream-fetch.js) on the
    server, or fetchFirst (src/shared/failover-fetch.js) in the browser; or
  - passing a signal directly: { signal: AbortSignal.timeout(8000) }.
See docs/shared-utilities.md for which wrapper suits which call.`);
	process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
