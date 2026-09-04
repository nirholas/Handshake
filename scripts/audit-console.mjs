#!/usr/bin/env node
/**
 * Console sweep — drives every canonical HTML route from data/pages.json in a
 * headless Chromium (Playwright) at desktop and mobile viewports, exercises the
 * primary interaction (scroll + settle), and collects:
 *   • console errors / warnings (from our code; environment noise filtered out)
 *   • uncaught page errors and unhandled promise rejections
 *   • failed first-party network requests (4xx/5xx + transport failures)
 *
 * A clean console is part of the Definition of Done (CLAUDE.md). This is the
 * lasting, npm-able check — wired as `npm run audit:console`.
 *
 * Any route that fails in the parallel pass is re-run once, serially, and that
 * second reading is what the report carries. This worktree is shared with other
 * agents and a sweep routinely runs beside somebody else's full build; a page
 * that misses its settle window at load 100+ has not failed. A real defect
 * reproduces on the quiet retry, so nothing is excused, only re-measured, and
 * the report says how many routes cleared that way.
 *
 * Usage:
 *   node scripts/audit-console.mjs                  # every HTML route, both viewports
 *   node scripts/audit-console.mjs / /forge /play   # specific routes only
 *   node scripts/audit-console.mjs --desktop        # 1440×900 only
 *   node scripts/audit-console.mjs --mobile         # 390×844 only
 *   node scripts/audit-console.mjs --no-blog        # skip /blog/* content pages
 *   node scripts/audit-console.mjs --report         # write docs/audit/console-sweep-<date>.md
 *   LOG_ALL=1 node scripts/audit-console.mjs        # stream every console line
 *   HEADFUL=1 node scripts/audit-console.mjs        # watch it run
 *   CONCURRENCY=6 node scripts/audit-console.mjs    # parallel tabs (default 5)
 *   AUDIT_BASE=http://localhost:3211 node scripts/audit-console.mjs  # drive a server you own
 *
 * Reuses a dev server already on :3000, otherwise spawns an ephemeral Vite. Set
 * AUDIT_BASE to drive a server you started yourself, which is what you want when
 * other agents share the box: a :3000 owned by someone else can disappear
 * mid-sweep and every remaining route then reads as a navigation failure. The
 * dev server proxies /api/* to https://three.ws, so API calls hit real
 * endpoints — auth/payment-gated 4xx are classified "expected", never failures.
 *
 * That proxy also means an API finding measures PRODUCTION, not this working
 * tree: when production runs behind main, a handler that exists here answers 404
 * or 500 there and the page above it reads as broken code. To tell the two apart,
 * run the repo's own server and point the dev proxy at it:
 *
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local server/index.mjs &
 *   DEV_API_PROXY=http://localhost:8080 npx vite --port 3211 --strictPort &
 *   AUDIT_BASE=http://localhost:3211 npm run audit:console
 *
 * A finding that clears under that run is deploy lag, not a defect. The reverse
 * also holds: endpoints whose credentials live only on the deployed service
 * answer `not_configured` locally, so judge those against the proxied default.
 *
 * Which API the pages talk to decides what a finding MEANS, so pick it on
 * purpose:
 *
 *   • Default (proxy to https://three.ws) measures what users actually get. It
 *     is the right run for judging the live site, and the one whose numbers
 *     belong in a report.
 *   • DEV_API_PROXY=http://localhost:8080, with `node server/index.mjs` running
 *     there, measures THIS working tree. Use it to tell a page defect apart
 *     from deploy lag: on 2026-09-03 a sweep against production blamed pages
 *     for a 404 on /api/home and a 500 on /api/oracle/model, and both handlers
 *     were already fixed on main and merely unshipped. Note the reverse trap
 *     too: endpoints whose credentials live only on the Cloud Run service
 *     answer 503 `not_configured` against a local server, which is environment,
 *     not a defect.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { chromium } from 'playwright';
import { isIgnorableConsole, isDevOnlyAsset } from './lib/console-noise.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = {
	g: (s) => `\x1b[32m${s}\x1b[0m`,
	r: (s) => `\x1b[31m${s}\x1b[0m`,
	y: (s) => `\x1b[33m${s}\x1b[0m`,
	d: (s) => `\x1b[2m${s}\x1b[0m`,
	b: (s) => `\x1b[1m${s}\x1b[0m`,
	c: (s) => `\x1b[36m${s}\x1b[0m`,
};

// ── Viewports ────────────────────────────────────────────────────────────────
const VIEWPORTS = {
	desktop: { width: 1440, height: 900, isMobile: false, label: 'desktop 1440×900' },
	mobile: { width: 390, height: 844, isMobile: true, label: 'mobile 390×844' },
};

// ── Route manifest from data/pages.json ──────────────────────────────────────
function loadRoutes({ includeBlog }) {
	const data = JSON.parse(readFileSync(join(ROOT, 'data/pages.json'), 'utf8'));
	const seen = new Set();
	const routes = [];
	for (const section of data.sections) {
		// `machine` section = non-HTML endpoints (.xml/.txt/.json/.well-known) —
		// no DOM, no console; not part of a browser sweep.
		if (section.id === 'machine') continue;
		if (section.id === 'blog' && !includeBlog) continue;
		for (const page of section.pages) {
			const path = page.path;
			// Skip anything that resolves to a static file rather than an HTML page.
			if (/\.[a-z0-9]+$/i.test(path) && !/\.html$/i.test(path)) continue;
			if (seen.has(path)) continue;
			seen.add(path);
			routes.push({
				path,
				section: section.id,
				title: page.title || path,
				auth: page.auth === 'required',
			});
		}
	}
	return routes;
}

// ── Dev server ───────────────────────────────────────────────────────────────
function probe(url, timeoutMs = 2000) {
	return new Promise((resolve) => {
		const req = httpGet(url, (res) => {
			res.resume();
			resolve(res.statusCode || 0);
		});
		req.setTimeout(timeoutMs, () => req.destroy());
		req.on('error', () => resolve(0));
	});
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

const PROBE_BASE = 'http://127.0.0.1:3000';

// Dev-server readiness budget. A shared/loaded box (several agents running
// browser fleets and test workers at once) starves Vite's boot: it answers
// eventually, just not inside a short window. Waiting longer only delays the
// sweep on a busy machine; it never changes what counts as a console error.
// Raise SERVER_BOOT_MS if a run still dies with "vite did not become ready".
const SERVER_BOOT_MS = Number(process.env.SERVER_BOOT_MS || 240_000);
const REUSE_PROBE_MS = Number(process.env.REUSE_PROBE_MS || 20_000);

async function warmupDeps(base) {
	// Hit a few dep-heavy pages so Vite pre-bundles before the timed sweep,
	// otherwise the first real navigation eats the optimizer's reload.
	const warmPaths = ['/', '/forge', '/play', '/pumpfun', '/agent-exchange'];
	process.stdout.write('  warming Vite dep optimizer ');
	for (const p of warmPaths) {
		await fetch(`${base}${p}`).catch(() => {});
		process.stdout.write('.');
	}
	await new Promise((r) => setTimeout(r, 8000));
	process.stdout.write('\n');
}

async function startServer() {
	// An explicit target wins over discovery: on a shared box the server on :3000
	// may belong to another agent and vanish mid-sweep, which turns every
	// remaining route into a bogus navigation failure.
	if (process.env.AUDIT_BASE) {
		const base = process.env.AUDIT_BASE.replace(/\/$/, '');
		// Poll rather than probe once: a live Vite on a saturated box can take tens
		// of seconds to answer, and a single miss would abort a sweep of a server
		// that is in fact up.
		const deadline = Date.now() + SERVER_BOOT_MS;
		let up = 0;
		while (!up && Date.now() < deadline) {
			up = await probe(`${base}/`, REUSE_PROBE_MS);
			if (!up) await new Promise((r) => setTimeout(r, 2000));
		}
		if (!up) throw new Error(`AUDIT_BASE ${base} is not answering`);
		console.log(C.d(`  using AUDIT_BASE ${base}`));
		await warmupDeps(base);
		return { base, stop: async () => {} };
	}
	if (await probe(`${PROBE_BASE}/`, REUSE_PROBE_MS)) {
		console.log(C.d('  reusing dev server on :3000'));
		// localhost (not 127.0.0.1) — some CDN CORS configs allow it, fewer spurious errors.
		const navBase = 'http://localhost:3000';
		await warmupDeps(navBase);
		return { base: navBase, stop: async () => {} };
	}
	const port = await freePort();
	const bin = join(ROOT, 'node_modules', '.bin', 'vite');
	const child = spawn(bin, ['--port', String(port), '--strictPort'], {
		cwd: ROOT,
		stdio: process.env.LOG_ALL ? 'inherit' : 'ignore',
		env: process.env,
	});
	const probeBase = `http://127.0.0.1:${port}`;
	const navBase = `http://localhost:${port}`;
	const deadline = Date.now() + SERVER_BOOT_MS;
	process.stdout.write(`  starting Vite on :${port} `);
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`vite exited early (code ${child.exitCode})`);
		if (await probe(`${probeBase}/`, 10_000)) {
			process.stdout.write('\n');
			break;
		}
		process.stdout.write('.');
		await new Promise((r) => setTimeout(r, 500));
	}
	if (Date.now() >= deadline) {
		child.kill('SIGKILL');
		throw new Error(`vite did not become ready within ${Math.round(SERVER_BOOT_MS / 1000)}s`);
	}
	await warmupDeps(navBase);
	return { base: navBase, stop: async () => child.kill('SIGTERM') };
}

// ── Per-route check ──────────────────────────────────────────────────────────
const SETTLE_MS = Number(process.env.SETTLE_MS || 3000);

// Errors that are the Vite dep-optimizer re-bundling mid-navigation: a page's
// first load can reference a dep generation the optimizer is still rebuilding,
// so a transitive import 504s and the dynamic import fails. Vite then full-reloads
// the page. On a second visit the dep is cached and the page loads clean. None of
// this exists in production (deps are pre-bundled). So: retry the route once, and
// only believe an error that survives the retry.
const OPTIMIZER_RACE = [
	/Failed to fetch dynamically imported module/i,
	/error loading dynamically imported module/i,
	/Importing a module script failed/i,
	/Outdated Optimize Dep/i,
	/504/,
	/\/.vite\/deps\//,
];

// Transport-level failures that describe the machine, not the page: the sweep
// drives many WebGL-heavy routes at once, and on a loaded or shared box a large
// asset fetch (a GLB, a texture) or a whole navigation can be starved out. They
// arrive with no attribution, a bare `net::ERR_FAILED` or an unattributed
// `TypeError: Failed to fetch` from inside a third-party viewer, so no route or
// module owns them, and they land on a different route each run. A page defect
// reproduces on a second visit; a starved socket does not.
const TRANSIENT_NETWORK = [
	/net::ERR_FAILED/i,
	/net::ERR_TIMED_OUT/i,
	/net::ERR_CONNECTION_RESET/i,
	/net::ERR_CONNECTION_CLOSED/i,
	/net::ERR_CONNECTION_ABORTED/i,
	/net::ERR_NETWORK_CHANGED/i,
	/net::ERR_EMPTY_RESPONSE/i,
	/net::ERR_ADDRESS_UNREACHABLE/i,
	/net::ERR_NAME_NOT_RESOLVED/i,
	/TypeError: Failed to fetch/i,
	/TypeError: NetworkError/i,
	/Load failed/i,
	/navigation failed: .*Timeout .* exceeded/i,
	/navigation failed: .*net::ERR_/i,
];

// Only believe an error that survives a second visit. Both lists demand that
// EVERY error on the route match, so a route carrying one genuine defect
// alongside the noise still fails on the first pass and is never retried away.
function isRetryableNoise(result) {
	const all = [
		...result.navErrors,
		...result.consoleErrors,
		...result.failedAssets,
		...result.rejections,
	];
	if (all.length === 0) return false;
	return all.every((e) =>
		OPTIMIZER_RACE.some((re) => re.test(e)) || TRANSIENT_NETWORK.some((re) => re.test(e)),
	);
}

async function checkRoute(context, base, route) {
	let result = await checkRouteOnce(context, base, route);
	if (totalErrors(result) > 0 && isRetryableNoise(result)) {
		// Second visit: deps the first load triggered are now optimized, and a
		// starved socket gets another chance. Whatever survives is the verdict.
		result = await checkRouteOnce(context, base, route);
	}
	return result;
}

async function checkRouteOnce(context, base, route) {
	const page = await context.newPage();

	const consoleErrors = [];
	const consoleWarnings = [];
	const failedAssets = [];
	const degradedApis = [];

	page.on('console', (msg) => {
		const text = msg.text();
		if (process.env.LOG_ALL) console.log(C.d(`  [${route.path} ${msg.type()}] ${text}`));
		if (isIgnorableConsole(text)) return;
		if (msg.type() === 'error') consoleErrors.push(text);
		else if (msg.type() === 'warning') consoleWarnings.push(text);
	});

	page.on('pageerror', (err) => {
		const msg = err.message || String(err);
		if (!isIgnorableConsole(msg)) consoleErrors.push('pageerror: ' + msg);
	});

	page.on('requestfailed', (req) => {
		const u = req.url();
		const errorText = req.failure()?.errorText || '';
		if (u.includes('@vite') || u.startsWith('ws:') || u.startsWith('wss:')) return;
		if (/posthog|sentry|segment|google-analytics|vercel-insights|vercel\.live/i.test(u)) return;
		if (isDevOnlyAsset(u)) return;
		const rt = req.resourceType();
		if (!['document', 'script', 'stylesheet', 'font'].includes(rt)) return;
		if (!u.startsWith(base)) return;
		if (rt === 'document' && errorText.includes('ERR_ABORTED')) return;
		if (errorText.includes('ERR_CONNECTION_REFUSED')) return;
		// ERR_ABORTED on a script/style usually follows a 4xx/5xx already recorded
		// by the response handler — don't double-count.
		if (errorText.includes('ERR_ABORTED')) return;
		failedAssets.push(`${req.method()} ${rt} ${u.replace(base, '')}: ${errorText}`);
	});

	page.on('response', (res) => {
		const u = res.url();
		const s = res.status();
		if (s < 400) return;
		if (/posthog|sentry|segment|google-analytics|vercel-insights|vercel\.live/i.test(u)) return;
		if (u.includes('/api/')) {
			degradedApis.push(`${s} ${u.replace(base, '')}`);
			return;
		}
		if (!u.startsWith(base)) return; // external (CDN/third-party) — not our first-party asset
		if (isDevOnlyAsset(u)) return;
		const rt = res.request().resourceType();
		failedAssets.push(`HTTP ${s} ${rt} ${u.replace(base, '')}`);
	});

	const navErrors = [];
	const rejections = [];
	await page.addInitScript(() => {
		window.addEventListener('unhandledrejection', (e) => {
			const r = e.reason;
			(window.__rejections ||= []).push(String((r && (r.stack || r.message)) || r));
		});
	});

	const url = base + route.path;
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
	} catch (e) {
		navErrors.push(`navigation failed: ${e.message}`);
		await page.close();
		return { route, navErrors, consoleErrors, consoleWarnings, failedAssets, degradedApis, rejections };
	}

	// Primary interaction: scroll the page to fire lazy loaders / intersection
	// observers / on-scroll mounts, then settle so async fetches + module loads land.
	try {
		await page.evaluate(async () => {
			const h = document.body?.scrollHeight || 0;
			window.scrollTo({ top: h, behavior: 'instant' });
			await new Promise((r) => setTimeout(r, 200));
			window.scrollTo({ top: 0, behavior: 'instant' });
		});
	} catch {
		/* page may have torn down */
	}
	await new Promise((r) => setTimeout(r, SETTLE_MS));

	const injected = await page.evaluate(() => window.__rejections || []).catch(() => []);
	for (const e of injected) if (!isIgnorableConsole(e)) rejections.push('unhandledrejection: ' + e);

	await page.close();
	return { route, navErrors, consoleErrors, consoleWarnings, failedAssets, degradedApis, rejections };
}

function totalErrors(r) {
	return r.navErrors.length + r.consoleErrors.length + r.failedAssets.length + r.rejections.length;
}

// ── Concurrency pool ─────────────────────────────────────────────────────────
async function runPool(items, size, worker) {
	const out = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) break;
			out[i] = await worker(items[i], i);
		}
	});
	await Promise.all(runners);
	return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argRoutes = args.filter((a) => a.startsWith('/'));
const wantReport = args.includes('--report');
const includeBlog = !args.includes('--no-blog');
const onlyDesktop = args.includes('--desktop');
const onlyMobile = args.includes('--mobile');
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);

const viewportKeys = onlyDesktop ? ['desktop'] : onlyMobile ? ['mobile'] : ['desktop', 'mobile'];

let routes = loadRoutes({ includeBlog });
if (argRoutes.length) routes = routes.filter((r) => argRoutes.includes(r.path));
if (!routes.length) {
	console.error('No matching routes from data/pages.json.');
	process.exit(1);
}

console.log(C.b('\n╔══ Console Sweep (Playwright) ═══════════════════════════════╗'));
console.log(`  ${routes.length} HTML routes × ${viewportKeys.length} viewport(s) — concurrency ${CONCURRENCY}`);
console.log(C.b('╚═════════════════════════════════════════════════════════════╝\n'));

const { base, stop } = await startServer();

function launchBrowser() {
	return chromium.launch({
		headless: !process.env.HEADFUL,
		args: [
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--disable-setuid-sandbox',
			'--use-gl=angle',
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--ignore-gpu-blocklist',
			'--mute-audio',
		],
	});
}

function newContext(browser, vp) {
	return browser.newContext({
		viewport: { width: vp.width, height: vp.height },
		isMobile: vp.isMobile,
		hasTouch: vp.isMobile,
		deviceScaleFactor: vp.isMobile ? 3 : 1,
		userAgent: vp.isMobile
			? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
			: undefined,
	});
}

// A headless Chromium driving dozens of WebGL routes can be killed outright on a
// loaded or memory-tight box. That is the machine dying, not a page defect, and
// it used to abort the whole sweep on whichever route happened to be next. Bring
// a fresh browser up instead and re-run that route: a real defect still fails on
// the retry, so nothing is excused, only re-measured.
const BROWSER_GONE = /has been closed|Target closed|browser has (been )?disconnected|Browser closed/i;

// The dev server went away, or the tab died taking the page with it. Either way
// the reading is about this machine, not about the route.
const HARNESS_DOWN = /ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|Page crashed/i;

// Wait for the base URL to answer again, so a route is re-read against a live
// server rather than blamed for a dead one. Bounded: a server that is gone for
// good must not stall the sweep.
async function waitForBase(deadlineMs = 60_000) {
	const until = Date.now() + deadlineMs;
	while (Date.now() < until) {
		if (await probe(`${base}/`, 3000)) return true;
		await new Promise((r) => setTimeout(r, 2000));
	}
	return false;
}

let browser = await launchBrowser();

// results[viewportKey] = array of per-route result objects
const results = {};
// retries[viewportKey] = { attempted, recovered } for the serial re-run below
const retries = {};

for (const vpKey of viewportKeys) {
	const vp = VIEWPORTS[vpKey];
	console.log(C.b(`\n▶ ${vp.label}\n`));
	let context = await newContext(browser, vp);
	let recycling = null;
	const recycle = () => {
		// One relaunch shared by every in-flight worker, never one browser each.
		recycling ||= (async () => {
			console.log(C.y('\n  headless browser died (machine, not page), relaunching\n'));
			try {
				await browser.close();
			} catch {
				/* already gone */
			}
			browser = await launchBrowser();
			context = await newContext(browser, vp);
		})().finally(() => {
			recycling = null;
		});
		return recycling;
	};

	// One reading of a route, transparently surviving a browser the machine killed.
	//
	// Relaunching is racy by nature: a worker can throw on a context that a
	// relaunch already replaced, ask for another relaunch, and close the browser
	// its neighbour was about to use. That cascade aborted a whole run on
	// 2026-09-04. So keep trying while the error is the machine and not the page,
	// bounded, rather than assuming one recycle is always enough.
	const RECYCLE_ATTEMPTS = 4;
	const recheck = async (route) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await checkRoute(context, base, route);
			} catch (e) {
				if (!BROWSER_GONE.test(e?.message || '') || attempt >= RECYCLE_ATTEMPTS) throw e;
				await recycle();
			}
		}
	};

	let done = 0;
	const res = await runPool(routes, CONCURRENCY, async (route) => {
		const r = await recheck(route);
		done++;
		const errs = totalErrors(r);
		const status = errs === 0 ? C.g('✓') : C.r(`✗ ${errs}`);
		const warn = r.consoleWarnings.length ? C.y(` (${r.consoleWarnings.length}w)`) : '';
		process.stdout.write(
			`  [${String(done).padStart(3)}/${routes.length}] ${status}${warn} ${C.c(route.path)}\n`,
		);
		return r;
	});
	// A route that failed once on a saturated box has not necessarily failed.
	// This worktree is shared with several agents, and a sweep routinely runs
	// beside somebody else's full build: at load 100+ a page can miss its settle
	// window, and the run then reports hundreds of "failures" that reproduce on
	// exactly none of them when checked alone. On 2026-09-04 one sweep called 550
	// of 780 routes broken for that reason and every route sampled from it was
	// clean in isolation, which makes the whole measurement worthless.
	//
	// So re-run every failing route once, serially, and keep the second reading:
	// contention disappears when nothing else is competing, and a real defect
	// fails again. Nothing is excused, only re-measured. The count is printed and
	// carried into the report so a run that leaned on this is visible rather than
	// quietly smoothed.
	const failed = res.map((r, i) => [r, i]).filter(([r]) => totalErrors(r) > 0);
	let recovered = 0;
	if (failed.length) {
		console.log(C.y(`\n  re-running ${failed.length} failing route(s) serially\n`));
		for (const [r, i] of failed) {
			let again = await recheck(r.route);
			// A retry that could not reach the dev server, or that crashed the tab,
			// measured the machine rather than the page. The serial pass walks the
			// heaviest WebGL routes back to back, which is exactly when a Vite on a
			// memory-tight box falls over, and on 2026-09-04 eight routes were
			// reported broken for that reason alone. Wait for the server to answer
			// again and take a third reading; only then is the result about the page.
			if (totalErrors(again) > 0 && again.navErrors.some((e) => HARNESS_DOWN.test(e))) {
				if (await waitForBase()) {
					again = await recheck(r.route);
				} else {
					console.log(C.r(`  ${base} never came back; ${r.route.path} was not measured`));
				}
			}
			const errs = totalErrors(again);
			if (errs === 0) recovered++;
			res[i] = again;
			process.stdout.write(
				`  retry ${errs === 0 ? C.g('✓') : C.r(`✗ ${errs}`)} ${C.c(r.route.path)}\n`,
			);
		}
		retries[vpKey] = { attempted: failed.length, recovered };
	}
	results[vpKey] = res;
	await context.close();
}

await browser.close();
await stop();

// ── Report ───────────────────────────────────────────────────────────────────
// Merge per-viewport rows by route for the summary table.
const byPath = new Map();
for (const vpKey of viewportKeys) {
	for (const r of results[vpKey]) {
		const row = byPath.get(r.route.path) || { route: r.route, vp: {} };
		row.vp[vpKey] = r;
		byPath.set(r.route.path, row);
	}
}

const rows = [...byPath.values()];
const failing = rows.filter((row) => viewportKeys.some((k) => totalErrors(row.vp[k]) > 0));
const warning = rows.filter((row) => viewportKeys.some((k) => row.vp[k].consoleWarnings.length > 0));

console.log('\n' + C.b('═══════════════ SUMMARY ═══════════════\n'));
let grandErrors = 0;
for (const row of rows) {
	const parts = [];
	for (const k of viewportKeys) {
		const r = row.vp[k];
		const e = totalErrors(r);
		grandErrors += e;
		parts.push(`${k}: ${e === 0 ? C.g('clean') : C.r(e + ' err')}${r.consoleWarnings.length ? C.y(' ' + r.consoleWarnings.length + 'w') : ''}`);
	}
}
if (failing.length === 0) {
	console.log(C.g(`  ALL ${rows.length} ROUTES CLEAN across ${viewportKeys.length} viewport(s) — zero errors from our code.\n`));
} else {
	console.log(C.r(`  ${failing.length} route(s) with errors:\n`));
	for (const row of failing) {
		console.log(C.r(`✗ ${row.route.path}  ${C.d('(' + row.route.section + ')')}`));
		for (const k of viewportKeys) {
			const r = row.vp[k];
			if (totalErrors(r) === 0) continue;
			for (const e of r.navErrors) console.log(`    ${C.d(k)} nav:    ${C.r(e)}`);
			for (const e of r.consoleErrors) console.log(`    ${C.d(k)} console:${C.r(e)}`);
			for (const e of r.failedAssets) console.log(`    ${C.d(k)} asset:  ${C.r(e)}`);
			for (const e of r.rejections) console.log(`    ${C.d(k)} reject: ${C.r(e)}`);
		}
	}
	console.log('');
}

// Warnings never fail the sweep, but "our own warnings get fixed" is only
// actionable if the text is visible, so every distinct warning is printed.
if (warning.length) {
	console.log(C.y(`  ${warning.length} route(s) with warnings:\n`));
	for (const row of warning) {
		const texts = new Set();
		for (const k of viewportKeys) for (const w of row.vp[k].consoleWarnings) texts.add(w);
		console.log(C.y(`! ${row.route.path}  ${C.d('(' + row.route.section + ')')}`));
		for (const w of texts) console.log(`    ${C.y(w)}`);
	}
	console.log('');
}

// ── Optional markdown report ─────────────────────────────────────────────────
if (wantReport) {
	const date = new Date().toISOString().slice(0, 10);
	const outDir = join(ROOT, 'docs/audit');
	mkdirSync(outDir, { recursive: true });
	const outFile = join(outDir, `console-sweep-${date}.md`);
	const lines = [];
	lines.push(`# Console Sweep: ${date}`);
	lines.push('');
	lines.push(
		`Headless Chromium (Playwright) over ${rows.length} HTML routes from \`data/pages.json\` at ${viewportKeys.map((k) => VIEWPORTS[k].label).join(' and ')}. ` +
			`Each route: \`domcontentloaded\` → scroll → ${SETTLE_MS}ms settle. ` +
			`Environment noise (Vite HMR-proxy wss handshake, third-party telemetry, auth-gated \`/api\` 4xx, dev-origin CDN CORS) is filtered.`,
	);
	lines.push('');
	lines.push(`**Result:** ${failing.length === 0 ? '✅ all routes clean' : `❌ ${failing.length} route(s) with errors`}. ${grandErrors} total error(s).`);
	lines.push('');
	// Say out loud how much of the result came from the serial re-run. A sweep
	// that recovered most of its failures that way was measured on a box under
	// heavy contention, and the reader should weigh it accordingly.
	const retried = Object.entries(retries).filter(([, v]) => v.attempted > 0);
	if (retried.length) {
		lines.push(
			'Routes that failed in the parallel pass are re-run once, serially, and the ' +
				'second reading is the one reported: ' +
				retried
					.map(([k, v]) => `${k} ${v.recovered}/${v.attempted} cleared on the retry`)
					.join(', ') +
				'. A route that cleared was losing its settle window to load on a shared box, ' +
				'not failing.',
		);
		lines.push('');
	}
	lines.push('## Per-route');
	lines.push('');
	const head = ['Route', 'Section', ...viewportKeys.flatMap((k) => [`${k} err`, `${k} warn`])];
	lines.push('| ' + head.join(' | ') + ' |');
	lines.push('|' + head.map(() => '---').join('|') + '|');
	for (const row of rows.sort((a, b) => a.route.path.localeCompare(b.route.path))) {
		const cells = [`\`${row.route.path}\``, row.route.section];
		for (const k of viewportKeys) {
			const r = row.vp[k];
			cells.push(String(totalErrors(r)), String(r.consoleWarnings.length));
		}
		lines.push('| ' + cells.join(' | ') + ' |');
	}
	if (failing.length) {
		lines.push('');
		lines.push('## Failures (detail)');
		lines.push('');
		for (const row of failing) {
			lines.push(`### \`${row.route.path}\` (${row.route.section})`);
			for (const k of viewportKeys) {
				const r = row.vp[k];
				if (totalErrors(r) === 0) continue;
				lines.push(`- **${k}**`);
				for (const e of r.navErrors) lines.push(`  - nav: ${e}`);
				for (const e of r.consoleErrors) lines.push(`  - console: ${e}`);
				for (const e of r.failedAssets) lines.push(`  - asset: ${e}`);
				for (const e of r.rejections) lines.push(`  - rejection: ${e}`);
			}
			lines.push('');
		}
	}
	if (warning.length) {
		lines.push('');
		lines.push('## Warnings (detail)');
		lines.push('');
		for (const row of warning) {
			const texts = new Set();
			for (const k of viewportKeys) for (const w of row.vp[k].consoleWarnings) texts.add(w);
			lines.push(`### \`${row.route.path}\` (${row.route.section})`);
			for (const w of texts) lines.push(`- ${w}`);
			lines.push('');
		}
	}
	writeFileSync(outFile, lines.join('\n') + '\n');
	console.log(C.c(`  report written → ${outFile.replace(ROOT + '/', '')}\n`));
}

process.exit(failing.length === 0 ? 0 : 1);
