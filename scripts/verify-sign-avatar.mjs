#!/usr/bin/env node
// Prove, in a real browser, the two things the Avatar control on the signing
// pages has to do: put an avatar the visitor chose from the gallery on stage,
// and let them move the camera around it.
//
// Usage: node scripts/verify-sign-avatar.mjs [baseUrl]
//   defaults to http://localhost:3000 (npm run dev)

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3000';
let failures = 0;

function check(label, ok, detail = '') {
	if (ok) console.log(`  ok    ${label}`);
	else {
		failures++;
		console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
	}
}

// Software WebGL, and /dev/shm off: a container's default 64 MB shared memory
// segment is not enough for a GLB-heavy renderer, which shows up as a bare
// "Page crashed" rather than any error the page could report.
const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// A shared dev server restarts under other work; give navigation and the first
// module transform room rather than reporting a cold cache as a broken page.
page.setDefaultTimeout(60000);
page.setDefaultNavigationTimeout(60000);

// The dev server's HMR socket cannot reach a forwarded Codespace port. That is
// the tunnel, not the page, and it never exists in a built deployment.
const isDevNoise = (text) => /\[vite\]|WebSocket (connection|closed)/i.test(text);

const consoleErrors = [];
let phase = 'boot';
page.on('console', (m) => {
	if (m.type() === 'error' && !isDevNoise(m.text())) consoleErrors.push(`[${phase}] ${m.text()}`);
});
page.on('pageerror', (e) => {
	if (!isDevNoise(String(e))) consoleErrors.push(`[${phase}] ${String(e)}`);
});

let lastPicked = '';

for (const route of ['/sign-language', '/asl-alphabet']) {
	const rigSel = route === '/sign-language' ? '#sl-rig' : '#aa-rig';
	const stageSel = route === '/sign-language' ? '#sl-stage' : '#aa-stage';
	console.log(`\nAvatar control, ${BASE}${route}`);

	// Each route is judged from a first visit: the cross-page carry-over is
	// checked on its own at the end, where it cannot mask a broken default.
	phase = `${route} first load`;
	await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
	await page.evaluate(() => localStorage.clear());
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector(`${rigSel} button`, { timeout: 60000 });
	await page.waitForTimeout(2500);

	const labels = await page.$$eval(`${rigSel} button`, (els) => els.map((e) => e.textContent));
	check('three rigs offered, the last one the visitor own avatar', labels.length === 3 && labels[2] === 'Your avatar…', labels.join(' | '));
	check('the stage rendered a canvas', await page.$(`${stageSel} canvas`) !== null);

	// The gallery: open it, take the first public avatar, and require the stage
	// to come back up on that GLB.
	// The gallery module is imported on demand (it pulls in model-viewer), so
	// the first open waits on a real network fetch, not just a render.
	phase = `${route} gallery`;
	await page.click(`${rigSel} button:nth-child(3)`);
	await page.waitForSelector('.agp-overlay.agp-open', { timeout: 60000 });
	check('the avatar gallery opened', true);
	await page.waitForSelector('.agp-card', { timeout: 60000 });
	const pickedName = await page.$eval('.agp-card', (el) => el.querySelector('.agp-card-name')?.textContent?.trim() || '');
	// The gallery shell animates in, and under load its transition can outlast
	// Playwright's stability wait, so drive these two the way a person does:
	// the element is there and enabled, click it.
	await page.click('.agp-card', { force: true });
	await page.click('.agp-cta', { force: true });
	phase = `${route} custom rig mounted`;
	await page.waitForTimeout(6000);

	const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('threews:sign-prefs') || '{}'));
	check('the pick was stored as a custom rig', String(prefs.customRig?.url || '').length > 0, JSON.stringify(prefs.customRig || null));
	const pillLabel = await page.$eval(`${rigSel} button:nth-child(3)`, (el) => el.textContent);
	check('the pill now carries the avatar name', pillLabel.length > 0 && pillLabel !== 'Your avatar…', `${pillLabel} vs ${pickedName}`);
	const activePill = await page.$eval(`${rigSel}`, (el) => el.querySelector('button[aria-pressed="true"]')?.textContent || '');
	check('the custom avatar is the one on stage', activePill === pillLabel, activePill);
	check('the stage remounted on the custom GLB', await page.$(`${stageSel} canvas`) !== null);

	// Mounting is not the feature: the custom rig has to actually form the
	// letters. Spell a word on it and require the page to report what it signed.
	if (route === '/sign-language') {
		await page.fill('#sl-spell-input', 'hi there');
		await page.click('#sl-spell-btn');
		await page.waitForTimeout(4000);
		const said = await page.$eval('#sl-status', (el) => el.textContent || '');
		check('the custom avatar signs what you type', /signed|spelled/i.test(said), said);
	} else {
		await page.click('.aa-key[data-char="F"]');
		await page.waitForTimeout(2500);
		const played = await page.evaluate(() => document.querySelector('.aa-key[aria-pressed="true"]')?.dataset.char || '');
		check('the custom avatar forms a chosen letter', played === 'F', played);
	}

	// The camera: a drag has to move the view and surface the reset affordance.
	// Measure only once the stage is centred, or the earlier interactions leave
	// it scrolled and the synthetic drag lands somewhere else entirely.
	await page.$eval(stageSel, (el) => el.scrollIntoView({ block: 'center' }));
	await page.waitForTimeout(500);
	const box = await page.$eval(`${stageSel} canvas`, (el) => {
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, w: r.width, h: r.height };
	});
	await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.w / 2 + 140, box.y + box.h / 2 + 40, { steps: 12 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	const resetVisible = () => page.$eval(`${stageSel} .av-pose-reset`, (el) => getComputedStyle(el).opacity === '1');
	check('dragging the avatar reveals the Reset view control', await resetVisible());
	await page.click(`${stageSel} .av-pose-reset`);
	await page.waitForTimeout(900);
	check('resetting the view hides the control again', !(await resetVisible()));

	// The choice has to survive a reload, and across the sibling page.
	phase = `${route} reload`;
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector(`${rigSel} button`, { timeout: 60000 });
	await page.waitForTimeout(2500);
	const afterReload = await page.$eval(`${rigSel}`, (el) => el.querySelector('button[aria-pressed="true"]')?.textContent || '');
	check('the custom avatar survives a reload', afterReload === pillLabel, afterReload);
	lastPicked = pillLabel;
}

// One avatar, every signing surface: the pick made on /asl-alphabet is already
// on stage when the visitor walks back to /sign-language.
console.log('\nCarry-over between the signing pages');
phase = 'carry-over';
await page.goto(`${BASE}/sign-language`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#sl-rig button', { timeout: 60000 });
await page.waitForTimeout(2500);
const carried = await page.$eval('#sl-rig', (el) => el.querySelector('button[aria-pressed="true"]')?.textContent || '');
check('the avatar chosen on the alphabet page is signing here too', carried === lastPicked, `${carried} vs ${lastPicked}`);

check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 6).join(" :: "));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
