#!/usr/bin/env node
// capture-walkthroughs.mjs — build the media for the interactive walkthrough
// player at /walkthroughs by driving the real, running product.
//
// What this produces is deliberately NOT the same artifact as
// scripts/capture-guide-shots.mjs. That script bakes numbered callouts into
// cropped PNGs for the markdown tutorials. This one captures CLEAN, unmarked
// full-viewport frames plus the normalized rectangle of the element each step
// is about, because the player draws its spotlight, its zoom and its callouts
// live in the DOM on top of the frame. Burned-in annotations would fight it.
//
// Every step declares a real route and a real CSS selector. If a selector stops
// matching, the capture fails loudly instead of leaving a stale picture behind,
// which is what keeps the walkthroughs honest as the UI moves.
//
// Usage:
//   node scripts/capture-walkthroughs.mjs                          # capture all, against production
//   node scripts/capture-walkthroughs.mjs --base http://localhost:3000
//   node scripts/capture-walkthroughs.mjs --only forge-your-first-3d-model
//   node scripts/capture-walkthroughs.mjs --verify                 # drift check, writes nothing
//
// Writes JPEGs to public/walkthroughs/shots/ and the player manifest to
// public/walkthroughs/manifest.json.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data', 'walkthroughs.json');
const OUT_DIR = join(ROOT, 'public', 'walkthroughs');
const SHOT_DIR = join(OUT_DIR, 'shots');

function arg(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const BASE = arg('base', process.env.BASE_URL || 'https://three.ws').replace(/\/+$/, '');
const ONLY = arg('only');
const VERIFY = process.argv.includes('--verify');
const SETTLE = Number(arg('settle', '4000'));

// Transient page furniture that belongs to the site rather than to the step
// being explained. Left visible it drifts across frames and dates them.
const SUPPRESS = ['#tws-corner-stack', '.tws-corner-stack', '#cookie-banner', '.cookie-banner', '#nav-pop-build', '#nav-pop-discover', '#nav-pop-learn'];

const HIDE_CSS = `${SUPPRESS.join(',')} { display: none !important; }
* { scroll-behavior: auto !important; }
.h-footer-glow-line, .cursor { animation: none !important; }`;

function log(...a) {
	console.log(...a);
}

async function applyBefore(page, before) {
	for (const act of before || []) {
		if (act.click) {
			await page.locator(act.click).first().click({ timeout: 15000 });
		} else if (act.fill) {
			const [sel, value] = act.fill;
			await page.locator(sel).first().fill(value, { timeout: 15000 });
		} else if (typeof act.wait === 'number') {
			await page.waitForTimeout(act.wait);
		}
	}
}

/**
 * Measure the focused element against the viewport, after centring it.
 * Returns the hotspot in normalized [0,1] viewport coordinates, which is the
 * only form the player needs: it renders the frame at an arbitrary size.
 */
async function measureHotspot(page, selector, viewport) {
	const el = page.locator(selector).first();
	await el.waitFor({ state: 'visible', timeout: 25000 });
	await el.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
	await page.waitForTimeout(450);
	const box = await el.boundingBox();
	if (!box) throw new Error(`element ${selector} has no box`);
	const clamp = (n) => Math.max(0, Math.min(1, n));
	const x = clamp(box.x / viewport.width);
	const y = clamp(box.y / viewport.height);
	const w = clamp((box.x + box.width) / viewport.width) - x;
	const h = clamp((box.y + box.height) / viewport.height) - y;
	if (w <= 0 || h <= 0) throw new Error(`element ${selector} is outside the viewport after centring`);
	return { x: +x.toFixed(5), y: +y.toFixed(5), w: +w.toFixed(5), h: +h.toFixed(5) };
}

async function main() {
	const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
	const viewport = source.viewport;
	const list = source.walkthroughs.filter((w) => !ONLY || w.slug === ONLY);
	if (!list.length) {
		console.error(`No walkthrough matches --only ${ONLY}`);
		process.exit(2);
	}

	if (!VERIFY) {
		mkdirSync(SHOT_DIR, { recursive: true });
		if (!ONLY) {
			for (const f of existsSync(SHOT_DIR) ? readdirSync(SHOT_DIR) : []) {
				if (f.endsWith('.jpg')) rmSync(join(SHOT_DIR, f));
			}
		}
	}

	const browser = await chromium.launch();
	const ctx = await browser.newContext({
		viewport,
		deviceScaleFactor: 2,
		reducedMotion: 'reduce',
		colorScheme: 'dark',
	});
	await ctx.addInitScript(() => {
		try {
			// The player's own frames should show the platform as a first-time
			// visitor sees it, minus the one-off promo furniture.
			localStorage.setItem('tws:getting-started-dismissed', '1');
		} catch (_) {
			/* storage unavailable in this context; the CSS suppression still applies */
		}
	});
	const page = await ctx.newPage();

	const failures = [];
	const out = [];

	for (const w of list) {
		log(`\n▸ ${w.slug}`);
		const steps = [];
		for (let i = 0; i < w.steps.length; i++) {
			const step = w.steps[i];
			const n = String(i + 1).padStart(2, '0');
			const file = `${w.slug}-${n}.jpg`;
			const label = `${w.slug} step ${i + 1} (${step.path} ${step.focus})`;
			try {
				await page.goto(BASE + step.path, { waitUntil: 'domcontentloaded', timeout: 60000 });
				await page.addStyleTag({ content: HIDE_CSS });
				await page.waitForTimeout(SETTLE);
				await applyBefore(page, step.before);
				const hotspot = await measureHotspot(page, step.focus, viewport);
				const pageTitle = (await page.title()).replace(/[\u2014\u2013]/g, '-');
				if (!VERIFY) {
					await page.screenshot({ path: join(SHOT_DIR, file), type: 'jpeg', quality: 84 });
				}
				steps.push({
					...step,
					shot: `/walkthroughs/shots/${file}`,
					hotspot,
					pageTitle,
				});
				log(`  ✓ step ${i + 1} ${step.focus}`);
			} catch (err) {
				failures.push(`${label}: ${err.message.split('\n')[0]}`);
				log(`  ✗ step ${i + 1} ${step.focus} — ${err.message.split('\n')[0]}`);
			}
		}
		out.push({ ...w, cover: steps[0]?.shot || null, steps });
	}

	await browser.close();

	if (failures.length) {
		console.error(`\n${failures.length} step(s) failed:`);
		for (const f of failures) console.error(`  - ${f}`);
		console.error('\nA failure here means the page or the selector moved. Fix data/walkthroughs.json, do not ship a stale frame.');
		process.exit(1);
	}

	if (VERIFY) {
		log(`\nAll ${out.reduce((n, w) => n + w.steps.length, 0)} step(s) still resolve against ${BASE}.`);
		return;
	}

	const manifest = {
		generatedAt: new Date().toISOString(),
		baseUrl: BASE,
		viewport,
		version: source.version,
		walkthroughs: out,
	};
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	log(`\nWrote public/walkthroughs/manifest.json (${out.length} walkthrough(s), ${out.reduce((n, w) => n + w.steps.length, 0)} frame(s)).`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
