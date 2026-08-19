#!/usr/bin/env node
/**
 * page-snapshot.mjs — daily visual snapshot of every page on the site.
 *
 * Drives a real Chromium across every public page (sourced from data/pages.json,
 * the same manifest that powers /sitemap, llms.txt and page-audit) in a desktop
 * and a mobile viewport, and saves a full-page screenshot of each. The result is
 * a complete picture of how the site looked on a given day — a design memory you
 * can flip back to after any drastic change.
 *
 * ── Storage model: stable paths + git history as the time machine ─────────────
 * Screenshots are written to STABLE filenames (snapshots/current/<viewport>/<slug>.jpg),
 * overwritten on every run. Each day's `git commit` of snapshots/ is the archive:
 *
 *   • Browse today:      open snapshots/current/index.html
 *   • See a page's past: git log --follow -- snapshots/current/desktop/home.jpg
 *   • Recover any day:   git checkout <sha> -- snapshots/current   (or git show <sha>:<path> > old.jpg)
 *   • Export a full day: scripts/snapshot-export-day.sh <YYYY-MM-DD>   (see that script)
 *
 * This keeps the working tree at ~one day's size (~tens of MB) while git history
 * holds every prior day in full — no unbounded snapshots/<date>/ folder bloat.
 *
 * ── Target ────────────────────────────────────────────────────────────────────
 *   BASE_URL=https://three.ws        (default — the live, deployed design)
 *   BASE_URL=http://localhost:3000   (vite/vercel dev)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   node scripts/page-snapshot.mjs                 # full snapshot, desktop + mobile
 *   node scripts/page-snapshot.mjs / /pay /ibm     # only these routes
 *   node scripts/page-snapshot.mjs --desktop-only  # skip the mobile viewport
 *   node scripts/page-snapshot.mjs --mobile-only   # skip the desktop viewport
 *   node scripts/page-snapshot.mjs --concurrency 4 # parallel pages per viewport (default 3)
 *   node scripts/page-snapshot.mjs --settle 5000   # ms to wait after load for 3D/animations
 *   node scripts/page-snapshot.mjs --quality 80    # JPEG quality (default 72)
 *   node scripts/page-snapshot.mjs --authed        # signed-in sweep (dashboard, settings, profile)
 *   node scripts/page-snapshot.mjs --out reports/x # write somewhere other than snapshots/current
 *
 * ── Authenticated sweep ───────────────────────────────────────────────────────
 * `--authed` replays the Playwright storageState that `npm run audit:web:login`
 * writes to .auth/audit-state.json, and widens the route list to every page a
 * signed-in visitor can reach. Those shots show the QA account's own data, so
 * they default to reports/ui-shots/ (gitignored) rather than the committed
 * public design record under snapshots/.
 *
 * Note: headless Chromium renders WebGL via SWANGLE/SwiftShader. Most 3D heroes
 * render, but some heavy GPU scenes (and backdrop-filter) may come out dark. The
 * full-page layout, type, copy and imagery are always captured faithfully — that
 * is the design record. Raise --settle if a page's data loads slowly.
 */
import { chromium, devices } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHED_ROUTES, manifestPages, slugFor } from './lib/audit-routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');
const AUTH_STATE = resolve(ROOT, '.auth/audit-state.json');

// ── CLI parsing ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DESKTOP_ONLY = flag('desktop-only');
const MOBILE_ONLY = flag('mobile-only');
const CONCURRENCY = Math.max(1, Number(opt('concurrency', 3)) || 3);
const SETTLE_MS = Math.max(0, Number(opt('settle', 3500)) || 3500);
const QUALITY = Math.min(100, Math.max(30, Number(opt('quality', 72)) || 72));
const explicitRoutes = argv.filter((a) => a.startsWith('/'));
// Signed-in sweep. The session comes from the storageState `npm run
// audit:web:login` writes, and it changes where the shots land: the committed
// design record under snapshots/ is a PUBLIC record, and an authenticated run
// shows the QA account's own data, so it defaults to a gitignored directory.
const AUTHED = flag('authed');
const OUT_DIR = resolve(ROOT, opt('out', AUTHED ? 'reports/ui-shots' : 'snapshots/current'));

// ── Route discovery ────────────────────────────────────────────────────────────
// Pages, the authenticated route list and the slug rule come from
// scripts/lib/audit-routes.mjs, shared with page-audit so the visual record and
// the console/layout audit always cover the same site.

// ── Snapshot one route in one viewport ──────────────────────────────────────────
async function snapshotRoute(ctx, page, route, viewport) {
	const slug = slugFor(route);
	const file = resolve(OUT_DIR, viewport, `${slug}.jpg`);
	let navStatus = 0;
	let title = '';
	try {
		const resp = await page
			.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 45000 })
			.catch(async () => {
				// networkidle never settles on pages with long-poll/SSE — fall back.
				return page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
			});
		navStatus = resp ? resp.status() : 0;
	} catch (e) {
		return { route, viewport, slug, ok: false, navStatus, error: String(e).slice(0, 160) };
	}
	// Let data, fonts, lazy images and 3D scenes settle before the shot.
	await page.waitForTimeout(SETTLE_MS);
	await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
	title = (await page.title().catch(() => '')) || '';
	mkdirSync(dirname(file), { recursive: true });
	try {
		await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: QUALITY });
	} catch {
		// Some pages are taller than the GPU surface limit — clip to a tall viewport shot.
		await page.screenshot({ path: file, fullPage: false, type: 'jpeg', quality: QUALITY });
	}
	const bytes = existsSync(file) ? statSync(file).size : 0;
	return { route, viewport, slug, ok: bytes > 0, navStatus, title, bytes };
}

// Bounded-concurrency pool, one shared-context page per worker.
async function runPool(ctx, routes, viewport, onResult) {
	const queue = [...routes];
	const results = [];
	const worker = async () => {
		const page = await ctx.newPage();
		// Silence page console so a noisy site doesn't drown the run log.
		page.on('console', () => {});
		page.on('pageerror', () => {});
		while (queue.length) {
			const route = queue.shift();
			const r = await snapshotRoute(ctx, page, route, viewport).catch((e) => ({
				route,
				viewport,
				slug: slugFor(route),
				ok: false,
				error: String(e).slice(0, 160),
			}));
			results.push(r);
			onResult(r);
		}
		await page.close();
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, routes.length) }, worker));
	return results;
}

// ── Gallery (self-contained: data is inlined so file:// works without a server) ──
function writeGallery(meta, byRoute) {
	const data = {
		capturedAt: meta.capturedAt,
		date: meta.date,
		baseUrl: meta.baseUrl,
		viewports: meta.viewports,
		pages: byRoute,
	};
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>three.ws — site snapshot ${meta.date}</title>
<style>
  :root { --bg:#0a0a0b; --panel:#141416; --line:#26262b; --fg:#f4f4f5; --mut:#9a9aa3; --accent:#e8e8ea; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif; }
  header { position:sticky; top:0; z-index:10; background:rgba(10,10,11,.85); backdrop-filter:blur(12px); border-bottom:1px solid var(--line); padding:18px 24px; display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; letter-spacing:-.01em; }
  header .meta { color:var(--mut); font-size:13px; }
  header .spacer { flex:1; }
  .toggle { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .toggle button { background:transparent; color:var(--mut); border:0; padding:6px 14px; font:inherit; cursor:pointer; }
  .toggle button[aria-pressed="true"] { background:var(--accent); color:#0a0a0b; font-weight:600; }
  input[type=search] { background:var(--panel); border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:7px 12px; font:inherit; min-width:220px; }
  main { padding:24px; }
  .section-title { color:var(--mut); text-transform:uppercase; letter-spacing:.08em; font-size:11px; margin:28px 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; transition:border-color .15s, transform .15s; }
  .card:hover { border-color:#3a3a42; transform:translateY(-2px); }
  .card a.shot { display:block; aspect-ratio:16/10; overflow:hidden; background:#000; border-bottom:1px solid var(--line); }
  .card a.shot img { width:100%; height:100%; object-fit:cover; object-position:top center; display:block; }
  .card .body { padding:11px 13px; }
  .card .t { font-weight:600; font-size:13px; margin:0 0 2px; }
  .card .p { color:var(--mut); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card.missing a.shot { display:flex; align-items:center; justify-content:center; color:var(--mut); font-size:12px; aspect-ratio:16/10; }
  .empty { color:var(--mut); padding:40px; text-align:center; }
</style>
</head>
<body>
<header>
  <h1>three.ws site snapshot</h1>
  <span class="meta" id="meta"></span>
  <span class="spacer"></span>
  <input type="search" id="q" placeholder="Filter pages…" aria-label="Filter pages" />
  <div class="toggle" role="group" aria-label="Viewport">
    <button id="vp-desktop" aria-pressed="true">Desktop</button>
    <button id="vp-mobile" aria-pressed="false">Mobile</button>
  </div>
</header>
<main id="main"></main>
<script>
const DATA = ${JSON.stringify(data)};
let viewport = DATA.viewports.includes('desktop') ? 'desktop' : 'mobile';
let query = '';
const main = document.getElementById('main');
document.getElementById('meta').textContent =
  DATA.pages.length + ' pages · ' + DATA.baseUrl + ' · captured ' + new Date(DATA.capturedAt).toLocaleString();

function bySection() {
  const m = new Map();
  for (const p of DATA.pages) {
    if (query && !(p.path.toLowerCase().includes(query) || (p.title||'').toLowerCase().includes(query))) continue;
    if (!m.has(p.section)) m.set(p.section, []);
    m.get(p.section).push(p);
  }
  return m;
}
function render() {
  const groups = bySection();
  if (!groups.size) { main.innerHTML = '<div class="empty">No pages match "' + query + '".</div>'; return; }
  let html = '';
  for (const [section, pages] of groups) {
    html += '<div class="section-title">' + section + ' · ' + pages.length + '</div><div class="grid">';
    for (const p of pages) {
      const shot = p.shots && p.shots[viewport];
      const src = shot ? viewport + '/' + p.slug + '.jpg' : '';
      html += '<div class="card' + (shot ? '' : ' missing') + '">'
        + (shot
            ? '<a class="shot" href="' + src + '" target="_blank" rel="noopener"><img loading="lazy" src="' + src + '" alt="' + (p.title||p.path) + '"></a>'
            : '<a class="shot">not captured</a>')
        + '<div class="body"><p class="t">' + (p.title||p.path) + '</p><p class="p">' + p.path + '</p></div></div>';
    }
    html += '</div>';
  }
  main.innerHTML = html;
}
function setVp(v) {
  viewport = v;
  document.getElementById('vp-desktop').setAttribute('aria-pressed', String(v==='desktop'));
  document.getElementById('vp-mobile').setAttribute('aria-pressed', String(v==='mobile'));
  render();
}
document.getElementById('vp-desktop').onclick = () => setVp('desktop');
document.getElementById('vp-mobile').onclick = () => setVp('mobile');
if (!DATA.viewports.includes('desktop')) document.getElementById('vp-desktop').disabled = true;
if (!DATA.viewports.includes('mobile')) document.getElementById('vp-mobile').disabled = true;
document.getElementById('q').oninput = (e) => { query = e.target.value.trim().toLowerCase(); render(); };
render();
</script>
</body>
</html>`;
	writeFileSync(resolve(OUT_DIR, 'index.html'), html);
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
	let targets;
	if (explicitRoutes.length) {
		targets = explicitRoutes.map((p) => ({ path: p, title: p, section: 'Selected', auth: null }));
	} else if (AUTHED) {
		// Everything a signed-in visitor can reach: the public pages plus the
		// auth-gated ones the manifest flags plus the dashboard sub-pages it
		// deliberately leaves out of the public index.
		const inManifest = new Set(manifestPages({ access: 'all' }).map((p) => p.path));
		targets = [
			...manifestPages({ access: 'all' }),
			...AUTHED_ROUTES.filter((path) => !inManifest.has(path)).map((path) => ({
				path,
				title: path,
				section: 'Signed in',
				auth: 'required',
			})),
		];
	} else {
		// Public design record: auth-gated pages would only show a login wall.
		targets = manifestPages({ access: 'public' });
	}
	const routes = targets.map((p) => p.path);

	if (AUTHED && !existsSync(AUTH_STATE)) {
		console.error(
			'--authed needs a session. Run `npm run audit:web:login` first (it writes .auth/audit-state.json).',
		);
		process.exitCode = 1;
		return;
	}

	const viewports = MOBILE_ONLY ? ['mobile'] : DESKTOP_ONLY ? ['desktop'] : ['desktop', 'mobile'];

	// `date` is the local calendar day this run belongs to — stamped into the
	// manifest and gallery so a committed set is self-describing.
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

	console.log(`■ Snapshotting ${routes.length} pages at ${BASE_URL}`);
	console.log(`  viewports: ${viewports.join(', ')}  ·  concurrency: ${CONCURRENCY}  ·  settle: ${SETTLE_MS}ms  ·  jpeg q${QUALITY}`);

	// Clear stale shots so a removed/renamed page never lingers in the committed set.
	for (const vp of viewports) {
		const dir = resolve(OUT_DIR, vp);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	}

	const browser = await chromium.launch({
		args: [
			'--no-sandbox',
			'--disable-dev-shm-usage',
			// Maximise the odds WebGL 3D heroes render under headless Chromium.
			'--ignore-gpu-blocklist',
			'--enable-unsafe-swiftshader',
			'--use-gl=angle',
			'--use-angle=swiftshader',
		],
	});

	const byRoute = new Map(targets.map((p) => [p.path, { ...p, slug: slugFor(p.path), shots: {} }]));
	let done = 0;
	const total = routes.length * viewports.length;

	for (const viewport of viewports) {
		const ctxOpts =
			viewport === 'mobile'
				? { ...devices['iPhone 13'] }
				: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
		if (AUTHED) ctxOpts.storageState = AUTH_STATE;
		const ctx = await browser.newContext(ctxOpts);
		ctx.setDefaultTimeout(45000);
		console.log(`── ${viewport} ──`);
		await runPool(ctx, routes, viewport, (r) => {
			done++;
			const entry = byRoute.get(r.route);
			if (entry && r.ok) entry.shots[viewport] = { bytes: r.bytes, navStatus: r.navStatus };
			const mark = r.ok ? '✓' : '✗';
			const size = r.ok ? `${Math.round(r.bytes / 1024)}kb` : r.error || `HTTP ${r.navStatus}`;
			console.log(`  ${mark} [${String(done).padStart(3)}/${total}] ${viewport} ${r.route}  ${size}`);
		});
		await ctx.close();
	}
	await browser.close();

	// ── Manifest + gallery ──────────────────────────────────────────────────────
	const pageList = [...byRoute.values()].map((p) => ({
		path: p.path,
		title: p.title,
		section: p.section,
		slug: p.slug,
		shots: p.shots,
	}));
	const captured = pageList.filter((p) => Object.keys(p.shots).length).length;
	const meta = {
		capturedAt: now.toISOString(),
		date,
		baseUrl: BASE_URL,
		viewports,
		pageCount: pageList.length,
		capturedCount: captured,
	};
	writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify({ ...meta, pages: pageList }, null, 2));
	writeGallery(meta, pageList);

	console.log(`\n■ Done. ${captured}/${pageList.length} pages captured for ${date}.`);
	console.log(`  Gallery:  snapshots/current/index.html`);
	console.log(`  Manifest: snapshots/current/manifest.json`);
	if (captured < pageList.length) {
		const missing = pageList.filter((p) => !Object.keys(p.shots).length).map((p) => p.path);
		console.log(`  Missing:  ${missing.join(', ')}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
