#!/usr/bin/env node
/**
 * Capture the documentation's own screenshots from the running product.
 *
 * Every tutorial image on this platform has to be a picture of the real thing,
 * which means the pictures have to be reproducible or they rot the moment the
 * UI moves. This script drives a real browser through /docs/world and writes
 * the images the docs embed, so refreshing them after a design change is one
 * command rather than a manual screenshot session.
 *
 *   npm run capture:docs-world                     # against the dev server
 *   npm run capture:docs-world -- --base https://three.ws
 *   npm run capture:docs-world -- --only search,reader
 *
 * Output: public/docs/img/docs-world-*.png, referenced from
 * docs/docs-world.md and docs/tutorials/explore-docs-world.md.
 *
 * The scene is WebGL, so a headless run needs a software rasteriser; the
 * swiftshader flags below are the same ones the repo's other browser checks
 * use. Frames are deterministic apart from the ambient shimmer, which is
 * stilled by forcing prefers-reduced-motion.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'docs', 'img');

const SLOW_MS = 120_000; // ceiling for every wait: see setDefaultTimeout below

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

function arg(name, fallback = null) {
	const i = process.argv.indexOf('--' + name);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = (arg('base', process.env.CAPTURE_BASE || 'http://localhost:3000')).replace(/\/$/, '');
const ONLY = arg('only') ? new Set(arg('only').split(',').map((s) => s.trim())) : null;

const want = (id) => !ONLY || ONLY.has(id);

/** Wait until the world has booted AND the avatar's real rig has loaded. */
async function waitForWorld(page) {
	await page.waitForFunction(() => !!window.__docsWorld, null, { timeout: SLOW_MS });
	// player.height only leaves its 1.7 default once a GLB has been measured, so
	// this is the honest "the avatar is really here" signal rather than a delay.
	await page.waitForFunction(
		() => window.__docsWorld.player.height > 1.5 && window.__docsWorld.player.root.children.length > 0,
		null,
		{ timeout: SLOW_MS },
	);
	// One more governed frame so the first render includes the loaded body.
	await page.waitForTimeout(600);
}

async function newWorldPage(browser, { viewport, skipTour = true, isMobile = false }) {
	const context = await browser.newContext({
		viewport,
		// 1.5x is the quality/cost knee for a software-rasterised WebGL page: sharp
		// on a retina display at the width docs render images, while a 2x buffer
		// (2880x1800) takes long enough per frame on a loaded machine that the
		// screenshot itself starts timing out.
		deviceScaleFactor: 1.5,
		isMobile,
		hasTouch: isMobile,
		// Stills the shimmer, the label bob and the chevron flow, so two runs of
		// this script produce the same picture instead of a random phase of it.
		reducedMotion: 'reduce',
	});
	// This repo's dev machine routinely runs several agents' build and browser
	// workloads at once, and every wait here is against a live render loop
	// competing for the same cores. Generous ceilings keep a slow machine from
	// being reported as a broken page.
	context.setDefaultTimeout(SLOW_MS);
	const page = await context.newPage();
	if (skipTour) {
		await page.addInitScript(() => {
			try {
				localStorage.setItem('tour:docs-world-welcome:done', '1');
			} catch {
				/* the tour simply shows; the shot is still valid */
			}
		});
	}
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await gotoWorld(page);
	await waitForWorld(page);
	return { context, page, errors };
}

/**
 * Navigate, retrying a refused connection.
 *
 * A capture run is minutes long and a Vite dev server restarts itself whenever
 * any config file is touched, so a single refused connection is far more often
 * "the server is two seconds into a restart" than "there is no server". Failing
 * the whole run on it would make the script unusable on a machine where anyone
 * else is working.
 */
async function gotoWorld(page, attempts = 6) {
	let lastErr;
	for (let i = 0; i < attempts; i++) {
		try {
			await page.goto(BASE + '/docs/world', { waitUntil: 'domcontentloaded', timeout: SLOW_MS });
			return;
		} catch (err) {
			lastErr = err;
			if (!/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|Timeout/.test(String(err))) throw err;
			const waitMs = 1500 * (i + 1);
			console.log('  server not answering yet, retrying in ' + waitMs + 'ms');
			await page.waitForTimeout(waitMs);
		}
	}
	throw lastErr;
}

/**
 * Open the search palette and type a query.
 *
 * Deliberately not a mouse click on the chip. The scene is a live WebGL render
 * loop, and under a software rasteriser at 2x device scale a frame can take
 * long enough that Playwright's actionability checks (hit-target, stability)
 * never see two quiet frames in a row and time out on a button that is, to a
 * real user on real hardware, perfectly clickable. Driving the palette through
 * the keyboard and its own API skips those checks entirely and exercises the
 * same code path the docs tell readers to use.
 */
async function openPalette(page, query) {
	await page.evaluate(() => window.__docsWorld.search.open());
	// open() focuses the input itself, so typing lands in the right place.
	await page.waitForFunction(() => document.activeElement?.id === 'dw-search-input', null, {
		timeout: SLOW_MS,
	});
	await page.keyboard.type(query, { delay: 12 });
	await page.waitForFunction(() => document.querySelectorAll('.dw-sr').length > 0, null, {
		timeout: SLOW_MS,
	});
	await page.waitForTimeout(250);
}

async function shoot(page, name) {
	const file = path.join(OUT_DIR, name + '.png');
	// animations:'disabled' freezes CSS transitions at their end state, so an
	// overlay caught mid-fade is captured fully opaque instead of ghosted.
	await page.screenshot({ path: file, timeout: SLOW_MS, animations: 'disabled' });
	console.log('  wrote public/docs/img/' + name + '.png');
	return file;
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const browser = await chromium.launch({
		args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
	});
	const written = [];
	const problems = [];

	try {
		// ── Desktop: plaza, search, wayfinder, reader, top down ────────────────
		const { context, page, errors } = await newWorldPage(browser, { viewport: DESKTOP });

		if (want('plaza')) {
			console.log('plaza: the spawn view');
			written.push(await shoot(page, 'docs-world-plaza'));
		}

		if (want('search')) {
			console.log('search: the palette over the scene');
			await openPalette(page, 'web component');
			written.push(await shoot(page, 'docs-world-search'));
			await page.keyboard.press('Escape');
			await page.waitForTimeout(200);
		}

		if (want('wayfinder')) {
			console.log('wayfinder: a live route across the plaza');
			await openPalette(page, 'web component');
			await page.keyboard.press('Shift+Enter'); // walk me there
			await page.waitForTimeout(600);
			// A raised, angled camera shows the trail bending around the ring, which
			// a shoulder-height follow cam cannot: the lane vanishes under the avatar.
			await page.evaluate(() => {
				const c = window.__docsWorld.controls;
				c.orbit.pitch = 0.78;
				c.orbit.dist = 15;
			});
			await page.waitForTimeout(700);
			const active = await page.evaluate(() => window.__docsWorld.wayfinder.active);
			if (!active) problems.push('wayfinder: no route was running at capture time');
			written.push(await shoot(page, 'docs-world-wayfinder'));
		}

		if (want('reader')) {
			console.log('reader: live markdown inside the scene');
			await page.evaluate(() => window.__docsWorld.overlays.openDoc('web-component'));
			await page.waitForFunction(
				() => document.getElementById('dw-reader-body').textContent.length > 1200,
				null,
				{ timeout: SLOW_MS },
			);
			await page.waitForTimeout(400);
			written.push(await shoot(page, 'docs-world-reader'));
			await page.keyboard.press('Escape');
			await page.waitForTimeout(250);
		}

		if (want('topdown')) {
			console.log('topdown: the whole ring at once');
			await page.evaluate(() => {
				const dw = window.__docsWorld;
				dw.player.root.position.set(0, 0, 8);
				// Cycle to the top-down mode by name rather than by counting presses,
				// so the shot survives a reordering of the camera modes.
				const btn = document.getElementById('dw-camera-btn');
				for (let i = 0; i < 6 && btn.textContent.trim() !== 'Top down'; i++) btn.click();
			});
			await page.waitForTimeout(1200);
			const mode = await page.locator('#dw-camera-btn').textContent();
			if (mode.trim() !== 'Top down') problems.push('topdown: camera stopped on "' + mode.trim() + '"');
			written.push(await shoot(page, 'docs-world-topdown'));
		}

		if (errors.length) problems.push('desktop page errors: ' + errors.join(' | '));
		await context.close();

		// ── Onboarding: the first-run coach mark, tour NOT suppressed ──────────
		if (want('tour')) {
			console.log('tour: the first-run welcome');
			const first = await newWorldPage(browser, { viewport: DESKTOP, skipTour: false });
			await first.page.waitForSelector('.tour-bubble', { timeout: SLOW_MS });
			await first.page.waitForTimeout(400);
			written.push(await shoot(first.page, 'docs-world-tour'));
			await first.context.close();
		}

		// ── Mobile: joystick, collapsed chips, full-width reader ───────────────
		if (want('mobile')) {
			console.log('mobile: the touch HUD at 390px');
			const m = await newWorldPage(browser, { viewport: MOBILE, isMobile: true });
			written.push(await shoot(m.page, 'docs-world-mobile'));
			await m.context.close();
		}
	} finally {
		await browser.close();
	}

	// A manifest so the docs and the tests can agree on what exists without
	// either of them hardcoding the list twice.
	const manifest = written.map((f) => '/docs/img/' + path.basename(f)).sort();
	await writeFile(
		path.join(OUT_DIR, 'docs-world-media.json'),
		JSON.stringify({ base: BASE, images: manifest }, null, '\t') + '\n',
	);

	console.log('\n' + written.length + ' image(s) captured from ' + BASE);
	if (problems.length) {
		console.error('\nProblems:');
		for (const p of problems) console.error('  - ' + p);
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
