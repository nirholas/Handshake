#!/usr/bin/env node
/**
 * capture-tutorial-media.mjs
 *
 * Turns the `figure:` directives written inside docs/tutorials/*.md into real
 * captured media, and records what it captured in public/tutorial-media.json.
 *
 * Why this exists: 68 tutorials shipped with zero images. Every honest way to
 * fix that is a capture pipeline, because the only images we are allowed to
 * publish are ones the platform actually produced. Nothing here draws, mocks,
 * or stock-sources an image: a page figure is a real Chromium screenshot of the
 * real deployed page, and a model figure is a real render returned by our own
 * /api/render/glb endpoint.
 *
 * ── Author syntax (plain markdown, no custom parser) ─────────────────────────
 * A figure is an ordinary markdown image whose src uses the `figure:` scheme,
 * so an unprocessed file still reads correctly in any markdown viewer:
 *
 *   ![The Forge with a prompt typed in](figure:page:/forge?sel=.forge-panel)
 *   ![Michelle, the default rigged avatar](figure:glb:/avatars/michelle.glb)
 *   ![Drag to orbit the model](figure:live:/avatars/michelle.glb)
 *
 * Kinds:
 *   page:<path>   screenshot of https://three.ws<path> in a real browser
 *   img:<path>    an image already committed under public/, adopted as a figure
 *   glb:<path>    PNG returned by GET /api/render/glb?glbUrl=…
 *   live:<path>   an interactive <model-viewer>, mounted at runtime. No capture
 *                 happens here; it is listed in the manifest so the checker can
 *                 confirm the GLB itself resolves.
 *
 * Options ride along as query params on the directive:
 *   page:  w, h (viewport, default 1280x760), sel (clip to a CSS selector),
 *          full=1 (full-page), settle (ms to wait after load, default 3500),
 *          theme (dark|light, default dark)
 *   glb:   w, h (default 1200x900), bg (default transparent)
 *   live:  orbit (camera-orbit string passed to <model-viewer>)
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   npm run tutorials:media              capture anything missing
 *   npm run tutorials:media -- --force   re-capture everything
 *   npm run tutorials:media -- --check   capture nothing; exit 1 on a gap
 *   npm run tutorials:media -- --only embed-in-30-seconds
 *   BASE_URL=http://localhost:3000 npm run tutorials:media
 *
 * Output: public/docs/img/<collection>/<slug>/<name>-<hash>.webp plus a manifest
 * carrying intrinsic width/height and a blurred inline placeholder, so the page
 * reserves the exact box before the byte arrives and never shifts layout.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');
// Where a reader goes when they click through a figure. This is deliberately
// NOT the capture base: figures are usually shot against a local server running
// the commit being shipped, and a doorway into localhost is a dead link.
const SITE_URL = (process.env.SITE_URL || 'https://three.ws').replace(/\/$/, '');
const MANIFEST = resolve(ROOT, 'public/tutorial-media.json');

// Every markdown collection whose figures this script captures. Both viewers
// (pages/tutorial.html and pages/recipe.html) load the same tutorial-figures.js
// and read the same manifest, so a collection is just a directory plus the
// folder its assets land in. Adding a third is one more row.
const COLLECTIONS = [
	{ name: 'tutorials', dir: resolve(ROOT, 'docs/tutorials'), img: 'docs/img/tutorials' },
	{ name: 'cookbook', dir: resolve(ROOT, 'docs/cookbook'), img: 'docs/img/cookbook' },
];

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const FORCE = has('force');
const CHECK_ONLY = has('check');
const ONLY = opt('only', '');
const QUALITY = Math.max(40, Math.min(100, Number(opt('quality', 82)) || 82));

const FIGURE_RE = /!\[([^\]]*)\]\((figure:[^)\s]+)\)/g;
const KINDS = new Set(['page', 'glb', 'live', 'img']);

// ── Parse ────────────────────────────────────────────────────────────────────

/** Split `figure:page:/forge?sel=.x` into its kind, target and options. */
function parseDirective(raw) {
	const body = raw.slice('figure:'.length);
	const colon = body.indexOf(':');
	if (colon === -1) return { error: 'a figure needs a kind, as in figure:page:/create' };
	const kind = body.slice(0, colon);
	if (!KINDS.has(kind)) return { error: `unknown figure kind "${kind}" (use page, glb, img or live)` };
	const rest = body.slice(colon + 1);
	const q = rest.indexOf('?');
	const target = q === -1 ? rest : rest.slice(0, q);
	const params = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1));
	if (!target.startsWith('/')) return { error: `figure target must be a site-absolute path, got "${target}"` };
	return { kind, target, params };
}

function collectDirectives() {
	const found = [];
	const problems = [];
	for (const collection of COLLECTIONS) {
		if (!existsSync(collection.dir)) continue;
		const files = readdirSync(collection.dir)
			.filter((f) => f.endsWith('.md'))
			.filter((f) => !ONLY || f === `${ONLY}.md`);
		for (const file of files) {
			const slug = file.replace(/\.md$/, '');
			const md = readFileSync(resolve(collection.dir, file), 'utf8');
			for (const match of md.matchAll(FIGURE_RE)) {
				const [, alt, raw] = match;
				const parsed = parseDirective(raw);
				if (parsed.error) {
					problems.push(`${file}: ${parsed.error}`);
					continue;
				}
				if (!alt.trim()) {
					problems.push(`${file}: ${raw} has an empty caption. Every figure needs one, for the caption and the alt text.`);
					continue;
				}
				found.push({ collection: collection.name, img: collection.img, slug, alt: alt.trim(), raw, ...parsed });
			}
		}
	}
	return { found, problems };
}

/** A short, stable name so a re-run overwrites rather than accumulates. */
function assetName(entry) {
	const stem =
		entry.target
			.replace(/^\//, '')
			.replace(/\.[a-z0-9]+$/i, '')
			.replace(/[^a-z0-9]+/gi, '-')
			.replace(/^-+|-+$/g, '')
			.toLowerCase()
			.slice(0, 40) || 'root';
	const hash = createHash('sha256').update(entry.raw).digest('hex').slice(0, 8);
	return `${entry.kind}-${stem}-${hash}`;
}

// ── Capture ──────────────────────────────────────────────────────────────────

async function capturePage(browser, entry) {
	const width = Math.max(320, Math.min(1920, Number(entry.params.get('w')) || 1280));
	const height = Math.max(240, Math.min(1600, Number(entry.params.get('h')) || 760));
	const settle = Math.max(0, Number(entry.params.get('settle')) || 3500);
	const selector = entry.params.get('sel');
	const fullPage = entry.params.get('full') === '1';
	const theme = entry.params.get('theme') === 'light' ? 'light' : 'dark';

	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 2,
		colorScheme: theme,
		reducedMotion: 'reduce',
	});
	// The site reads its theme from localStorage before first paint, so setting
	// it as an init script is the only way to capture the light theme honestly.
	await context.addInitScript(`try{localStorage.setItem('twx_theme',${JSON.stringify(theme)})}catch(e){}`);
	// Floating chrome is not the UI a tutorial is teaching, and most of it
	// rotates its contents per visit, so leaving it in makes every re-capture a
	// spurious diff. Hiding it with a stylesheet installed before first paint
	// beats removing the nodes after load: the i18n switcher and the corner
	// stack both mount asynchronously, after any fixed settle has elapsed, so a
	// removal pass races them and loses on the slower pages.
	await context.addInitScript(`(function(){
		var css = '#cookie-banner,.cookie-banner,[data-role="consent"],.newsletter-toast,'
			+ '#tws-corner-stack,.twx-i18n-fab,lang-switcher,.walk-c2w-fx,.nav-skip,'
			+ '.tour-overlay,.tour-spotlight,.tour-bubble'
			+ '{display:none !important}';
		function put(){ var s=document.createElement('style'); s.textContent=css; (document.head||document.documentElement).appendChild(s); }
		if (document.head) put(); else document.addEventListener('DOMContentLoaded', put);
	})();`);
	// Every first-run coach tour on the platform gates on `tour:<id>:done`, and a
	// capture browser is always a first visit, so every figure of a touring page
	// would otherwise be a photo of the tour instead of the feature. Answering
	// "already seen" is what a returning reader's browser says, and it suppresses
	// the tour before it mounts rather than racing to remove it afterwards.
	await context.addInitScript(`(function(){
		try {
			var real = localStorage.getItem.bind(localStorage);
			localStorage.getItem = function(key){ return /^tour:.*:done$/.test(key) ? '1' : real(key); };
		} catch (e) {}
	})();`);
	const page = await context.newPage();
	try {
		const url = `${BASE_URL}${entry.target}`;
		const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
		if (res && res.status() >= 400) throw new Error(`${url} returned HTTP ${res.status()}`);
		await page.waitForTimeout(settle);
		// The stylesheet above covers the chrome we know by name. Anything else
		// still pinned to a viewport corner at capture time is chrome too.
		await page.evaluate(() => {
			for (const el of document.querySelectorAll('body > *')) {
				if (getComputedStyle(el).position !== 'fixed') continue;
				const r = el.getBoundingClientRect();
				if (r.width > 0 && r.width < 420 && r.bottom > window.innerHeight - 220) el.remove();
			}
		});
		await page.waitForTimeout(400);

		// A page driving a render loop never reaches the idle state the default
		// screenshot path waits for, so a 3D figure times out at exactly the
		// moment it looks best. Freezing CSS animations and giving the shot a
		// real budget is what makes the WebGL surfaces capturable at all.
		const shotOpts = { type: 'png', animations: 'disabled', timeout: 120000 };
		let shot;
		if (selector) {
			const el = await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });
			shot = await el.screenshot(shotOpts);
		} else {
			shot = await page.screenshot({ ...shotOpts, fullPage });
		}
		return shot;
	} finally {
		await context.close();
	}
}

/**
 * Adopt an image that already lives in public/ into the figure system.
 *
 * Some real platform output is a file before it is ever a URL: a still rendered
 * from a model a recipe generated, committed alongside that recipe. Those bytes
 * are as real as a fresh capture, and without this kind the only way to show one
 * is a bare markdown <img> with no caption, no placeholder and no lightbox. This
 * gives it the same figure treatment as everything else.
 *
 * It reads from disk only. A missing file is a hard failure, never a silent gap.
 */
async function captureLocalImage(entry) {
	const path = resolve(ROOT, 'public', entry.target.replace(/^\//, ''));
	if (!existsSync(path)) {
		throw new Error(`no such image in public/: ${entry.target}`);
	}
	const buf = readFileSync(path);
	if (buf.length < 100) throw new Error(`${entry.target} is ${buf.length} bytes, which is not an image`);
	return buf;
}

async function captureGlb(entry) {
	const width = Math.max(64, Math.min(2048, Number(entry.params.get('w')) || 1200));
	const height = Math.max(64, Math.min(2048, Number(entry.params.get('h')) || 900));
	const background = entry.params.get('bg') || 'transparent';
	// The renderer fetches the mesh server-side, so the GLB has to be reachable
	// from outside this machine. Capturing against a local server is normal here;
	// pointing the renderer at that local URL is not, and it 400s.
	const glbUrl = `${SITE_URL}${entry.target}`;
	const url = `${BASE_URL}/api/render/glb?glbUrl=${encodeURIComponent(glbUrl)}&width=${width}&height=${height}&background=${encodeURIComponent(background)}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`render/glb returned HTTP ${res.status} for ${entry.target} ${detail.slice(0, 200)}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length < 1000) throw new Error(`render/glb returned ${buf.length} bytes for ${entry.target}, which is not an image`);
	return buf;
}

/** Confirm a live figure's model actually resolves, so the page never mounts a dead viewer. */
async function verifyLive(entry) {
	const url = `${BASE_URL}${entry.target}`;
	const res = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-64' }, signal: AbortSignal.timeout(30000) });
	if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
	return null;
}

/** Encode to webp, and derive the inline placeholder that holds the layout. */
async function encode(png, outPath) {
	const image = sharp(png);
	const meta = await image.metadata();
	// Retina captures are 2x; publish at half so the intrinsic size matches the
	// CSS box and the browser still has the denser pixels to sample from.
	const width = meta.width || 1200;
	const height = meta.height || 800;
	await sharp(png).webp({ quality: QUALITY, effort: 5 }).toFile(outPath);
	const placeholder = await sharp(png)
		.resize(20, null, { fit: 'inside' })
		.blur(1.2)
		.webp({ quality: 40 })
		.toBuffer();
	return {
		width,
		height,
		placeholder: `data:image/webp;base64,${placeholder.toString('base64')}`,
	};
}

/** The revision the captures were taken from, or null outside a git checkout. */
function headCommit() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() || null;
	} catch {
		return null;
	}
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
	const { found, problems } = collectDirectives();
	if (problems.length) {
		for (const p of problems) console.error(`  bad figure  ${p}`);
		console.error(`\ncapture-tutorial-media: ${problems.length} malformed figure directive(s). Fix the markdown.`);
		process.exit(1);
	}

	const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { figures: {} };
	const prevFigures = previous.figures || {};

	// One entry per unique directive: the same figure may be reused across
	// tutorials and must not be captured, or stored, twice.
	const byDirective = new Map();
	for (const entry of found) {
		if (!byDirective.has(entry.raw)) byDirective.set(entry.raw, { ...entry, slugs: new Set() });
		byDirective.get(entry.raw).slugs.add(entry.slug);
	}
	const entries = [...byDirective.values()];
	console.log(`capture-tutorial-media: ${entries.length} figure(s) across ${new Set(found.map((f) => f.slug)).size} document(s), base ${BASE_URL}`);

	if (CHECK_ONLY) {
		const missing = entries.filter((e) => e.kind !== 'live' && !prevFigures[e.raw]);
		const orphaned = entries.filter((e) => {
			const rec = prevFigures[e.raw];
			return rec && rec.src && !existsSync(resolve(ROOT, 'public', rec.src.replace(/^\//, '')));
		});
		for (const e of missing) console.error(`  uncaptured  ${e.raw}  (in ${[...e.slugs].join(', ')})`);
		for (const e of orphaned) console.error(`  file gone   ${e.raw}  (in ${[...e.slugs].join(', ')})`);
		if (missing.length || orphaned.length) {
			console.error('\ncapture-tutorial-media --check failed. Run `npm run tutorials:media` to capture the gaps.');
			process.exit(1);
		}
		console.log('capture-tutorial-media: every figure has its media. OK');
		return;
	}

	let browser = null;
	const needsBrowser = entries.some((e) => e.kind === 'page' && (FORCE || !prevFigures[e.raw]));
	if (needsBrowser) browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

	// A scoped run (--only) sees just one document's directives, and a run where
	// some captures fail sees fewer still. Writing `figures` fresh would then
	// publish a manifest missing every figure this run did not look at, and the
	// prune below would delete their files. Carry the prior manifest forward and
	// let this run overwrite only what it actually re-captured.
	const partialRun = Boolean(ONLY);
	const figures = partialRun ? { ...prevFigures } : {};
	let captured = 0;
	let reused = 0;
	const failures = [];

	try {
		for (const entry of entries) {
			const slugs = [...entry.slugs].sort();
			const name = assetName(entry);
			const rel = `${entry.img}/${slugs[0]}/${name}.webp`;
			const outPath = resolve(ROOT, 'public', rel);
			const prior = prevFigures[entry.raw];

			if (entry.kind === 'live') {
				try {
					await verifyLive(entry);
					figures[entry.raw] = {
						kind: 'live',
						model: entry.target,
						orbit: entry.params.get('orbit') || null,
						source: `${SITE_URL}${entry.target}`,
						collection: entry.collection,
						docs: slugs,
					};
					console.log(`  live   ${entry.target}`);
				} catch (err) {
					failures.push(`${entry.raw}: ${err.message}`);
				}
				continue;
			}

			if (!FORCE && prior && prior.src && existsSync(resolve(ROOT, 'public', prior.src.replace(/^\//, '')))) {
				figures[entry.raw] = { ...prior, collection: entry.collection, docs: slugs };
				reused += 1;
				continue;
			}

			try {
				const png =
					entry.kind === 'page'
						? await capturePage(browser, entry)
						: entry.kind === 'img'
							? await captureLocalImage(entry)
							: await captureGlb(entry);
				mkdirSync(dirname(outPath), { recursive: true });
				const { width, height, placeholder } = await encode(png, outPath);
				figures[entry.raw] = {
					kind: entry.kind,
					src: `/${rel}`,
					width,
					height,
					placeholder,
					source: `${SITE_URL}${entry.target}`,
					collection: entry.collection,
					docs: slugs,
				};
				captured += 1;
				console.log(`  wrote  /${rel}  ${width}x${height}`);
			} catch (err) {
				failures.push(`${entry.raw}: ${err.message}`);
				console.error(`  FAIL   ${entry.raw}\n         ${err.message}`);
			}
		}
	} finally {
		if (browser) await browser.close();
	}

	// Drop assets whose directive no longer exists, so the folder tracks the
	// markdown instead of growing forever. Only a full sweep may prune: a scoped
	// run has not read the directives that justify the other files, so to it
	// every one of them looks orphaned.
	if (!partialRun && !failures.length) {
		const live = new Set(Object.values(figures).map((f) => f.src).filter(Boolean));
		for (const rec of Object.values(prevFigures)) {
			if (!rec.src || live.has(rec.src)) continue;
			const stale = resolve(ROOT, 'public', rec.src.replace(/^\//, ''));
			if (existsSync(stale)) {
				rmSync(stale);
				console.log(`  pruned /${rec.src.replace(/^\//, '')}`);
			}
		}
	} else if (failures.length) {
		console.log('  skipped pruning: this run had failures, so an absent figure may just be one that did not capture.');
	}

	const payload = {
		$comment: 'GENERATED by scripts/capture-tutorial-media.mjs. Do not edit; run `npm run tutorials:media`.',
		base: BASE_URL,
		site: SITE_URL,
		// The commit the product was on when these figures were shot. A figure is
		// only honest about a screen that existed at a known revision, so the
		// manifest carries that revision instead of leaving readers to guess.
		commit: headCommit(),
		capturedAt: new Date().toISOString(),
		figures: Object.fromEntries(Object.entries(figures).sort(([a], [b]) => a.localeCompare(b))),
	};
	mkdirSync(dirname(MANIFEST), { recursive: true });
	writeFileSync(MANIFEST, `${JSON.stringify(payload, null, '\t')}\n`);
	console.log(`capture-tutorial-media: ${captured} captured, ${reused} reused, ${Object.keys(figures).length} in manifest`);

	if (failures.length) {
		console.error(`\ncapture-tutorial-media: ${failures.length} figure(s) failed:`);
		for (const f of failures) console.error(`  ${f}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`capture-tutorial-media: ${err.stack || err.message}`);
	process.exit(1);
});
