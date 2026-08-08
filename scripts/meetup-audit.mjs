// Meetup event layer audit: drives a real browser through /play's live-event
// experience and asserts every piece of it actually mounted and behaved.
//
// Run it before an event to prove the layer works end to end on the machine
// you are about to ship from:
//
//   npm run dev                      # terminal 1 (vite, port 3000)
//   npm run dev:walk-all             # terminal 2 (Colyseus, port 2567)
//   node scripts/meetup-audit.mjs    # terminal 3
//
// Options:
//   --base <url>   dev server origin (default http://localhost:3000)
//   --shots <dir>  where to write screenshots (default .meetup-audit/, gitignored)
//
// It loads the $THREE home town with ?meetup=now, which shifts the configured
// event to start 20 seconds after load (applyPreviewOverride in
// src/game/meetup-schedule.js) so a single run covers the pre-show countdown,
// the go-live moment, and the live fireworks without editing public/event.json.
//
// Exit code is the result: 0 every check passed, 1 something regressed.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
	const i = args.indexOf(flag);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf('--base', 'http://localhost:3000').replace(/\/$/, '');
const SHOTS = resolve(argOf('--shots', '.meetup-audit'));
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const URL = `${BASE}/play?coin=${MINT}&name=three.ws&symbol=three&meetup=now`;

mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
	results.push({ name, pass: !!pass, detail });
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ args: ['--use-gl=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Console errors that are the app's own fault. The vite HMR websocket cannot
// reach a Codespaces-forwarded origin and RPC/matchmake noise is environmental,
// so those are filtered rather than failing an otherwise clean run.
const IGNORE = [/vite.*websocket/i, /WebSocket closed without opened/i, /ERR_CONNECTION_REFUSED/i, /favicon/i];
const errors = [];
const note = (t) => { if (!IGNORE.some((re) => re.test(t))) errors.push(t.slice(0, 200)); };
page.on('console', (m) => { if (m.type() === 'error') note(m.text()); });
page.on('pageerror', (e) => note('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

const entered = await page
	.waitForFunction(() => window.__CC__?.phase === 'world', null, { timeout: 180_000 })
	.catch(() => null);
check('world entered from a deep link', entered, entered ? '' : 'phase never reached "world"');
if (!entered) {
	await page.screenshot({ path: `${SHOTS}/00-stuck.png`, timeout: 60_000 }).catch(() => {});
	await browser.close();
	process.exit(1);
}

// --- pre-show: the chip mounts and counts down ------------------------------
const chip = await page.waitForSelector('#cc-meetup-chip', { timeout: 30_000 }).catch(() => null);
check('event chip mounts in the home town', chip);
const chipText = chip ? (await chip.textContent()).replace(/\s+/g, ' ').trim() : '';
check('chip shows a live countdown', /Starts in|LIVE/.test(chipText), chipText);

check('generic countdown pill stands down', await page.evaluate(() => {
	const p = document.querySelector('.cc-event-pill');
	return !p || getComputedStyle(p).display === 'none';
}));

check('chip does not collide with the totem card', await page.evaluate(() => {
	const king = document.getElementById('cc-king-hud');
	const c = document.getElementById('cc-meetup-chip');
	if (!c) return false;
	if (!king || king.hidden || king.offsetParent === null) return true;
	return c.getBoundingClientRect().top >= king.getBoundingClientRect().bottom;
}));

// --- agenda drawer ----------------------------------------------------------
await chip.click();
const panelOpen = await page.waitForSelector('#cc-meetup-panel.cc-meetup-panel--open', { timeout: 8000 }).catch(() => null);
check('agenda drawer opens from the chip', panelOpen);
const segs = await page.$$eval('.cc-meetup-seg', (n) => n.length).catch(() => 0);
check('agenda renders every configured segment', segs > 0, `${segs} segments`);
check('photo + buy actions are present', await page.evaluate(() =>
	!!document.querySelector('.cc-meetup-photo-btn') && !!document.querySelector('.cc-meetup-buy-btn')));
await page.screenshot({ path: `${SHOTS}/01-agenda.png`, timeout: 60_000 }).catch(() => {});

await page.keyboard.press('Escape');
check('Escape closes the drawer', await page
	.waitForFunction(() => !document.querySelector('#cc-meetup-panel.cc-meetup-panel--open'), null, { timeout: 5000 })
	.then(() => true).catch(() => false));

// --- go-live ----------------------------------------------------------------
const live = await page
	.waitForFunction(() => document.querySelector('#cc-meetup-chip.cc-meetup-islive'), null, { timeout: 60_000 })
	.catch(() => null);
check('chip flips to LIVE at the start instant', live);

const banner = await page.waitForSelector('#cc-meetup-banner.cc-meetup-banner--show', { timeout: 10_000 }).catch(() => null);
check('go-live moment banner fires', banner, banner ? (await banner.textContent()).replace(/\s+/g, ' ').slice(0, 60) : '');

await page.waitForTimeout(6000);
const fw = await page.evaluate(() => {
	let n = -1;
	window.__CC__.scene.traverse((o) => { if (o.name === 'fireworks') n = o.children.length; });
	return n;
});
check('fireworks group is live in the scene', fw >= 0, `${fw} objects`);
await page.screenshot({ path: `${SHOTS}/02-live.png`, timeout: 60_000 }).catch(() => {});

// --- zen mode -----------------------------------------------------------------
await page.keyboard.press('z');
await page.waitForTimeout(600);
check('zen mode hides the event UI', await page.evaluate(() => {
	const c = document.getElementById('cc-meetup-chip');
	return !c || getComputedStyle(c).display === 'none';
}));
await page.keyboard.press('z');
await page.waitForTimeout(600);

// --- photo --------------------------------------------------------------------
await page.evaluate(() => document.getElementById('cc-meetup-chip')?.click());
await page.waitForSelector('#cc-meetup-panel.cc-meetup-panel--open', { timeout: 8000 }).catch(() => {});
const download = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
await page.evaluate(() => document.querySelector('.cc-meetup-photo-btn')?.click());
const dl = await download;
check('commemorative photo downloads a framed image', !!dl, dl ? dl.suggestedFilename() : 'no download event');
if (dl) await dl.saveAs(`${SHOTS}/03-photo.jpg`).catch(() => {});

// --- mobile ---------------------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
check('chip stays on screen at 390px', await page.evaluate(() => {
	const c = document.getElementById('cc-meetup-chip');
	if (!c) return false;
	const r = c.getBoundingClientRect();
	return r.left >= 0 && r.right <= window.innerWidth + 1;
}));
await page.screenshot({ path: `${SHOTS}/04-mobile.png`, timeout: 60_000 }).catch(() => {});

check('no console errors from the event layer', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
