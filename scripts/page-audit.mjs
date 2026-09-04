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
 *   node scripts/page-audit.mjs --engine webkit # audit in Safari's engine instead
 */
import { chromium, webkit, firefox, devices } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import {
	AUTHED_ROUTES,
	isHtmlRoute,
	manifestRoutes,
	seedDynamicRoutes,
} from './lib/audit-routes.mjs';

// The QA credentials live in .env, so `npm run audit:web:login` has to read it:
// without this the script only ever saw an inline-prefixed environment and told
// every caller the credentials were missing while they sat on disk.
// Shell env wins: dotenv never overrides a var that is already set.
dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
dotenv({ path: new URL('../.env.local', import.meta.url), quiet: true });

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

// Which engine renders the sweep. Chromium is the default because it is the
// only browser every machine here already has, but it cannot see a whole class
// of bug on its own: JavaScriptCore and V8 disagree about when a temporal dead
// zone is checked, so a page can render perfectly in Chrome and throw
// "Cannot access uninitialized variable." on every Safari. That is exactly how
// /avatars/:id shipped dead on iOS and macOS while this audit stayed green.
// `--engine webkit` needs `npx playwright install webkit` once.
const ENGINES = { chromium, webkit, firefox };
const ENGINE_NAME = String(opt('engine', 'chromium')).toLowerCase();
const ENGINE = ENGINES[ENGINE_NAME];
if (!ENGINE) {
	console.error(`✗ unknown --engine "${ENGINE_NAME}". Use one of: ${Object.keys(ENGINES).join(', ')}`);
	process.exit(2);
}
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
	// Errors raised inside the embedded DexScreener chart iframe (its own
	// origin fetching its own backends) are theirs, not ours.
	/dexscreener\.com/,
	// Performance advisories emitted by the headless box's software GL stack
	// (ANGLE over SwiftShader), e.g. "[.WebGL-0x…]GL Driver Message (OpenGL,
	// Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels". They
	// come from the emulated driver, not from page code, and no visitor on a
	// real GPU ever sees them. Scoped to the Performance category on purpose:
	// a driver message in the Error category is still a real WebGL fault and
	// stays reportable.
	/GL Driver Message \(OpenGL, Performance/,
];
// Failures that only happen because serverless functions / CDNs aren't present
// under a bare local dev server. Applied only when auditing localhost.
const LOCAL_ONLY_IGNORE = [
	/localhost:\d+\/api\//,
	/localhost:\d+\/chat/,
	/esm\.sh/,
	/ajax\.googleapis\.com/,
	/\/node_modules\/vite\/dist\/client\/env\.mjs/,
	// Vite's HMR client dials a websocket at the page's own host. On a plain
	// laptop that connects; inside a Codespace the page is served over a
	// forwarded https origin whose wss upgrade answers 404, so every locally
	// audited page reports the same three errors (the handshake, Vite's own
	// retry log, and the uncaught close) before a single line of page code
	// runs. Hot reload is a dev-server feature that production does not ship,
	// so its failure says nothing about the page.
	/\[vite\] failed to connect to websocket/,
	/WebSocket (connection to '[^']*' failed|closed without opened)/,
	/Unexpected token .+, .<!doctype /,
	/Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text\/html"/,
];
const ignorePatterns = IS_LOCAL ? [...ALWAYS_IGNORE, ...LOCAL_ONLY_IGNORE] : ALWAYS_IGNORE;
const shouldIgnore = (text) => ignorePatterns.some((re) => re.test(text || ''));

// ── Route discovery ───────────────────────────────────────────────────────────
// Public pages, the authenticated route list and the dynamic-id seeder all come
// from scripts/lib/audit-routes.mjs, shared with the visual sweep so the two
// can never disagree about what pages exist.
function buildRouteList(dynamic) {
	if (explicitRoutes.length) {
		const skipped = explicitRoutes.filter((r) => !isHtmlRoute(r));
		for (const r of skipped) console.log(`  skipping ${r} (non-HTML endpoint, nothing to audit)`);
		return [...new Set(explicitRoutes.filter(isHtmlRoute))];
	}
	// With a session, the manifest's own auth-gated pages come in too. Asking
	// for the public set alone dropped five of them (/conversions, /agent-screen,
	// /agent-studio, /proof, /autopilot-activity): flagged `auth` in
	// data/pages.json, so the public filter removed them, and absent from
	// AUTHED_ROUTES, which only carries what the manifest deliberately omits.
	// They fell between the two lists and no sweep had ever loaded them.
	const signedIn = existsSync(AUTH_STATE);
	const manifest = manifestRoutes(signedIn ? { access: 'all' } : undefined);
	const authed = signedIn ? AUTHED_ROUTES : [];
	return [...new Set([...manifest, ...authed, ...dynamic])];
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

// ── Click-listener tracking (installed before any page script runs) ───────────
// `el.onclick` is only set by inline onclick= attributes and direct property
// assignment. Everything wired with addEventListener reports onclick === null,
// so a dead-control check built on it both misses real handlers and slanders
// working ones. Patching addEventListener at document start is the only way to
// know from inside the page which elements are genuinely interactive.
function trackClickListeners() {
	const ACTIVATING = new Set(['click', 'pointerdown', 'mousedown', 'mouseup', 'keydown', 'keyup']);
	const wired = new WeakSet();
	// Walk up to (but not including) <body>. A listener on a real container is
	// genuine delegation and makes the anchor live. A listener on
	// body/document/window is not counted: pages routinely attach one for
	// dropdown dismissal or analytics, and honouring those would mark every
	// anchor on the page live and silence the check entirely.
	window.__auditWiredClick = (el) => {
		for (let n = el; n && n !== document.body; n = n.parentElement) {
			if (wired.has(n)) return true;
			if (typeof n.onclick === 'function') return true;
		}
		return false;
	};
	const original = EventTarget.prototype.addEventListener;
	EventTarget.prototype.addEventListener = function (type, listener, options) {
		if (ACTIVATING.has(type) && listener) wired.add(this);
		return original.call(this, type, listener, options);
	};
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
	// A link is dead only if it has no destination AND nothing made it
	// interactive. Placeholder href="#" anchors that JS fills in later are fine
	// once assigned; the ones nobody ever assigns or wires are real dead ends.
	const deadLinks = [];
	const wiredCheck = window.__auditWiredClick;
	for (const a of document.querySelectorAll('a')) {
		const href = a.getAttribute('href');
		const r = a.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		if (href !== null && href !== '' && href !== '#' && href !== 'javascript:void(0)') continue;
		if (a.getAttribute('role')) continue;
		if (wiredCheck ? wiredCheck(a) : a.onclick) continue;
		deadLinks.push(
			`${label(a)} ("${(a.textContent || '').trim().slice(0, 32) || 'no text'}") href=${
				href === null ? 'absent' : `"${href}"`
			}`,
		);
		if (deadLinks.length >= 12) break;
	}
	if (deadLinks.length > 0) {
		findings.push({
			type: 'dead-link',
			severity: 'warn',
			detail: `${deadLinks.length} link(s) with no destination and no click handler: ${deadLinks.join('; ')}`,
		});
	}

	// Blank-render detection: the page "loaded" but nothing meaningful painted.
	// A 3D canvas, iframe, or video counts as content; otherwise we require some
	// visible text or a reasonable number of visible elements.
	const visibleText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
	const hasMedia = !!document.querySelector('canvas, iframe, video');
	let visibleEls = 0;
	for (const el of document.querySelectorAll('body *')) {
		const r = el.getBoundingClientRect();
		if (r.width > 4 && r.height > 4) visibleEls++;
		if (visibleEls > 12) break;
	}
	if (!hasMedia && visibleText.length < 40 && visibleEls <= 12) {
		findings.push({
			type: 'blank-page',
			severity: 'error',
			detail: `page rendered ~nothing: ${visibleText.length} chars of visible text, ${visibleEls} visible elements, no canvas/iframe/video`,
		});
	}

	// Visible failure text: error banners and raw exception text a user would see.
	const ERROR_TEXT =
		/something went wrong|an error occurred|unexpected error|failed to (load|fetch|initialize)|cannot read propert|is not a function|is not defined|internal server error|\bTypeError\b|\bReferenceError\b/i;
	const seenBanners = new Set();
	for (const el of document.querySelectorAll('body *')) {
		if (el.children.length > 3) continue;
		// Docs and articles legitimately print error strings in code samples.
		if (el.closest('pre, code, script, style, table, article')) continue;
		const t = (el.innerText || '').trim();
		if (!t || t.length > 400 || !ERROR_TEXT.test(t)) continue;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		const st = getComputedStyle(el);
		if (st.display === 'none' || st.visibility === 'hidden') continue;
		const key = t.slice(0, 120);
		if (seenBanners.has(key)) continue;
		seenBanners.add(key);
		findings.push({ type: 'error-banner', severity: 'error', detail: `visible error text: "${key}"` });
		if (seenBanners.size >= 5) break;
	}

	// Same-origin links, for crawl discovery of routes missing from the manifest.
	const links = new Set();
	for (const a of document.querySelectorAll('a[href]')) {
		try {
			const u = new URL(a.getAttribute('href'), location.href);
			if (u.origin !== location.origin) continue;
			const p = u.pathname.replace(/\/$/, '') || '/';
			links.add(p);
		} catch {}
	}

	return {
		title: document.title,
		hasHorizontalScroll: docW > vw + 2,
		findings,
		links: [...links].slice(0, 400),
	};
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
		// A blocked or failed resource is reported once, by the requestfailed
		// handler below. Each engine also echoes it to the console in its own
		// words, and counting those again turned one blocked IPFS image into
		// three findings. Chromium's echo is "Failed to load resource"; these
		// are WebKit's.
		if (text.startsWith('Failed to load resource')) return; // cascade, captured below
		if (/^Cancelled load to .+ because it violates the Content Security Policy/.test(text)) return;
		if (/^Cannot load .+ due to access control checks\.$/.test(text)) return;
		push(t === 'error' ? 'console-error' : 'console-warn', t === 'error' ? 'error' : 'warn', text);
	});
	page.on('pageerror', (e) => push('exception', 'error', `${e.message}`));
	page.on('requestfailed', (req) => {
		const f = req.failure()?.errorText || '';
		// Same event, two vocabularies: Chromium says net::ERR_ABORTED, WebKit
		// says "Load request cancelled". Both mean the page navigated away or a
		// long-lived stream (SSE, the pump/oracle trade feeds) was closed with
		// the tab, which is the audit's own doing rather than a page fault.
		if (f === 'net::ERR_ABORTED' || /^Load request cancelled$/i.test(f.trim())) return;
		push('request-failed', 'error', `${req.url()} — ${f}`);
	});
	page.on('response', (res) => {
		const s = res.status();
		if (s < 400) return;
		// x402 payment-gated endpoints correctly answer 402 to a non-paying
		// browser; that is the product working, not a defect.
		if (s === 402 && new URL(res.url()).pathname.startsWith('/api/')) {
			push('payment-gated', 'info', `HTTP 402 ${res.url()} (x402 payment required, expected)`);
			return;
		}
		push('http-' + s, s >= 500 ? 'error' : 'warn', `HTTP ${s} ${res.url()}`);
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
	let links = [];
	try {
		const r = await page.evaluate(inPageAudit);
		title = r.title;
		links = r.links || [];
		for (const f of r.findings) {
			// Tap-target noise is only meaningful on the mobile pass.
			if (f.type === 'tap-target' && viewport !== 'mobile') continue;
			// Content-heavy prose surfaces mention error strings legitimately;
			// keep the signal but do not fail the page on it.
			const sev =
				f.type === 'error-banner' && /^\/(docs|blog|news|changelog|specs)(\/|$)/.test(route)
					? 'info'
					: f.severity;
			push(f.type, sev, f.detail);
		}
	} catch {
		/* page torn down mid-eval */
	}

	// A screenshot for every page with an error-severity finding, so the report
	// shows what a user would have seen.
	let screenshot = null;
	if (findings.some((f) => f.severity === 'error')) {
		try {
			const dir = resolve(ROOT, 'reports/screens');
			mkdirSync(dir, { recursive: true });
			const safe = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
			screenshot = `reports/screens/${safe}-${viewport}.png`;
			await page.screenshot({ path: resolve(ROOT, screenshot), fullPage: false });
		} catch {
			screenshot = null;
		}
	}

	await page.close();
	return { route, viewport, title, navStatus, findings, links, screenshot };
}

// ── Crawl discovery ───────────────────────────────────────────────────────────
// Links collected on audited pages that point at same-origin HTML routes we
// were NOT going to visit. These are exactly the pages past audits missed:
// reachable by users, absent from the manifest. Deep dynamic families
// (/u/<id>, /coin/<mint>, ...) are sampled, never exhaustively crawled, and
// anything sampled out is reported rather than silently dropped.
function pickDiscovered(links, known) {
	const candidates = [];
	for (const p of links) {
		if (!p.startsWith('/') || known.has(p)) continue;
		if (!isHtmlRoute(p)) continue;
		if (/^\/(api|assets|cdn|static|models|textures|_)/.test(p)) continue;
		candidates.push(p);
	}
	candidates.sort();
	const perFamily = new Map();
	const audit = [];
	const dropped = [];
	for (const p of candidates) {
		const fam = p.split('/').slice(0, 2).join('/');
		const depth = p.split('/').filter(Boolean).length;
		const cap = depth >= 2 ? 3 : Infinity;
		const n = perFamily.get(fam) || 0;
		if (n >= cap || audit.length >= 150) {
			dropped.push(p);
			continue;
		}
		perFamily.set(fam, n + 1);
		audit.push(p);
	}
	return { audit, dropped };
}

// ── Re-verification ───────────────────────────────────────────────────────────
// The sweep runs CONCURRENCY pages at once, and a WebGL-heavy page audited
// beside four others in one headless (software-GL) browser fails in ways a real
// visitor never sees: GPU contention makes texture uploads fail, and a
// contended page misses a 25 s networkidle it would otherwise hit easily.
// Measured 2026-07-28: 108 of 131 console errors in one report were
// "GLTFLoader: Couldn't load texture blob:…" from avatar pages, alongside
// "Framebuffer is incomplete" and GPU-stall warnings. Re-running those same
// routes one at a time, and even in parallel from a fresh browser, produced
// ZERO. A report where 4 findings in 5 are phantom is a report nobody can act
// on, so every error-severity finding is re-checked SOLO before it is reported:
// findings that reproduce stay errors, findings that do not are demoted to info
// and labelled, never silently dropped.
// `|| 60` here silently rewrote an explicit `--reverify-cap 0` back to 60, so
// the documented way to skip the solo re-check never skipped anything. Fall
// back only when the value is absent or not a number.
const REVERIFY_CAP = (() => {
	const raw = Number(opt('reverify-cap', 60));
	return Number.isFinite(raw) && raw >= 0 ? raw : 60;
})();

// Collapse the volatile parts of a finding so the same defect matches across
// runs: blob/object URLs, uuids, base58 mints, query strings and bare numbers
// all differ per load while naming the same problem.
function fingerprint(f) {
	const detail = String(f.detail || '')
		.replace(/blob:[^\s"']+/g, 'BLOB')
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
		.replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, 'ADDR')
		.replace(/\?[^\s"']*/g, '')
		.replace(/\d+/g, 'N')
		.trim();
	return `${f.type}::${detail}`;
}

async function reverify(browser, results, viewports, authed) {
	// One route may fail on desktop, mobile, or both; re-check each pair once.
	const suspects = [];
	for (const r of results) {
		if (r.findings.some((f) => f.severity === 'error')) suspects.push(r);
	}
	if (!suspects.length) return { checked: 0, demoted: 0, skipped: 0 };

	// The cap is spread evenly across viewports, never spent in arrival order.
	// Desktop runs first, so a flat slice handed all 60 slots to desktop and left
	// every mobile suspect reported-but-unverified: on 2026-08-11 that published
	// 28 unchecked mobile pages as the report's worst offenders while the desktop
	// pages beside them demoted at 4-in-5. Round-robin keeps one slow viewport
	// from starving the other.
	const byViewport = new Map();
	for (const s of suspects) {
		if (!byViewport.has(s.viewport)) byViewport.set(s.viewport, []);
		byViewport.get(s.viewport).push(s);
	}
	const lanes = [...byViewport.values()];
	const budget = [];
	for (let i = 0; budget.length < Math.min(REVERIFY_CAP, suspects.length); i++) {
		for (const lane of lanes) {
			if (i >= lane.length) continue;
			budget.push(lane[i]);
			if (budget.length >= REVERIFY_CAP) break;
		}
	}
	const skipped = suspects.length - budget.length;
	console.log(
		`\n── re-verify: ${budget.length} route/viewport pair(s) with errors, re-checked one at a time ──`,
	);
	if (skipped) {
		console.log(`  (${skipped} beyond --reverify-cap ${REVERIFY_CAP} kept as reported, unverified)`);
	}

	let demoted = 0;
	let checked = 0;
	for (const suspect of budget) {
		const viewport = suspect.viewport;
		if (!viewports.includes(viewport)) continue;
		let ctx;
		try {
			ctx = await browser.newContext({
				...(viewport === 'mobile' ? devices['iPhone 13'] : { viewport: { width: 1440, height: 900 } }),
				...(authed ? { storageState: AUTH_STATE } : {}),
				ignoreHTTPSErrors: true,
			});
		} catch (err) {
			// No browser to re-check with. Every remaining suspect keeps the
			// severity the sweep gave it, and the report still gets written.
			console.log(`  ⚠ re-verify stopped: ${err.message.split('\n')[0]}`);
			return { checked, demoted, skipped: skipped + (budget.length - checked), aborted: true };
		}
		let solo;
		try {
			solo = await auditRoute(ctx, suspect.route, viewport);
		} catch {
			solo = null; // a crashed re-check proves nothing; leave the finding as-is
		}
		try {
			await ctx.close();
		} catch {
			// The context went down with its browser; the session relaunches it.
		}
		if (!solo) continue;
		checked++;

		const reproduced = new Set(solo.findings.map(fingerprint));
		let localDemotions = 0;
		for (const f of suspect.findings) {
			if (f.severity !== 'error') continue;
			if (reproduced.has(fingerprint(f))) {
				f.reproduced = true;
				continue;
			}
			f.severity = 'info';
			f.reproduced = false;
			f.detail = `${f.detail} [not reproduced on a solo re-check: contention artifact]`;
			localDemotions++;
		}
		demoted += localDemotions;
		const left = suspect.findings.filter((f) => f.severity === 'error').length;
		process.stdout.write(
			`  ${left ? '🔴' : '✓ '} ${suspect.route} [${viewport}] ${left} confirmed, ${localDemotions} demoted\n`,
		);
	}
	return { checked, demoted, skipped };
}

// ── Worker pool ───────────────────────────────────────────────────────────────
// A dead browser or a context torn down with it is not a defect in the page
// being audited: every route after it would otherwise be reported as an
// `audit-crash` error against a page nobody ever loaded.
const DEAD_SESSION = /Target (page, context or browser|closed)|browser has been closed|Browser closed|has been closed/i;

async function runPool(pool, routes, viewport, onResult) {
	const queue = [...routes];
	const results = [];
	const worker = async () => {
		while (queue.length) {
			const route = queue.shift();
			let r = null;
			// One retry on a torn-down session, against a rebuilt context. A second
			// failure is reported, so a route that genuinely crashes the renderer
			// still surfaces instead of looping.
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					r = await auditRoute(await pool.context(), route, viewport);
					break;
				} catch (e) {
					if (attempt === 0 && DEAD_SESSION.test(e.message || '')) {
						await pool.recycle();
						continue;
					}
					r = {
						route,
						viewport,
						title: '',
						navStatus: null,
						findings: [{ type: 'audit-crash', severity: 'error', detail: e.message }],
					};
					break;
				}
			}
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
		if (r.screenshot) entry.screenshot = entry.screenshot || r.screenshot;
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
	if (meta.verification?.checked) {
		lines.push(
			`- Every error was re-checked solo: ${meta.verification.checked} route/viewport pair(s) re-run one at a time, ` +
				`${meta.verification.demoted} finding(s) demoted to info as parallel-run contention artifacts` +
				(meta.verification.skipped ? `, ${meta.verification.skipped} left unverified (past --reverify-cap)` : '') +
				'. Errors below reproduced on a page loaded by itself, so they are real.',
		);
	}
	if (meta.verification?.aborted) {
		lines.push(
			'- ⚠ The solo re-check did not finish (the browser session ended). Errors that were not' +
				' re-checked are reported exactly as the parallel sweep saw them, so some may be' +
				' contention artifacts. Re-run those routes with `--concurrency 1` before acting.',
		);
	}
	lines.push('');
	if (meta.discovered?.length) {
		lines.push('## Crawl-discovered routes (linked on the site, missing from data/pages.json)');
		lines.push('');
		lines.push('These were audited this run, but add them to the manifest so every future');
		lines.push('audit, the sitemap, and llms.txt see them:');
		lines.push('');
		for (const d of meta.discovered) lines.push(`- \`${d}\``);
		lines.push('');
	}
	if (meta.droppedDiscoveries?.length) {
		lines.push(
			`*Crawl sampled out ${meta.droppedDiscoveries.length} additional dynamic route(s) (families capped at 3): ${meta.droppedDiscoveries.slice(0, 15).map((d) => `\`${d}\``).join(', ')}${meta.droppedDiscoveries.length > 15 ? ', ...' : ''}*`,
		);
		lines.push('');
	}
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
		if (p.screenshot) lines.push(`*screenshot: ${p.screenshot}*`);
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

// ── Browser session ───────────────────────────────────────────────────────────
// A full sweep drives hundreds of WebGL pages through one browser process for
// well over an hour, on a box that is often running other agents' builds beside
// it. When that process dies (the kernel reaps it, or a renderer takes the
// browser down with it), every later `newContext` throws
// "Target page, context or browser has been closed" and the run aborts with
// hundreds of already-collected results still in memory and no report on disk.
// The findings were never the problem, so a dead browser is replaced rather
// than allowed to end the sweep.
class BrowserSession {
	constructor() {
		this.browser = null;
		this.relaunches = 0;
	}

	// The sandbox flags are chromium-only; webkit and firefox reject unknown args.
	async #launch() {
		this.browser = await ENGINE.launch(
			ENGINE_NAME === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {},
		);
		return this.browser;
	}

	async start() {
		return this.#launch();
	}

	// Playwright reports a dead process through isConnected(), but a browser can
	// also die between that check and the call, so the retry covers both.
	async newContext(opts) {
		for (let attempt = 0; ; attempt++) {
			if (!this.browser || !this.browser.isConnected()) {
				this.relaunches++;
				console.log(`  ⚠ browser process gone; relaunching (#${this.relaunches})`);
				await this.#launch();
			}
			try {
				return await this.browser.newContext(opts);
			} catch (err) {
				if (attempt >= 2) throw err;
				try {
					await this.browser.close();
				} catch {
					// Already gone. Nothing to close, and nothing that changes the retry.
				}
				this.browser = null;
			}
		}
	}

	async close() {
		if (!this.browser) return;
		try {
			await this.browser.close();
		} catch {
			// Closing a browser that already died is not a sweep failure.
		}
		this.browser = null;
	}
}

// One shared context per viewport pass, rebuilt on demand. The pool exists so
// the concurrent workers in runPool can agree on a single replacement instead
// of each opening its own after the same crash.
class ContextPool {
	constructor(session, opts, init) {
		this.session = session;
		this.opts = opts;
		this.init = init;
		this.ctx = null;
		this.pending = null;
		this.recycling = null;
	}

	async context() {
		if (this.ctx) return this.ctx;
		if (!this.pending) {
			this.pending = (async () => {
				try {
					const ctx = await this.session.newContext(this.opts);
					if (this.init) await ctx.addInitScript(this.init);
					this.ctx = ctx;
					return ctx;
				} finally {
					// Cleared on failure too: a rejected promise left in `pending`
					// would be handed to every remaining route, turning one bad
					// launch into a sweep of identical phantom crashes.
					this.pending = null;
				}
			})();
		}
		return this.pending;
	}

	// Drop the current context so the next `context()` builds a fresh one. Every
	// worker that hit the same dead session calls this at once, so a recycle
	// already in flight is awaited rather than started again: otherwise the
	// second caller would throw away the replacement the first just built.
	async recycle() {
		if (this.recycling) return this.recycling;
		this.recycling = (async () => {
			const dead = this.ctx;
			this.ctx = null;
			this.pending = null;
			if (dead) {
				try {
					await dead.close();
				} catch {
					// The context died with its browser; there is nothing left to close.
				}
			}
			this.recycling = null;
		})();
		return this.recycling;
	}

	async close() {
		const ctx = this.ctx;
		this.ctx = null;
		if (!ctx) return;
		try {
			await ctx.close();
		} catch {
			// Same as above: a context whose browser is gone needs no teardown.
		}
	}
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
	console.log(`  engine: ${ENGINE_NAME}`);

	const browser = new BrowserSession();
	await browser.start();
	const seedCtx = await browser.newContext(
		authed ? { storageState: AUTH_STATE } : {},
	);
	const dynamic = explicitRoutes.length ? [] : await seedDynamicRoutes(seedCtx, BASE_URL);
	await seedCtx.close();
	const routes = buildRouteList(dynamic);
	console.log(`  routes: ${routes.length}\n`);

	const allResults = [];
	const knownRoutes = new Set(routes);
	const discovered = [];
	let droppedDiscoveries = [];
	let firstViewport = true;
	for (const viewport of viewports) {
		const ctxOpts = {
			...(viewport === 'mobile' ? devices['iPhone 13'] : { viewport: { width: 1440, height: 900 } }),
			...(authed ? { storageState: AUTH_STATE } : {}),
			// Codespaces hostnames aren't in the R2 CORS allowlist; ignore HTTPS errors.
			ignoreHTTPSErrors: true,
		};
		const pool = new ContextPool(browser, ctxOpts, trackClickListeners);
		console.log(`── ${viewport} ──`);
		const onResult = (r) => {
			const e = r.findings.filter((f) => f.severity === 'error').length;
			const w = r.findings.filter((f) => f.severity === 'warn').length;
			const tag = e ? '🔴' : w ? '🟡' : '✓ ';
			process.stdout.write(`  ${tag} ${r.route} (${e}e/${w}w)\n`);
			allResults.push(r);
		};
		await runPool(pool, routes, viewport, onResult);
		// After the first pass, audit every crawl-discovered route the manifest
		// missed. They join `routes` so later viewports cover them too.
		if (firstViewport && !explicitRoutes.length) {
			const linkSet = new Set(allResults.flatMap((r) => r.links || []));
			const picked = pickDiscovered(linkSet, knownRoutes);
			droppedDiscoveries = picked.dropped;
			if (picked.audit.length) {
				console.log(
					`  ── crawl: ${picked.audit.length} linked route(s) missing from the manifest, auditing them too ──`,
				);
				for (const d of picked.audit) {
					routes.push(d);
					knownRoutes.add(d);
					discovered.push(d);
				}
				await runPool(pool, picked.audit, viewport, onResult);
			}
			if (picked.dropped.length) {
				console.log(
					`  ── crawl: ${picked.dropped.length} more discovered route(s) sampled out (dynamic families capped at 3) ──`,
				);
			}
			firstViewport = false;
		}
		await pool.close();
	}

	// Confirm every error against a solo re-check before reporting it.
	let verification = { checked: 0, demoted: 0, skipped: 0 };
	try {
		verification = await reverify(browser, allResults, viewports, authed);
	} catch (err) {
		// Hundreds of collected results are worth more than a perfect re-check.
		// Report what the sweep saw and say the pass did not finish.
		console.log(`  ⚠ re-verify failed: ${err.message.split('\n')[0]}`);
		verification.aborted = true;
	}
	await browser.close();

	const { jsonPath, mdPath, totals, pages } = writeReport(allResults, {
		baseUrl: BASE_URL,
		authed,
		viewports,
		discovered,
		droppedDiscoveries,
		verification,
	});

	console.log('\n── Summary ──');
	console.log(`  ${totals.error} error · ${totals.warn} warn · ${totals.info} info`);
	if (verification.checked) {
		console.log(
			`  (re-verified ${verification.checked} route/viewport pair(s); ${verification.demoted} finding(s) demoted as contention artifacts)`,
		);
	}
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
