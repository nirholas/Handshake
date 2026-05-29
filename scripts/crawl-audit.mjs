#!/usr/bin/env node
/**
 * Site-wide error crawler.
 *
 * Drives a headless Chromium across every public page route and records, per
 * page: uncaught exceptions, console errors/warnings, failed network requests,
 * and HTTP 4xx/5xx responses. Replaces the manual "open every page with the
 * dev console" loop — one run surfaces every issue across the whole site.
 *
 * ─ Quick start ───────────────────────────────────────────────────────────────
 *   npm run audit:crawl                       # anonymous crawl of local dev (:3000)
 *   npm run audit:crawl -- --base=https://three.ws        # crawl production
 *   npm run audit:crawl -- --base=https://three.ws --auth # authenticated crawl
 *
 * ─ Authentication ────────────────────────────────────────────────────────────
 *   The session cookie is `__Host-sid` (Secure), which browsers refuse to store
 *   over http://localhost. Authenticated crawls therefore require an https base
 *   (i.e. production). Provide credentials via env or flags:
 *
 *     CRAWL_EMAIL=you@example.com CRAWL_PASSWORD=secret \
 *       npm run audit:crawl -- --base=https://three.ws --auth
 *
 *     npm run audit:crawl -- --base=https://three.ws --auth \
 *       --email=you@example.com --password=secret
 *
 *   On success the session is saved to .crawl-auth.json (gitignored) and reused
 *   on subsequent runs (skip re-login with --reuse-auth, force fresh with --auth).
 *
 * ─ Useful flags ──────────────────────────────────────────────────────────────
 *   --base=URL          Target origin (default http://localhost:3000)
 *   --routes=/a,/b      Crawl only these paths (comma-separated) instead of all
 *   --filter=pump       Only crawl routes whose path includes this substring
 *   --include-authed    Include dashboard/auth-gated routes (implied by --auth)
 *   --concurrency=4     Parallel pages (default 4)
 *   --timeout=25000     Per-page navigation timeout in ms
 *   --settle=1500       Extra ms to wait after load for async errors to surface
 *   --scroll            Scroll each page to bottom to trigger lazy loads
 *   --warnings          Treat console warnings as reportable (default: errors only)
 *   --out=path.json     Report file (default crawl-report.json)
 *   --no-fail           Always exit 0 (default exits 1 when any page has errors)
 *   --quiet             Suppress per-page progress lines
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── arg parsing ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Map();
for (const a of argv) {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	if (m) flags.set(m[1], m[2] === undefined ? true : m[2]);
}
const flag = (k, def) => (flags.has(k) ? flags.get(k) : def);
const num = (k, def) => (flags.has(k) ? Number(flags.get(k)) : def);

const BASE = String(flag('base', process.env.CRAWL_BASE || 'http://localhost:3000')).replace(/\/$/, '');
const isHttps = BASE.startsWith('https://');
const DO_AUTH = !!flag('auth', false);
const REUSE_AUTH = !!flag('reuse-auth', false);
const INCLUDE_AUTHED = DO_AUTH || REUSE_AUTH || !!flag('include-authed', false);
const CONCURRENCY = Math.max(1, num('concurrency', 4));
const TIMEOUT = num('timeout', 25000);
const SETTLE = num('settle', 1500);
const SCROLL = !!flag('scroll', false);
const REPORT_WARNINGS = !!flag('warnings', false);
const OUT = resolve(root, String(flag('out', 'crawl-report.json')));
const NO_FAIL = !!flag('no-fail', false);
const QUIET = !!flag('quiet', false);
const AUTH_STATE = resolve(root, '.crawl-auth.json');

const EMAIL = flag('email', process.env.CRAWL_EMAIL);
const PASSWORD = flag('password', process.env.CRAWL_PASSWORD);

// Console messages that are third-party noise or environmental, not bugs in our
// code. Keep this conservative — only suppress things we've confirmed benign.
const IGNORE_CONSOLE = [
	/Download the React DevTools/i,
	/\[vite\] connect(ed|ing)/i,
	/Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/i, // ad/tracker blockers
	/Content Security Policy.*report-uri/i,
];
// Network failures that are environmental rather than our bug.
const IGNORE_REQUEST = [
	/ERR_BLOCKED_BY_CLIENT/i,
	/ERR_ABORTED/i, // navigations the crawler itself cancels
];

// ── route collection ──────────────────────────────────────────────────────────
function collectRoutes() {
	if (flags.has('routes')) {
		return String(flag('routes'))
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.map((p) => (p.startsWith('/') ? p : '/' + p));
	}

	const set = new Set();

	// 1. data/pages.json — curated public feature index (source of truth).
	try {
		const pages = JSON.parse(readFileSync(resolve(root, 'data/pages.json'), 'utf8'));
		for (const s of pages.sections || []) {
			for (const p of s.pages || []) if (p.path) set.add(normalize(p.path));
		}
	} catch {
		/* optional */
	}

	// 2. vercel.json — every static .html route (catches pages not yet indexed).
	try {
		const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
		for (const r of vercel.routes || []) {
			if (!isCrawlableRoute(r)) continue;
			set.add(normalize(r.src));
		}
	} catch {
		/* optional */
	}

	let routes = [...set];
	if (!INCLUDE_AUTHED) routes = routes.filter((p) => !isAuthGated(p));
	if (flags.has('filter')) {
		const needle = String(flag('filter')).toLowerCase();
		routes = routes.filter((p) => p.toLowerCase().includes(needle));
	}
	return routes.sort();
}

const normalize = (p) => (p !== '/' && p.endsWith('/') ? p.slice(0, -1) : p);

function isCrawlableRoute(r) {
	if (!r.src || !r.dest) return false;
	if (!/\.html$/.test(r.dest)) return false;
	if (/[()\[\]+*?\\]|\$\d/.test(r.src)) return false; // dynamic/capture routes need params
	if (r.src.includes('/api/')) return false;
	if (/\/\.well-known/.test(r.src)) return false;
	if (/embed/i.test(r.src) || /embed/i.test(r.dest)) return false; // iframe surfaces, not pages
	if (/\.(js|css|svg|png|jpg|json|xml|txt|ico|webmanifest)$/.test(r.src)) return false;
	return true;
}

// Routes that only render meaningfully for a signed-in user.
const AUTH_PREFIXES = ['/dashboard', '/dashboard-classic'];
const AUTH_EXACT = new Set(['/profile', '/a-me', '/create-review', '/deploy']);
function isAuthGated(p) {
	return AUTH_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/')) || AUTH_EXACT.has(p);
}

// ── auth ──────────────────────────────────────────────────────────────────────
async function authenticate(context) {
	if (!isHttps) {
		console.error(
			`✗ --auth requires an https base (got ${BASE}). The session cookie is Secure and\n` +
				`  cannot be stored over http://localhost. Use --base=https://three.ws to crawl authed pages.`
		);
		process.exit(2);
	}
	if (!EMAIL || !PASSWORD) {
		console.error(
			'✗ --auth needs credentials. Set CRAWL_EMAIL and CRAWL_PASSWORD (or pass --email / --password).'
		);
		process.exit(2);
	}
	const res = await context.request.post(`${BASE}/api/auth/login`, {
		data: { email: EMAIL, password: PASSWORD },
		headers: { 'content-type': 'application/json' },
	});
	if (!res.ok()) {
		const body = await res.text().catch(() => '');
		console.error(`✗ Login failed (${res.status()}): ${body.slice(0, 200)}`);
		process.exit(2);
	}
	await context.storageState({ path: AUTH_STATE });
	if (!QUIET) console.log(`✓ Authenticated as ${EMAIL} — session saved to .crawl-auth.json`);
}

// ── per-page crawl ──────────────────────────────────────────────────────────────
async function crawlPage(context, path) {
	const page = await context.newPage();
	const issues = { errors: [], warnings: [], pageErrors: [], failedRequests: [], badResponses: [] };

	page.on('console', (m) => {
		const type = m.type();
		if (type !== 'error' && type !== 'warning') return;
		const text = m.text();
		if (IGNORE_CONSOLE.some((re) => re.test(text))) return;
		const loc = m.location();
		const entry = { text: text.slice(0, 500), url: loc.url, line: loc.lineNumber };
		if (type === 'error') issues.errors.push(entry);
		else if (REPORT_WARNINGS) issues.warnings.push(entry);
	});
	page.on('pageerror', (e) => {
		issues.pageErrors.push({ message: (e.message || String(e)).slice(0, 500), stack: (e.stack || '').slice(0, 600) });
	});
	page.on('requestfailed', (req) => {
		const failure = req.failure();
		const reason = failure ? failure.errorText : 'unknown';
		if (IGNORE_REQUEST.some((re) => re.test(reason))) return;
		issues.failedRequests.push({ url: req.url().slice(0, 300), method: req.method(), reason });
	});
	page.on('response', (resp) => {
		const status = resp.status();
		if (status < 400) return;
		const url = resp.url();
		if (url.startsWith('data:')) return;
		issues.badResponses.push({ url: url.slice(0, 300), status, method: resp.request().method() });
	});

	let title = '';
	let navStatus = null;
	let navError = null;
	try {
		const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
		navStatus = resp ? resp.status() : null;
		await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
		if (SCROLL) await autoScroll(page);
		await page.waitForTimeout(SETTLE);
		title = await page.title().catch(() => '');
	} catch (e) {
		navError = (e.message || String(e)).split('\n')[0].slice(0, 200);
	}

	await page.close();

	const total =
		issues.errors.length +
		issues.pageErrors.length +
		issues.failedRequests.length +
		issues.badResponses.length +
		(REPORT_WARNINGS ? issues.warnings.length : 0) +
		(navError ? 1 : 0);

	return { path, title, navStatus, navError, issues, total };
}

async function autoScroll(page) {
	await page
		.evaluate(async () => {
			await new Promise((done) => {
				let y = 0;
				const step = () => {
					window.scrollBy(0, 800);
					y += 800;
					if (y >= document.body.scrollHeight || y > 20000) return done();
					setTimeout(step, 100);
				};
				step();
			});
			window.scrollTo(0, 0);
		})
		.catch(() => {});
}

// ── concurrency pool ────────────────────────────────────────────────────────────
async function runPool(context, routes) {
	const results = [];
	let idx = 0;
	let done = 0;
	const total = routes.length;
	async function worker() {
		while (idx < routes.length) {
			const path = routes[idx++];
			const r = await crawlPage(context, path);
			results.push(r);
			done++;
			if (!QUIET) {
				const mark = r.total === 0 ? '✓' : '✗';
				const detail = r.navError
					? `nav error: ${r.navError}`
					: r.total === 0
						? 'clean'
						: summarizeCounts(r);
				console.log(`[${String(done).padStart(3)}/${total}] ${mark} ${path}  ${detail}`);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
	return results.sort((a, b) => a.path.localeCompare(b.path));
}

function summarizeCounts(r) {
	const parts = [];
	if (r.issues.pageErrors.length) parts.push(`${r.issues.pageErrors.length} exception(s)`);
	if (r.issues.errors.length) parts.push(`${r.issues.errors.length} console error(s)`);
	if (REPORT_WARNINGS && r.issues.warnings.length) parts.push(`${r.issues.warnings.length} warning(s)`);
	if (r.issues.badResponses.length) parts.push(`${r.issues.badResponses.length} bad response(s)`);
	if (r.issues.failedRequests.length) parts.push(`${r.issues.failedRequests.length} failed request(s)`);
	return parts.join(', ');
}

// ── report ──────────────────────────────────────────────────────────────────────
function printReport(results) {
	const withIssues = results.filter((r) => r.total > 0);
	console.log('\n' + '═'.repeat(72));
	console.log(`CRAWL REPORT — ${BASE}`);
	console.log(`${results.length} pages crawled · ${withIssues.length} with issues · ${results.length - withIssues.length} clean`);
	console.log('═'.repeat(72));

	for (const r of withIssues) {
		console.log(`\n● ${r.path}${r.navStatus ? `  (HTTP ${r.navStatus})` : ''}${r.title ? `  — ${r.title}` : ''}`);
		if (r.navError) console.log(`    ⚠ navigation: ${r.navError}`);
		for (const e of r.issues.pageErrors) console.log(`    ✗ exception: ${e.message}`);
		for (const e of r.issues.errors) console.log(`    ✗ console.error: ${e.text}${e.url ? `  (${trimUrl(e.url)}:${e.line})` : ''}`);
		if (REPORT_WARNINGS) for (const e of r.issues.warnings) console.log(`    ⚠ console.warn: ${e.text}`);
		for (const e of r.issues.badResponses) console.log(`    ✗ HTTP ${e.status} ${e.method} ${trimUrl(e.url)}`);
		for (const e of r.issues.failedRequests) console.log(`    ✗ request failed (${e.reason}) ${e.method} ${trimUrl(e.url)}`);
	}

	// Aggregate: which errors recur across many pages (likely shared modules).
	const tally = new Map();
	for (const r of results) {
		for (const e of [...r.issues.pageErrors.map((x) => x.message), ...r.issues.errors.map((x) => x.text)]) {
			const key = e.replace(/\d+/g, '#').slice(0, 120);
			tally.set(key, (tally.get(key) || 0) + 1);
		}
	}
	const recurring = [...tally.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
	if (recurring.length) {
		console.log('\n' + '─'.repeat(72));
		console.log('RECURRING ERRORS (appear on multiple pages — fix these first):');
		for (const [msg, n] of recurring.slice(0, 15)) console.log(`  ${String(n).padStart(3)}×  ${msg}`);
	}

	// On local dev, Vite serves files directly and does NOT apply vercel.json
	// rewrites (clean URLs, redirects). Page-level 404s here usually mean "route
	// only exists via a Vercel rewrite", not a real bug — they resolve on prod.
	if (!isHttps) {
		const navsmissing = results.filter((r) => r.navStatus === 404).length;
		if (navsmissing) {
			console.log(
				`\nℹ ${navsmissing} page(s) 404'd at the route level. On local dev this usually means the\n` +
					`  clean-URL is a vercel.json rewrite Vite doesn't apply — re-run against production\n` +
					`  (--base=https://three.ws) to confirm. Auth-gated 401s likewise need --auth.`
			);
		}
	}

	console.log('\n' + '═'.repeat(72));
	console.log(`Full structured report → ${OUT}`);
}

const trimUrl = (u) => u.replace(BASE, '').replace(/^https?:\/\//, '');

// ── main ──────────────────────────────────────────────────────────────────────
const routes = collectRoutes();
if (!routes.length) {
	console.error('No routes to crawl. Pass --routes=/a,/b or check data/pages.json / vercel.json.');
	process.exit(2);
}

if (!QUIET) {
	console.log(`Crawling ${routes.length} route(s) on ${BASE} · concurrency ${CONCURRENCY}${INCLUDE_AUTHED ? ' · authed pages included' : ''}`);
}

const browser = await chromium.launch();
const useSaved = REUSE_AUTH && existsSync(AUTH_STATE) && !DO_AUTH;
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	userAgent:
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) three-ws-crawler/1.0 Chrome/120 Safari/537.36',
	...(useSaved ? { storageState: AUTH_STATE } : {}),
});

if (DO_AUTH) await authenticate(context);
else if (useSaved && !QUIET) console.log('✓ Reusing saved session from .crawl-auth.json');

const results = await runPool(context, routes);
await browser.close();

writeFileSync(OUT, JSON.stringify({ base: BASE, crawledAt: new Date().toISOString(), results }, null, 2));
printReport(results);

const hadIssues = results.some((r) => r.total > 0);
process.exit(hadIssues && !NO_FAIL ? 1 : 0);
