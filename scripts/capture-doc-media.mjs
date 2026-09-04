#!/usr/bin/env node
/**
 * capture-doc-media.mjs — the docs' media, captured from the real product.
 *
 * Tutorials used to be walls of text: 68 of them, 6 with any image. The reason
 * was never laziness about writing `![...]()`, it was that a screenshot is a
 * liability. Someone has to take it, nobody knows which build it came from, and
 * the day the UI moves it silently starts lying to readers.
 *
 * So the screenshots are not assets here, they are *output*. Every image under
 * public/docs/img/ that this script owns is declared in data/doc-media.json as a
 * recipe (a route, an optional interaction script, a crop) and produced by
 * driving the actual site in a real Chromium. Re-running the script re-derives
 * every image from the current code, so "is this screenshot still true?" is a
 * command, not an argument.
 *
 * Two kinds of capture:
 *   • still  — one frame, PNG out of Chromium, WebP through sharp.
 *   • motion — N frames at a fixed fps assembled by ffmpeg into an animated
 *              WebP. This platform's product is movement (an avatar walking,
 *              a viseme firing, a forge job filling in); a still undersells it.
 *
 * Provenance is written next to the pixels: public/docs/media-manifest.json
 * records, per shot, the route it came from, the commit that was checked out,
 * the capture time, byte size, intrinsic dimensions, and a sha256. The docs
 * renderer (public/doc-figures.js) reads that manifest to size the figure box
 * before the image loads (no layout shift) and to print a "captured from <route>"
 * line the reader can click.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/capture-doc-media.mjs                  # every shot, against https://three.ws
 *   node scripts/capture-doc-media.mjs --only forge-prompt,walk-hero
 *   node scripts/capture-doc-media.mjs --base http://localhost:3000
 *   node scripts/capture-doc-media.mjs --list           # print the shot table, capture nothing
 *   node scripts/capture-doc-media.mjs --concurrency 2  # default 2; 3D routes are GPU-less and heavy
 *
 * Target defaults to the live site, because that is the build a reader is
 * looking at when they compare a figure against the product. Pass
 * `--base http://localhost:3000` to shoot the working tree instead (worth doing
 * before shipping a UI change that a figure documents).
 *
 * Headless Chromium renders WebGL through ANGLE/SwiftShader, which is slower
 * than a GPU but faithful; `settle` per shot is the knob when a 3D route needs
 * longer to finish loading its rig. On those routes the compositor can also be
 * too busy to satisfy Playwright's screenshot within its timeout, so `shoot()`
 * falls back to a direct CDP capture that never waits for a stable frame.
 */
import { chromium } from 'playwright';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

/** Read AUDIT_EMAIL / AUDIT_PASSWORD out of .env the way the rest of scripts/ does. */
function loadDotEnv(file) {
	const full = path.join(ROOT_DIR, file);
	if (!existsSync(full)) return;
	for (const line of readFileSync(full, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
	}
}

const run = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = ROOT_DIR;
loadDotEnv('.env.local');
loadDotEnv('.env');

/** Read a --name value straight off argv. Needed above the CLI block below, which parses argv into the richer opt(). */
function optRaw(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
// Where a run reads its recipes and writes its pixels. The defaults are the
// docs' own figures; --spec/--out/--manifest point the same engine at another
// set. Announcement media (data/announce-media.json) uses that: it wants the
// identical guarantees (a real route in a real browser, a motion loop of the
// running product, provenance next to the bytes) and duplicating the engine to
// get them would mean two capture paths drifting apart.
const SPEC_FILE = path.join(ROOT, optRaw('spec', 'data/doc-media.json'));
const OUT_DIR = path.join(ROOT, optRaw('out', 'public/docs/img'));
const MANIFEST_FILE = path.join(ROOT, optRaw('manifest', 'public/docs/media-manifest.json'));
/** The web path the written files answer on, derived from OUT_DIR so a manifest never points at the wrong folder. */
const PUBLIC_SRC = `/${path.relative(path.join(ROOT, 'public'), OUT_DIR).split(path.sep).join('/')}`;

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = opt('base', process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');
const CONCURRENCY = Math.max(1, Number(opt('concurrency', 2)) || 2);
const ONLY = (opt('only', '') || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

// Logical viewports. Captures run at deviceScaleFactor 2 and are downscaled on
// the way out, so UI text stays crisp on retina without shipping 2x bytes.
const VIEWPORTS = {
	desktop: { width: 1280, height: 800 },
	wide: { width: 1600, height: 900 },
	mobile: { width: 390, height: 844 },
	square: { width: 900, height: 900 },
};

// Site chrome that follows the visitor across every route and parks itself over
// a corner of the viewport. Removing the nodes once after load is not enough:
// the feature-discovery card is injected on a timer and reappeared during the
// settle, so the first announcement captures shipped with a "have you tried
// Forge" promo over the subject. A stylesheet installed before any script runs
// holds regardless of when a node appears, and the removal below still handles
// anything that ignores CSS.
const SITE_CHROME = [
	'#tws-corner-stack',
	'.tws-disc-card',
	'.tws-atlas-hint',
	'.twx-i18n-fab',
	// The walk companion roams every route and parks itself over the lower
	// right. It is one of our own features, which is exactly why it cannot sit
	// in a frame announcing a different one.
	'.walk-companion',
	'.walk-trail-layer',
	'.walk-c2w-fx',
	'#cookie-banner',
	'.cookie-banner',
	'[data-consent-banner]',
];

const SCALE = 2;
/** Cap the emitted pixel width. Beyond this the extra bytes buy nothing in a doc column. */
const MAX_OUT_WIDTH = 1800;

function readSpec() {
	if (!existsSync(SPEC_FILE)) {
		fail(`missing ${path.relative(ROOT, SPEC_FILE)} — nothing to capture`);
	}
	const spec = JSON.parse(readFileSync(SPEC_FILE, 'utf8'));
	const defaults = spec.defaults || {};
	const shots = (spec.shots || []).map((shot) => ({ ...defaults, ...shot }));
	const seen = new Set();
	for (const shot of shots) {
		if (!shot.id) fail('every shot needs an id');
		if (seen.has(shot.id)) fail(`duplicate shot id: ${shot.id}`);
		seen.add(shot.id);
		if (!shot.url) fail(`shot ${shot.id} has no url`);
		if (!shot.alt) fail(`shot ${shot.id} has no alt text (a doc image without alt is a bug)`);
		if (!VIEWPORTS[shot.viewport || 'desktop']) {
			fail(`shot ${shot.id} has unknown viewport "${shot.viewport}"`);
		}
	}
	return shots;
}

function fail(message) {
	console.error(`capture-doc-media: ${message}`);
	process.exit(1);
}

function currentCommit() {
	try {
		return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
			.toString()
			.trim();
	} catch {
		return null;
	}
}

/**
 * Run a shot's interaction script. Each action is deliberately small and
 * declarative so a spec stays readable as documentation of the flow itself.
 */
async function applyActions(page, actions = []) {
	for (const action of actions) {
		switch (action.type) {
			case 'click':
				await page.click(action.selector, { timeout: action.timeout || 15000 });
				break;
			case 'fill':
				await page.fill(action.selector, action.value, { timeout: action.timeout || 15000 });
				break;
			case 'press':
				await page.press(action.selector || 'body', action.key, {
					timeout: action.timeout || 15000,
				});
				break;
			case 'hover':
				await page.hover(action.selector, { timeout: action.timeout || 15000 });
				break;
			case 'scroll':
				await page.evaluate(
					([sel, top]) => {
						if (sel) document.querySelector(sel)?.scrollIntoView({ block: 'center' });
						else window.scrollTo(0, top || 0);
					},
					[action.selector || null, action.top || 0],
				);
				break;
			case 'waitFor':
				await page.waitForSelector(action.selector, {
					state: action.state || 'visible',
					timeout: action.timeout || 20000,
				});
				break;
			case 'wait':
				await page.waitForTimeout(action.ms || 500);
				break;
			// Site chrome that legitimately belongs on a live page: the corner
			// companion, the onboarding checklist, a "have you tried" promo: sits
			// on top of whatever a doc figure is trying to show. Hiding it is not
			// staging the product; it is framing the subject, the same way a crop
			// is. Anything hidden here is named in the recipe, so a reader can see
			// exactly what was taken out of frame.
			case 'hide':
				await page.evaluate((selectors) => {
					for (const sel of selectors) {
						for (const node of document.querySelectorAll(sel)) node.style.display = 'none';
					}
				}, Array.isArray(action.selectors) ? action.selectors : [action.selector]);
				break;
			default:
				fail(`unknown action type "${action.type}"`);
		}
	}
}

/** Everything a page needs to look like a real, settled visit before we shoot. */
async function preparePage(page, shot) {
	const url = shot.url.startsWith('http') ? shot.url : BASE + shot.url;
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {
		/* long-poll and 3D routes may never idle; the settle below covers them */
	});
	await page.evaluate(() => document.fonts?.ready).catch(() => {});
	// Site chrome that follows the visitor across every route and parks itself
	// over the bottom-right of the viewport: the corner companion stack (the
	// "have you tried…" promo and the getting-started pill) and consent banners.
	// It is real UI, but it is never the subject of a doc figure, and leaving it
	// in means every screenshot on the site carries the same two floating cards
	// over whatever the reader was told to look at. Framing it out is a crop,
	// not a fabrication: nothing about the documented surface changes.
	await page
		.evaluate((chrome) => {
			for (const selector of chrome) {
				for (const node of document.querySelectorAll(selector)) node.remove();
			}
		}, [...SITE_CHROME, ...(shot.hide || [])])
		.catch(() => {});
	await applyActions(page, shot.actions);
	await page.waitForTimeout(shot.settle ?? 3500);
}

/** Resolve the element (or full viewport) a shot is framed on. */
async function subjectOf(page, shot) {
	if (!shot.clip) return page;
	const handle = await page.waitForSelector(shot.clip, { state: 'visible', timeout: 25000 });
	await handle.scrollIntoViewIfNeeded();
	await page.waitForTimeout(250);
	return handle;
}

/**
 * Take one PNG of `subject`.
 *
 * Playwright's screenshot waits for the compositor to produce a stable frame.
 * On a route running a continuous WebGL render loop through SwiftShader that
 * can never happen inside the timeout, and the capture dies on a page that is
 * in fact rendering perfectly. So: try the normal path (it produces the better
 * result, element-clipped and correctly scaled), and when it times out fall
 * back to a raw CDP capture, which grabs whatever is on screen right now. The
 * clip rectangle is recomputed from the element box so a cropped shot stays
 * cropped.
 */
async function shoot(page, subject, { fullPage = false, timeout = 20000 } = {}) {
	const isElement = subject !== page;
	try {
		return await subject.screenshot({
			type: 'png',
			timeout,
			...(isElement ? {} : { fullPage }),
		});
	} catch (err) {
		if (!/timeout/i.test(String(err?.message))) throw err;
		const session = await page.context().newCDPSession(page);
		try {
			const box = isElement ? await subject.boundingBox() : null;
			const scale = await page.evaluate(() => window.devicePixelRatio).catch(() => 1);
			const { data } = await session.send('Page.captureScreenshot', {
				format: 'png',
				captureBeyondViewport: false,
				...(box
					? { clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale } }
					: {}),
			});
			return Buffer.from(data, 'base64');
		} finally {
			await session.detach().catch(() => {});
		}
	}
}

/** PNG buffer from Chromium → optimised WebP on disk. Returns the written metadata. */
async function writeStill(buffer, outPath) {
	const image = sharp(buffer);
	const meta = await image.metadata();
	const targetWidth = Math.min(MAX_OUT_WIDTH, Math.round((meta.width || MAX_OUT_WIDTH) / SCALE) * 2);
	const out = await image
		.resize({ width: Math.min(meta.width || targetWidth, targetWidth), withoutEnlargement: true })
		.webp({ quality: 90, effort: 6 })
		.toBuffer();
	writeFileSync(outPath, out);
	const final = await sharp(out).metadata();
	return { bytes: out.length, width: final.width, height: final.height };
}

/**
 * Animated capture. Chromium has no video encoder we can trust for a short
 * looping clip, so we sample real frames on a fixed cadence and let ffmpeg
 * assemble them. The result is a genuine recording of the running product,
 * not a synthesised animation.
 */
async function writeMotion(page, shot, subject, outPath) {
	const fps = Math.min(24, Math.max(4, shot.motion.fps || 12));
	const seconds = Math.min(10, Math.max(1, shot.motion.seconds || 3));
	const frameCount = Math.round(fps * seconds);
	const frameDir = mkdtempSync(path.join(tmpdir(), 'docmedia-'));
	try {
		const interval = 1000 / fps;
		for (let i = 0; i < frameCount; i++) {
			const started = Date.now();
			// Short per-frame timeout on purpose: a frame that cannot be taken
			// promptly must fall through to the CDP grab, otherwise one slow
			// frame stalls the whole cadence and the loop plays back uneven.
			const buffer = await shoot(page, subject, { timeout: 8000 });
			writeFileSync(path.join(frameDir, `f${String(i).padStart(4, '0')}.png`), buffer);
			const elapsed = Date.now() - started;
			if (elapsed < interval) await page.waitForTimeout(interval - elapsed);
		}
		// Downscale on the way in so the encoder is not fed 2x frames it will
		// only shrink again, and keep width even (some encoders reject odd sizes).
		const first = await sharp(path.join(frameDir, 'f0000.png')).metadata();
		const width = Math.min(MAX_OUT_WIDTH, Math.round((first.width || MAX_OUT_WIDTH) / SCALE) * 2);
		await run('ffmpeg', [
			'-y',
			'-loglevel',
			'error',
			'-framerate',
			String(fps),
			'-i',
			path.join(frameDir, 'f%04d.png'),
			'-vf',
			`scale=${width - (width % 2)}:-2:flags=lanczos`,
			'-loop',
			'0',
			'-quality',
			'82',
			'-compression_level',
			'6',
			outPath,
		]);
		const out = readFileSync(outPath);
		const meta = await sharp(out, { animated: true }).metadata();
		return {
			bytes: out.length,
			width: meta.width,
			// sharp reports an animated WebP's height as pages*height; the frame
			// height is what a layout box needs.
			height: meta.pageHeight || meta.height,
			frames: frameCount,
			fps,
		};
	} finally {
		rmSync(frameDir, { recursive: true, force: true });
	}
}

/**
 * One signed-in session, reused by every `auth: true` shot.
 *
 * Signed out, an authenticated surface shows its gate, and a gate is the one
 * thing an announcement must not show: the first Genesis capture was a "Sign in
 * to claim your agent" banner over empty inputs, which is a true picture of the
 * page and a false picture of the product. The QA account in .env
 * (AUDIT_EMAIL / AUDIT_PASSWORD) is a real production account, so what these
 * shots show is the real signed-in product with that account's own data.
 *
 * Returns null when the credentials are absent, and the caller then skips those
 * shots loudly rather than shipping a gate.
 */
let authStatePromise = null;
function authState(browser) {
	if (authStatePromise) return authStatePromise;
	authStatePromise = (async () => {
		const email = process.env.AUDIT_EMAIL;
		const password = process.env.AUDIT_PASSWORD;
		if (!email || !password) return null;
		const context = await browser.newContext({ viewport: VIEWPORTS.wide, deviceScaleFactor: 1 });
		const page = await context.newPage();
		try {
			await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
			// By id, not by input type: /login also renders a passwordless widget
			// whose own input[type=email] comes first in the DOM.
			await page.waitForSelector('#email', { timeout: 30000 });
			await page.fill('#email', email);
			await page.fill('#password', password);
			await page.click('form button[type="submit"]');
			await page.waitForURL((url) => !/\/login/.test(url.pathname), { timeout: 45000 });
			return await context.storageState();
		} catch (err) {
			console.error(`capture-doc-media: sign-in failed (${String(err.message || err).split('\n')[0]})`);
			return null;
		} finally {
			await context.close();
		}
	})();
	return authStatePromise;
}

async function captureShot(browser, shot, commit) {
	const viewport = VIEWPORTS[shot.viewport || 'desktop'];
	const storageState = shot.auth ? await authState(browser) : null;
	if (shot.auth && !storageState) {
		throw new Error('shot needs a signed-in session; set AUDIT_EMAIL and AUDIT_PASSWORD in .env');
	}
	const context = await browser.newContext({
		viewport,
		deviceScaleFactor: SCALE,
		colorScheme: shot.theme === 'light' ? 'light' : 'dark',
		reducedMotion: shot.motion ? 'no-preference' : 'reduce',
		...(storageState ? { storageState } : {}),
	});
	// The site persists its own theme; set it before any script runs so the
	// first paint is already the theme the shot asked for.
	await context.addInitScript((theme) => {
		try {
			localStorage.setItem('twx_theme', theme);
		} catch {
			/* storage disabled: the colorScheme hint above still applies */
		}
	}, shot.theme === 'light' ? 'light' : 'dark');
	await context.addInitScript((selectors) => {
		const css = `${selectors.join(',')}{display:none !important}`;
		const install = () => {
			const style = document.createElement('style');
			style.textContent = css;
			document.head?.appendChild(style);
		};
		if (document.head) install();
		else document.addEventListener('DOMContentLoaded', install, { once: true });
	}, [...SITE_CHROME, ...(shot.hide || [])]);

	const page = await context.newPage();
	// Stills and loops both ship as WebP: a UI screenshot at quality 90 is
	// visually lossless at a fraction of PNG's bytes, and an animated WebP is
	// the only looping format that stays an ordinary <img> on every browser
	// the site supports.
	const outPath = path.join(OUT_DIR, `${shot.id}.webp`);
	try {
		await preparePage(page, shot);
		const subject = await subjectOf(page, shot);
		const written = shot.motion
			? await writeMotion(page, shot, subject, outPath)
			: await writeStill(
					await shoot(page, subject, { fullPage: Boolean(shot.fullPage), timeout: 25000 }),
					outPath,
				);
		const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');
		return {
			id: shot.id,
			src: `${PUBLIC_SRC}/${shot.id}.webp`,
			alt: shot.alt,
			caption: shot.caption || null,
			route: shot.url,
			viewport: shot.viewport || 'desktop',
			animated: Boolean(shot.motion),
			authenticated: Boolean(shot.auth),
			hidden: shot.hide && shot.hide.length ? shot.hide : undefined,
			capturedAt: new Date().toISOString(),
			capturedFrom: BASE,
			commit,
			sha256,
			...written,
		};
	} finally {
		await context.close();
	}
}

async function main() {
	let shots = readSpec();
	if (ONLY.length) {
		const known = new Set(shots.map((s) => s.id));
		for (const id of ONLY) if (!known.has(id)) fail(`--only names an unknown shot: ${id}`);
		shots = shots.filter((s) => ONLY.includes(s.id));
	}

	if (flag('list')) {
		for (const shot of shots) {
			console.log(
				`${shot.id.padEnd(30)} ${shot.motion ? 'motion' : 'still '} ${(shot.viewport || 'desktop').padEnd(8)} ${shot.url}`,
			);
		}
		console.log(`\n${shots.length} shot(s)`);
		return;
	}

	const reachable = await fetch(BASE + '/', { method: 'GET' })
		.then((r) => r.ok || r.status < 500)
		.catch(() => false);
	if (!reachable) {
		fail(`${BASE} is not answering. Start it with \`npm run dev\` or pass --base https://three.ws`);
	}

	mkdirSync(OUT_DIR, { recursive: true });
	const commit = currentCommit();
	const browser = await chromium.launch({
		args: [
			'--no-sandbox',
			'--disable-dev-shm-usage',
			// Give the WebGL routes the best software renderer available; without
			// these the 3D shots come back as empty black boxes.
			'--ignore-gpu-blocklist',
			'--enable-unsafe-swiftshader',
			'--use-gl=angle',
			'--use-angle=swiftshader',
		],
	});

	const results = [];
	const failures = [];
	const queue = [...shots];
	const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
		for (;;) {
			const shot = queue.shift();
			if (!shot) return;
			const started = Date.now();
			try {
				const entry = await captureShot(browser, shot, commit);
				results.push(entry);
				console.log(
					`  ok  ${shot.id.padEnd(30)} ${String(entry.width)}x${entry.height} ${(entry.bytes / 1024).toFixed(0)}kB ${((Date.now() - started) / 1000).toFixed(1)}s`,
				);
			} catch (err) {
				failures.push({ id: shot.id, message: String(err?.message || err).split('\n')[0] });
				console.error(`  FAIL ${shot.id.padEnd(30)} ${String(err?.message || err).split('\n')[0]}`);
			}
		}
	});
	await Promise.all(workers);
	await browser.close();

	// Merge into the existing manifest so a targeted --only run never drops the
	// provenance of the shots it did not take.
	const previous = existsSync(MANIFEST_FILE)
		? JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
		: { shots: {} };
	const merged = { ...(previous.shots || {}) };
	for (const entry of results) merged[entry.id] = entry;
	// Drop manifest entries whose spec was deleted: a stale entry would keep
	// promising a figure the docs can no longer render.
	const specIds = new Set(readSpec().map((s) => s.id));
	for (const id of Object.keys(merged)) if (!specIds.has(id)) delete merged[id];

	// Manifest alt text echoes doc copy, and the repo bans em/en dashes in
	// committed bytes, so scrub them at the boundary.
	writeFileSync(
		MANIFEST_FILE,
		`${JSON.stringify(
			{
				generatedBy: 'scripts/capture-doc-media.mjs',
				generatedAt: new Date().toISOString(),
				shots: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))),
			},
			null,
			'\t',
		).replace(/ [\u2013\u2014] /g, ': ').replace(/[\u2013\u2014]/g, '-')}\n`,
	);

	console.log(
		`\n${results.length} captured, ${failures.length} failed → ${path.relative(ROOT, MANIFEST_FILE)}`,
	);
	if (failures.length) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
