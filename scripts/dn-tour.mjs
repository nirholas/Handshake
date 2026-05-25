#!/usr/bin/env node
// dn-tour — drive the /dashboard-next prototype as a signed-in user.
//
// Usage:
//   node scripts/dn-tour.mjs                          # creates + reuses a throwaway test user
//   TEST_EMAIL=you@x.com TEST_PASSWORD=… node scripts/dn-tour.mjs
//   PORT=3010 node scripts/dn-tour.mjs                # default 3010
//   FRESH=1 node scripts/dn-tour.mjs                  # force a new test user
//   OUT_DIR=/tmp/dn-tour node scripts/dn-tour.mjs
//
// What it does:
//   1. Signs in (or registers a throwaway user via POST /api/auth/register)
//   2. Visits every /dashboard-next page in a real Chromium browser
//   3. Captures a 1440x900 screenshot of each to OUT_DIR
//   4. Reports any unhandled JS errors, console errors, or 5xx network failures
//   5. Returns exit 0 if every page passed, exit 1 otherwise
//
// Use this to verify the dashboard end-to-end against real APIs before
// shipping. Requires a running dev server (`npx vite --port 3010`).

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';

const PORT = process.env.PORT || '3010';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR || '/tmp/dn-tour';
const FRESH = process.env.FRESH === '1';

const PAGES = [
	{ slug: '',          name: 'overview', selector: '.dn-shell .dn-rail-item' },
	{ slug: '/avatars',  name: 'avatars',  selector: '.dn-shell .dn-rail-item' },
	{ slug: '/library',  name: 'library',  selector: '.dn-shell .dn-rail-item' },
	{ slug: '/widgets',  name: 'widgets',  selector: '.dn-shell .dn-rail-item' },
	{ slug: '/api',      name: 'api',      selector: '.dn-shell .dn-rail-item' },
	{ slug: '/monetize', name: 'monetize', selector: '.dn-shell .dn-rail-item' },
	{ slug: '/account',  name: 'account',  selector: '.dn-shell .dn-rail-item' },
];

mkdirSync(OUT_DIR, { recursive: true });

// ── Make sure dev server is up ────────────────────────────────────────────

const ping = await fetch(`${BASE}/dashboard-next`).catch(() => null);
if (!ping || !ping.ok) {
	console.error(`✗ Dev server not reachable at ${BASE}.`);
	console.error(`  Start one with:  npx vite --port ${PORT} --host 127.0.0.1`);
	process.exit(2);
}

// ── Resolve credentials ──────────────────────────────────────────────────

let email = process.env.TEST_EMAIL;
let password = process.env.TEST_PASSWORD;
let created = false;

if (FRESH || !email || !password) {
	const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
	email = `dn-tour-${stamp}@three.test`;
	password = `Tour-${stamp}-Aa1!`;
	console.log(`→ Registering throwaway user  ${email}`);
	created = true;
	// Registration runs inside the browser context too so the response cookie
	// (if the server auto-signs-in on register) lands in Chromium's jar.
} else {
	console.log(`→ Using credentials for      ${email}`);
}

// ── Walk every page in a fresh Chromium ──────────────────────────────────
//
// We log in from inside the browser context (via ctx.request) so the
// Secure / __Host- session cookie is set by Chromium's own network stack —
// avoids the "Invalid cookie fields" error you get from manually injecting
// __Host- cookies through addCookies().

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

if (created) {
	const reg = await ctx.request.post(`${BASE}/api/auth/register`, {
		headers: { 'content-type': 'application/json' },
		data: { email, password, display_name: 'DN Tour' },
	});
	if (!reg.ok()) {
		const body = await reg.text().catch(() => '');
		console.error(`✗ Registration failed: HTTP ${reg.status()} — ${body.slice(0, 240)}`);
		console.error(`  Tip: pass TEST_EMAIL / TEST_PASSWORD env vars to use an existing account.`);
		await browser.close();
		process.exit(2);
	}
}

const loginRes = await ctx.request.post(`${BASE}/api/auth/login`, {
	headers: { 'content-type': 'application/json' },
	data: { email, password },
});
if (!loginRes.ok()) {
	const body = await loginRes.text().catch(() => '');
	console.error(`✗ Login failed: HTTP ${loginRes.status()} — ${body.slice(0, 240)}`);
	await browser.close();
	process.exit(2);
}
const cookies = await ctx.cookies();
console.log(`→ Logged in. Cookies set:    ${cookies.map((c) => c.name).join(', ') || '(none)'}`);

let failed = 0;
const summary = [];

for (const page of PAGES) {
	const url = `${BASE}/dashboard-next${page.slug}`;
	const out = `${OUT_DIR}/${page.name}.png`;
	const errs = [];
	const p = await ctx.newPage();
	p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 240)));
	p.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 240)); });
	p.on('response', (res) => {
		const u = res.url();
		const s = res.status();
		if (s >= 500 && !/posthog|esm\.sh|googletagmanager/.test(u)) {
			errs.push(`HTTP ${s} ${u}`);
		}
	});

	let status = 'PASS';
	let note = '';
	try {
		await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
		if (p.url().includes('/login')) {
			status = 'FAIL';
			note = 'redirected to /login — auth cookie not accepted';
		} else {
			await p.waitForSelector(page.selector, { timeout: 15000 });
			// Give async fetches + 3D previews a beat to settle.
			await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
			await p.waitForTimeout(1200);
		}
		await p.screenshot({ path: out, fullPage: false });
	} catch (e) {
		status = 'FAIL';
		note = e.message.slice(0, 180);
	}

	// Filter known-noisy errors that aren't our code.
	const real = errs.filter((e) => {
		if (/posthog\.com|esm\.sh|googletagmanager/.test(e)) return false;
		if (/Failed to load resource.*40[14]/.test(e))       return false;
		return true;
	});
	if (real.length > 0 && status === 'PASS') {
		status = 'FAIL';
		note = real[0];
	}

	if (status === 'FAIL') failed++;
	summary.push({ name: page.name, status, out, note, errs: real });
	const label = status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
	console.log(`[${label}] ${page.name.padEnd(10)} → ${out}${note ? `  · ${note}` : ''}`);
	for (const e of real.slice(0, 3)) console.log(`         ${e}`);

	await p.close();
}

await browser.close();

// ── Report ───────────────────────────────────────────────────────────────

console.log('');
console.log(`Screenshots: ${OUT_DIR}/`);
if (created) {
	console.log(`Test user:   ${email}  (password: ${password})`);
	console.log(`             (account will keep working — delete from DB if you want)`);
}
console.log('');
const pass = summary.filter((s) => s.status === 'PASS').length;
console.log(`${pass}/${summary.length} pages passed.`);
process.exit(failed ? 1 : 0);

// ── Helpers ──────────────────────────────────────────────────────────────

function parseSetCookie(raw) {
	// Node fetch joins multiple Set-Cookie headers with ", " but only when the
	// value itself doesn't contain a comma. Splitting on "," would corrupt
	// expires=Wed, 31 Mar … — so we split conservatively on ", <name>=" boundaries.
	const parts = raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
	return parts.map((part) => {
		const segments = part.split(';').map((s) => s.trim());
		const [first, ...rest] = segments;
		const eq = first.indexOf('=');
		const name = first.slice(0, eq);
		const value = first.slice(eq + 1);
		const cookie = { name, value };
		for (const seg of rest) {
			const [k, v] = seg.split('=');
			const key = k.toLowerCase();
			if (key === 'httponly') cookie.httpOnly = true;
			if (key === 'secure')   cookie.secure = true;
			if (key === 'samesite') cookie.sameSite = (v || '').replace(/^./, (c) => c.toUpperCase());
		}
		return cookie;
	});
}
