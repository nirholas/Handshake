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
// Usage:
//   node server/index.mjs &                     # or any origin serving dist/
//   node scripts/audit-csp.mjs                  # sweeps the default page set
//   node scripts/audit-csp.mjs --base http://127.0.0.1:8099
//   node scripts/audit-csp.mjs --all            # every page in data/pages.json
//   node scripts/audit-csp.mjs /pay /studio     # only these paths

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
	try {
		// Many pages here poll a live feed forever, so `networkidle` never
		// fires. Wait for the document instead, then give deferred scripts and
		// lazy chunks a fixed window to run and violate.
		const res = await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 45000 });
		status = res ? res.status() : 0;
		await page.waitForTimeout(SETTLE_MS);
		violations.push(...(await page.evaluate(() => window.__cspViolations || [])));
	} catch (err) {
		errors.push(`navigation: ${err.message}`);
	}
	await context.close();
	// A page that never loaded proves nothing. Counting it as clean is how a
	// sweep reports success after the server under test died halfway through.
	const unreachable = status === 0 || status >= 500;
	results.push({ path: p, status, violations, errors, unreachable });
	const mark = violations.length ? 'CSP' : unreachable ? 'DEAD' : errors.length ? 'err' : ' ok';
	console.log(`[${mark}] ${String(status).padEnd(3)} ${p}${violations.length ? `  (${violations.length} violation(s))` : ''}`);
}

await browser.close();

const failed = results.filter((r) => r.violations.length > 0);
const unreachable = results.filter((r) => r.unreachable);
const errored = results.filter((r) => r.errors.length > 0 && r.violations.length === 0 && !r.unreachable);

if (errored.length) {
	console.log('\nPage errors (not CSP, but worth reading):');
	for (const r of errored) for (const e of r.errors) console.log(`  ${r.path}: ${e}`);
}

if (unreachable.length) {
	console.error(`\nCSP audit: ${unreachable.length} of ${results.length} page(s) never loaded, so this run proves nothing.`);
	console.error(`Check that ${BASE} is still serving. First few:`);
	for (const r of unreachable.slice(0, 8)) console.error(`  ${r.path} (status ${r.status})`);
	process.exit(2);
}

if (failed.length === 0) {
	console.log(`\nCSP audit: clean across ${results.length} page(s) on ${BASE}`);
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
