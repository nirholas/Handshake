#!/usr/bin/env node
// Drives a real Chromium through every state of the live-event countdown, on
// both surfaces that carry it: the /play lobby banner + in-world pill
// (src/game/event-countdown.js) and the home-page strip
// (src/home-event-banner.js). Run it before an event goes live; it is the
// go/no-go evidence that the countdown a holder sees is the countdown that
// actually ticks.
//
//   npm run verify:event                       # against a local `npm run dev`
//   BASE=https://three.ws npm run verify:event # against production
//
// The three states (upcoming, live, over) are exercised by serving a different
// /event.json body per case, which is the same thing as editing the file except
// it cannot leave the repo in a wrong state halfway through. Nothing else is
// stubbed: the modules, the DOM, the clock, and the styling are the real ones,
// and the assertions read computed style, not source.
//
// Exits 0 when every check passes, 1 otherwise, so it works as a gate.

import { chromium } from 'playwright';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const COIN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVENT_LINK = `/play?coin=${COIN}&name=three.ws&symbol=three`;
const NAME = '$THREE First Holders Meetup';
const TAGLINE = 'The first live gathering in the three.ws world.';

// /play boots a full Three.js world; give it room on a cold dev server.
const WORLD_TIMEOUT = 120000;
const PAGE_TIMEOUT = 45000;

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
	checks++;
	if (!ok) failures++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

function cfg({ startsIn, endsIn }) {
	const now = Date.now();
	return JSON.stringify({
		id: 'three-first-meetup',
		name: NAME,
		tagline: `${TAGLINE} Drop in, hang out, win prizes.`,
		startsAt: new Date(now + startsIn).toISOString(),
		endsAt: new Date(now + endsIn).toISOString(),
		link: EVENT_LINK,
		linkLabel: 'Join the $THREE world',
		// meetup-event.js reads the same file; keep its agenda present so the
		// in-world experience layer behaves exactly as it does in production.
		agenda: [
			{ atMin: 0, title: 'Doors open in the plaza', detail: 'Say hi in chat', icon: '\u{1F44B}' },
			{ atMin: 20, title: 'King of the Totem showdown', detail: 'Hold the gold ring', icon: '\u{1F451}' },
		],
	});
}

// Console noise that predates the countdown and is unrelated to it: the sandbox
// has no outbound network and swiftshader narrates its own stalls.
const IGNORE = [/favicon/i, /Failed to load resource/i, /net::ERR_/i, /WebGL/i, /THREE\./i, /\[vite\]/i, /websocket/i];
const ownErrors = (errs) => errs.filter((e) => !IGNORE.some((re) => re.test(e)));

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

async function newPage({ body, viewport, reducedMotion, storage }) {
	const ctx = await browser.newContext({
		viewport: viewport || { width: 1440, height: 900 },
		reducedMotion: reducedMotion || 'no-preference',
		storageState: storage,
	});
	const page = await ctx.newPage();
	const errors = [];
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
	page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
	// Third-party beacons (analytics, fonts, CDNs) hang for their full timeout
	// where there is no outbound network, stalling load events that have nothing
	// to do with this feature. The event surfaces are entirely first-party.
	await page.route('**/*', (r) => {
		const u = r.request().url();
		if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
		return r.abort();
	});
	if (body) {
		await page.route('**/event.json*', (r) =>
			r.fulfill({ status: 200, contentType: 'application/json', body }));
	}
	return { ctx, page, errors };
}

// A dev server shared with other work restarts under you; a single navigation is
// not a reliable signal of whether the site is reachable.
async function go(page, path) {
	let last;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await page.goto(BASE + path, { waitUntil: 'commit', timeout: PAGE_TIMEOUT });
			return;
		} catch (err) {
			last = err;
			await page.waitForTimeout(3000);
		}
	}
	throw last;
}

// The pill only shows itself once the player is in-world (the lobby is hidden).
const waitForPill = (page) => page.waitForFunction(() => {
	const p = document.querySelector('.cc-event-pill');
	return !!p && !p.hidden;
}, null, { timeout: WORLD_TIMEOUT });

const cssAnim = (loc) => loc.evaluate((n) => getComputedStyle(n).animationName);

// ── /play lobby banner: upcoming ───────────────────────────────────────────
console.log('\n/play lobby banner, upcoming');
{
	const { ctx, page, errors } = await newPage({ body: cfg({ startsIn: 3 * 86400e3, endsIn: 4 * 86400e3 }) });
	await go(page, '/play');
	await page.waitForSelector('.cc-event-banner', { timeout: WORLD_TIMEOUT });
	const b = page.locator('.cc-event-banner');
	check('state is upcoming', (await b.getAttribute('data-state')) === 'upcoming');
	check('event name rendered', (await b.locator('.cc-event-name').textContent()) === NAME);
	check('tagline rendered', (await b.locator('.cc-event-tagline').textContent()).includes('live gathering'));
	const when = await b.locator('.cc-event-when').textContent();
	check('start time in the visitor timezone', /^Starts .+\d{1,2}:\d\d/.test(when), JSON.stringify(when));
	const labels = await b.locator('.cc-event-seg span').allTextContents();
	check('D/H/M/S segments', JSON.stringify(labels) === '["days","hrs","min","sec"]', JSON.stringify(labels));

	const s1 = await b.locator('.cc-event-seg b').last().textContent();
	await page.waitForTimeout(2100);
	const s2 = await b.locator('.cc-event-seg b').last().textContent();
	check('clock ticks', s1 !== s2, `${s1} -> ${s2}`);

	const cta = b.locator('.cc-event-cta');
	check('CTA points into the $THREE world', (await cta.getAttribute('href')).includes(COIN));
	const rest = await cta.evaluate((n) => getComputedStyle(n).boxShadow);
	await cta.hover();
	await page.waitForTimeout(250);
	check('CTA hover state', (await cta.evaluate((n) => getComputedStyle(n).boxShadow)) !== rest);
	check('CTA focus-visible ring',
		(await cta.evaluate((n) => { n.focus(); return getComputedStyle(n).outlineWidth; })) !== '0px');
	check('pill stays hidden in the lobby', await page.locator('.cc-event-pill').isHidden());
	check('no console errors', ownErrors(errors).length === 0, ownErrors(errors).join(' | '));
	await ctx.close();
}

// ── /play: upcoming flips to live with no reload ───────────────────────────
console.log('\n/play, upcoming flips to live with no reload');
{
	const { ctx, page, errors } = await newPage({ body: cfg({ startsIn: 10000, endsIn: 3600e3 }) });
	await go(page, '/play');
	await page.waitForSelector('.cc-event-banner[data-state="upcoming"]', { timeout: WORLD_TIMEOUT });
	check('mounts as upcoming', true);
	await page.waitForSelector('.cc-event-banner[data-state="live"]', { timeout: 30000 });
	check('flips to live in place', true);
	check('kicker reads live', (await page.locator('.cc-event-banner .cc-event-kicker').textContent()).trim() === 'Live now');
	check('clock reads LIVE', (await page.locator('.cc-event-clock b').textContent()) === 'LIVE');
	check('live dot pulses', (await cssAnim(page.locator('.cc-event-banner .cc-event-dot'))) === 'cc-event-pulse');
	check('no console errors', ownErrors(errors).length === 0, ownErrors(errors).join(' | '));
	await ctx.close();
}

// ── /play: reduced motion ──────────────────────────────────────────────────
console.log('\n/play, prefers-reduced-motion');
{
	const { ctx, page } = await newPage({ body: cfg({ startsIn: -60e3, endsIn: 3600e3 }), reducedMotion: 'reduce' });
	await go(page, '/play');
	await page.waitForSelector('.cc-event-banner[data-state="live"]', { timeout: WORLD_TIMEOUT });
	check('no pulse animation', (await cssAnim(page.locator('.cc-event-banner .cc-event-dot'))) === 'none');
	await ctx.close();
}

// ── /play: the event ends while the page is open ───────────────────────────
console.log('\n/play, the event ends while the page is open');
{
	const { ctx, page, errors } = await newPage({ body: cfg({ startsIn: -3600e3, endsIn: 12000 }) });
	await go(page, '/play');
	await page.waitForSelector('.cc-event-banner', { timeout: WORLD_TIMEOUT });
	check('mounted while live', true);
	await page.waitForSelector('.cc-event-banner', { state: 'detached', timeout: 30000 });
	check('banner unmounts at endsAt', true);
	check('pill unmounts at endsAt', (await page.locator('.cc-event-pill').count()) === 0);
	check('no console errors', ownErrors(errors).length === 0, ownErrors(errors).join(' | '));
	await ctx.close();
}

// ── /play: an already-ended event owes the player zero pixels ──────────────
console.log('\n/play, an already-ended event mounts nothing');
{
	const { ctx, page } = await newPage({ body: cfg({ startsIn: -7200e3, endsIn: -3600e3 }) });
	await go(page, '/play');
	await page.waitForSelector('#cc-lobby .cc-lobby-inner', { timeout: WORLD_TIMEOUT });
	await page.waitForTimeout(5000);
	check('nothing mounted', (await page.locator('.cc-event-banner, .cc-event-pill').count()) === 0);
	await ctx.close();
}

// ── /play in-world pill ────────────────────────────────────────────────────
console.log('\n/play in-world pill');
{
	const body = cfg({ startsIn: 3 * 86400e3, endsIn: 4 * 86400e3 });
	const { ctx, page, errors } = await newPage({ body });
	await go(page, EVENT_LINK);
	await waitForPill(page);
	check('pill visible in-world', true);
	const t1 = await page.locator('.cc-event-pill [role="timer"]').textContent();
	await page.waitForTimeout(2100);
	const t2 = await page.locator('.cc-event-pill [role="timer"]').textContent();
	check('pill clock ticks', t1 !== t2, `${t1} -> ${t2}`);
	check('CTA absent while standing in the event world',
		(await page.locator('.cc-event-pill a').count()) === 0);

	const x = page.locator('.cc-event-pill-x');
	const xRest = await x.evaluate((n) => getComputedStyle(n).backgroundColor);
	await x.hover();
	await page.waitForTimeout(250);
	check('dismiss hover state', (await x.evaluate((n) => getComputedStyle(n).backgroundColor)) !== xRest);
	check('dismiss focus ring',
		(await x.evaluate((n) => { n.focus(); return getComputedStyle(n).outlineWidth; })) !== '0px');
	await x.click();
	await page.waitForTimeout(300);
	check('dismiss removes the pill', (await page.locator('.cc-event-pill').count()) === 0);
	const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cc-event-dismissed:')));
	check('dismissal persisted to localStorage', keys.length === 1, JSON.stringify(keys));
	check('no console errors', ownErrors(errors).length === 0, ownErrors(errors).join(' | '));

	const storage = await ctx.storageState();
	await ctx.close();

	const again = await newPage({ body, storage });
	await go(again.page, EVENT_LINK);
	await again.page.waitForSelector('.cc-event-banner', { timeout: WORLD_TIMEOUT });
	await again.page.waitForTimeout(4000);
	check('dismissal survives a reload', (await again.page.locator('.cc-event-pill').count()) === 0);
	check('lobby banner still shown after dismissal', (await again.page.locator('.cc-event-banner').count()) === 1);
	await again.ctx.close();
}

// ── /play at 375px ─────────────────────────────────────────────────────────
console.log('\n/play at 375px');
{
	const { ctx, page } = await newPage({
		body: cfg({ startsIn: 3 * 86400e3, endsIn: 4 * 86400e3 }),
		viewport: { width: 375, height: 812 },
	});
	await go(page, EVENT_LINK);
	await page.waitForSelector('.cc-event-banner', { timeout: WORLD_TIMEOUT });
	const doc = await page.evaluate(() => ({
		scrollW: document.documentElement.scrollWidth,
		clientW: document.documentElement.clientWidth,
	}));
	check('page does not scroll sideways', doc.scrollW <= doc.clientW + 1, JSON.stringify(doc));
	const bb = await page.locator('.cc-event-banner').boundingBox();
	check('banner fits the viewport', bb.x >= -1 && bb.x + bb.width <= 376, JSON.stringify(bb));

	await waitForPill(page);
	const overlap = await page.evaluate(() => {
		const p = document.querySelector('.cc-event-pill').getBoundingClientRect();
		const hits = [];
		const sels = ['#cc-joystick', '.cc-joystick', '#cc-chat', '.cc-chat', '.cc-chat-log', '.cc-chat-input',
			'.cc-touch', '#cc-touch-controls', '.cc-touch-controls', '.cc-action-btn'];
		for (const sel of sels) {
			for (const n of document.querySelectorAll(sel)) {
				if (n.offsetParent === null && getComputedStyle(n).position !== 'fixed') continue;
				const r = n.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				if (!(r.right < p.left || r.left > p.right || r.bottom < p.top || r.top > p.bottom)) hits.push(sel);
			}
		}
		return { pill: p.toJSON(), hits, viewportH: innerHeight };
	});
	check('pill fits the viewport',
		overlap.pill.x >= -1 && overlap.pill.x + overlap.pill.width <= 376
		&& overlap.pill.top >= 0 && overlap.pill.bottom <= overlap.viewportH + 1, JSON.stringify(overlap.pill));
	check('pill clears chat and the touch controls', overlap.hits.length === 0, JSON.stringify(overlap.hits));
	await ctx.close();
}

// ── home page strip: upcoming ──────────────────────────────────────────────
console.log('\nhome page strip, upcoming');
{
	const { ctx, page, errors } = await newPage({ body: cfg({ startsIn: 3 * 86400e3, endsIn: 4 * 86400e3 }) });
	await go(page, '/');
	await page.waitForSelector('.tws-eventbar', { timeout: PAGE_TIMEOUT });
	const bar = page.locator('.tws-eventbar');
	check('state is upcoming', (await bar.getAttribute('data-state')) === 'upcoming');
	check('event name rendered', (await bar.locator('.tws-eventbar-name').textContent()) === NAME);
	const place = await page.evaluate(() => {
		const b = document.querySelector('.tws-eventbar').getBoundingClientRect();
		const hero = document.querySelector('.hero').getBoundingClientRect();
		const nav = document.querySelector('#nav-container').getBoundingClientRect();
		return { aboveHero: b.bottom <= hero.top + 1, belowNav: b.top >= nav.bottom - 1 };
	});
	check('sits between the nav and the hero', place.aboveHero && place.belowNav, JSON.stringify(place));
	const c1 = await bar.locator('.tws-eventbar-clock').textContent();
	await page.waitForTimeout(2100);
	const c2 = await bar.locator('.tws-eventbar-clock').textContent();
	check('clock ticks', c1 !== c2, `${c1} -> ${c2}`);

	const cta = bar.locator('.tws-eventbar-cta');
	check('CTA points into the $THREE world', (await cta.getAttribute('href')).includes(COIN));
	const rest = await cta.evaluate((n) => getComputedStyle(n).backgroundColor);
	await cta.hover();
	await page.waitForTimeout(250);
	check('CTA hover state', (await cta.evaluate((n) => getComputedStyle(n).backgroundColor)) !== rest);
	check('CTA focus-visible ring',
		(await cta.evaluate((n) => { n.focus(); return getComputedStyle(n).outlineWidth; })) !== '0px');
	check('no console errors', ownErrors(errors).length === 0, ownErrors(errors).join(' | '));
	await ctx.close();
}

// ── home page strip: live, then over ───────────────────────────────────────
console.log('\nhome page strip, upcoming to live to over');
{
	const { ctx, page, errors } = await newPage({ body: cfg({ startsIn: 8000, endsIn: 20000 }) });
	await go(page, '/');
	await page.waitForSelector('.tws-eventbar[data-state="upcoming"]', { timeout: PAGE_TIMEOUT });
	check('mounts as upcoming', true);
	await page.waitForSelector('.tws-eventbar[data-state="live"]', { timeout: 30000 });
	check('flips to live with no reload', true);
	check('kicker reads live', (await page.locator('.tws-eventbar-kicker').textContent()).trim() === 'Live now');
	check('clock reads LIVE', (await page.locator('.tws-eventbar-clock').textContent()) === 'LIVE');
	check('live dot pulses', (await cssAnim(page.locator('.tws-eventbar-dot'))) === 'tws-eventbar-pulse');
	await page.waitForSelector('.tws-eventbar', { state: 'detached', timeout: 30000 });
	check('unmounts at endsAt', true);
	check('no console errors', ownErrors(errors).length === 0, ownErrors(errors).join(' | '));
	await ctx.close();
}

// ── home page strip: reduced motion, already over, dismissal, 375px ────────
console.log('\nhome page strip, reduced motion / already over / dismissal / 375px');
{
	const rm = await newPage({ body: cfg({ startsIn: -60e3, endsIn: 3600e3 }), reducedMotion: 'reduce' });
	await go(rm.page, '/');
	await rm.page.waitForSelector('.tws-eventbar[data-state="live"]', { timeout: PAGE_TIMEOUT });
	check('no pulse animation under reduced motion', (await cssAnim(rm.page.locator('.tws-eventbar-dot'))) === 'none');
	await rm.ctx.close();

	const over = await newPage({ body: cfg({ startsIn: -7200e3, endsIn: -3600e3 }) });
	await go(over.page, '/');
	await over.page.waitForSelector('.hero', { timeout: PAGE_TIMEOUT });
	await over.page.waitForTimeout(4000);
	check('an already-ended event mounts nothing', (await over.page.locator('.tws-eventbar').count()) === 0);
	await over.ctx.close();

	const body = cfg({ startsIn: 3 * 86400e3, endsIn: 4 * 86400e3 });
	const d = await newPage({ body });
	await go(d.page, '/');
	await d.page.waitForSelector('.tws-eventbar', { timeout: PAGE_TIMEOUT });
	await d.page.locator('.tws-eventbar-x').click();
	await d.page.waitForTimeout(300);
	check('dismiss removes the strip', (await d.page.locator('.tws-eventbar').count()) === 0);
	const storage = await d.ctx.storageState();
	await d.ctx.close();

	const again = await newPage({ body, storage });
	await go(again.page, '/');
	await again.page.waitForSelector('.hero', { timeout: PAGE_TIMEOUT });
	await again.page.waitForTimeout(4000);
	check('dismissal survives a reload', (await again.page.locator('.tws-eventbar').count()) === 0);
	await again.ctx.close();

	const m = await newPage({ body, viewport: { width: 375, height: 812 } });
	await go(m.page, '/');
	await m.page.waitForSelector('.tws-eventbar', { timeout: PAGE_TIMEOUT });
	const geo = await m.page.evaluate(() => ({
		scrollW: document.documentElement.scrollWidth,
		clientW: document.documentElement.clientWidth,
		nameTop: document.querySelector('.tws-eventbar-name').getBoundingClientRect().top,
		ctaTop: document.querySelector('.tws-eventbar-cta').getBoundingClientRect().top,
		right: document.querySelector('.tws-eventbar-in').getBoundingClientRect().right,
	}));
	check('page does not scroll sideways at 375px', geo.scrollW <= geo.clientW + 1, JSON.stringify(geo));
	check('strip wraps instead of clipping', geo.ctaTop > geo.nameTop && geo.right <= 376, JSON.stringify(geo));
	await m.ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed against ${BASE}`);
process.exit(failures === 0 ? 0 : 1);
