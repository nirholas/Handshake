#!/usr/bin/env node
/**
 * capture-tour-atlas.mjs: turn the Feature Tour curriculum into a real,
 * verified picture of the product.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The Feature Tour (src/feature-tour/*) already knows more about this platform
 * than any other artifact in the repo: every page worth showing, the element on
 * that page worth pointing at, and a plain-language sentence about what it does.
 * That knowledge was only ever spent at runtime, on one visitor at a time, and
 * nothing verified it. When a page was redesigned the tour's CSS anchor quietly
 * stopped matching, the spotlight fell back to a whole-page dim, and no test
 * anywhere noticed.
 *
 * This script drives a real Chromium across every stop in the curriculum
 * against a real deployment. For each stop it:
 *
 *   1. loads the stop's page and records the HTTP status and console errors,
 *   2. resolves the stop's CSS anchor the same way the live Spotlight does,
 *   3. paints the tour's own spotlight ring over the resolved element,
 *   4. screenshots the viewport and encodes a hero + thumbnail WebP.
 *
 * The output is two things at once:
 *
 *   • a media library (public/media/tour/*.webp) of real product screenshots
 *     with the feature under discussion literally circled, which the docs,
 *     tutorials and the /tour/atlas page all render, and
 *   • a health manifest (data/tour-atlas.json) that says, per stop, whether the
 *     anchor still resolves. scripts/audit-tour-atlas.mjs turns that into a
 *     gate, so tour rot fails a check instead of silently degrading.
 *
 * No mock pages and no synthetic fixtures: the default target is production, so
 * a shot in the atlas is a shot of what a visitor sees right now.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/capture-tour-atlas.mjs                     # every stop, from https://three.ws
 *   node scripts/capture-tour-atlas.mjs --base http://localhost:3000
 *   node scripts/capture-tour-atlas.mjs --only home,forge   # just these stop ids
 *   node scripts/capture-tour-atlas.mjs --section build     # one curriculum chapter
 *   node scripts/capture-tour-atlas.mjs --track quick       # one track's playlist
 *   node scripts/capture-tour-atlas.mjs --limit 10
 *   node scripts/capture-tour-atlas.mjs --concurrency 4     # default 3
 *   node scripts/capture-tour-atlas.mjs --settle 3500       # ms after load before shooting
 *   node scripts/capture-tour-atlas.mjs --health            # resolve anchors only, write nothing
 *   node scripts/capture-tour-atlas.mjs --mobile            # also capture a 390px shot per stop
 *
 * A partial run (--only / --section / --track / --limit) MERGES into the existing
 * manifest rather than replacing it, so re-shooting one chapter never deletes the
 * rest of the atlas.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	TOUR_FALLBACK_SELECTORS,
	TOUR_CONTENT_ROOT_SELECTOR,
} from '../src/feature-tour/curriculum.js';
// The summary shape is owned by the gate that verifies it, so the writer and the
// checker can never disagree about what a number means.
import { summarizeStops } from './build-tour-atlas.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CURRICULUM_PATH = resolve(ROOT, 'public/tour/curriculum.json');
const MANIFEST_PATH = resolve(ROOT, 'data/tour-atlas.json');
const MEDIA_DIR = resolve(ROOT, 'public/media/tour');
const MEDIA_URL_BASE = '/media/tour';

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, fallback) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const list = (n) =>
	String(opt(n, ''))
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

const BASE = String(opt('base', process.env.BASE_URL || 'https://three.ws')).replace(/\/$/, '');
const ONLY = new Set(list('only'));
const SECTIONS = new Set(list('section'));
const TRACK = opt('track', '');
const LIMIT = Number(opt('limit', 0)) || 0;
const CONCURRENCY = Math.min(8, Math.max(1, Number(opt('concurrency', 3)) || 3));
const SETTLE_MS = Math.max(0, Number(opt('settle', 3000)) || 3000);
const NAV_TIMEOUT_MS = Math.max(10_000, Number(opt('timeout', 45_000)) || 45_000);
const HEALTH_ONLY = flag('health');
const WITH_MOBILE = flag('mobile');
const QUIET = flag('quiet');

// Capture geometry. The hero is what the atlas lightbox and the tutorials show;
// the thumb is what the atlas grid lazy-loads, so it has to stay small enough
// that a 185-card grid is cheap on a phone.
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 2 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2 };
const HERO_WIDTH = 1200;
const HERO_QUALITY = 78;
const THUMB_WIDTH = 520;
const THUMB_QUALITY = 60;
const MOBILE_WIDTH = 620;

const log = (...a) => {
	if (!QUIET) console.log(...a);
};

// ── Curriculum ───────────────────────────────────────────────────────────────
function loadCurriculum() {
	if (!existsSync(CURRICULUM_PATH)) {
		throw new Error(
			`missing ${CURRICULUM_PATH}. Run "node scripts/build-tour.mjs" to generate the curriculum first.`,
		);
	}
	const data = JSON.parse(readFileSync(CURRICULUM_PATH, 'utf8'));
	if (!Array.isArray(data.stops) || !data.stops.length) throw new Error('curriculum has no stops');
	return data;
}

// Which tracks a stop belongs to, mirroring buildPlaylist() in
// src/feature-tour/curriculum.js. Onboarding stops are deliberately disjoint
// from full/quick there, and the atlas has to report the same membership or its
// track filter would lie about what a visitor actually sees.
function tracksFor(stop) {
	if (stop.section === 'onboarding') return ['onboarding'];
	return stop.highlight ? ['full', 'quick'] : ['full'];
}

function selectStops(curriculum) {
	let stops = curriculum.stops.map((stop, index) => ({ ...stop, index, tracks: tracksFor(stop) }));
	if (ONLY.size) stops = stops.filter((s) => ONLY.has(s.id));
	if (SECTIONS.size) stops = stops.filter((s) => SECTIONS.has(s.section));
	if (TRACK) stops = stops.filter((s) => s.tracks.includes(TRACK));
	if (LIMIT) stops = stops.slice(0, LIMIT);
	return stops;
}

const isPartialRun = () => ONLY.size > 0 || SECTIONS.size > 0 || Boolean(TRACK) || LIMIT > 0;

// The ordered selector groups the live tour would try for a stop, tagged with
// where each came from so the atlas can tell a curated anchor apart from the
// director's generic fallback. Only about a fifth of the curriculum carries
// hand-authored anchors (scripts/build-tour.mjs, TARGETS); every other stop is
// spotlit by the fallback chain, which is why the atlas has to know it too. The
// chain is imported from the same module the director imports it from, so the
// two can never drift into reporting on a tour that does not exist.
function anchorGroups(stop) {
	const curated = (Array.isArray(stop.targets) ? stop.targets : []).filter(Boolean);
	return [
		...curated.map((selector) => ({ selector, source: 'curriculum' })),
		...TOUR_FALLBACK_SELECTORS.map((selector) => ({ selector, source: 'fallback' })),
	];
}

// ── In-page helpers ──────────────────────────────────────────────────────────
// Serialized into the live page by page.evaluate(). They run in the browser, so
// they can close over nothing from this module: every input arrives as an
// argument and every output has to be structured-cloneable.

// Overlays that would otherwise sit on top of every shot. Each is a real
// element this site can render (consent bar, PWA install prompt, the mobile nav
// drawer when a narrow viewport auto-opens it). Removing them is not hiding a
// failure: they are chrome that appears on any page, not the feature the stop
// is about, and the tour dismisses or ignores them too.
const CHROME_SELECTORS = [
	'.cookie-banner',
	'#cookie-banner',
	'[data-cookie-consent]',
	'.pwa-install-prompt',
	'#pwa-install',
	'.nav-drawer.is-open',
	'.tws-toast',
	'[data-testid="cookie-consent"]',
];

function dismissChrome(selectors) {
	for (const sel of selectors) {
		for (const el of document.querySelectorAll(sel)) el.remove();
	}
}

// Resolve the stop's anchor byte-for-byte the way TourDirector._resolveTarget()
// does in src/feature-tour/director.js: walk the selector groups in order, take
// querySelector's FIRST match for each (not the first visible match across all
// of them), and accept it only if it is visible. Any divergence here would make
// the atlas a report about a tour that does not exist.
//
// `groups` arrives as [{ selector, source }] so the result can say whether the
// anchor came from the curriculum's hand-authored `targets` or from the
// director's generic fallback chain. That distinction is the difference between
// "the tour points at this feature" and "the tour points at the page's h1".
function resolveAnchor({ groups, contentRootSelector }) {
	const visible = (el) => {
		if (!el || !el.isConnected) return false;
		const r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4) return false;
		const cs = getComputedStyle(el);
		return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
	};
	const scopeOf = (el) => {
		if (el.closest('main, [role="main"], article')) return 'main';
		if (el.closest('header, nav, [role="navigation"], .site-nav, .nav')) return 'nav';
		if (el.closest('footer')) return 'footer';
		return 'other';
	};
	const main = document.querySelector(contentRootSelector);
	const roots = main ? [main, document] : [document];
	for (const root of roots) {
		for (const group of groups) {
			let el = null;
			try {
				el = root.querySelector(group.selector);
			} catch {
				continue; // an unparseable selector is rot too, and falls through as unmatched
			}
			if (!visible(el)) continue;
			el.setAttribute('data-tws-atlas-anchor', '1');
			return {
				matched: true,
				selector: group.selector,
				source: group.source,
				scope: scopeOf(el),
				tag: el.tagName.toLowerCase(),
			};
		}
	}
	return { matched: false, selector: null, source: null, scope: null, tag: null };
}

// Scroll the anchor into view, then paint the tour's own spotlight over it plus
// a caption chip. The ring geometry, colour and padding come straight from
// src/feature-tour/spotlight.js so an atlas shot reads as a frame of the real
// tour. The one deliberate difference is the scrim: the live tour dims the rest
// of the page to 62% because a visitor can still scroll and look around, while
// a still frame has to stay legible as a 520px thumbnail, so the atlas dims to
// 44% instead.
async function paintSpotlight(title) {
	const el = document.querySelector('[data-tws-atlas-anchor]');
	if (!el) return null;
	// Only scroll when the anchor is not already comfortably in view, which is
	// what src/feature-tour/spotlight.js does. Always centring would push the
	// site header out of frame on pages where the tour never scrolls at all.
	const first = el.getBoundingClientRect();
	if (!(first.top >= 64 && first.bottom <= window.innerHeight - 64)) {
		el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
	}
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const r = el.getBoundingClientRect();
	if (r.width < 4 || r.height < 4) return null;

	const pad = 8;
	const left = Math.max(0, r.left - pad);
	const top = Math.max(0, r.top - pad);
	const width = Math.min(window.innerWidth, r.right + pad) - left;
	const height = Math.min(window.innerHeight, r.bottom + pad) - top;

	const style = document.createElement('style');
	style.textContent = `
.tws-atlas-spot{position:fixed;z-index:2147483100;border-radius:12px;pointer-events:none;
	box-shadow:0 0 0 9999px rgba(8,10,16,.44),0 0 0 2px rgba(122,162,255,.95),0 0 28px 6px rgba(122,162,255,.5) inset}
.tws-atlas-spot::after{content:'';position:absolute;inset:-2px;border-radius:14px;border:2px solid rgba(122,162,255,.55)}
.tws-atlas-chip{position:fixed;z-index:2147483101;max-width:min(420px,72vw);padding:9px 14px;border-radius:999px;
	font:600 13px/1.35 Inter,system-ui,-apple-system,sans-serif;color:#eef1ff;background:rgba(12,14,22,.92);
	border:1px solid rgba(122,162,255,.42);box-shadow:0 12px 34px rgba(0,0,0,.45);
	white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}`;
	document.head.appendChild(style);

	const spot = document.createElement('div');
	spot.className = 'tws-atlas-spot';
	spot.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
	document.body.appendChild(spot);

	const chip = document.createElement('div');
	chip.className = 'tws-atlas-chip';
	chip.textContent = title;
	document.body.appendChild(chip);
	const ch = chip.getBoundingClientRect();
	// Prefer sitting under the ring; flip above when that would fall off-screen,
	// and clamp horizontally so a wide chip never bleeds past the viewport.
	const below = top + height + 14;
	const chipTop = below + ch.height < window.innerHeight - 12 ? below : Math.max(12, top - ch.height - 14);
	const chipLeft = Math.min(
		Math.max(12, left + width / 2 - ch.width / 2),
		window.innerWidth - ch.width - 12,
	);
	chip.style.left = chipLeft + 'px';
	chip.style.top = chipTop + 'px';

	return { left, top, width, height };
}

// Freeze motion right before the shutter so two runs of the same stop produce
// comparable frames. Applied last, after scrolling and painting, so nothing that
// depends on a transition to become visible is caught mid-flight.
function freezeMotion() {
	const style = document.createElement('style');
	style.textContent = `*,*::before,*::after{animation-play-state:paused !important;
		animation-duration:0s !important;transition:none !important;caret-color:transparent !important}
		html{scrollbar-width:none}::-webkit-scrollbar{display:none}`;
	document.head.appendChild(style);
}

// Lazy images below the fold never decode in a headless run, which leaves grey
// holes in the shot. Force every in-viewport lazy image to load eagerly and wait
// for the decode, so the atlas shows the page as a scrolling human sees it.
async function settleImages() {
	const imgs = Array.from(document.images).filter((img) => {
		const r = img.getBoundingClientRect();
		return r.bottom > -200 && r.top < window.innerHeight + 200;
	});
	for (const img of imgs) {
		if (img.loading === 'lazy') img.loading = 'eager';
		if (img.dataset.src && !img.src) img.src = img.dataset.src;
	}
	await Promise.all(
		imgs.map((img) =>
			img.complete
				? Promise.resolve()
				: new Promise((r) => {
						img.addEventListener('load', r, { once: true });
						img.addEventListener('error', r, { once: true });
						setTimeout(r, 4000);
					}),
		),
	);
	try {
		await document.fonts.ready;
	} catch {
		/* fonts API unavailable, the shot is still valid */
	}
}

// ── Navigation ───────────────────────────────────────────────────────────────
// Reaching a page and finishing its JavaScript are two different questions, and
// conflating them is how a healthy page gets reported dead. `waitUntil:
// 'domcontentloaded'` makes the navigation itself hostage to script execution:
// a heavy WebGL stop like /walk or /temporary parses its DOM in under two
// seconds but does not fire DOMContentLoaded for another ten-plus while its
// module graph boots, and on a loaded runner that pushes past the timeout. The
// navigation then throws, the status stays 0, and summarizeStops() counts a page
// that answered HTTP 200 in 200ms as unreachable, telling whoever reads the
// report to "fix the page or drop the stop" about a page with nothing wrong.
//
// `commit` resolves as soon as the server's response arrives, so the recorded
// status is the one the server actually sent. A 404 still reads 404, a refused
// connection or a bad host still throws, and slow scripts read as slow scripts
// further down. The page's own milestones are then awaited separately, where
// missing one is a note rather than a verdict about reachability.
export const NAV_ATTEMPTS = 2;

export async function navigate(page, url, notes, { timeout = NAV_TIMEOUT_MS, attempts = NAV_ATTEMPTS } = {}) {
	let lastError = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await page.goto(url, { waitUntil: 'commit', timeout });
			// A retry that worked is worth recording but must not displace the
			// anchor diagnostics that follow it, so it lands at the end of the run.
			if (attempt > 1) return { status: response?.status() ?? 0, attempts: attempt, recovered: lastError };
			return { status: response?.status() ?? 0, attempts: attempt, recovered: null };
		} catch (err) {
			lastError = String(err?.message || err).split('\n')[0].slice(0, 200);
		}
	}
	// Failing every attempt is the honest unreachable case: status 0, which the
	// summary counts and the gate fails on.
	notes.push(`navigation failed ${attempts} times, last error: ${lastError}`);
	return { status: 0, attempts, recovered: null };
}

// ── Capture ──────────────────────────────────────────────────────────────────
async function encode(buffer, { file, width, quality }) {
	const out = resolve(MEDIA_DIR, file);
	const info = await sharp(buffer)
		.resize({ width, withoutEnlargement: true })
		.webp({ quality, effort: 5 })
		.toFile(out);
	return { url: `${MEDIA_URL_BASE}/${file}`, width: info.width, height: info.height, bytes: info.size };
}

async function captureStop(context, stop) {
	const page = await context.newPage();
	const consoleErrors = [];
	const notes = [];

	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		const text = msg.text().slice(0, 300);
		if (consoleErrors.length < 8) consoleErrors.push(text);
	});
	page.on('pageerror', (err) => {
		if (consoleErrors.length < 8) consoleErrors.push(String(err?.message || err).slice(0, 300));
	});

	const record = {
		id: stop.id,
		index: stop.index,
		title: stop.title,
		path: stop.path,
		section: stop.section,
		tracks: stop.tracks,
		highlight: Boolean(stop.highlight),
		narration: stop.narration || '',
		status: 0,
		anchor: { state: 'unresolved', selector: null, source: null, scope: null, tag: null, rect: null },
		consoleErrors: 0,
		consoleSamples: [],
		notes,
		media: null,
		capturedAt: new Date().toISOString(),
	};

	let recoveredNav = null;
	try {
		const nav = await navigate(page, `${BASE}${stop.path}`, notes);
		record.status = nav.status;
		recoveredNav = nav.recovered;

		// A 4xx/5xx page has nothing worth photographing, and a shot of the error
		// page in the atlas would read as a real feature. A status of 0 means every
		// navigation attempt failed at the transport layer, so there is no page at
		// all. Record and stop.
		if (record.status >= 400) {
			notes.push(`page returned HTTP ${record.status}`);
			return record;
		}
		if (!record.status) return record;

		// The DOM has to exist before an anchor can be resolved against it, but a
		// stop whose scripts are still booting has a fully parsed DOM long before
		// DOMContentLoaded fires. Wait for the milestone, and when it does not
		// arrive say so rather than pretending the page was never served.
		await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {
			notes.push('DOMContentLoaded did not fire within the timeout, anchors resolved against a partial DOM');
		});
		await page.waitForLoadState('load', { timeout: NAV_TIMEOUT_MS }).catch(() => {
			notes.push('load event did not fire within the timeout, captured at domcontentloaded');
		});
		await page.waitForTimeout(SETTLE_MS);
		await page.evaluate(dismissChrome, CHROME_SELECTORS);

		const groups = anchorGroups(stop);
		const hit = await page.evaluate(resolveAnchor, {
			groups,
			contentRootSelector: TOUR_CONTENT_ROOT_SELECTOR,
		});
		record.anchor.state = hit.matched ? 'resolved' : 'missing';
		record.anchor.selector = hit.selector;
		record.anchor.source = hit.source;
		record.anchor.scope = hit.scope;
		record.anchor.tag = hit.tag;
		if (!hit.matched) {
			notes.push(`none of the ${groups.length} tour anchors matched a visible element`);
		} else if (hit.source === 'fallback') {
			notes.push("anchored by the director's generic fallback, not a curated selector for this page");
		} else if (hit.scope === 'nav') {
			notes.push('the anchor resolved inside the site nav rather than the page content');
		}

		await page.evaluate(settleImages);

		if (record.anchor.state === 'resolved') {
			const rect = await page.evaluate(paintSpotlight, stop.title);
			if (rect) record.anchor.rect = rect;
			else {
				// The anchor resolved but went zero-size or detached during the scroll.
				// That is the same failure the live Spotlight hits, so report it as rot.
				record.anchor.state = 'missing';
				notes.push('the tour anchor stopped being paintable after scrolling into view');
			}
		}

		if (!HEALTH_ONLY) {
			await page.evaluate(freezeMotion);
			const png = await page.screenshot({ type: 'png', animations: 'disabled' });
			const hero = await encode(png, {
				file: `${stop.id}.webp`,
				width: HERO_WIDTH,
				quality: HERO_QUALITY,
			});
			const thumb = await encode(png, {
				file: `${stop.id}.thumb.webp`,
				width: THUMB_WIDTH,
				quality: THUMB_QUALITY,
			});
			record.media = { hero, thumb };

			if (WITH_MOBILE) {
				await page.setViewportSize({ width: MOBILE.width, height: MOBILE.height });
				await page.waitForTimeout(600);
				await page.evaluate(dismissChrome, CHROME_SELECTORS);
				await page.evaluate(settleImages);
				const mobilePng = await page.screenshot({ type: 'png', animations: 'disabled' });
				record.media.mobile = await encode(mobilePng, {
					file: `${stop.id}.mobile.webp`,
					width: MOBILE_WIDTH,
					quality: HERO_QUALITY,
				});
			}
		}
	} catch (err) {
		notes.push(String(err?.message || err).slice(0, 300));
	} finally {
		if (recoveredNav) notes.push(`the first navigation attempt failed and was retried: ${recoveredNav}`);
		record.consoleErrors = consoleErrors.length;
		record.consoleSamples = consoleErrors.slice(0, 3);
		await page.close().catch(() => {});
	}

	return record;
}

// ── Manifest ─────────────────────────────────────────────────────────────────
function readExistingManifest() {
	if (!existsSync(MANIFEST_PATH)) return null;
	try {
		return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
	} catch {
		return null;
	}
}

function writeManifest(curriculum, fresh) {
	const previous = readExistingManifest();
	const merged = new Map();
	if (isPartialRun() && previous?.stops) {
		for (const stop of previous.stops) merged.set(stop.id, stop);
	}
	for (const stop of fresh) merged.set(stop.id, stop);

	// A stop that left the curriculum has to leave the atlas, or the guard would
	// keep checking media for a page nobody can reach any more.
	//
	// The curriculum's own order is the only truth about a stop's position, so
	// every merged stop is re-numbered from it rather than trusting the `index`
	// it carried in. A partial run (`--only`) keeps the previous manifest's
	// entries verbatim, and those were numbered against whatever curriculum
	// existed the day they were captured; sorting a mixed set by that stale
	// number produced duplicate and skipped stop numbers on /tour/atlas (58
	// duplicated badges by 2026-09-02) and shuffled the grid out of tour order.
	const order = new Map(curriculum.stops.map((s, i) => [s.id, i]));
	const stops = [...merged.values()]
		.filter((s) => order.has(s.id))
		.map((s) => ({ ...s, index: order.get(s.id) }))
		.sort((a, b) => a.index - b.index);

	const manifest = {
		version: 1,
		generatedBy: 'scripts/capture-tour-atlas.mjs',
		generatedAt: new Date().toISOString(),
		base: BASE,
		curriculumVersion: curriculum.version ?? null,
		curriculumGeneratedAt: curriculum.generatedAt ?? null,
		sections: (curriculum.sections || []).map((s) => ({ id: s.id, title: s.title })),
		tracks: (curriculum.tracks || []).map((t) => ({ id: t.id, title: t.title })),
		summary: summarizeStops(stops),
		stops,
	};
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, '\t')}\n`);
	return manifest;
}

// ── Run ──────────────────────────────────────────────────────────────────────
async function main() {
	const curriculum = loadCurriculum();
	const stops = selectStops(curriculum);
	if (!stops.length) {
		console.error('No stops matched the given filters.');
		process.exitCode = 1;
		return;
	}
	if (!HEALTH_ONLY) mkdirSync(MEDIA_DIR, { recursive: true });

	log(
		`Tour Atlas ${HEALTH_ONLY ? 'health sweep' : 'capture'}: ${stops.length} stop${stops.length === 1 ? '' : 's'} against ${BASE} (${CONCURRENCY} in parallel)`,
	);

	const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
	const results = [];
	let cursor = 0;
	let done = 0;

	const worker = async () => {
		const context = await browser.newContext({
			viewport: { width: DESKTOP.width, height: DESKTOP.height },
			deviceScaleFactor: DESKTOP.deviceScaleFactor,
			colorScheme: 'dark',
			reducedMotion: 'reduce',
			locale: 'en-US',
			// A tour visitor is a real browser, so the atlas must be one too:
			// spoofing a bot UA would change which experiences the site serves.
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 three-ws-tour-atlas',
		});
		try {
			for (;;) {
				const i = cursor++;
				if (i >= stops.length) break;
				const stop = stops[i];
				const record = await captureStop(context, stop);
				results.push(record);
				done++;
				const mark =
					record.status >= 400 || record.status === 0
						? 'DEAD'
						: record.anchor.state === 'missing'
							? 'ROT '
							: record.anchor.source === 'fallback'
								? 'GEN '
								: 'OK  ';
				log(
					`  [${String(done).padStart(3)}/${stops.length}] ${mark} ${record.path}  ${record.id}` +
						(record.notes.length ? `  (${record.notes[0]})` : ''),
				);
			}
		} finally {
			await context.close().catch(() => {});
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stops.length) }, worker));
	await browser.close();

	results.sort((a, b) => a.index - b.index);

	if (HEALTH_ONLY) {
		const s = summarizeStops(results);
		console.log(
			`\nAnchors: ${s.anchored} resolved (${s.curatedAnchor} curated, ${s.fallbackAnchor} fallback), ` +
				`${s.missingAnchor} missing. ${s.unreachable} unreachable page(s), ` +
				`${s.withConsoleErrors} with console errors.`,
		);
		for (const r of results.filter((r) => r.anchor.state === 'missing')) {
			console.log(`  rot: ${r.id} (${r.path}): ${r.notes[0] || 'anchor did not resolve'}`);
		}
		process.exitCode = s.missingAnchor > 0 || s.unreachable > 0 ? 1 : 0;
		return;
	}

	const manifest = writeManifest(curriculum, results);
	const s = manifest.summary;
	const bytes = manifest.stops.reduce(
		(n, stop) => n + (stop.media?.hero?.bytes || 0) + (stop.media?.thumb?.bytes || 0) + (stop.media?.mobile?.bytes || 0),
		0,
	);
	log(
		`\nWrote ${MANIFEST_PATH.replace(`${ROOT}/`, '')}: ${s.total} stops, ${s.captured} captured, ` +
			`${s.anchored} anchored, ${s.missingAnchor} rotted, ${(bytes / 1e6).toFixed(1)} MB of media.`,
	);
}

// Only run when invoked directly, so tests can import navigate() above and hold
// it to the contract the gate depends on, the way build-tour-atlas.mjs already
// exposes its pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
