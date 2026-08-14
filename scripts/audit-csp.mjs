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
// `--headers-only` answers the narrower question ("does this origin serve the
// headers the route table declares?") with a plain fetch and no browser. It is
// the only mode that can sweep production honestly: a real browser loading 200
// live pages is minutes of work and is at the mercy of whatever else the
// machine is doing, while the header comparison is deterministic. It proves
// strictly less than the full run (nothing evaluates the policy), so it is an
// addition to the browser sweep, never a substitute for it.
//
// Usage:
//   node server/index.mjs &                     # or any origin serving dist/
//   node scripts/audit-csp.mjs                  # sweeps the default page set
//   node scripts/audit-csp.mjs --base http://127.0.0.1:8099
//   node scripts/audit-csp.mjs --base https://three.ws   # audit production
//   node scripts/audit-csp.mjs --all            # every page in data/pages.json
//   node scripts/audit-csp.mjs --headers-only --base https://three.ws --all
//   node scripts/audit-csp.mjs /pay /studio     # only these paths

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadRouteTable, resolvePhase1 } from '../server/route-resolve.mjs';
import { headerProblems as compareHeaders } from './lib/csp-headers.mjs';

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
const headersOnly = args.includes('--headers-only');
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

// What counts as a header problem lives in scripts/lib/csp-headers.mjs, next to
// the tests that pin it. It checks the headers a path declares AND that the
// document ones are declared at all, so deleting the global header rule from
// vercel.json fails here instead of shipping a bare-headed site.

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

/**
 * Every way the response's security headers fail to be what the repo says it
 * serves for this path.
 */
function headerProblems(pathname, base, servedHeaders) {
	return compareHeaders(declaredHeaders(pathname, base), servedHeaders);
}

/**
 * The header half of the audit for one path, over a plain request. No policy is
 * evaluated: a clean result here means the response carried what vercel.json
 * declares, nothing more.
 */
async function auditHeaders(p) {
	const violations = [];
	const errors = [];
	const headers = [];
	let status = 0;
	try {
		const res = await fetch(BASE + p, { redirect: 'follow' });
		await res.arrayBuffer();
		status = res.status;
		if (status < 400) {
			const bag = {};
			for (const [k, v] of res.headers) bag[k.toLowerCase()] = v;
			headers.push(...headerProblems(new URL(res.url).pathname, BASE, bag));
		}
	} catch (err) {
		errors.push(`request: ${err.message}`);
	}
	return { status, violations, errors, headers };
}

/** The full audit for one path: load it in a real browser and collect what the policy blocked. */
async function auditInBrowser(browser, p) {
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
	return { status, violations, errors, headers };
}

const browser = headersOnly
	? null
	: await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

const results = [];
for (const p of paths) {
	const { status, violations, errors, headers } = headersOnly
		? await auditHeaders(p)
		: await auditInBrowser(browser, p);
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

if (browser) await browser.close();

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
	console.log(
		headersOnly
			? 'Each response carried the headers vercel.json declares. No policy was evaluated: rerun without --headers-only for that.'
			: 'Each page loaded, carried the policy vercel.json declares, and fired no violation.',
	);
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
