#!/usr/bin/env node
// capture-guide-shots.mjs — capture every tutorial screenshot from the real,
// running product.
//
// Tutorial media on three.ws is never hand-cropped and never mocked. Each
// picture in docs/tutorials/*.md is declared as a "shot" in data/guide-shots.json
// (which page, which element, which controls to point at) and produced by this
// script driving the live site in a real browser. Re-running it after a UI
// change regenerates every picture, so the guides cannot drift away from the
// product they document.
//
// Usage:
//   node scripts/capture-guide-shots.mjs                     # capture all, against production
//   node scripts/capture-guide-shots.mjs --base http://localhost:3000
//   node scripts/capture-guide-shots.mjs --only forge-compose,create-hub
//   node scripts/capture-guide-shots.mjs --list
//
// Writes PNGs to public/docs/img/guides/ and a per-shot result report to
// data/guide-shots.capture.json. Exits non-zero if any shot failed, so a
// selector that no longer exists is a loud failure rather than a stale picture.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'guide-shots.json');
const REPORT = join(ROOT, 'data', 'guide-shots.capture.json');
const OUT_DIR = join(ROOT, 'public', 'docs', 'img', 'guides');

// ── args ─────────────────────────────────────────────────────────────────────

function arg(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASE = (arg('base', 'https://three.ws')).replace(/\/+$/, '');
const ONLY = arg('only') ? new Set(arg('only').split(',').map(s => s.trim())) : null;
const LIST = process.argv.includes('--list');

// ── the frame: what a capture must never contain ─────────────────────────────
// Site chrome that follows the user around (the onboarding pill, the corner
// stack, discovery cards, an in-progress tour) is real product, but it is not
// what any given guide step is about, and it moves between runs. Suppressing it
// keeps a shot about its subject and keeps re-captures byte-stable.

const SUPPRESS_CSS = `
  #page-loading,
  #tws-corner-stack,
  .twg-root, .twg-modal-overlay,
  .tws-disc-card, .tws-disc-new,
  .tour-overlay, .tour-bubble, .tour-spotlight,
  [data-tws-capture-hide] { display: none !important; }
  *, *::before, *::after {
    transition: none !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

// ── annotation: numbered callouts drawn over the live page ───────────────────
// Rendered into the page itself (not composited afterwards) so the pins sit in
// the same pixel space as the UI they point at, at whatever the real layout is.

const ANNOTATE = (callouts) => {
  const ACCENT = '#7c5cff';
  document.querySelectorAll('[data-tws-callout]').forEach(n => n.remove());
  const missing = [];
  const layer = document.createElement('div');
  layer.setAttribute('data-tws-callout', 'layer');
  Object.assign(layer.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '2147483000',
  });
  document.body.appendChild(layer);

  callouts.forEach((c, i) => {
    const el = document.querySelector(c.selector);
    if (!el) { missing.push(c.selector); return; }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { missing.push(c.selector); return; }
    const top = r.top + window.scrollY;
    const left = r.left + window.scrollX;

    const ring = document.createElement('div');
    Object.assign(ring.style, {
      position: 'absolute',
      top: (top - 4) + 'px', left: (left - 4) + 'px',
      width: (r.width + 8) + 'px', height: (r.height + 8) + 'px',
      border: '2px solid ' + ACCENT,
      borderRadius: (parseFloat(getComputedStyle(el).borderRadius) || 8) + 6 + 'px',
      boxShadow: '0 0 0 4px rgba(124,92,255,0.22), 0 0 22px rgba(124,92,255,0.38)',
      pointerEvents: 'none',
    });
    layer.appendChild(ring);

    const pin = document.createElement('div');
    pin.textContent = String(c.n || i + 1);
    // Nudge the pin inside the viewport when the target hugs the left edge.
    const pinLeft = Math.max(4, left - 15);
    Object.assign(pin.style, {
      position: 'absolute',
      top: (top - 15) + 'px', left: pinLeft + 'px',
      width: '30px', height: '30px', borderRadius: '999px',
      background: ACCENT, color: '#fff',
      font: '700 15px/30px Inter, system-ui, sans-serif',
      textAlign: 'center',
      boxShadow: '0 2px 10px rgba(0,0,0,0.45), 0 0 0 3px rgba(10,10,14,0.85)',
      pointerEvents: 'none',
    });
    layer.appendChild(pin);
  });
  return missing;
};

// A transparent, absolutely-positioned rect used as the screenshot target. Using
// an element (rather than a raw clip box) keeps padding unambiguous: Playwright
// scrolls it into view and captures exactly its bounds.
const FRAME = ({ selector, pad }) => {
  document.getElementById('tws-capture-frame')?.remove();
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const x = Math.max(0, r.left + window.scrollX - pad);
  const y = Math.max(0, r.top + window.scrollY - pad);
  const w = Math.min(docW - x, r.width + pad * 2);
  const h = Math.min(docH - y, r.height + pad * 2);
  const frame = document.createElement('div');
  frame.id = 'tws-capture-frame';
  Object.assign(frame.style, {
    position: 'absolute', top: y + 'px', left: x + 'px',
    width: w + 'px', height: h + 'px',
    pointerEvents: 'none', background: 'transparent', zIndex: '0',
  });
  document.body.appendChild(frame);
  return { w: Math.round(w), h: Math.round(h) };
};

// ── prep steps: drive the UI into the state a guide step describes ────────────

async function runPrep(page, prep) {
	for (const step of prep) {
		if (step.click) {
			const loc = page.locator(step.click).first();
			await loc.waitFor({ state: 'visible', timeout: 15000 });
			await loc.click({ timeout: 15000 });
		}
		if (step.fill) {
			const loc = page.locator(step.fill.selector).first();
			await loc.waitFor({ state: 'visible', timeout: 15000 });
			await loc.fill(step.fill.value, { timeout: 15000 });
		}
		if (step.scrollTo) {
			await page.locator(step.scrollTo).first()
				.scrollIntoViewIfNeeded({ timeout: 15000 });
		}
		if (step.wait) await page.waitForTimeout(step.wait);
	}
}

// ── main ─────────────────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const defaults = manifest.defaults || {};
const shots = manifest.shots.filter(s => !ONLY || ONLY.has(s.id));

const tutorialsOf = s => (s.placements || []).map(p => p.tutorial);

if (LIST) {
	for (const s of manifest.shots) {
		console.log(`${s.id.padEnd(24)} ${s.url.padEnd(16)} -> ${tutorialsOf(s).join(', ')}`);
	}
	const covered = new Set(manifest.shots.flatMap(tutorialsOf));
	console.log(`\n${manifest.shots.length} shots, ${covered.size} tutorials covered`);
	process.exit(0);
}

if (!shots.length) {
	console.error('No shots matched. Use --list to see available ids.');
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log(`Capturing ${shots.length} shot(s) against ${BASE}\n`);

const browser = await chromium.launch({
	args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
		'--hide-scrollbars', '--force-color-profile=srgb'],
});

const results = [];

for (const shot of shots) {
	const started = Date.now();
	const viewport = shot.viewport || defaults.viewport || { width: 1440, height: 900 };
	const settle = shot.settle ?? defaults.settle ?? 3500;
	const outPath = join(OUT_DIR, `${shot.id}.png`);
	const rel = `/docs/img/guides/${shot.id}.png`;

	// A fresh context per shot: no cookie, storage, or tour state carries over,
	// so every capture is what a first-time visitor actually sees.
	const ctx = await browser.newContext({
		viewport,
		deviceScaleFactor: shot.scale ?? defaults.scale ?? 2,
		colorScheme: 'dark',
		reducedMotion: 'reduce',
		userAgent: defaults.userAgent,
	});
	const page = await ctx.newPage();
	const consoleErrors = [];
	page.on('pageerror', e => consoleErrors.push(String(e.message).slice(0, 200)));

	try {
		const res = await page.goto(BASE + shot.url, {
			waitUntil: 'domcontentloaded', timeout: 60000,
		});
		const status = res?.status() ?? 0;
		if (status >= 400) throw new Error(`HTTP ${status} for ${shot.url}`);

		await page.addStyleTag({ content: SUPPRESS_CSS });
		await page.waitForTimeout(settle);
		try { await page.evaluate(() => document.fonts?.ready); } catch {}

		if (shot.prep?.length) {
			await runPrep(page, shot.prep);
			await page.waitForTimeout(shot.prepSettle ?? 900);
		}

		// Re-apply after prep: a click can mount fresh chrome.
		await page.addStyleTag({ content: SUPPRESS_CSS });

		let missing = [];
		if (shot.callouts?.length) {
			missing = await page.evaluate(ANNOTATE, shot.callouts);
		}
		if (missing.length) {
			throw new Error(`callout target(s) not found: ${missing.join(', ')}`);
		}

		let dims = null;
		if (shot.clip) {
			dims = await page.evaluate(FRAME, { selector: shot.clip, pad: shot.pad ?? 20 });
			if (!dims) throw new Error(`clip target not found or zero-size: ${shot.clip}`);
			await page.locator('#tws-capture-frame').screenshot({
				path: outPath, timeout: 90000, animations: 'disabled',
			});
		} else {
			await page.screenshot({
				path: outPath, timeout: 90000, animations: 'disabled',
				fullPage: !!shot.fullPage,
			});
			dims = { w: viewport.width, h: viewport.height };
		}

		const bytes = statSync(outPath).size;
		if (bytes < 2048) throw new Error(`suspiciously small image (${bytes} bytes)`);

		results.push({
			id: shot.id, tutorials: tutorialsOf(shot), url: shot.url, path: rel,
			ok: true, bytes, width: dims.w, height: dims.h,
			ms: Date.now() - started, pageErrors: consoleErrors.slice(0, 3),
		});
		console.log(`  ok   ${shot.id.padEnd(30)} ${String(Math.round(bytes / 1024)).padStart(5)} KB  ${dims.w}x${dims.h}`);
	} catch (err) {
		results.push({
			id: shot.id, tutorials: tutorialsOf(shot), url: shot.url, path: rel,
			ok: false, error: String(err.message).slice(0, 300), ms: Date.now() - started,
		});
		console.log(`  FAIL ${shot.id.padEnd(30)} ${String(err.message).slice(0, 90)}`);
	} finally {
		await ctx.close();
	}
}

await browser.close();

const failed = results.filter(r => !r.ok);
writeFileSync(REPORT, JSON.stringify({
	base: BASE,
	shots: results.length,
	failed: failed.length,
	results,
}, null, '\t') + '\n');

console.log(`\n${results.length - failed.length}/${results.length} captured -> public/docs/img/guides/`);
console.log(`report: data/guide-shots.capture.json`);
if (failed.length) {
	console.error(`\n${failed.length} shot(s) failed:`);
	for (const f of failed) console.error(`  ${f.id}: ${f.error}`);
	process.exit(1);
}
