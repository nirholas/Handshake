#!/usr/bin/env node
/**
 * page-audit.mjs — authenticated, full-site console / error / network / layout audit.
 *
 * Drives a real Chromium across every public and authenticated page (sourced
 * from data/pages.json plus the dynamic agent/dashboard routes), in both a
 * desktop and a mobile viewport, and records everything a human would otherwise
 * hunt for with the dev console open on each page:
 *
 *   • console.error / console.warn output
 *   • uncaught exceptions (pageerror)
 *   • failed network requests (requestfailed)
 *   • HTTP responses with status >= 400
 *   • horizontal overflow / elements escaping the viewport
 *   • interactive controls below the 32px tap-target floor
 *   • missing <title>, missing alt text, empty links/buttons
 *
 * Findings are deduped, grouped per page, scored by severity, and written to
 * reports/page-audit-<timestamp>.{json,md}. A console summary is printed at the
 * end. The harness never mutates the target — it only reads pages.
 *
 * ── Target ──────────────────────────────────────────────────────────────────
 *   BASE_URL=https://three.ws        (default — real APIs, real data)
 *   BASE_URL=http://localhost:3000   (vite/vercel dev)
 *
 * ── Auth (reach dashboard / wallet / profile pages) ──────────────────────────
 * Authentication is a server-set HttpOnly session cookie. Generate a reusable
 * Playwright storageState once, then every run replays it:
 *
 *   AUDIT_EMAIL=you@example.com AUDIT_PASSWORD=••• \
 *     node scripts/page-audit.mjs --login
 *
 * That logs in via POST /api/auth/login against the chosen BASE_URL and saves
 * cookies + localStorage to .auth/audit-state.json (gitignored). Subsequent
 * runs pick it up automatically. Without it, the audit runs anonymously and
 * skips authenticated-only routes.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/page-audit.mjs                 # full audit, all routes
 *   node scripts/page-audit.mjs / /agents /pay  # only these routes
 *   node scripts/page-audit.mjs --login         # (re)create the auth session
 *   node scripts/page-audit.mjs --desktop-only  # skip the mobile viewport
 *   node scripts/page-audit.mjs --mobile-only   # skip the desktop viewport
 *   node scripts/page-audit.mjs --concurrency 6 # parallel pages per viewport
 *   node scripts/page-audit.mjs --strict        # exit 1 if any error-severity finding
 */
import { chromium, devices } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');
const AUTH_STATE = resolve(ROOT, '.auth/audit-state.json');
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE_URL);

// ── CLI parsing ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DO_LOGIN = flag('login');
const DESKTOP_ONLY = flag('desktop-only');
const MOBILE_ONLY = flag('mobile-only');
const STRICT = flag('strict');
const CONCURRENCY = Math.max(1, Number(opt('concurrency', 5)) || 5);
const explicitRoutes = argv.filter((a) => a.startsWith('/'));

// ── Noise filter ────────────────────────────────────────────────────────────
// Third-party chatter that is never our bug, regardless of target. Kept tight
// so we don't accidentally swallow real failures.
const ALWAYS_IGNORE = [
	/chrome-extension:\/\//,
	/favicon\.ico/,
	/google-analytics\.com|googletagmanager\.com|analytics\.google/,
	/doubleclick\.net|facebook\.net|hotjar|sentry\.io|fullstory/,
	/Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/, // ad/track blockers
];
// Failures that only happen because serverless functions / CDNs aren't present
// under a bare local dev server. Applied only when auditing localhost.
const LOCAL_ONLY_IGNORE = [
	/localhost:\d+\/api\//,
	/localhost:\d+\/chat/,
	/esm\.sh/,
	/ajax\.googleapis\.com/,
	/\/node_modules\/vite\/dist\/client\/env\.mjs/,
	/Unexpected token .+, .<!doctype /,
	/Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text\/html"/,
];
const ignorePatterns = IS_LOCAL ? [...ALWAYS_IGNORE, ...LOCAL_ONLY_IGNORE] : ALWAYS_IGNORE;
const shouldIgnore = (text) => ignorePatterns.some((re) => re.test(text || ''));

// ── Route discovery ───────────────────────────────────────────────────────────
// Public, user-discoverable pages come straight from the manifest that already
// drives /sitemap, llms.txt and the changelog — the single source of truth.
function manifestRoutes() {
	try {
		const pages = JSON.parse(readFileSync(resolve(ROOT, 'data/pages.json'), 'utf8'));
		const out = [];
		for (const s of pages.sections || []) {
			for (const p of s.pages || []) {
				if (p.path && p.path.startsWith('/') && !/[:*]/.test(p.path)) out.push(p.path);
			}
		}
		return out;
	} catch {
		return [];
	}
}

// Authenticated and parameterised routes the manifest intentionally omits.
// Dynamic params are filled with REAL ids fetched from the live API at runtime
// (see seedDynamicRoutes) — never placeholders.
const STATIC_AUTHED_ROUTES = [
	'/dashboard',
	'/dashboard/actions',
	'/dashboard/sessions',
	'/dashboard/usage',
	'/dashboard/wallets',
	'/dashboard/storage',
	'/dashboard/memory',
	'/dashboard/strategy',
	'/dashboard/voice',
	'/dashboard/sns',
	'/dashboard/delegation',
	'/dashboard/embed-policy',
	'/dashboard/agent-pumpfun',
	'/dashboard/x402',
	'/dashboard/portfolio',
	'/profile',
	'/settings',
	'/my-agents',
	'/api-keys',
];

async function seedDynamicRoutes(ctx) {
	const routes = [];
	try {
		const res = await ctx.request.get(`${BASE_URL}/api/explore?limit=5`, { timeout: 15000 });
		if (res.ok()) {
			const body = await res.json();
			const items = body.items || body.agents || [];
			const onchain = items.find((i) => i.agentId && i.chainId);
			if (onchain) {
				routes.push(`/a/${onchain.chainId}/${onchain.agentId}`);
				routes.push(`/agent/${onchain.chainId}:${onchain.agentId}`);
			}
		}
	} catch {
		/* live API unreachable — dynamic routes simply skipped */
	}
	return routes;
}

function buildRouteList(dynamic) {
	if (explicitRoutes.length) return [...new Set(explicitRoutes)];
	const authed = existsSync(AUTH_STATE) ? STATIC_AUTHED_ROUTES : [];
	return [...new Set([...manifestRoutes(), ...authed, ...dynamic])];
}

// ── Login (storageState bootstrap) ────────────────────────────────────────────
async function login() {
	const email = process.env.AUDIT_EMAIL;
	const passwordVal = process.env.AUDIT_PASSWORD;
	if (!email || !passwordVal) {
		console.error(
			'✗ --login needs AUDIT_EMAIL and AUDIT_PASSWORD in the environment.\n' +
				'  Example:\n' +
				'    AUDIT_EMAIL=you@example.com AUDIT_PASSWORD=secret \\\n' +
				`      BASE_URL=${BASE_URL} node scripts/page-audit.mjs --login`,
		);
		process.exit(2);
	}
	const browser = await chromium.launch();
	const ctx = await browser.newContext();
	console.log(`Logging in as ${email} at ${BASE_URL}…`);
	const res = await ctx.request.post(`${BASE_URL}/api/auth/login`, {
		data: { email, password: passwordVal },
		headers: { 'content-type': 'application/json' },
		timeout: 20000,
	});
	if (!res.ok()) {
		const text = await res.text().catch(() => '');
		console.error(`✗ login failed: HTTP ${res.status()} ${text.slice(0, 200)}`);
		await browser.close();
		process.exit(1);
	}
	// Prime the optimistic auth-hint the viewer reads on first paint.
	const page = await ctx.newPage();
	await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
	await page.evaluate(() => {
		try {
			localStorage.setItem('3dagent:auth-hint', JSON.stringify({ authed: true, ts: Date.now() }));
		} catch {}
	});
	mkdirSync(dirname(AUTH_STATE), { recursive: true });
	await ctx.storageState({ path: AUTH_STATE });
	await browser.close();
	console.log(`✓ session saved to ${AUTH_STATE.replace(ROOT + '/', '')}`);
}

// ── In-page audit (runs in the browser) ───────────────────────────────────────
function inPageAudit() {
	const vw = window.innerWidth;
	const docW = document.documentElement.scrollWidth;
	const findings = [];
	const cls = (el) =>
		(el.className && typeof el.className === 'string' ? el.className : '').trim().slice(0, 60);
	const label = (el) =>
		`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls(el) ? '.' + cls(el).split(/\s+/)[0] : ''}`;

	// Horizontal overflow — elements escaping the viewport that aren't clipped
	// by a scrollable ancestor (marquees / carousels are fine).
	if (docW > vw + 2) {
		for (const el of document.querySelectorAll('body *')) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const st = getComputedStyle(el);
			if (st.position === 'fixed') continue;
			if (r.right <= vw + 2 && r.left >= -2) continue;
			let clipped = false;
			for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
				const ox = getComputedStyle(p).overflowX;
				if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') {
					clipped = true;
					break;
				}
			}
			if (clipped) continue;
			findings.push({
				type: 'overflow',
				severity: 'warn',
				detail: `${label(el)} overflows: left=${Math.round(r.left)} right=${Math.round(r.right)} vw=${vw}`,
			});
			if (findings.filter((f) => f.type === 'overflow').length >= 10) break;
		}
	}

	// Tiny tap targets (mobile only — caller decides whether to keep these).
	for (const el of document.querySelectorAll(
		'a[href], button, input, select, textarea, [role="button"]',
	)) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		const st = getComputedStyle(el);
		if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') continue;
		if (r.height < 32 || r.width < 24) {
			findings.push({
				type: 'tap-target',
				severity: 'info',
				detail: `${label(el)} is ${Math.round(r.width)}×${Math.round(r.height)}px ("${(el.textContent || '').trim().slice(0, 24)}")`,
			});
			if (findings.filter((f) => f.type === 'tap-target').length >= 8) break;
		}
	}

	// Accessibility / dead-control smells.
	if (!document.title || !document.title.trim()) {
		findings.push({ type: 'a11y', severity: 'warn', detail: 'page has no <title>' });
	}
	let noAlt = 0;
	for (const img of document.querySelectorAll('img')) {
		const r = img.getBoundingClientRect();
		if (r.width < 24 || r.height < 24) continue;
		if (!img.hasAttribute('alt')) noAlt++;
	}
	if (noAlt > 0) {
		findings.push({ type: 'a11y', severity: 'info', detail: `${noAlt} image(s) missing alt text` });
	}
	let deadLinks = 0;
	for (const a of document.querySelectorAll('a')) {
		const href = a.getAttribute('href');
		const r = a.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		if (href === null || href === '' || href === '#' || href === 'javascript:void(0)') {
			if (!a.getAttribute('role') && !a.onclick) deadLinks++;
		}
	}
	if (deadLinks > 0) {
		findings.push({
			type: 'dead-link',
			severity: 'info',
			detail: `${deadLinks} link(s) with no destination (href="#"/empty, no handler)`,
		});
	}

	return { title: document.title, hasHorizontalScroll: docW > vw + 2, findings };
}

// ── Per-route audit ───────────────────────────────────────────────────────────
async function auditRoute(ctx, route, viewport) {
	const page = await ctx.newPage();
	const findings = [];
	const push = (type, severity, detail) => {
		if (shouldIgnore(detail)) return;
		findings.push({ type, severity, detail: String(detail).slice(0, 300) });
	};

	page.on('console', (m) => {
		const t = m.type();
		if (t !== 'error' && t !== 'warning') return;
		const text = m.text();
		if (text.startsWith('Failed to load resource')) return; // cascade — captured below
		push(t === 'error' ? 'console-error' : 'console-warn', t === 'error' ? 'error' : 'warn', text);
	});
	page.on('pageerror', (e) => push('exception', 'error', `${e.message}`));
	page.on('requestfailed', (req) => {
		const f = req.failure()?.errorText || '';
		if (f === 'net::ERR_ABORTED') return; // navigations / cancelled prefetch
		push('request-failed', 'error', `${req.url()} — ${f}`);
	});
	page.on('response', (res) => {
		const s = res.status();
		if (s >= 400) push('http-' + s, s >= 500 ? 'error' : 'warn', `HTTP ${s} ${res.url()}`);
	});

	let navStatus = null;
	try {
		const resp = await page.goto(`${BASE_URL}${route}`, {
			waitUntil: 'networkidle',
			timeout: 25000,
		});
		navStatus = resp?.status() ?? null;
	} catch {
		try {
			const resp = await page.goto(`${BASE_URL}${route}`, {
				waitUntil: 'domcontentloaded',
				timeout: 25000,
			});
			navStatus = resp?.status() ?? null;
		} catch (e) {
			push('nav-failed', 'error', e.message);
		}
	}
	// Let async boot code settle (3D loads, data fetches, late errors).
	await page.waitForTimeout(2500);

	if (navStatus && navStatus >= 400) {
		push('nav-status', navStatus >= 500 ? 'error' : 'warn', `navigation returned HTTP ${navStatus}`);
	}

	let title = '';
	try {
		const r = await page.evaluate(inPageAudit);
		title = r.title;
		for (const f of r.findings) {
			// Tap-target noise is only meaningful on the mobile pass.
			if (f.type === 'tap-target' && viewport !== 'mobile') continue;
			push(f.type, f.severity, f.detail);
		}
	} catch {
		/* page torn down mid-eval */
	}

	await page.close();
	return { route, viewport, title, navStatus, findings };
}

// ── Worker pool ───────────────────────────────────────────────────────────────
async function runPool(ctx, routes, viewport, onResult) {
	const queue = [...routes];
	const results = [];
	const worker = async () => {
		while (queue.length) {
			const route = queue.shift();
			const r = await auditRoute(ctx, route, viewport).catch((e) => ({
				route,
				viewport,
				title: '',
				navStatus: null,
				findings: [{ type: 'audit-crash', severity: 'error', detail: e.message }],
			}));
			results.push(r);
			onResult(r);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, routes.length) }, worker));
	return results;
}

// ── Reporting ─────────────────────────────────────────────────────────────────
function dedupe(findings) {
	const seen = new Map();
	for (const f of findings) {
		const key = `${f.type}::${f.detail}`;
		if (!seen.has(key)) seen.set(key, { ...f, count: 1 });
		else seen.get(key).count++;
	}
	return [...seen.values()];
}

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

function writeReport(allResults, meta) {
	mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const jsonPath = resolve(ROOT, `reports/page-audit-${stamp}.json`);
	const mdPath = resolve(ROOT, `reports/page-audit-${stamp}.md`);

	// Group by route, merging viewports.
	const byRoute = new Map();
	for (const r of allResults) {
		if (!byRoute.has(r.route)) byRoute.set(r.route, { route: r.route, viewports: {}, findings: [] });
		const entry = byRoute.get(r.route);
		entry.viewports[r.viewport] = { title: r.title, navStatus: r.navStatus };
		for (const f of r.findings) entry.findings.push({ ...f, viewport: r.viewport });
	}

	const pages = [...byRoute.values()].map((p) => {
		const deduped = dedupe(p.findings).sort(
			(a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
		);
		const counts = { error: 0, warn: 0, info: 0 };
		for (const f of deduped) counts[f.severity] += f.count;
		return { ...p, findings: deduped, counts };
	});
	pages.sort((a, b) => b.counts.error - a.counts.error || b.counts.warn - a.counts.warn);

	const totals = pages.reduce(
		(t, p) => ({
			error: t.error + p.counts.error,
			warn: t.warn + p.counts.warn,
			info: t.info + p.counts.info,
		}),
		{ error: 0, warn: 0, info: 0 },
	);

	const report = { meta: { ...meta, generatedAt: stamp, totals }, pages };
	writeFileSync(jsonPath, JSON.stringify(report, null, 2));

	// Markdown
	const lines = [];
	lines.push(`# Page audit — ${meta.baseUrl}`);
	lines.push('');
	lines.push(`- Generated: ${new Date().toISOString()}`);
	lines.push(`- Auth: ${meta.authed ? 'authenticated session' : 'anonymous'}`);
	lines.push(`- Viewports: ${meta.viewports.join(', ')}`);
	lines.push(`- Routes audited: ${pages.length}`);
	lines.push(
		`- **Totals: ${totals.error} error · ${totals.warn} warn · ${totals.info} info**`,
	);
	lines.push('');
	lines.push('## Pages by severity');
	lines.push('');
	lines.push('| Route | err | warn | info |');
	lines.push('| --- | --: | --: | --: |');
	for (const p of pages) {
		if (p.counts.error + p.counts.warn + p.counts.info === 0) continue;
		lines.push(`| \`${p.route}\` | ${p.counts.error} | ${p.counts.warn} | ${p.counts.info} |`);
	}
	const clean = pages.filter((p) => p.counts.error + p.counts.warn + p.counts.info === 0);
	if (clean.length) {
		lines.push('');
		lines.push(`✓ ${clean.length} route(s) clean: ${clean.map((p) => `\`${p.route}\``).join(', ')}`);
	}
	lines.push('');
	lines.push('## Detail');
	for (const p of pages) {
		if (p.counts.error + p.counts.warn + p.counts.info === 0) continue;
		lines.push('');
		lines.push(`### \`${p.route}\``);
		const navs = Object.entries(p.viewports)
			.map(([v, d]) => `${v}: HTTP ${d.navStatus ?? '?'}`)
			.join(' · ');
		lines.push(`*${navs}*`);
		lines.push('');
		for (const f of p.findings) {
			const icon = f.severity === 'error' ? '🔴' : f.severity === 'warn' ? '🟡' : '⚪';
			const n = f.count > 1 ? ` ×${f.count}` : '';
			lines.push(`- ${icon} **${f.type}**${n}: ${f.detail}`);
		}
	}
	lines.push('');
	writeFileSync(mdPath, lines.join('\n'));

	return { jsonPath, mdPath, totals, pages };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	if (DO_LOGIN) {
		await login();
		return;
	}

	const authed = existsSync(AUTH_STATE);
	const viewports = MOBILE_ONLY
		? ['mobile']
		: DESKTOP_ONLY
			? ['desktop']
			: ['desktop', 'mobile'];

	console.log(`Page audit → ${BASE_URL}`);
	console.log(`  auth: ${authed ? 'session from ' + AUTH_STATE.replace(ROOT + '/', '') : 'anonymous'}`);
	console.log(`  viewports: ${viewports.join(', ')}  ·  concurrency: ${CONCURRENCY}`);

	const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
	const seedCtx = await browser.newContext(
		authed ? { storageState: AUTH_STATE } : {},
	);
	const dynamic = explicitRoutes.length ? [] : await seedDynamicRoutes(seedCtx);
	await seedCtx.close();
	const routes = buildRouteList(dynamic);
	console.log(`  routes: ${routes.length}\n`);

	const allResults = [];
	for (const viewport of viewports) {
		const ctxOpts = {
			...(viewport === 'mobile' ? devices['iPhone 13'] : { viewport: { width: 1440, height: 900 } }),
			...(authed ? { storageState: AUTH_STATE } : {}),
			// Codespaces hostnames aren't in the R2 CORS allowlist; ignore HTTPS errors.
			ignoreHTTPSErrors: true,
		};
		const ctx = await browser.newContext(ctxOpts);
		console.log(`── ${viewport} ──`);
		await runPool(ctx, routes, viewport, (r) => {
			const e = r.findings.filter((f) => f.severity === 'error').length;
			const w = r.findings.filter((f) => f.severity === 'warn').length;
			const tag = e ? '🔴' : w ? '🟡' : '✓ ';
			process.stdout.write(`  ${tag} ${r.route} (${e}e/${w}w)\n`);
			allResults.push(r);
		});
		await ctx.close();
	}
	await browser.close();

	const { jsonPath, mdPath, totals, pages } = writeReport(allResults, {
		baseUrl: BASE_URL,
		authed,
		viewports,
	});

	console.log('\n── Summary ──');
	console.log(`  ${totals.error} error · ${totals.warn} warn · ${totals.info} info`);
	const worst = pages.filter((p) => p.counts.error).slice(0, 10);
	if (worst.length) {
		console.log('  Pages with errors:');
		for (const p of worst) console.log(`    ${p.route}  (${p.counts.error} error)`);
	}
	console.log(`\n  Report: ${mdPath.replace(ROOT + '/', '')}`);
	console.log(`          ${jsonPath.replace(ROOT + '/', '')}`);

	if (STRICT && totals.error > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
