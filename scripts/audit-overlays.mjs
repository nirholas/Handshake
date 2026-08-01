#!/usr/bin/env node
/**
 * audit-overlays.mjs — prove that no floating widget covers another.
 *
 * three.ws grew a lot of persistent, viewport-anchored UI: the Walk Companion,
 * the corner stack ("Getting started", feature discovery, the language FAB),
 * cookie and consent bars, sticky headers and CTA rails, chat launchers, the
 * command palette. Each one is independently correct. Together they compete for
 * the same few hundred pixels, and the failure is invisible to unit tests and to
 * whoever built either widget — it only appears on the one page where both are
 * on, at the one viewport where they touch.
 *
 * Every fix for that class of bug so far has been a bug report, a hand
 * measurement, and a magic offset. This script replaces the hand measurement.
 * It drives a real Chromium over real routes at real viewports, finds every
 * painted `position: fixed | sticky` overlay root, and computes the pairwise
 * intersections. A collision is reported when two independent overlays overlap
 * enough to hide each other's controls.
 *
 * It writes visual evidence, not just a list: each finding gets a screenshot of
 * the page with the two offenders outlined and their intersection filled, and
 * the run produces a browsable report at reports/overlays/index.html.
 *
 * ── What counts as a collision ────────────────────────────────────────────────
 *   • Both parties are painted (they have a background, border, shadow, or a
 *     canvas/img/video/svg inside). A transparent positioning wrapper hides
 *     nothing and is not a finding.
 *   • The party UNDERNEATH is interactive or carries text: something a visitor
 *     could have clicked or read, and now cannot. A decorative layer losing
 *     pixels is not a defect: the Walk Companion is drawn over its own
 *     footprint-trail canvas on purpose.
 *   • The overlap clears both thresholds: --min-area px² and --min-ratio of the
 *     SMALLER party's area. Ratio alone flags hairline seams on huge bars;
 *     area alone flags a 1% clip of two full-width rails.
 *   • Neither party is an ancestor of the other, and they are not the same
 *     stacking family (a widget's own dropdown is allowed to sit on it).
 *
 * Full-viewport scrims (>= 90% of the viewport) are classified as `layer` and
 * reported separately: a modal backdrop covering the page is correct, a stray
 * one is a serious bug, and neither is an overlay-vs-overlay collision.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   npm run audit:overlays                      # curated widget-heavy routes, 3 viewports
 *   npm run audit:overlays -- --all             # every HTML route in data/pages.json
 *   npm run audit:overlays -- --routes /,/examples,/docs
 *   npm run audit:overlays -- --base https://three.ws
 *   npm run audit:overlays -- --viewport mobile
 *   npm run audit:overlays -- --json            # machine-readable findings on stdout
 *   npm run audit:overlays -- --no-widgets      # audit the page's own chrome only
 *
 * Exits 1 when any collision is found, so it can gate a release. Everything it
 * writes lands under reports/ (gitignored).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'reports/overlays');

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const BASE = (opt('base', process.env.BASE_URL || 'http://localhost:3000')).replace(/\/$/, '');
const JSON_ONLY = has('json');
const ALL_ROUTES = has('all');
const WITH_WIDGETS = !has('no-widgets');
const SETTLE_MS = Math.max(0, Number(opt('settle', 6000)) || 6000);
const MIN_AREA = Math.max(0, Number(opt('min-area', 900)) || 900);
const MIN_RATIO = Math.max(0, Number(opt('min-ratio', 0.06)) || 0.06);
const CONCURRENCY = Math.max(1, Number(opt('concurrency', 2)) || 2);

const VIEWPORTS = [
	{ id: 'desktop', width: 1440, height: 900 },
	{ id: 'tablet', width: 834, height: 1112 },
	{ id: 'mobile', width: 390, height: 844 },
];
const viewportFilter = opt('viewport', null);
const viewports = viewportFilter
	? VIEWPORTS.filter((v) => v.id === viewportFilter)
	: VIEWPORTS;

// Routes where persistent widgets actually stack up: the marketing surfaces a
// first-time visitor lands on, the doc surfaces the companion follows them
// onto, and the dense app pages where a covered control is unrecoverable.
const CURATED_ROUTES = [
	'/',
	'/examples',
	'/docs',
	'/create',
	'/agents',
	'/marketplace',
	'/pricing',
	'/walk',
	'/embed',
	'/pay',
];

function manifestRoutes() {
	const pages = JSON.parse(readFileSync(path.join(ROOT, 'data/pages.json'), 'utf8'));
	const out = [];
	for (const s of pages.sections || []) {
		if (s.id === 'machine') continue;
		for (const p of s.pages || []) {
			if (!p.path || !p.path.startsWith('/') || /[:*]/.test(p.path)) continue;
			if (/\.(xml|txt|json|js|png|svg|ico)$/.test(p.path)) continue;
			if (p.path.startsWith('/.well-known')) continue;
			if (p.auth) continue;
			out.push(p.path);
		}
	}
	return [...new Set(out)];
}

const explicit = (opt('routes', '') || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const routes = explicit.length ? explicit : ALL_ROUTES ? manifestRoutes() : CURATED_ROUTES;

// ── The in-page collector ─────────────────────────────────────────────────────
// Serialised into the browser. Everything it needs must live inside it.
function collectOverlays() {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const FOCUSABLE =
		'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[contenteditable="true"]';

	const clip = (r) => ({
		left: Math.max(0, r.left),
		top: Math.max(0, r.top),
		right: Math.min(vw, r.right),
		bottom: Math.min(vh, r.bottom),
	});
	const areaOf = (b) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);

	// A wrapper that paints nothing cannot hide anything behind it. Shadows count:
	// a large blurred shadow is exactly how a floating card asserts itself.
	function paints(el, cs) {
		if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
		if (cs.boxShadow && cs.boxShadow !== 'none') return true;
		if (cs.borderTopWidth !== '0px' && cs.borderTopColor !== 'rgba(0, 0, 0, 0)') return true;
		if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
		const bg = cs.backgroundColor || '';
		const m = bg.match(/rgba?\(([^)]+)\)/);
		if (m) {
			const parts = m[1].split(',').map((n) => parseFloat(n));
			const alpha = parts.length > 3 ? parts[3] : 1;
			if (alpha > 0.02) return true;
		}
		if (el.querySelector('canvas,img,video,svg,picture')) return true;
		// Bare text on a transparent background still occludes visually.
		if ((el.textContent || '').trim().length > 0 && el.children.length === 0) return true;
		return false;
	}

	function interactive(el, cs) {
		if (cs.pointerEvents !== 'none' && el.matches(FOCUSABLE)) return true;
		for (const child of el.querySelectorAll(FOCUSABLE)) {
			if (getComputedStyle(child).pointerEvents !== 'none') return true;
		}
		return false;
	}

	function label(el) {
		if (el.id) return '#' + el.id;
		const cls = (el.getAttribute('class') || '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.join('.');
		const tag = el.tagName.toLowerCase();
		return cls ? `${tag}.${cls}` : tag;
	}

	function measurable(el) {
		const cs = getComputedStyle(el);
		if (cs.display === 'none' || cs.visibility === 'hidden') return null;
		if (parseFloat(cs.opacity || '1') < 0.05) return null;
		if (el.hasAttribute('hidden')) return null;
		const box = clip(el.getBoundingClientRect());
		const area = areaOf(box);
		if (area < 400) return null;
		if (box.right - box.left < 12 || box.bottom - box.top < 12) return null;
		return { el, cs, box, area };
	}

	// Pass 1: the viewport anchors — every visible fixed/sticky box, outermost only.
	const anchors = [];
	for (const el of document.querySelectorAll('body *')) {
		const cs = getComputedStyle(el);
		if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
		const m = measurable(el);
		if (!m) continue;
		anchors.push(m);
	}
	const outerAnchors = anchors.filter((a) => !anchors.some((o) => o !== a && o.el.contains(a.el)));

	// Pass 2: resolve each anchor to the boxes a visitor actually sees.
	//
	// An anchor that paints nothing is a positioning shell, not an overlay — and
	// the shells are where the interesting collisions hide. #tws-corner-stack is
	// a transparent, pointer-events:none flex column whose MEMBERS are
	// position:relative; auditing only fixed/sticky elements would have declared
	// that whole family invisible and missed the exact bug this exists to catch.
	// So a non-painting anchor is replaced by its outermost painted descendants,
	// each treated as an overlay in its own right.
	const roots = [];
	const seen = new Set();
	function push(m) {
		if (seen.has(m.el)) return;
		seen.add(m.el);
		roots.push(m);
	}
	function descend(el, depth) {
		if (depth > 6) return;
		for (const child of el.children) {
			const m = measurable(child);
			if (!m) continue;
			if (paints(child, m.cs)) push(m);
			else descend(child, depth + 1);
		}
	}
	for (const a of outerAnchors) {
		if (paints(a.el, a.cs)) push(a);
		else descend(a.el, 0);
	}

	return roots.map((c, i) => ({
		index: i,
		label: label(c.el),
		role: c.el.getAttribute('role') || null,
		ariaHidden: c.el.getAttribute('aria-hidden') === 'true',
		position: c.cs.position,
		zIndex: c.cs.zIndex === 'auto' ? null : Number(c.cs.zIndex),
		pointerEvents: c.cs.pointerEvents,
		interactive: interactive(c.el, c.cs),
		hasText: (c.el.innerText || '').trim().length > 1,
		box: c.box,
		area: Math.round(c.area),
		coverage: +(c.area / (vw * vh)).toFixed(3),
		isDialog: c.el.tagName === 'DIALOG' || c.el.getAttribute('role') === 'dialog',
	}));
}

// ── Analysis (node side) ──────────────────────────────────────────────────────
function intersect(a, b) {
	const left = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const right = Math.min(a.right, b.right);
	const bottom = Math.min(a.bottom, b.bottom);
	if (right <= left || bottom <= top) return null;
	return { left, top, right, bottom, area: (right - left) * (bottom - top) };
}

const SCRIM_COVERAGE = 0.9;

function findCollisions(overlays) {
	const widgets = overlays.filter((o) => o.coverage < SCRIM_COVERAGE);
	const out = [];
	for (let i = 0; i < widgets.length; i++) {
		for (let j = i + 1; j < widgets.length; j++) {
			const a = widgets[i];
			const b = widgets[j];
			// A dialog is meant to sit on everything while it is open.
			if (a.isDialog || b.isDialog) continue;
			if (a.ariaHidden && b.ariaHidden) continue;
			const hit = intersect(a.box, b.box);
			if (!hit) continue;
			const smaller = Math.min(a.area, b.area);
			const ratio = hit.area / smaller;
			if (hit.area < MIN_AREA || ratio < MIN_RATIO) continue;
			// Whichever paints last wins the pixel; that is the one hiding the other.
			const az = a.zIndex ?? 0;
			const bz = b.zIndex ?? 0;
			const top = az === bz ? (a.index > b.index ? a : b) : az > bz ? a : b;
			const under = top === a ? b : a;
			// The defect is losing something you could have read or clicked. A
			// decorative layer underneath loses nothing: the Walk Companion is
			// deliberately drawn over its own footprint-trail canvas, and calling
			// that a bug would train everyone to ignore this report.
			if (!under.interactive && !under.hasText) continue;
			out.push({
				a: a.label,
				b: b.label,
				covering: top.label,
				covered: under.label,
				zIndexA: a.zIndex,
				zIndexB: b.zIndex,
				overlapPx: Math.round(hit.area),
				overlapRatio: +ratio.toFixed(3),
				rect: {
					left: Math.round(hit.left),
					top: Math.round(hit.top),
					right: Math.round(hit.right),
					bottom: Math.round(hit.bottom),
				},
				boxes: [a.box, b.box],
			});
		}
	}
	return out.sort((x, y) => y.overlapPx - x.overlapPx);
}

function findStrayScrims(overlays) {
	return overlays
		.filter((o) => o.coverage >= SCRIM_COVERAGE && !o.isDialog && o.pointerEvents !== 'none')
		.filter((o) => o.interactive === false)
		.map((o) => ({ label: o.label, coverage: o.coverage, zIndex: o.zIndex }));
}

// ── Capture ───────────────────────────────────────────────────────────────────
// Widget state a first-time visitor actually gets. Without this the audit runs
// against a page with every persistent widget switched off and finds nothing —
// which is exactly the blind spot that let these collisions ship.
const FIRST_VISIT_STATE = () => {
	try {
		localStorage.setItem('walk:companion:enabled', '1');
		localStorage.removeItem('tws:getting-started:dismissed');
		localStorage.removeItem('tws:feature-discovery:seen');
	} catch (e) {
		/* storage disabled: the page still renders its own chrome */
	}
};

async function auditRoute(browser, route, viewport) {
	const ctx = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		deviceScaleFactor: 1,
		reducedMotion: 'reduce',
	});
	if (WITH_WIDGETS) await ctx.addInitScript(FIRST_VISIT_STATE);
	const page = await ctx.newPage();
	const result = { route, viewport: viewport.id, collisions: [], scrims: [], error: null };
	try {
		// One retry: a dev server restarting mid-sweep (or a cold serverless
		// route) refuses a single connection, and an audit that reports that as
		// a finding is worse than useless.
		let res = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				res = await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
				break;
			} catch (err) {
				if (attempt === 1) throw err;
				await page.waitForTimeout(4000);
			}
		}
		if (res && res.status() >= 400) {
			result.error = `HTTP ${res.status()}`;
			await ctx.close();
			return result;
		}
		// The companion is a lazily-injected Three.js module; on an unbundled dev
		// server it can take ten seconds to appear. Waiting for it (rather than
		// guessing a settle) is the difference between auditing the widget-heavy
		// page a visitor sees and auditing a page with the widgets still absent.
		if (WITH_WIDGETS) {
			await page
				.waitForSelector('.walk-companion.is-in', { timeout: 20000 })
				.catch(() => {
					/* excluded route, no WebGL, or the visitor already dismissed it */
				});
		}
		await page.waitForTimeout(SETTLE_MS);
		const overlays = await page.evaluate(collectOverlays);
		result.overlayCount = overlays.length;
		result.collisions = findCollisions(overlays);
		result.scrims = findStrayScrims(overlays);

		if (result.collisions.length) {
			const slug =
				(route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '-')) +
				'-' +
				viewport.id;
			const file = path.join(OUT_DIR, 'shots', `${slug}.png`);
			mkdirSync(path.dirname(file), { recursive: true });
			await annotate(page, result.collisions);
			await page.screenshot({ path: file });
			result.shot = path.relative(OUT_DIR, file);
		}
	} catch (err) {
		result.error = err?.message || String(err);
	}
	await ctx.close();
	return result;
}

/** Draw the offenders and their intersection onto the live page before shooting. */
async function annotate(page, collisions) {
	await page.evaluate((hits) => {
		const layer = document.createElement('div');
		layer.id = 'tws-overlay-audit-layer';
		layer.style.cssText =
			'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:600 11px/1.2 ui-monospace,monospace';
		const draw = (box, css, text) => {
			const d = document.createElement('div');
			d.style.cssText =
				`position:absolute;left:${box.left}px;top:${box.top}px;` +
				`width:${box.right - box.left}px;height:${box.bottom - box.top}px;` +
				css;
			if (text) {
				const t = document.createElement('span');
				t.textContent = text;
				t.style.cssText =
					'position:absolute;left:0;top:-15px;white-space:nowrap;padding:1px 4px;' +
					'border-radius:3px;background:#ff2d55;color:#fff';
				d.appendChild(t);
			}
			layer.appendChild(d);
		};
		for (const hit of hits) {
			for (const b of hit.boxes) draw(b, 'outline:2px dashed rgba(255,45,85,.85);', null);
			draw(
				hit.rect,
				'background:rgba(255,45,85,.38);outline:2px solid #ff2d55;',
				`${hit.covering} over ${hit.covered}`,
			);
		}
		document.body.appendChild(layer);
	}, collisions);
}

// ── Report ────────────────────────────────────────────────────────────────────
const esc = (s) =>
	String(s).replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
	);

function writeReport(results, meta) {
	const bad = results.filter((r) => r.collisions.length);
	const cards = bad
		.map(
			(r) => `
	<article class="card">
		<header>
			<h2><a href="${esc(meta.base + r.route)}">${esc(r.route)}</a></h2>
			<span class="vp">${esc(r.viewport)}</span>
			<span class="count">${r.collisions.length} collision${r.collisions.length === 1 ? '' : 's'}</span>
		</header>
		${r.shot ? `<a class="shot" href="${esc(r.shot)}"><img loading="lazy" src="${esc(r.shot)}" alt="Annotated screenshot of ${esc(r.route)} at ${esc(r.viewport)} width"></a>` : ''}
		<ul>
			${r.collisions
				.map(
					(c) => `<li>
				<code>${esc(c.covering)}</code> covers <code>${esc(c.covered)}</code>
				<span class="meta">${c.overlapPx.toLocaleString()} px&sup2; &middot; ${Math.round(c.overlapRatio * 100)}% of the smaller box &middot; z ${c.zIndexA ?? 'auto'} / ${c.zIndexB ?? 'auto'}</span>
			</li>`,
				)
				.join('')}
		</ul>
	</article>`,
		)
		.join('');

	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overlay collisions — three.ws</title>
<style>
:root{color-scheme:dark;--bg:#0b0d12;--panel:#12151d;--line:#232837;--fg:#e8ecf4;--dim:#8b93a7;--bad:#ff2d55;--ok:#3ddc97}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:48px 20px 96px}
h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px}
.sub{color:var(--dim);margin:0 0 28px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 32px;padding:0;list-style:none}
.stats li{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.stats b{display:block;font-size:22px;letter-spacing:-.02em}
.stats span{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 18px}
.card header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.card h2{font-size:17px;margin:0}
.card h2 a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--line)}
.card h2 a:hover{border-color:var(--fg)}
.vp,.count{font:600 11px/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;padding:5px 8px;border-radius:999px}
.vp{background:#1b2130;color:var(--dim)}
.count{background:rgba(255,45,85,.16);color:var(--bad)}
.shot{display:block;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:12px}
.shot img{display:block;width:100%;height:auto}
.card ul{margin:0;padding-left:18px}
.card li{margin:0 0 6px}
code{background:#1b2130;border-radius:5px;padding:1px 6px;font:600 12.5px/1 ui-monospace,monospace}
.meta{display:block;color:var(--dim);font-size:12.5px}
.clean{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--ok);border-radius:12px;padding:22px}
.clean h2{margin:0 0 6px;font-size:18px}
.clean p{margin:0;color:var(--dim)}
footer{color:var(--dim);font-size:13px;margin-top:36px;border-top:1px solid var(--line);padding-top:16px}
@media (max-width:640px){.wrap{padding:28px 14px 64px}h1{font-size:24px}}
</style></head><body><div class="wrap">
<h1>Overlay collisions</h1>
<p class="sub">Every painted <code>fixed</code> / <code>sticky</code> overlay on each route, intersected pairwise. Dashed boxes are the two offenders; the filled box is what one hides of the other.</p>
<ul class="stats">
	<li><b>${meta.routes}</b><span>routes</span></li>
	<li><b>${meta.viewports}</b><span>viewports</span></li>
	<li><b>${meta.checks}</b><span>page renders</span></li>
	<li><b>${meta.collisions}</b><span>collisions</span></li>
</ul>
${bad.length ? cards : '<div class="clean"><h2>No collisions.</h2><p>No two interactive overlays overlapped past the thresholds on any audited route.</p></div>'}
<footer>${esc(meta.base)} &middot; captured ${esc(meta.at)} &middot; thresholds: ${MIN_AREA} px&sup2; and ${Math.round(MIN_RATIO * 100)}% of the smaller box &middot; regenerate with <code>npm run audit:overlays</code></footer>
</div></body></html>`;

	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(path.join(OUT_DIR, 'index.html'), html);
	writeFileSync(
		path.join(OUT_DIR, 'report.json'),
		JSON.stringify({ meta, results }, null, '\t'),
	);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	if (!viewports.length) {
		console.error(`Unknown --viewport. Choose one of: ${VIEWPORTS.map((v) => v.id).join(', ')}`);
		process.exit(2);
	}
	// A stale shot from a route that no longer collides would misreport the run.
	if (existsSync(path.join(OUT_DIR, 'shots'))) {
		rmSync(path.join(OUT_DIR, 'shots'), { recursive: true, force: true });
	}

	const jobs = [];
	for (const route of routes) for (const vp of viewports) jobs.push({ route, vp });

	if (!JSON_ONLY) {
		console.log(`Overlay audit — ${routes.length} routes x ${viewports.length} viewports on ${BASE}`);
	}

	const browser = await chromium.launch();
	const results = [];
	let cursor = 0;
	async function worker() {
		while (cursor < jobs.length) {
			const job = jobs[cursor++];
			const r = await auditRoute(browser, job.route, job.vp);
			results.push(r);
			if (!JSON_ONLY) {
				const mark = r.error ? '!' : r.collisions.length ? 'x' : '.';
				const note = r.error
					? ` ${r.error}`
					: r.collisions.length
						? ` ${r.collisions.length} collision(s)`
						: '';
				console.log(`  ${mark} ${r.route} @ ${r.viewport}${note}`);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
	await browser.close();

	results.sort((a, b) => a.route.localeCompare(b.route) || a.viewport.localeCompare(b.viewport));
	const collisions = results.reduce((n, r) => n + r.collisions.length, 0);
	const errored = results.filter((r) => r.error);
	const meta = {
		base: BASE,
		at: new Date().toISOString(),
		routes: routes.length,
		viewports: viewports.length,
		checks: results.length,
		collisions,
		widgetsEnabled: WITH_WIDGETS,
	};
	writeReport(results, meta);

	if (JSON_ONLY) {
		console.log(JSON.stringify({ meta, results }, null, '\t'));
	} else {
		console.log('');
		for (const r of results.filter((x) => x.collisions.length)) {
			console.log(`${r.route} @ ${r.viewport}`);
			for (const c of r.collisions) {
				console.log(
					`   ${c.covering} covers ${c.covered} — ${c.overlapPx} px2 (${Math.round(c.overlapRatio * 100)}% of the smaller box)`,
				);
			}
		}
		const strays = results.filter((r) => r.scrims.length);
		for (const r of strays) {
			for (const s of r.scrims) {
				console.log(`${r.route} @ ${r.viewport}: full-viewport layer ${s.label} blocks the page`);
			}
		}
		if (errored.length) {
			console.log(`\n${errored.length} route(s) could not be rendered:`);
			for (const r of errored) console.log(`   ${r.route} @ ${r.viewport}: ${r.error}`);
		}
		console.log(
			`\n${collisions} collision(s) across ${results.length} renders. Report: reports/overlays/index.html`,
		);
	}
	// A route that would not render is not a pass. Silently exiting 0 on a dead
	// dev server is how an audit starts lying about coverage.
	process.exit(collisions > 0 || errored.length > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
