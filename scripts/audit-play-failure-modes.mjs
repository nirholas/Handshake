#!/usr/bin/env node
/**
 * /play failure-mode audit, deliberate failure injection in a real browser.
 *
 * `npm run audit:console` proves /play is clean when everything works. This one
 * proves it stays usable when things break, which is what an event crowd will
 * actually hit: no session, ad blockers eating IPFS, a dead GLB, a 500 on the
 * auth nonce, an expired pass mid-session, and hostile query strings pasted from
 * a shared link.
 *
 * Each scenario drives a fresh browser context against /play with specific
 * network routes aborted or rewritten, then asserts:
 *
 *   • the boot loader always resolves, either the world opens, or a designed
 *     error card with a recovery action replaces it. Never a stuck spinner.
 *   • no uncaught exception, and no console error/warning from our code
 *     (judged against the shared filter in lib/console-noise.mjs)
 *   • hostile `name` / `symbol` / `image` params never execute script and never
 *     escape a CSS `url()` into the surrounding style attribute
 *   • the world still renders a real avatar when its GLB or coin art is blocked
 *
 * Usage:
 *   node scripts/audit-play-failure-modes.mjs                 # every scenario
 *   node scripts/audit-play-failure-modes.mjs xss css-inject  # named scenarios
 *   node scripts/audit-play-failure-modes.mjs --list
 *   HEADFUL=1 node scripts/audit-play-failure-modes.mjs xss   # watch it run
 *   BASE_URL=https://three.ws node scripts/audit-play-failure-modes.mjs
 *
 * Reuses a dev server already on :3000, otherwise spawns an ephemeral Vite. The
 * dev server proxies /api/* to https://three.ws, so the auth gate, the coin feed
 * and the avatar registry are all real.
 *
 * Exit code 1 on any failed assertion, so this is CI/pre-event gateable.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { chromium } from 'playwright';
import { isIgnorableConsole } from './lib/console-noise.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = {
	g: (s) => `\x1b[32m${s}\x1b[0m`,
	r: (s) => `\x1b[31m${s}\x1b[0m`,
	y: (s) => `\x1b[33m${s}\x1b[0m`,
	d: (s) => `\x1b[2m${s}\x1b[0m`,
	b: (s) => `\x1b[1m${s}\x1b[0m`,
	c: (s) => `\x1b[36m${s}\x1b[0m`,
};

// The canonical $THREE community deep link (docs/event-readiness/README.md).
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const THREE_IMAGE =
	'/api/img?url=https%3A%2F%2Fipfs.io%2Fipfs%2Fbafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q&seed=' +
	THREE_MINT;
const CANONICAL = `/play?coin=${THREE_MINT}&name=three.ws&symbol=three&image=${encodeURIComponent(THREE_IMAGE)}`;

// How long to let the world settle before asserting. The boot loader carries its
// own 6s avatar safety net and a 45s watchdog, so 20s is past every designed
// resolution point while staying well inside the watchdog.
const SETTLE_MS = 20_000;

// Navigation budget. 60s is generous against a healthy host, but this repo's dev
// box is shared by many concurrent agents and a starved chromium can take minutes
// to reach DOMContentLoaded on a page it would otherwise open in two seconds.
// Raise it there (NAV_TIMEOUT_MS=180000) so host contention shows up as a slow
// pass instead of a fabricated "the world hung" finding.
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS) || 60_000;

// ── Hostile inputs ───────────────────────────────────────────────────────────
// Every payload calls the same sentinel, so one flag proves script execution
// regardless of which vector fired.
const XSS_PAYLOADS = {
	name: '"><img src=x onerror="window.__xss=1"><svg onload="window.__xss=1">',
	symbol: '\'"--></style></script><script>window.__xss=1</script>',
	// Breaks out of  background-image:url("<here>")  in a style attribute.
	cssImage: 'x");position:fixed;inset:0;z-index:2147483647;background:red;--x:url("y',
};

// ── Scenarios ────────────────────────────────────────────────────────────────
// `routes` entries run through page.route(); `expect` runs in Node with the
// collected observations.

// The top-level document is never the thing under test: a scenario injects a
// failure into the page's SUBRESOURCES. It has to be excluded explicitly,
// because /play carries its deep link in the query string, so the page URL for
// the canonical link literally contains "/api/img" and an unguarded matcher
// aborts the navigation itself. That failure reads as "the whole scenario
// crashed" while actually testing nothing at all.
const notDocument = (route) => route.request().resourceType() !== 'document';

/** Abort every request whose URL matches, as an ad blocker or a dead host would. */
const block = (re, code = 'blockedbyclient') => ({
	match: re,
	handler: (route) => (notDocument(route) ? route.abort(code) : route.continue()),
});
/** Answer with a status, as a throttled or broken upstream would. */
const status = (re, s, body = '{"error":"injected"}') => ({
	match: re,
	handler: (route) => (notDocument(route)
		? route.fulfill({ status: s, contentType: 'application/json', body })
		: route.continue()),
});

const SCENARIOS = [
	{
		id: 'anon',
		title: 'Signed out, everything healthy',
		url: CANONICAL,
	},
	{
		id: 'no-params',
		title: 'Bare /play, no query string at all',
		url: '/play',
	},
	{
		id: 'garbage-coin',
		title: 'Garbage ?coin= mint',
		url: '/play?coin=not-a-real-mint-%F0%9F%92%A5%3Cscript%3E',
	},
	{
		id: 'xss',
		title: 'XSS attempt in ?name= and ?symbol=',
		url:
			`/play?coin=${THREE_MINT}` +
			`&name=${encodeURIComponent(XSS_PAYLOADS.name)}` +
			`&symbol=${encodeURIComponent(XSS_PAYLOADS.symbol)}`,
	},
	{
		id: 'css-inject',
		title: 'CSS breakout in ?image=',
		url: `/play?coin=${THREE_MINT}&name=three.ws&symbol=three&image=${encodeURIComponent(XSS_PAYLOADS.cssImage)}`,
	},
	{
		id: 'oversized-image',
		title: 'Oversized ?image= URL (8 KB)',
		url: `/play?coin=${THREE_MINT}&name=three.ws&symbol=three&image=${encodeURIComponent('https://example.com/' + 'a'.repeat(8192) + '.png')}`,
	},
	{
		id: 'block-coin-art',
		title: 'Coin art blocked (ad blocker on IPFS + /api/img)',
		url: CANONICAL,
		routes: [block(/\/api\/img\b/), block(/ipfs\.io|dweb\.link|flk-ipfs\.xyz|arweave\.net/)],
	},
	{
		id: 'block-glb',
		title: 'Every avatar GLB blocked',
		url: CANONICAL,
		routes: [block(/\.(glb|vrm)(\?|$)/i)],
	},
	{
		id: 'nonce-500',
		title: 'Auth gate unreachable (/api/play/nonce → 500)',
		url: CANONICAL,
		routes: [status(/\/api\/play\/nonce/, 500)],
	},
	{
		id: 'nonce-429',
		title: 'Auth gate rate-limited (/api/play/nonce → 429)',
		url: CANONICAL,
		routes: [status(/\/api\/play\/nonce/, 429)],
	},
	{
		id: 'nonce-offline',
		title: 'Auth gate offline (/api/play/nonce aborted)',
		url: CANONICAL,
		routes: [block(/\/api\/play\/nonce/, 'connectionfailed')],
	},
	{
		id: 'feed-down',
		title: 'Coin feed down (/api/pump/* → 500)',
		url: '/play',
		routes: [status(/\/api\/pump\//, 500)],
	},
	{
		id: 'expired-pass',
		title: 'Expired play pass already in sessionStorage',
		url: CANONICAL,
		// Seed a pass that expired an hour ago. loadStoredPass() must discard it
		// rather than hand a dead token to the room join.
		init: `sessionStorage.setItem('cc-play-pass', JSON.stringify({
			wallet: 'SEEDEDwallet1111111111111111111111111111111',
			playPass: 'expired.pass.token',
			mint: '${THREE_MINT}',
			balance: 1,
			symbol: 'three',
			expiresAt: new Date(Date.now() - 3600e3).toISOString(),
		}));`,
		expect: (o) => (o.storedPass === null ? null : 'expired pass survived in sessionStorage'),
	},
	{
		id: 'corrupt-pass',
		title: 'Corrupt play pass in sessionStorage',
		url: CANONICAL,
		init: `sessionStorage.setItem('cc-play-pass', '{not json at all');`,
	},
	{
		id: 'storage-denied',
		title: 'localStorage and sessionStorage throw (private mode / blocked cookies)',
		url: CANONICAL,
		// Mirrors Safari private mode and hardened-privacy extensions: the object
		// exists but every access throws. Every storage read in /play is wrapped;
		// this proves it.
		init: `
			const boom = () => { throw new DOMException('denied', 'SecurityError'); };
			for (const k of ['localStorage', 'sessionStorage']) {
				Object.defineProperty(window, k, {
					configurable: true,
					get: () => ({ getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 }),
				});
			}`,
	},
	{
		id: 'script-scheme-image',
		title: 'Script-scheme ?image= (javascript: and data:text/html)',
		// proxiedImageURL must refuse these outright rather than pass them to an
		// <img src> / TextureLoader, where they cannot execute but do produce an
		// ERR_UNKNOWN_URL_SCHEME console error and a permanently broken tile.
		url: `/play?coin=${THREE_MINT}&name=three.ws&symbol=three&image=${encodeURIComponent('javascript:window.__xss=1')}`,
		expect: (o) => (o.hostileSrc?.length ? `hostile ?image= reached an image sink: ${o.hostileSrc[0]}` : null),
	},
	{
		id: 'adblock-extras',
		title: 'Ad blocker eats the optional page scripts',
		// The single most likely visitor at an event: uBlock/Brave/a corporate
		// filter kills the non-critical extras. The world does not depend on any
		// of them, so the boot watchdog must NOT paint its error card over a page
		// that is loading normally.
		url: CANONICAL,
		routes: [block(/\/(brand|i18n|theme-switcher)\.js(\?|$)/)],
		expect: (o) => (o.errorCard ? 'boot error card shown after only optional scripts were blocked' : null),
	},
	{
		id: 'api-blackout',
		title: 'Every /api/* request blocked (venue filter / API down)',
		// Each fetch boundary owns its own failure state, so the world must still
		// open onto designed empty/error states rather than a boot error card.
		url: CANONICAL,
		routes: [block(/\/api\//)],
		expect: (o) => (o.errorCard ? 'boot error card shown for an API outage the page is meant to absorb' : null),
	},
];

// ── Dev server (same contract as audit-console.mjs) ──────────────────────────
const PROBE_BASE = 'http://127.0.0.1:3000';

function probe(url, timeoutMs = 2000) {
	return new Promise((resolve) => {
		const req = httpGet(url, (res) => { res.resume(); resolve(res.statusCode || 0); });
		req.setTimeout(timeoutMs, () => req.destroy());
		req.on('error', () => resolve(0));
	});
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
	});
}

async function startServer() {
	if (process.env.BASE_URL) {
		const base = process.env.BASE_URL.replace(/\/$/, '');
		console.log(C.d(`  targeting ${base}`));
		// A local Vite still needs its dep optimizer warmed; a deployed origin does not.
		if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base)) await warmup(base);
		return { base, stop: async () => {} };
	}
	if (await probe(`${PROBE_BASE}/`, 5000)) {
		console.log(C.d('  reusing dev server on :3000'));
		await warmup('http://localhost:3000');
		return { base: 'http://localhost:3000', stop: async () => {} };
	}
	const port = await freePort();
	const child = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['--port', String(port), '--strictPort'], {
		cwd: ROOT, stdio: process.env.LOG_ALL ? 'inherit' : 'ignore', env: process.env,
	});
	const deadline = Date.now() + 90_000;
	process.stdout.write(`  starting Vite on :${port} `);
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`vite exited early (code ${child.exitCode})`);
		if (await probe(`http://127.0.0.1:${port}/`, 2000)) { process.stdout.write('\n'); break; }
		process.stdout.write('.');
		await new Promise((r) => setTimeout(r, 500));
	}
	if (Date.now() >= deadline) { child.kill('SIGKILL'); throw new Error('vite did not become ready within 90s'); }
	await warmup(`http://localhost:${port}`);
	return { base: `http://localhost:${port}`, stop: async () => child.kill('SIGTERM') };
}

// Pre-bundle /play's deps so the first scenario doesn't eat the optimizer reload.
async function warmup(base) {
	process.stdout.write('  warming Vite dep optimizer ');
	for (const p of ['/', '/play']) { await fetch(`${base}${p}`).catch(() => {}); process.stdout.write('.'); }
	await new Promise((r) => setTimeout(r, 8000));
	process.stdout.write('\n');
}

// ── One scenario ─────────────────────────────────────────────────────────────

// One browser PROCESS per scenario, not one context on a shared browser.
// /play stands up two WebGL contexts (the boot avatar and the main scene) plus a
// rAF loop and a game socket, and chromium does not reclaim those promptly when
// only the owning context closes. On a shared browser the first scenario passed
// and every later one timed out on `domcontentloaded`, which reads exactly like
// a site outage while actually being exhausted GPU-context slots in the harness.
// A fresh process costs about a second and makes each scenario's result mean
// what it says.
async function runScenario(base, sc) {
	const browser = await chromium.launch({ headless: !process.env.HEADFUL });
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	// Close the process, not just the context. Every exit path goes through this.
	const teardown = async () => {
		await context.close().catch(() => {});
		await browser.close().catch(() => {});
	};
	const consoleIssues = [];
	const pageErrors = [];

	// Sentinel + payload-echo harness, installed before any page script runs.
	await context.addInitScript(`
		window.__xss = 0;
		window.addEventListener('unhandledrejection', (e) => {
			(window.__rejections = window.__rejections || []).push(String(e.reason?.message || e.reason));
		});
	`);
	if (sc.init) await context.addInitScript(sc.init);

	const page = await context.newPage();
	// A payload that fires window.alert would hang the run; auto-dismiss and record.
	page.on('dialog', async (d) => { pageErrors.push(`dialog: ${d.type()} ${d.message()}`); await d.dismiss(); });
	page.on('console', (msg) => {
		const type = msg.type();
		if (type !== 'error' && type !== 'warning') return;
		const text = msg.text();
		if (isIgnorableConsole(text)) return;
		consoleIssues.push(`${type}: ${text}`);
	});
	page.on('pageerror', (err) => {
		const m = String(err?.message || err);
		if (!isIgnorableConsole(m)) pageErrors.push(`pageerror: ${m}`);
	});

	for (const r of sc.routes || []) await page.route(r.match, r.handler);

	const findings = [];
	try {
		await page.goto(base + sc.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
	} catch (err) {
		const m = String(err?.message || err);
		await teardown();
		// A dead browser is this harness starving, not the product failing. On a
		// loaded box chromium gets OOM-killed mid-navigation and Playwright reports
		// it as a goto failure, which reads identically to "the site hung" and would
		// put a fabricated outage in the report. Hand it back as `infra` so the
		// caller can retry it and, if it never runs, count it as NOT RUN rather than
		// as a pass or a finding.
		if (/Page crashed|Target (page|closed)|browser has been closed|Target crashed/i.test(m)) {
			return { infra: m, findings: [], consoleIssues: [], pageErrors: [] };
		}
		findings.push(`navigation failed: ${m}`);
		return { findings, consoleIssues, pageErrors };
	}

	await page.waitForTimeout(SETTLE_MS);

	const o = await page.evaluate(() => {
		const loader = document.getElementById('kx-loading');
		const hidden = !loader || loader.classList.contains('kx-hidden');
		const errorCard = !!document.querySelector('.kx-boot-error');
		const gate = document.querySelector('.pg-root');
		// Any element whose inline style carries a declaration we never author
		// after a url() means the CSS breakout landed.
		const styleBreakout = Array.from(document.querySelectorAll('[style]'))
			.map((n) => n.getAttribute('style') || '')
			.filter((s) => /url\(["'][^"']*["']\)\s*;\s*\S/.test(s) || /position:\s*fixed;inset:0;z-index:2147483647/.test(s));
		// A script-scheme or HTML-document URL that reached any image sink. It
		// cannot execute from an <img src>, but it is a value that should have
		// been refused upstream, and it always shows up as a console error.
		const HOSTILE = /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i;
		const hostileSrc = Array.from(document.querySelectorAll('[src],[href],[style]'))
			.flatMap((n) => [n.getAttribute('src'), n.getAttribute('href'), n.getAttribute('style')])
			.filter((v) => v && (HOSTILE.test(v) || /url\(["']?\s*(javascript|vbscript):/i.test(v)))
			.slice(0, 3);
		let stored = null;
		try { stored = sessionStorage.getItem('cc-play-pass'); } catch { stored = null; }
		const rig = window.__CC__?.localRig;
		return {
			loaderResolved: hidden || errorCard,
			errorCard,
			errorCardText: errorCard ? (document.querySelector('.kx-boot-error-msg')?.textContent || '') : '',
			errorCardHasAction: errorCard ? !!document.querySelector('.kx-boot-error-btn') : true,
			gateVisible: !!gate,
			gateState: gate?.querySelector('.pg-card')?.getAttribute('data-state') || null,
			xss: window.__xss === 1,
			injectedScripts: document.querySelectorAll('script[src*="onerror"], img[onerror]').length,
			styleBreakout,
			hostileSrc,
			storedPass: stored,
			phase: window.__CC__?.phase || null,
			hasScene: !!window.__CC__?.scene,
			hasLocalRig: !!rig,
			rigVisible: rig ? rig.visible !== false : null,
			// A rendered avatar has at least one skinned or regular mesh under it.
			rigMeshes: rig ? (() => { let n = 0; rig.traverse((x) => { if (x.isMesh || x.isSkinnedMesh) n++; }); return n; })() : 0,
			bodyText: (document.body.innerText || '').slice(0, 400),
			rejections: window.__rejections || [],
		};
	});

	// ── Universal assertions ────────────────────────────────────────────────
	if (o.xss) findings.push('SCRIPT EXECUTED from a query parameter (window.__xss set)');
	if (o.injectedScripts) findings.push(`${o.injectedScripts} injected script/img[onerror] node(s) in the DOM`);
	if (o.styleBreakout.length) {
		findings.push(`CSS breakout from a query parameter into a style attribute: ${JSON.stringify(o.styleBreakout[0].slice(0, 160))}`);
	}
	if (!o.loaderResolved) findings.push('boot loader never resolved, stuck spinner, no error card');
	if (o.errorCard && !o.errorCardHasAction) findings.push('error card has no recovery action');
	if (o.errorCard && !o.errorCardText.trim()) findings.push('error card has no message');
	for (const r of o.rejections) if (!isIgnorableConsole(r)) findings.push(`unhandledrejection: ${r}`);

	// A world that opened must show a real avatar, never an empty rig.
	if (o.phase === 'world' && o.hasLocalRig && o.rigMeshes === 0) {
		findings.push('local avatar rig has no meshes, invisible player');
	}

	if (sc.expect) { const extra = sc.expect(o); if (extra) findings.push(extra); }

	await teardown();
	return { findings, consoleIssues, pageErrors, o };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	if (args.includes('--list')) {
		for (const s of SCENARIOS) console.log(`${s.id.padEnd(18)} ${s.title}`);
		return 0;
	}
	const wanted = args.filter((a) => !a.startsWith('--'));
	const scenarios = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
	if (!scenarios.length) { console.error(C.r(`no scenario matched: ${wanted.join(', ')}`)); return 1; }

	console.log(C.b('\n╔══ /play failure-mode audit ═════════════════════════════════╗'));
	console.log(`  ${scenarios.length} scenario(s) × 1 viewport`);
	console.log(C.b('╚═════════════════════════════════════════════════════════════╝\n'));

	const server = await startServer();
	const failed = [];
	const notRun = [];

	try {
		for (const sc of scenarios) {
			process.stdout.write(`  ${C.c(sc.id.padEnd(18))} ${C.d(sc.title)}\n`);
			// Give a browser that died of resource starvation one more chance before
			// giving up on the scenario. Two crashes in a row is a machine that cannot
			// run this audit, not a verdict on /play.
			let res = await runScenario(server.base, sc);
			if (res.infra) {
				console.log(`      ${C.y('↻')} ${C.d(`browser died (${res.infra.split('\n')[0]}), retrying`)}`);
				res = await runScenario(server.base, sc);
			}
			if (res.infra) {
				notRun.push({ sc, why: res.infra.split('\n')[0] });
				console.log(`      ${C.y('!')} ${C.y('NOT RUN')} ${C.d('browser crashed twice, host out of resources')}`);
				continue;
			}
			const { findings, consoleIssues, pageErrors, o } = res;
			const all = [...findings, ...pageErrors, ...consoleIssues];
			if (all.length) {
				failed.push({ sc, all });
				for (const f of all) console.log(`      ${C.r('✗')} ${f}`);
			} else {
				const note = o?.errorCard
					? 'designed error card'
					: o?.gateVisible
						? `gate: ${o.gateState}`
						: o?.phase === 'world'
							? `world (${o.rigMeshes} avatar meshes)`
							: `lobby (${o?.phase})`;
				console.log(`      ${C.g('✓')} ${C.d(note)}`);
			}
		}
	} finally {
		await server.stop();
	}

	console.log(C.b('\n═══════════════ SUMMARY ═══════════════\n'));
	const ran = scenarios.length - notRun.length;
	// A scenario that never ran is never silently folded into the pass count: an
	// audit that says "all clear" while a third of it never executed is worse than
	// one that says nothing.
	if (notRun.length) {
		console.log(C.y(`  ${notRun.length} of ${scenarios.length} scenario(s) NOT RUN (host out of resources):`));
		for (const { sc, why } of notRun) console.log(`      ${C.y('!')} ${sc.id}: ${why}`);
		console.log('');
	}
	if (!failed.length) {
		console.log(C.g(`  ${ran} of ${scenarios.length} FAILURE MODES HANDLED, no stuck loaders, no script execution, clean console.\n`));
		return notRun.length ? 2 : 0;
	}
	console.log(C.r(`  ${failed.length} of ${ran} scenario(s) that ran failed:\n`));
	for (const { sc, all } of failed) {
		console.log(`  ${C.b(sc.id)}, ${sc.title}`);
		for (const f of all) console.log(`      ${C.r('•')} ${f}`);
	}
	console.log('');
	return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
	console.error(C.r(`\naudit failed to run: ${err.stack || err.message}\n`));
	process.exit(1);
});
