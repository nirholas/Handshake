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
 *   node scripts/capture-doc-media.mjs                  # every shot, against localhost:3000
 *   node scripts/capture-doc-media.mjs --only forge-prompt,walk-hero
 *   node scripts/capture-doc-media.mjs --base https://three.ws
 *   node scripts/capture-doc-media.mjs --list           # print the shot table, capture nothing
 *   node scripts/capture-doc-media.mjs --concurrency 2  # default 2; 3D routes are GPU-less and heavy
 *
 * Target defaults to http://localhost:3000 (`npm run dev`) so a capture reflects
 * the working tree rather than whatever is deployed. Pass --base to shoot prod.
 *
 * Headless Chromium renders WebGL through ANGLE/SwiftShader, which is slower
 * than a GPU but faithful; `settle` per shot is the knob when a 3D route needs
 * longer to finish loading its rig.
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

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_FILE = path.join(ROOT, 'data/doc-media.json');
const OUT_DIR = path.join(ROOT, 'public/docs/img');
const MANIFEST_FILE = path.join(ROOT, 'public/docs/media-manifest.json');

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = (opt('base', process.env.BASE_URL || 'http://localhost:3000')).replace(/\/$/, '');
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
	// Dismiss anything that would sit on top of the subject in a first visit.
	await page
		.evaluate(() => {
			for (const sel of ['#cookie-banner', '.cookie-banner', '[data-consent-banner]']) {
				document.querySelector(sel)?.remove();
			}
		})
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
			const buffer = await subject.screenshot({ type: 'png', animations: 'allow' });
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

async function captureShot(browser, shot, commit) {
	const viewport = VIEWPORTS[shot.viewport || 'desktop'];
	const context = await browser.newContext({
		viewport,
		deviceScaleFactor: SCALE,
		colorScheme: shot.theme === 'light' ? 'light' : 'dark',
		reducedMotion: shot.motion ? 'no-preference' : 'reduce',
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

	const page = await context.newPage();
	const ext = shot.motion ? 'webp' : 'webp';
	const outPath = path.join(OUT_DIR, `${shot.id}.${ext}`);
	try {
		await preparePage(page, shot);
		const subject = await subjectOf(page, shot);
		const written = shot.motion
			? await writeMotion(page, shot, subject, outPath)
			: await writeStill(
					await subject.screenshot({
						type: 'png',
						...(subject === page ? { fullPage: Boolean(shot.fullPage) } : {}),
					}),
					outPath,
				);
		const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');
		return {
			id: shot.id,
			src: `/docs/img/${shot.id}.${ext}`,
			alt: shot.alt,
			caption: shot.caption || null,
			route: shot.url,
			viewport: shot.viewport || 'desktop',
			animated: Boolean(shot.motion),
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
		)}\n`,
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
