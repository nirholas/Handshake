// Browser verification for the /forge "Split into parts" panel.
//
// Loads /forge with a real model already in the viewer, opens the panel, runs a
// REAL segmentation against the production /api/forge-segment worker, then
// isolates one of the returned parts. Asserts the part list rendered with real
// face counts and that the viewer swapped to each returned GLB. Also sweeps the
// three responsive breakpoints and reports console errors and failed requests.
//
// Run with: node scripts/verify-forge-segment.mjs
//   BASE_URL=http://localhost:3000 node scripts/verify-forge-segment.mjs
//
// The API calls are proxied to production by the dev server, so this exercises
// the same worker a user hits. Budget ~2 minutes for the two jobs.

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MODEL = process.env.SEGMENT_MODEL || 'https://three.ws/avatars/cesium-man.glb';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const failed = [];
// Vite's HMR socket cannot reach a Codespaces-forwarded port, so it always fails
// there. It is dev-server plumbing, not page code, and never ships to production.
const NOISE = /vite\]|WebSocket|app\.github\.dev/i;
page.on('pageerror', (e) => {
	if (!NOISE.test(e.message)) errors.push(`pageerror: ${e.message}`);
});
page.on('console', (msg) => {
	if (msg.type() === 'error' && !NOISE.test(msg.text())) errors.push(`console.error: ${msg.text()}`);
});
page.on('requestfailed', (req) => {
	failed.push(`${req.url()} (${req.failure()?.errorText})`);
});

function ok(label, pass, detail = '') {
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	return pass;
}

let allPass = true;
const check = (label, pass, detail) => {
	allPass = ok(label, pass, detail) && allPass;
};

await page.goto(`${BASE}/forge`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// The panel only reveals once a model is in the viewer. Drive that the same way
// forge.js does, so we exercise the real reveal path rather than forcing state.
await page.evaluate((src) => {
	const v = document.getElementById('viewer');
	v.setAttribute('src', src);
	document.dispatchEvent(
		new CustomEvent('forge:model-ready', { detail: { glbUrl: src, label: 'Cesium Man' } }),
	);
	document.getElementById('state-result')?.classList.remove('is-hidden');
}, MODEL);
await page.waitForTimeout(600);

const panel = page.locator('.segmentp');
check('panel reveals when a model is ready', await panel.count() === 1 && !(await panel.isHidden()));

// Collapsed by default, opens on click, and reports its state to assistive tech.
const toggle = page.locator('.segmentp-toggle');
check('panel starts collapsed', (await toggle.getAttribute('aria-expanded')) === 'false');
await toggle.click();
await page.waitForTimeout(250);
check('panel opens on click', (await toggle.getAttribute('aria-expanded')) === 'true');
check('body visible when open', await page.locator('.segmentp-body').isVisible());

// Method switching drives both the pressed state and the crease-angle field.
check('crease field hidden for auto', await page.locator('.seg-crease-field').isHidden());
await page.locator('button[data-method="crease"]').click();
await page.waitForTimeout(150);
check(
	'crease method presses and reveals its angle field',
	(await page.locator('button[data-method="crease"]').getAttribute('aria-pressed')) === 'true' &&
		(await page.locator('.seg-crease-field').isVisible()),
);
await page.locator('button[data-method="auto"]').click();
await page.waitForTimeout(150);
check('auto method re-presses', (await page.locator('button[data-method="auto"]').getAttribute('aria-pressed')) === 'true');
check('method hint is populated', ((await page.locator('.seg-hint').textContent()) || '').length > 20);

// Focus ring reachable by keyboard.
await page.locator('.seg-run').focus();
check('run button is keyboard focusable', await page.evaluate(() => document.activeElement?.classList.contains('seg-run')));

// ── The real run ───────────────────────────────────────────────────────────
await page.selectOption('.seg-max', '8');
await page.locator('.seg-run').click();

// Honest elapsed counter while the job runs.
await page.waitForTimeout(1500);
const busyText = (await page.locator('.seg-status').textContent()) || '';
check('shows a real elapsed counter while working', /\d+s/.test(busyText), `"${busyText.trim()}"`);

await page.waitForSelector('.seg-parts .seg-part', { timeout: 240000 });
await page.waitForTimeout(500);

const partCount = await page.locator('.seg-part').count();
check('part list rendered', partCount > 0, `${partCount} parts`);

const firstName = (await page.locator('.seg-part-name').first().textContent()) || '';
const firstFaces = (await page.locator('.seg-part-faces').first().textContent()) || '';
check('parts carry real names and face counts', firstName.length > 0 && /[\d,]+ faces/.test(firstFaces), `${firstName} / ${firstFaces}`);

const swatch = await page.locator('.seg-swatch').first().evaluate((el) => getComputedStyle(el).backgroundColor);
check('part swatch uses the returned colour', swatch !== 'rgba(0, 0, 0, 0)', swatch);

const segmentedSrc = await page.locator('#viewer').getAttribute('src');
check('viewer swapped to the segmented GLB', Boolean(segmentedSrc) && segmentedSrc !== MODEL, segmentedSrc?.slice(0, 80));

const dl = await page.locator('.seg-download').getAttribute('href');
check('download points at the real artifact', Boolean(dl) && dl.startsWith('http'));
check('manifest link resolves', Boolean(await page.locator('.seg-manifest').getAttribute('href')));
check('summary reports the split', ((await page.locator('.seg-summary').textContent()) || '').includes('parts'));

// ── Isolate a single part (a second real job) ──────────────────────────────
await page.locator('.seg-part').first().click();
await page.waitForTimeout(1200);
check('isolating marks the part active', (await page.locator('.seg-part').first().getAttribute('aria-pressed')) === 'true');

await page.waitForFunction(
	(prev) => {
		const t = document.querySelector('.seg-status')?.textContent || '';
		return t.includes('isolated') || document.querySelector('.seg-status')?.dataset.kind === 'error';
	},
	segmentedSrc,
	{ timeout: 240000 },
);
const isoKind = await page.locator('.seg-status').getAttribute('data-kind');
const isoSrc = await page.locator('#viewer').getAttribute('src');
check('part isolated into its own GLB', isoKind === 'done' && isoSrc !== segmentedSrc, isoSrc?.slice(0, 80));
const isoDl = await page.locator('.seg-download').getAttribute('download');
check('isolated part downloads under its own name', Boolean(isoDl) && isoDl !== '', isoDl);

// Toggling the same part off returns to the full split without a new job.
await page.locator('.seg-part').first().click();
await page.waitForTimeout(800);
check('toggling off returns to all parts', (await page.locator('#viewer').getAttribute('src')) === segmentedSrc);

// Revert restores the original mesh and clears the result affordances.
await page.locator('.seg-revert').click();
await page.waitForTimeout(400);
check('revert restores the original model', (await page.locator('#viewer').getAttribute('src')) === MODEL);
check('revert hides the part list', await page.locator('.seg-parts').isHidden());

// ── Responsive sweep ───────────────────────────────────────────────────────
for (const [w, h] of [[320, 720], [768, 1024], [1440, 900]]) {
	await page.setViewportSize({ width: w, height: h });
	await page.waitForTimeout(250);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
	check(`no horizontal overflow at ${w}px`, !overflow);
}

console.log('\n--- console errors ---');
console.log(errors.length ? errors.join('\n') : 'none');
console.log('--- failed requests ---');
console.log(failed.length ? failed.join('\n') : 'none');

await browser.close();

if (errors.length) allPass = false;
console.log(`\n${allPass ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}`);
process.exit(allPass ? 0 : 1);
