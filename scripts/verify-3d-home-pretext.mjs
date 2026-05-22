// One-off verification for the pretext overlay on /demos/3d-home.
// Loads the page, watches for console errors and failed requests,
// confirms the overlay is mounted with content, and samples line count
// across a few frames to prove per-frame relayout is running.
//
// Usage: node scripts/verify-3d-home-pretext.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL  = BASE + '/demos/3d-home.html';

const browser = await chromium.launch();
const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page    = await ctx.newPage();

const errors = [];
const fails  = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console',  m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('requestfailed', r => fails.push(`${r.url()} (${r.failure()?.errorText})`));
page.on('response', r => { if (r.status() >= 400) fails.push(`${r.url()} → ${r.status()}`); });

console.log(`→ ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForFunction(
	() => document.fonts?.status === 'loaded' || document.fonts?.ready,
	{ timeout: 5000 },
).catch(() => {});

// Wait for the cycle to actually be running.
await page.waitForTimeout(2500);

const probe = await page.evaluate(() => {
	const ov = document.querySelector('.hero-sub-pretext');
	const sub = document.querySelector('.hero-sub');
	const active = document.body.classList.contains('pretext-active');
	const lines = ov?.querySelectorAll('.hero-sub-pretext-line') ?? [];
	const widths = [...lines].map(l => l.getBoundingClientRect().width);
	return {
		overlayMounted: !!ov,
		overlayHasLines: lines.length,
		bodyHasActiveClass: active,
		subVisibilityHidden: sub ? getComputedStyle(sub).visibility === 'hidden' : null,
		minLineWidth: widths.length ? Math.min(...widths) : 0,
		maxLineWidth: widths.length ? Math.max(...widths) : 0,
	};
});

// Sample across a full cycle (~10s) so we catch sit, standup, jump, land.
// During pure sit the layout is steady — distinctness only proves reflow if
// the window covers a transition. We also accept a varying line count as
// proof that the per-frame layout is responsive to the avatar's motion.
const samples = [];
const lineCounts = new Set();
for (let i = 0; i < 14; i++) {
	const sample = await page.evaluate(() => {
		const lines = [...document.querySelectorAll('.hero-sub-pretext-line')];
		return { text: lines.map(l => l.textContent).join('|'), count: lines.length };
	});
	samples.push(sample.text);
	lineCounts.add(sample.count);
	await page.waitForTimeout(800);
}
const distinct = new Set(samples).size;

console.log('  probe:', probe);
console.log(`  distinct frames over ${samples.length * 0.8}s window: ${distinct}/${samples.length}`);
console.log(`  distinct line counts: ${[...lineCounts].join(', ')}`);
if (errors.length) {
	console.log('  ✖ console errors:');
	errors.forEach(e => console.log(`    ${e}`));
}
if (fails.length) {
	console.log('  ✖ failed requests:');
	fails.forEach(r => console.log(`    ${r}`));
}

// Reflow proof: either the rendered text changes, or the line count varies
// — both confirm per-frame relayout is active. (A perfectly steady sit
// phase covering the full sample window can yield only one distinct text
// snapshot, so accept varying line counts as the alternative signal.)
const reflowResponsive = distinct >= 2 || lineCounts.size >= 2;

const ok =
	!errors.length &&
	!fails.length &&
	probe.overlayMounted &&
	probe.overlayHasLines > 0 &&
	probe.bodyHasActiveClass &&
	probe.subVisibilityHidden === true &&
	reflowResponsive;

console.log(ok ? '\n✓ pretext overlay verified' : '\n✖ verification failed');
await browser.close();
process.exit(ok ? 0 : 1);
