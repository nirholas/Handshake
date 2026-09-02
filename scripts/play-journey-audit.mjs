// Full-journey audit for /play. Walks the player path a first-time visitor
// walks (cold load, lobby, search, avatar bar, world entry, HUD panels) in a
// real browser and reports only measured facts: console output, failed
// requests, cumulative layout shift, elements that overflow the viewport,
// touch targets under the 40px bar, and every tab stop with its focus ring.
//
//   node scripts/play-journey-audit.mjs                       # desktop, local
//   VIEWPORT=375 node scripts/play-journey-audit.mjs
//   VIEWPORT=375 LOBBY_ONLY=1 node scripts/play-journey-audit.mjs   # skip the world
//   TAB_CHECK=1 node scripts/play-journey-audit.mjs                 # add a real Tab pass
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

// NO_WEBGL=1 drops the software renderer entirely. The lobby's layout is pure
// DOM and CSS, so a chrome without 3D measures it exactly the same while using
// a fraction of the memory, and it doubles as a check that the WebGL-unavailable
// fallbacks (avatar-thumb.js, the world boot) degrade instead of stranding the
// page. Use it for layout and touch-target sweeps; use the default for anything
// that has to actually render the world.
const NO_WEBGL = process.env.NO_WEBGL === '1';
const browser = await chromium.launch({
	args: NO_WEBGL
		? ['--disable-3d-apis', '--disable-gpu']
		: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
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
const NOISE = /GL Driver Message|GPU stall|\[vite\]|@vite\/client|WebSocket closed without opened|Error during WebSocket handshake|Third-party cookie|preloaded using link preload/i;
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
		// The defect this scan exists to catch is content the player can SEE being
		// cut off by the screen edge, so an element only counts when it actually
		// straddles that edge. /play pins <body> to `overflow: hidden`, and three
		// harmless classes of element live entirely outside the viewport behind
		// that clip: name labels the 3D projection puts at x=10000 when their
		// subject is off camera, buttons parked past the end of the horizontally
		// scrollable emote tray, and a closed right-docked drawer. All three used
		// to be reported every run, which buried the hits that mattered.
		const straddles = (r) => (r.right > vw + 1 && r.left < vw) || (r.left < -1 && r.right > 0);
		for (const n of document.querySelectorAll('body *')) {
			if (!n.offsetParent && getComputedStyle(n).position !== 'fixed') continue;
			const r = n.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			if (straddles(r)) {
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
 * Focus every tabbable control in DOM order and compare its focused computed
 * style against its resting one. A control whose outline and box-shadow are
 * identical either way is invisible to a keyboard user, which is the defect
 * this catches. Runs entirely in-page: one round trip, no per-key latency, so
 * it stays accurate on a machine whose main thread is busy rendering WebGL.
 */
async function focusSweep(label) {
	const res = await page.evaluate(() => {
		const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
		// A focus indicator is often painted on a ::before/::after ring rather than
		// the control itself, so the fingerprint has to cover the pseudo-elements
		// too or a perfectly visible ring reads as missing.
		const style = (n) => {
			const parts = [];
			for (const pseudo of [null, '::before', '::after']) {
				const cs = getComputedStyle(n, pseudo);
				parts.push(`${cs.outlineStyle}|${cs.outlineWidth}|${cs.outlineColor}|${cs.boxShadow}|${cs.borderColor}|${cs.backgroundColor}|${cs.opacity}`);
			}
			return parts.join('##');
		};
		const out = { total: 0, noRing: [], notFocusable: [] };
		const prev = document.activeElement;
		for (const n of document.querySelectorAll(TABBABLE)) {
			if (n.disabled || n.hidden) continue;
			const r = n.getBoundingClientRect();
			const cs0 = getComputedStyle(n);
			if (r.width === 0 || r.height === 0 || cs0.visibility === 'hidden' || cs0.display === 'none') continue;
			out.total++;
			const resting = style(n);
			n.focus({ preventScroll: true });
			const focused = document.activeElement === n;
			const desc = {
				sel: n.id ? `#${n.id}` : `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')}`,
				label: (n.getAttribute('aria-label') || n.title || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 34),
			};
			if (!focused) { out.notFocusable.push(desc); continue; }
			if (style(n) === resting) out.noRing.push(desc);
			n.blur();
		}
		if (prev && prev.focus) prev.focus({ preventScroll: true });
		// Collapse repeats: thirty identical grid cells are one defect.
		const uniq = (arr) => {
			const m = new Map();
			for (const d of arr) if (!m.has(d.sel)) m.set(d.sel, d);
			return [...m.values()].slice(0, 20);
		};
		out.noRing = uniq(out.noRing);
		out.notFocusable = uniq(out.notFocusable);
		return out;
	});
	console.log(at(), `[focus:${label}] ${res.total} tabbable, ${res.noRing.length} kinds without a focus ring, ${res.notFocusable.length} that refuse focus`);
	for (const b of res.noRing) console.log('   no ring:', b.sel, '|', b.label);
	for (const b of res.notFocusable) console.log('   unfocusable:', b.sel, '|', b.label);
	if (res.noRing.length || res.notFocusable.length) findings.focus.push({ label, bad: [...res.noRing, ...res.notFocusable] });
	return res;
}

/**
 * A real Tab-key pass, short on purpose: it exists to catch a focus trap (Tab
 * cycling inside a small set) that the DOM-order sweep above cannot see.
 */
async function tabTrapCheck(label, steps = 25) {
	const seen = new Set();
	await page.evaluate(() => document.body.focus());
	for (let i = 0; i < steps; i++) {
		await page.keyboard.press('Tab');
		const sel = await page.evaluate(() => {
			const n = document.activeElement;
			if (!n || n === document.body) return null;
			return (n.id ? `#${n.id}` : n.tagName.toLowerCase() + '.' + String(n.className).split(' ')[0]) + '|' + (n.textContent || '').trim().slice(0, 20);
		});
		if (sel) seen.add(sel);
	}
	console.log(at(), `[tab:${label}] ${steps} presses reached ${seen.size} distinct controls`);
	// Naming them is what separates "a modal is trapping focus, as designed"
	// from "the tab order is broken", which look identical as a bare count.
	for (const s of [...seen].slice(0, 12)) console.log('    ', s);
	return seen.size;
}

/** The run's verdict, in the same shape whichever depth the run went to. */
function summarize() {
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
}

async function noteState(label, fn, arg) {
	const v = await page.evaluate(fn, arg).catch((e) => ({ error: String(e) }));
	findings.states.push({ label, v });
	console.log(at(), `[state:${label}]`, JSON.stringify(v));
	return v;
}

// ── 1. cold load into the lobby ────────────────────────────────────────────
console.log(at(), `journey start ${BASE} @ ${width}x${height}${MOBILE ? ' (touch)' : ''}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 150000 });
// The lobby element exists from boot but stays hidden behind the loader, so
// "rendered" means a coin card (or a designed empty/error state) is on screen.
await page.waitForFunction(() => {
	const lobby = document.getElementById('cc-lobby');
	return !!lobby && lobby.getBoundingClientRect().height > 0;
}, { timeout: 60000 }).catch(() => console.log(at(), 'LOBBY NEVER BECAME VISIBLE'));

// The skeleton has to exist before data lands, otherwise the grid pops in.
await noteState('lobby-first-paint', () => ({
	skeletons: document.querySelectorAll('.cc-skeleton').length,
	cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
	empty: !!document.querySelector('.cc-state'),
}));

await page.waitForFunction(() => document.querySelectorAll('.cc-card:not(.cc-skeleton)').length > 0
	|| document.querySelector('.cc-state'), { timeout: 30000 })
	.catch(() => console.log(at(), 'GRID NEVER RESOLVED (no cards, no empty state, no error state)'));

await noteState('lobby-loaded', () => ({
	cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
	skeletons: document.querySelectorAll('.cc-skeleton').length,
	empty: !!document.querySelector('.cc-state'),
	stateText: document.querySelector('.cc-state')?.textContent?.trim().slice(0, 140) || null,
	presets: document.querySelectorAll('.cc-avatar-chip').length,
}));

await overflowScan('lobby');
if (MOBILE) await touchScan('lobby');
await focusSweep('lobby');

// The cold-open intro (src/game/play-intro.js) auto-shows once per browser and
// correctly traps focus while it is up. Measuring the lobby's own tab order
// means dismissing it first, or the trap check just re-reports the modal.
const introDismissed = await page.evaluate(() => {
	const skip = document.querySelector('.pi-close, .pi-btn-ghost');
	if (!skip) return false;
	skip.click();
	return true;
});
if (introDismissed) console.log(at(), '[dismissed] cold-open intro');
await page.waitForTimeout(600);
// Opt-in: a real Tab press costs a page round trip, and on a machine rendering
// this world in software that is seconds each. focusSweep above already proves
// reachability, so the trap check is only worth its minutes when something
// looks wrong with the tab order specifically.
if (process.env.TAB_CHECK === '1') await tabTrapCheck('lobby');

// LOBBY_ONLY stops here. The lobby's layout and focus story is what a responsive
// pass re-checks over and over, and it is reachable in a fraction of the time a
// world entry costs, so it is worth being able to ask for on its own.
if (process.env.LOBBY_ONLY === '1') {
	findings.cls = await page.evaluate(() => ({ cls: Number((window.__cls || 0).toFixed(4)), shifts: (window.__shifts || []).slice(0, 8) }));
	console.log(at(), '[cls]', JSON.stringify(findings.cls));
	console.log(`\n=== lobby summary @${VIEWPORT} ===`);
	console.log('console issues:', findings.console.length);
	for (const c of [...new Set(findings.console)].slice(0, 10)) console.log('   ', c);
	console.log('network issues:', findings.network.length);
	for (const n of [...new Set(findings.network)].slice(0, 10)) console.log('   ', n);
	console.log('overflow scans with hits:', findings.overflow.length);
	console.log('touch-target scans with hits:', findings.touch.length);
	console.log('focus problems:', findings.focus.reduce((a, f) => a + f.bad.length, 0));
	await browser.close();
	process.exit(findings.console.length || findings.network.length ? 1 : 0);
}

// ── 2. search: a query with hits, then one with none ───────────────────────
//
// The value is set and an `input` event dispatched rather than typed through
// the keyboard: Playwright's actionability wait needs the main thread, and this
// one is busy rendering a world in software. The handler under test is the
// same either way, since the lobby listens for `input`.
const typeSearch = (value) => page.evaluate((v) => {
	const el = document.querySelector('.cc-search input');
	if (!el) return false;
	el.focus();
	el.value = v;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	return true;
}, value);

if (await typeSearch('dog')) {
	await page.waitForTimeout(4000);
	await noteState('search-hits', () => ({
		cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
		more: !!document.querySelector('.cc-search-more'),
		empty: !!document.querySelector('.cc-state'),
	}));
	await typeSearch('zzzqqqxnotacoin9999');
	await page.waitForTimeout(5000);
	await noteState('search-no-hits', () => ({
		cards: document.querySelectorAll('.cc-card:not(.cc-skeleton)').length,
		empty: !!document.querySelector('.cc-state'),
		emptyText: document.querySelector('.cc-state')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 140) || null,
	}));
	await typeSearch('');
	await page.waitForTimeout(1500);
} else {
	console.log(at(), '[missing] lobby search input');
}

// A phone-sized sweep is worth running on its own: the lobby is where the
// layout defects live, and skipping the world keeps the run inside the memory
// a shared machine can spare.
if (process.env.LOBBY_ONLY === '1') {
	findings.cls = await page.evaluate(() => ({ cls: Number((window.__cls || 0).toFixed(4)), shifts: (window.__shifts || []).slice(0, 8) }));
	console.log(at(), '[cls]', JSON.stringify(findings.cls));
	summarize();
	await browser.close();
	process.exit(findings.console.length || findings.network.length ? 1 : 0);
}

// ── 3. avatar bar: gallery + create modal open/close ───────────────────────
for (const [name, sel] of [['create', '.cc-create-btn'], ['gallery', '.cc-gallery-btn']]) {
	// Dispatched rather than driven through the mouse: under software GL the
	// main thread stalls long enough for Playwright's stability check to time
	// out on a button that is perfectly clickable for a real user.
	const found = await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return false; b.click(); return true; }, sel);
	if (!found) { console.log(at(), `[missing] ${name} button`); continue; }
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
await page.goto(worldUrl, { waitUntil: 'domcontentloaded', timeout: 150000 });
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
await focusSweep('world');

// ── 5. every HUD panel: open, measure, close ───────────────────────────────
const PANELS = [
	['store', /store|shop|boutique/i],
	['bank', /bank|wallet|balance/i],
	// "emote wheel" also matches /wheel/, and its button sits in the HUD while
	// the Wheel of Fortune is proximity-gated behind its station. Without the
	// exclusion this step opened the emote wheel and reported it as the spin
	// wheel, so a real gap would have read as a pass.
	['wheel', /(?<!emote )wheel|spin/i],
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
// `left` lives in this Node scope, so it has to be passed in; referencing it
// inside the page threw "left is not defined" and the whole leave step was
// silently swallowed by the .catch(), never verifying the lobby came back.
await noteState('after-leave', (clicked) => ({
	leaveButton: clicked,
	lobbyVisible: !!document.querySelector('#cc-lobby:not([hidden])'),
	worldGone: !document.querySelector('#cc-hud:not([hidden])'),
}), left);

findings.cls = await page.evaluate(() => ({ cls: Number((window.__cls || 0).toFixed(4)), shifts: (window.__shifts || []).slice(0, 8) }));
console.log(at(), '[cls]', JSON.stringify(findings.cls));

await page.screenshot({ path: process.env.SHOT || `/tmp/play-journey-${VIEWPORT}.png` }).catch(() => {});

summarize();

await browser.close();
process.exit(findings.console.length || findings.network.length ? 1 : 0);
