#!/usr/bin/env node
// Loads real pages in a real browser and fails on any Content-Security-Policy
// violation.
//
// server/csp-hashes.mjs computes `script-src` hashes from the exact bytes of
// each HTML response. That is a strong guarantee on paper, and a page that
// still breaks breaks completely: one missed inline script and the page ships
// blank. This is the check that proves it, because only a browser applies a
// policy the way a browser applies a policy.
//
// Every `securitypolicyviolation` event and every page error is collected per
// URL. A violation is a hard failure; a page error is reported so a broken
// refactor cannot hide behind a green CSP.
//
// A violation-free run only means something if the page actually loaded AND the
// response actually carried the policy. Both halves are checked here, because
// each has produced a green run over nothing:
//
//   - A 404 has no inline scripts, so it can never fire a violation. A sweep
//     that counts 4xx as clean reports success loudest exactly when `dist/` is
//     missing, which is the moment it should be screaming.
//   - A response with no CSP header cannot be violated either. On 2026-08-11
//     the default origin (port 8099) was held by an unrelated uvicorn server;
//     the sweep walked 25 URLs on it and printed "clean across 25 page(s)".
//     Nothing about three.ws was tested.
//
// So every page's own response headers are compared against what vercel.json
// declares for that path, using the server's own resolver (`resolvePhase1`)
// rather than a second copy of the rules. `server/csp-hashes.mjs` rewrites
// script-src per response, so that one directive is compared modulo the
// documented transform (drop 'unsafe-inline', add 'sha256-…'); every other
// directive and every other security header must match the route table exactly.
//
// Usage:
//   node server/index.mjs &                     # or any origin serving dist/
//   node scripts/audit-csp.mjs                  # sweeps the default page set
//   node scripts/audit-csp.mjs --base http://127.0.0.1:8099
//   node scripts/audit-csp.mjs --base https://three.ws   # audit production
//   node scripts/audit-csp.mjs --all            # every page in data/pages.json
//   node scripts/audit-csp.mjs /pay /studio     # only these paths

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadRouteTable, resolvePhase1 } from '../server/route-resolve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The pages whose inline handlers were converted to delegated listeners, plus
// the shells that carry the most inline script. A regression shows up here
// first.
const DEFAULT_PATHS = [
	'/',
	'/activity',
	'/coin-intel',
	'/daily-match',
	'/pump-dashboard',
	'/pump-live',
	'/smart-money',
	'/payments',
	'/unstoppable',
	'/walk-analytics',
	'/tour-builder',
	'/avatar-artifact',
	'/agents',
	'/my-agents',
	'/pay',
	'/studio',
	'/validation',
	'/dashboard',
	'/dashboard/wallets',
	'/dashboard/x402',
	'/dashboard/portfolio',
	'/vanity/gallery',
	'/vanity/premium',
	'/demos-embed/forge.html',
	'/docs',
];

const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const BASE = baseIdx === -1 ? 'http://127.0.0.1:8099' : args[baseIdx + 1];
const wantAll = args.includes('--all');
const explicit = args.filter((a) => a.startsWith('/'));

function allCataloguedPaths() {
	const catalogue = JSON.parse(readFileSync(path.join(ROOT, 'data', 'pages.json'), 'utf8'));
	const paths = [];
	for (const section of catalogue.sections || []) {
		for (const page of section.pages || []) {
			if (typeof page.path === 'string' && page.path.startsWith('/')) paths.push(page.path);
		}
	}
	return [...new Set(paths)];
}

const paths = explicit.length ? explicit : wantAll ? allCataloguedPaths() : DEFAULT_PATHS;

// How long to let a loaded page keep running before judging it. Long enough for
// deferred scripts, dynamic imports and the first render pass of a live feed.
const SETTLE_MS = Number(process.env.CSP_AUDIT_SETTLE_MS) || 3500;

const { phase1Routes } = loadRouteTable(path.join(ROOT, 'vercel.json'));

// The security headers vercel.json is expected to put on a document. Anything
// the route table declares for a path is checked; this list is what makes a
// MISSING declaration visible too, so deleting the global header rule fails
// here instead of shipping a bare-headed site.
const REQUIRED_ON_HTML = [
	'content-security-policy',
	'strict-transport-security',
	'x-content-type-options',
	'referrer-policy',
];

/** The header bag vercel.json declares for `pathname`, per the server's resolver. */
function declaredHeaders(pathname, base) {
	const url = new URL(pathname, base);
	const req = { headers: { host: url.host } };
	const bag = {};
	for (const [k, v] of Object.entries(resolvePhase1(phase1Routes, req, url).headers)) {
		bag[k.toLowerCase()] = v;
	}
	return bag;
}

/** "a 'b' c; d 'e'" -> Map{ a => Set{'b','c'}, d => Set{'e'} } */
function parsePolicy(value) {
	const directives = new Map();
	for (const chunk of String(value).split(';')) {
		const parts = chunk.trim().split(/\s+/).filter(Boolean);
		if (!parts.length) continue;
		directives.set(parts[0].toLowerCase(), new Set(parts.slice(1)));
	}
	return directives;
}

const setsEqual = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

/**
 * Differences between the policy the route table declares and the one the
 * response carried, allowing only the rewrite server/csp-hashes.mjs performs:
 * within script-src / script-src-elem, `'unsafe-inline'` is replaced by any
 * number of `'sha256-…'` sources. Everything else must survive byte-for-byte.
 */
function policyDiff(declared, served) {
	const want = parsePolicy(declared);
	const got = parsePolicy(served);
	const problems = [];
	for (const [name, wantSources] of want) {
		const gotSources = got.get(name);
		if (!gotSources) {
			problems.push(`directive "${name}" is missing from the served policy`);
			continue;
		}
		const hashable = name === 'script-src' || name === 'script-src-elem';
		const expected = new Set(wantSources);
		const actual = new Set(gotSources);
		if (hashable) {
			expected.delete("'unsafe-inline'");
			for (const src of [...actual]) if (src.startsWith("'sha256-")) actual.delete(src);
		}
		if (setsEqual(expected, actual)) continue;
		const missing = [...expected].filter((s) => !actual.has(s));
		const extra = [...actual].filter((s) => !expected.has(s));
		problems.push(
			`directive "${name}" differs${missing.length ? ` (missing ${missing.join(' ')})` : ''}` +
				`${extra.length ? ` (unexpected ${extra.join(' ')})` : ''}`,
		);
	}
	return problems;
}

/**
 * Every way the response's security headers fail to be what the repo says it
 * serves for this path.
 */
function headerProblems(pathname, base, servedHeaders) {
	const want = declaredHeaders(pathname, base);
	const problems = [];

	for (const name of REQUIRED_ON_HTML) {
		if (!want[name]) problems.push(`vercel.json declares no ${name} for this path`);
	}

	for (const [name, expected] of Object.entries(want)) {
		// Only security headers are the subject here. Cache and CORS values are
		// legitimately rewritten by the CDN and by conditional-request handling.
		if (!name.startsWith('x-') && !REQUIRED_ON_HTML.includes(name) && name !== 'permissions-policy') {
			continue;
		}
		const served = servedHeaders[name];
		if (served === undefined) {
			problems.push(`${name} was declared but the response did not carry it`);
			continue;
		}
		if (name === 'content-security-policy') {
			problems.push(...policyDiff(expected, served));
			continue;
		}
		if (served.trim() !== expected.trim()) {
			problems.push(`${name} is "${served}" but vercel.json declares "${expected}"`);
		}
	}
	return problems;
}

const browser = await chromium.launch({
	args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const results = [];
for (const p of paths) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const violations = [];
	const errors = [];

	// Collected inside the page so the browser's own policy evaluation is what
	// reports, not a re-implementation of it here.
	await page.addInitScript(() => {
		window.__cspViolations = [];
		document.addEventListener('securitypolicyviolation', (e) => {
			window.__cspViolations.push({
				directive: e.effectiveDirective || e.violatedDirective,
				blocked: e.blockedURI,
				sample: (e.sample || '').slice(0, 120),
				line: e.lineNumber,
				source: (e.sourceFile || '').slice(0, 200),
			});
		});
	});
	page.on('pageerror', (err) => errors.push(String(err.message).slice(0, 200)));

	let status = 0;
	const headers = [];
	try {
		// Many pages here poll a live feed forever, so `networkidle` never
		// fires. Wait for the document instead, then give deferred scripts and
		// lazy chunks a fixed window to run and violate.
		const res = await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 45000 });
		status = res ? res.status() : 0;
		if (res && status < 400) {
			// Judge the headers of the document that actually rendered: a route
			// that redirects is governed by its destination's rules, not the
			// requested path's.
			headers.push(...headerProblems(new URL(res.url()).pathname, BASE, res.headers()));
		}
		await page.waitForTimeout(SETTLE_MS);
		violations.push(...(await page.evaluate(() => window.__cspViolations || [])));
	} catch (err) {
		errors.push(`navigation: ${err.message}`);
	}
	await context.close();
	// A page that never loaded, or answered with an error status, proves
	// nothing: it has no inline scripts to block. Counting it as clean is how a
	// sweep reports success over a wiped dist/ or a server that died halfway.
	const unreachable = status === 0 || status >= 400;
	results.push({ path: p, status, violations, errors, headers, unreachable });
	const mark = violations.length
		? 'CSP'
		: unreachable
			? 'DEAD'
			: headers.length
				? 'HDR'
				: errors.length
					? 'err'
					: ' ok';
	const note = violations.length
		? `  (${violations.length} violation(s))`
		: headers.length
			? `  (${headers.length} header problem(s))`
			: '';
	console.log(`[${mark}] ${String(status).padEnd(3)} ${p}${note}`);
}

await browser.close();

const failed = results.filter((r) => r.violations.length > 0);
const unreachable = results.filter((r) => r.unreachable);
const misheaded = results.filter((r) => !r.unreachable && r.headers.length > 0);
const errored = results.filter((r) => r.errors.length > 0 && r.violations.length === 0 && !r.unreachable);

if (errored.length) {
	console.log('\nPage errors (not CSP, but worth reading):');
	for (const r of errored) for (const e of r.errors) console.log(`  ${r.path}: ${e}`);
}

if (unreachable.length) {
	console.error(`\nCSP audit: ${unreachable.length} of ${results.length} page(s) never loaded or answered with an error, so this run proves nothing.`);
	console.error(`A page that does not render has no inline script to block. Check that ${BASE} is serving a built dist/. First few:`);
	for (const r of unreachable.slice(0, 8)) console.error(`  ${r.path} (status ${r.status})`);
	process.exit(2);
}

if (misheaded.length) {
	console.error(`\nCSP audit: ${misheaded.length} page(s) did not carry the headers vercel.json declares\n`);
	for (const r of misheaded) {
		console.error(`  ${r.path}`);
		for (const h of r.headers) console.error(`    ${h}`);
	}
	process.exit(3);
}

if (failed.length === 0) {
	console.log(`\nCSP audit: clean across ${results.length} page(s) on ${BASE}`);
	console.log('Each page loaded, carried the policy vercel.json declares, and fired no violation.');
	process.exit(0);
}

console.error(`\nCSP audit: ${failed.length} page(s) violated the policy\n`);
for (const r of failed) {
	console.error(`  ${r.path}`);
	for (const v of r.violations) {
		console.error(`    ${v.directive} blocked ${v.blocked || '(inline)'} at ${v.source}:${v.line}`);
		if (v.sample) console.error(`      sample: ${v.sample}`);
	}
}
process.exit(1);
