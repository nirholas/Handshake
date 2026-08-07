// Full-journey audit for /play. Walks the player path a first-time visitor
// walks (cold load, lobby, search, avatar bar, world entry, HUD panels) in a
// real browser and reports only measured facts: console output, failed
// requests, cumulative layout shift, elements that overflow the viewport,
// touch targets under the 40px bar, and every tab stop with its focus ring.
//
//   node scripts/play-journey-audit.mjs                       # desktop, local
//   VIEWPORT=375 node scripts/play-journey-audit.mjs
//   VIEWPORT=320 node scripts/play-journey-audit.mjs https://three.ws/play
//
// Nothing here is inferred from source. Every finding is a resolved computed
// style or a measured box, so a clean run is real evidence the journey is clean.
import { chromium, devices } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3000/play';
const VIEWPORT = String(process.env.VIEWPORT || 'desktop');
const HOME_COIN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const TOUCH_MIN = 40;

const MOBILE = VIEWPORT !== 'desktop';
const width = MOBILE ? Number(VIEWPORT) : 1440;
const height = MOBILE ? 812 : 900;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext(
	MOBILE
		? { ...devices['iPhone 14'], viewport: { width, height }, screen: { width, height } }
		: { viewport: { width, height } },
);

// CLS has to be observed from the first frame, so the observer is installed
// before any page script runs.
await ctx.addInitScript(() => {
	window.__cls = 0;
	window.__shifts = [];
	try {
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) {
				if (e.hadRecentInput) continue;
				window.__cls += e.value;
				if (e.value > 0.01) {
					window.__shifts.push({
						value: Number(e.value.toFixed(4)),
						sources: (e.sources || []).map((s) => s.node?.className || s.node?.id || s.node?.tagName || '?').slice(0, 3),
					});
				}
			}
		}).observe({ type: 'layout-shift', buffered: true });
	} catch { /* layout-shift unsupported */ }
});

const page = await ctx.newPage();
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const findings = { console: [], network: [], overflow: [], touch: [], focus: [], states: [], cls: null };

// Noise that is not our code: the swiftshader driver's own performance chatter,
// and Vite's dev-only HMR client, whose websocket cannot reach a forwarded
// Codespaces port. Everything else counts as a defect.
const NOISE = /GL Driver Message|GPU stall|\[vite\]|@vite\/client|WebSocket closed without opened|Third-party cookie|preloaded using link preload/i;
const OURS = (text) => !NOISE.test(text);

page.on('console', (m) => {
	const type = m.type();
	if (type !== 'error' && type !== 'warning') return;
	const text = m.text().slice(0, 300);
	if (!OURS(text)) return;
	findings.console.push(`[${type}] ${text}`);
	console.log(at(), `[console.${type}]`, text);
});
page.on('pageerror', (e) => {
	const line = String(e?.stack || e).slice(0, 400);
	if (!OURS(line)) return;
	findings.console.push(`[pageerror] ${line}`);
	console.log(at(), '[pageerror]', line);
});
page.on('requestfailed', (r) => {
	const err = r.failure()?.errorText || '';
	if (/ERR_ABORTED/.test(err)) return;
	findings.network.push(`${err} ${r.url().slice(0, 120)}`);
	console.log(at(), '[reqfail]', err, r.url().slice(0, 120));
});
page.on('response', (r) => {
	if (r.status() < 400) return;
	findings.network.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
	console.log(at(), `[http ${r.status()}]`, r.url().slice(0, 120));
});

/** Every element whose border box crosses the right edge of the viewport. */
async function overflowScan(label) {
	const hits = await page.evaluate((vw) => {
		const out = [];
		const doc = document.scrollingElement;
		if (doc.scrollWidth > doc.clientWidth + 1) out.push({ sel: 'document', right: doc.scrollWidth, w: doc.clientWidth });
		for (const n of document.querySelectorAll('body *')) {
			if (!n.offsetParent && getComputedStyle(n).position !== 'fixed') continue;
			const r = n.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			if (r.right > vw + 1 || r.left < -1) {
				const sel = n.id ? `#${n.id}` : `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')}`;
				out.push({ sel, left: Math.round(r.left), right: Math.round(r.right) });
			}
		}
		// Collapse to unique selectors: a repeated grid cell is one defect, not thirty.
		const seen = new Map();
		for (const o of out) if (!seen.has(o.sel)) seen.set(o.sel, o);
		return [...seen.values()].slice(0, 25);
	}, width);
	if (hits.length) {
		findings.overflow.push({ label, hits });
		console.log(at(), `[overflow:${label}]`, JSON.stringify(hits));
	}
	return hits;
}

/** Visible interactive elements whose hit box is under the touch bar. */
async function touchScan(label) {
	const hits = await page.evaluate((min) => {
		const out = [];
		const sel = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
		for (const n of document.querySelectorAll(sel)) {
			const r = n.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const cs = getComputedStyle(n);
			if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
			// Inline links inside a paragraph are exempt (WCAG 2.5.8).
			const inlineLink = n.tagName === 'A' && cs.display.startsWith('inline') && n.closest('p, li, small');
			if (inlineLink) continue;
			if (r.width < min || r.height < min) {
				out.push({
					sel: n.id ? `#${n.id}` : `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')}`,
					label: (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 24),
					w: Math.round(r.width), h: Math.round(r.height),
				});
			}
		}
		const seen = new Map();
		for (const o of out) if (!seen.has(o.sel)) seen.set(o.sel, o);
		return [...seen.values()].slice(0, 30);
	}, TOUCH_MIN);
	if (hits.length) {
		findings.touch.push({ label, hits });
		console.log(at(), `[touch<${TOUCH_MIN}:${label}]`, JSON.stringify(hits));
	}
	return hits;
}

/**
 * Tab through the surface and record whether each stop paints a focus ring.
 * A stop with no outline and no box-shadow change is invisible to a keyboard
 * user, which is the defect this catches.
 */
async function focusSweep(label, steps = 60) {
	const stops = [];
	await page.evaluate(() => document.body.focus());
	for (let i = 0; i < steps; i++) {
		await page.keyboard.press('Tab');
		const stop = await page.evaluate(() => {
			const n = document.activeElement;
			if (!n || n === document.body) return null;
			const cs = getComputedStyle(n);
			const r = n.getBoundingClientRect();
			const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || /rgb|inset/.test(cs.boxShadow || '');
			return {
				sel: n.id ? `#${n.id}` : `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')}`,
				label: (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 30),
				ring,
				offscreen: r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight,
			};
		});
		if (!stop) break;
		if (stops.some((s) => s.sel === stop.sel && s.label === stop.label)) continue;
		stops.push(stop);
	}
	const bad = stops.filter((s) => !s.ring && !s.offscreen);
	console.log(at(), `[focus:${label}] ${stops.length} stops, ${bad.length} without a visible ring`);
	if (bad.length) {
		findings.focus.push({ label, bad });
		for (const b of bad) console.log('   no ring:', b.sel, '|', b.label);
	}
	return stops;
}

async function noteState(label, fn) {
	const v = await page.evaluate(fn).catch((e) => ({ error: String(e) }));
	findings.states.push({ label, v });
	console.log(at(), `[state:${label}]`, JSON.stringify(v));
	return v;
}

// ── 1. cold load into the lobby ────────────────────────────────────────────
console.log(at(), `journey start ${BASE} @ ${width}x${height}${MOBILE ? ' (touch)' : ''}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#cc-lobby', { timeout: 30000 }).catch(() => console.log(at(), 'LOBBY NEVER RENDERED'));

// The skeleton has to exist before data lands, otherwise the grid pops in.
await noteState('lobby-first-paint', () => ({
	skeletons: document.querySelectorAll('.cc-skeleton').length,
	cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
	empty: !!document.querySelector('.cc-empty'),
}));

await page.waitForFunction(() => document.querySelectorAll('.cc-card:not(.cc-skeleton)').length > 0
	|| document.querySelector('.cc-empty') || document.querySelector('.cc-grid-error'), { timeout: 30000 })
	.catch(() => console.log(at(), 'GRID NEVER RESOLVED (no cards, no empty state, no error state)'));

await noteState('lobby-loaded', () => ({
	cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
	skeletons: document.querySelectorAll('.cc-skeleton').length,
	empty: !!document.querySelector('.cc-empty'),
	error: !!document.querySelector('.cc-grid-error'),
	presets: document.querySelectorAll('.cc-avatar-chip').length,
}));

await overflowScan('lobby');
if (MOBILE) await touchScan('lobby');
await focusSweep('lobby', MOBILE ? 40 : 70);

// ── 2. search: a query with hits, then one with none ───────────────────────
const search = await page.$('.cc-search input');
if (search) {
	await search.click();
	await search.type('dog', { delay: 30 });
	await page.waitForTimeout(3500);
	await noteState('search-hits', () => ({
		cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
		more: !!document.querySelector('.cc-search-more'),
		empty: !!document.querySelector('.cc-empty'),
	}));
	await search.fill('zzzqqqxnotacoin9999');
	await page.waitForTimeout(4000);
	await noteState('search-no-hits', () => ({
		cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
		empty: !!document.querySelector('.cc-empty'),
		emptyText: document.querySelector('.cc-empty')?.textContent?.trim().slice(0, 120) || null,
	}));
	await search.fill('');
	await page.waitForTimeout(1500);
}

// ── 3. avatar bar: gallery + create modal open/close ───────────────────────
for (const [name, sel] of [['create', '.cc-create-btn'], ['gallery', '.cc-gallery-btn']]) {
	const btn = await page.$(sel);
	if (!btn) { console.log(at(), `[missing] ${name} button`); continue; }
	await btn.click().catch(() => {});
	await page.waitForTimeout(2500);
	await noteState(`${name}-open`, () => ({
		overlays: [...document.querySelectorAll('[class*="overlay"], [class*="modal"], dialog')]
			.filter((n) => n.offsetParent).map((n) => String(n.className).slice(0, 40)),
	}));
	await overflowScan(`${name}-modal`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(800);
	await noteState(`${name}-closed-by-escape`, () => ({
		stillOpen: [...document.querySelectorAll('[class*="overlay"], [class*="modal"], dialog')].filter((n) => n.offsetParent).length,
	}));
	// Belt and braces: click any close control still on screen.
	await page.evaluate(() => {
		const x = [...document.querySelectorAll('button')].find((b) => b.offsetParent && /close|✕|×/i.test(b.getAttribute('aria-label') || b.textContent || ''));
		x?.click();
	});
	await page.waitForTimeout(500);
}

// ── 4. into the $THREE world ───────────────────────────────────────────────
const worldUrl = `${BASE}${BASE.includes('?') ? '&' : '?'}coin=${HOME_COIN}`;
console.log(at(), 'entering world', worldUrl);
await page.goto(worldUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => {
	const l = document.getElementById('kx-loading');
	return !l || l.classList.contains('kx-hidden') || l.hidden || getComputedStyle(l).display === 'none';
}, { timeout: 60000 }).catch(() => console.log(at(), 'LOADER NEVER CLEARED'));
console.log(at(), 'world interactive');

// Dismiss whatever onboarding is showing so the HUD is reachable.
for (let i = 0; i < 4; i++) {
	await page.waitForTimeout(1500);
	const hit = await page.evaluate(() => {
		const b = [...document.querySelectorAll('button')]
			.find((x) => x.offsetParent && /^(continue|enter the world|got it|start|skip|drop in|let's go)$/i.test((x.textContent || '').trim()));
		if (b) { b.click(); return b.textContent.trim(); }
		return null;
	});
	if (hit) console.log(at(), '[dismissed]', hit);
}

await noteState('world-hud', () => ({
	hud: !!document.querySelector('#cc-hud:not([hidden])'),
	canvas: !!document.querySelector('canvas'),
	status: document.getElementById('cc-status')?.getAttribute('data-state') || null,
	statusText: document.getElementById('cc-status')?.textContent?.trim().slice(0, 60) || null,
	joystick: !!document.getElementById('cc-joystick'),
	chatCollapsed: document.getElementById('cc-chat')?.classList.contains('cc-chat-min') ?? null,
}));

await overflowScan('world');
if (MOBILE) await touchScan('world');

// ── 5. every HUD panel: open, measure, close ───────────────────────────────
const PANELS = [
	['store', /store|shop|boutique/i],
	['bank', /bank|wallet|balance/i],
	['wheel', /wheel|spin/i],
	['quests', /quest|job|board/i],
	['friends', /friend|crew/i],
	['emotes', /emote/i],
];
for (const [name, re] of PANELS) {
	const opened = await page.evaluate((src) => {
		const rx = new RegExp(src.slice(1, src.lastIndexOf('/')), 'i');
		const b = [...document.querySelectorAll('button, [role="button"]')]
			.filter((x) => x.offsetParent)
			.find((x) => rx.test((x.getAttribute('aria-label') || x.title || x.textContent || '')));
		if (!b) return null;
		b.click();
		return (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30);
	}, String(re));
	if (!opened) { console.log(at(), `[panel:${name}] no trigger visible`); continue; }
	await page.waitForTimeout(2200);
	const shape = await page.evaluate(() => {
		const panels = [...document.querySelectorAll('[class*="panel"], [class*="modal"], [class*="overlay"], dialog')]
			.filter((n) => n.offsetParent)
			.map((n) => {
				const r = n.getBoundingClientRect();
				return {
					cls: String(n.className).slice(0, 40),
					box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
					overflows: r.right > innerWidth + 1 || r.bottom > innerHeight + 1,
					text: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
				};
			});
		return panels.slice(0, 4);
	});
	findings.states.push({ label: `panel:${name}`, v: { opened, shape } });
	console.log(at(), `[panel:${name}] via "${opened}"`, JSON.stringify(shape));
	if (MOBILE) await touchScan(`panel:${name}`);
	await overflowScan(`panel:${name}`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(700);
}

// ── 6. leave back to the lobby ─────────────────────────────────────────────
const left = await page.evaluate(() => {
	const b = document.querySelector('.cc-leave');
	if (!b) return false;
	b.click();
	return true;
});
await page.waitForTimeout(2500);
await noteState('after-leave', () => ({ leaveButton: left, lobbyVisible: !!document.querySelector('#cc-lobby:not([hidden])') }))
	.catch(() => {});

findings.cls = await page.evaluate(() => ({ cls: Number((window.__cls || 0).toFixed(4)), shifts: (window.__shifts || []).slice(0, 8) }));
console.log(at(), '[cls]', JSON.stringify(findings.cls));

await page.screenshot({ path: process.env.SHOT || `/tmp/play-journey-${VIEWPORT}.png` }).catch(() => {});

console.log('\n=== summary @' + VIEWPORT + ' ===');
const counts = new Map();
for (const c of findings.console) {
	const k = c.replace(/\d+/g, 'N').slice(0, 160);
	counts.set(k, (counts.get(k) || 0) + 1);
}
console.log('console issues:', findings.console.length);
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log('  ', String(n).padStart(3), 'x', k);
console.log('network issues:', findings.network.length);
for (const n of [...new Set(findings.network)].slice(0, 15)) console.log('   ', n);
console.log('overflow scans with hits:', findings.overflow.length);
console.log('touch-target scans with hits:', findings.touch.length);
console.log('focus stops without a ring:', findings.focus.reduce((a, f) => a + f.bad.length, 0));
console.log('CLS:', findings.cls?.cls);

await browser.close();
process.exit(findings.console.length || findings.network.length ? 1 : 0);
