// src/irl/discovery.js — IRL discovery onboarding + designed empty state (task 02)
//
// /irl deliberately has no radar, roster, or map: you find agents by physically
// being near them and looking through your camera. That privacy win is also the
// UX risk — with a tight discovery radius, "nothing on screen" is the COMMON
// first experience, and a bare badge reads as "this feature is empty everywhere."
//
// This module owns the two pieces that turn that emptiness into "keep exploring":
//   1. A once-per-device explainer that teaches the stumble-upon model (and is
//      re-openable any time from the topbar "?" affordance).
//   2. A designed empty state — a centered, low-contrast prompt with a gentle
//      looping hint + a "Place an agent here" CTA — that retires smoothly the
//      moment a real agent comes into range.
//
// irl.js drives it: initDiscovery() once at boot, setEmpty() from the same
// reconcile that updates the nearby badge, and maybeFirstRun() after onboarding.
// The topbar nearby badge (irl.js) owns the polite screen-reader announcement of
// the empty⇄populated transition, so the visual prompt here is decorative
// (aria-hidden) and never double-speaks — only its CTA is in the a11y tree.

const EXPLAINED_KEY = 'irl_discovery_explained_v1';
const STYLE_ID = 'irl-dx-styles';

const reducedMotion = () =>
	typeof window !== 'undefined' &&
	typeof window.matchMedia === 'function' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// IRL cube mark, reused from the onboarding header so the explainer reads as the
// same product surface.
const MARK_SVG =
	'<svg class="irl-dx-mark" viewBox="0 0 26 28" fill="none" aria-hidden="true"><path class="irl-dx-cube" d="M13 2.5 4 7v9l9 4.5 9-4.5V7Z"/><path class="irl-dx-cube" d="M13 2.5v9M4 7l9 4.5M22 7l-9 4.5"/><path class="irl-dx-anchor" d="M13 20.5v1.9"/><ellipse class="irl-dx-anchor" cx="13" cy="24.3" rx="7.4" ry="1.9"/><circle class="irl-dx-dot" cx="13" cy="24.3" r="1" stroke="none"/></svg>';

// The three lessons, in order of what a first-timer needs: how discovery works,
// that it's mutual, and the privacy guarantee (which builds the trust task 08
// reinforces). Icons are decorative.
const LESSONS = [
	{
		icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
		title: 'They’re hidden around you',
		body: 'Agents are tucked into the world nearby. Walk around and look through your camera — when you get close to one, it appears.',
	},
	{
		icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
		title: 'Discovery is mutual',
		body: 'Drop your own agent anywhere. Whoever comes to that exact spot later will find it — just like you find others’.',
	},
	{
		icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
		title: 'No list, no map — ever',
		body: 'We never show a roster of where agents are — not even to you. You stumble on them by being there. That’s the whole point.',
	},
];

// ── DOM refs (resolved at init from the static shell in pages/irl.html) ───────
let emptyEl = null;
let hintEl = null;
let modalEl = null;
let helpBtn = null;
let _onPlace = null;
let _emptyVisible = false;
let _modalDone = null; // active modal teardown, if open

// ── Explainer modal CSS (injected once, co-located like onboarding.js) ────────
function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = MODAL_CSS;
	(document.head || document.documentElement).appendChild(style);
}

// ── First-run explainer ───────────────────────────────────────────────────────
function buildModal() {
	if (!modalEl) return;
	modalEl.innerHTML = `
		<div class="irl-dx-scrim" data-dx-close></div>
		<div class="irl-dx-panel" role="document">
			<div class="irl-dx-head">
				<span class="irl-dx-badge">${MARK_SVG} IRL</span>
				<h2 class="irl-dx-title">How you’ll find agents</h2>
				<p class="irl-dx-sub">There’s no map and no list — you discover agents by exploring. Here’s the idea.</p>
			</div>
			<ul class="irl-dx-lessons">
				${LESSONS.map((l) => `
					<li class="irl-dx-lesson">
						<span class="irl-dx-lesson-ic" aria-hidden="true">${l.icon}</span>
						<span class="irl-dx-lesson-tx">
							<span class="irl-dx-lesson-t">${l.title}</span>
							<span class="irl-dx-lesson-b">${l.body}</span>
						</span>
					</li>`).join('')}
			</ul>
			<div class="irl-dx-actions">
				<button type="button" class="irl-dx-btn irl-dx-btn--primary" data-dx-start>Start exploring</button>
				<button type="button" class="irl-dx-btn" data-dx-place>Place an agent here</button>
			</div>
			<a class="irl-dx-learn" href="/irl-privacy" target="_blank" rel="noopener">How location &amp; privacy work <span aria-hidden="true">↗</span></a>
		</div>`;
}

function openExplainer({ markSeen = false } = {}) {
	if (!modalEl) return;
	ensureStyles();
	if (markSeen) {
		try { localStorage.setItem(EXPLAINED_KEY, '1'); } catch {}
	}
	// A second open (e.g. the "?" tapped while still animating closed) replaces the
	// previous instance cleanly rather than stacking listeners.
	if (_modalDone) _modalDone();
	buildModal();

	const prevFocus = typeof document !== 'undefined' ? document.activeElement : null;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener('keydown', onKey, true);
		modalEl.classList.remove('is-open');
		const after = () => { modalEl.hidden = true; modalEl.innerHTML = ''; };
		if (reducedMotion()) after(); else setTimeout(after, 240);
		_modalDone = null;
		try { prevFocus?.focus?.(); } catch {}
	};
	_modalDone = close;

	const onKey = (e) => {
		if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
		if (e.key === 'Tab') trapTab(e);
	};
	function trapTab(e) {
		const f = modalEl.querySelectorAll('button, a[href]');
		if (!f.length) return;
		const first = f[0], last = f[f.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}
	document.addEventListener('keydown', onKey, true);

	modalEl.querySelectorAll('[data-dx-close]').forEach((el) => el.addEventListener('click', close));
	modalEl.querySelector('[data-dx-start]')?.addEventListener('click', close);
	modalEl.querySelector('[data-dx-place]')?.addEventListener('click', () => {
		close();
		try { _onPlace?.(); } catch {}
	});

	modalEl.hidden = false;
	const reveal = () => modalEl.classList.add('is-open');
	if (reducedMotion()) reveal(); else requestAnimationFrame(reveal);
	setTimeout(() => { try { modalEl.querySelector('[data-dx-start]')?.focus(); } catch {} }, reducedMotion() ? 0 : 60);
}

// Defer the first-run card until any first-run privacy disclosure (task 08, a
// higher-z modal that fires the moment location is granted) has closed — so the
// two never stack. Event-driven via a MutationObserver, no polling.
function whenModalsClear(run) {
	if (typeof document === 'undefined') { run(); return; }
	const open = () => document.querySelector('.irlpc-root');
	if (!open()) { run(); return; }
	const obs = new MutationObserver(() => {
		if (!open()) { obs.disconnect(); run(); }
	});
	obs.observe(document.body, { childList: true });
}

// ── Designed empty state ──────────────────────────────────────────────────────
/**
 * Show or retire the "keep exploring" prompt. Called from the same reconcile that
 * updates the nearby badge, so the two are always in sync. `ar` tailors the hint
 * to whether the camera is live (look around) or not (turn it on to explore).
 */
export function setEmpty(show, { ar = false } = {}) {
	if (!emptyEl) return;
	if (show) {
		if (hintEl) {
			hintEl.textContent = ar
				? 'Look around 👀  ·  or be the first to pin here'
				: 'Turn on your camera and explore  ·  or be the first to pin here';
		}
		if (!_emptyVisible) {
			emptyEl.hidden = false;
			if (reducedMotion()) emptyEl.classList.add('is-visible');
			else requestAnimationFrame(() => emptyEl.classList.add('is-visible'));
			_emptyVisible = true;
		}
	} else if (_emptyVisible) {
		emptyEl.classList.remove('is-visible');
		_emptyVisible = false;
		const hide = () => { if (!emptyEl.classList.contains('is-visible')) emptyEl.hidden = true; };
		if (reducedMotion()) hide(); else setTimeout(hide, 420);
	}
}

// ── Public boot API ────────────────────────────────────────────────────────────
/** Wire the static shell once. `onPlace` runs when either CTA is tapped. */
export function initDiscovery({ onPlace } = {}) {
	_onPlace = typeof onPlace === 'function' ? onPlace : null;
	emptyEl = document.getElementById('irl-discovery-empty');
	hintEl = emptyEl ? emptyEl.querySelector('.irl-dx-empty-hint') : null;
	modalEl = document.getElementById('irl-discovery-explainer');
	helpBtn = document.getElementById('irl-dx-help');
	ensureStyles();
	emptyEl?.querySelector('.irl-dx-place')?.addEventListener('click', () => { try { _onPlace?.(); } catch {} });
	helpBtn?.addEventListener('click', () => openExplainer());
	return { setEmpty, maybeFirstRun, openExplainer };
}

/**
 * Reveal the always-available "?" affordance and, on a fresh device, show the
 * explainer once (after any open first-run modal clears). Call after onboarding
 * settles so the card never lands on top of the permission flow.
 */
export function maybeFirstRun() {
	if (helpBtn) helpBtn.hidden = false;
	let seen = false;
	try { seen = localStorage.getItem(EXPLAINED_KEY) === '1'; } catch {}
	if (seen) return;
	whenModalsClear(() => openExplainer({ markSeen: true }));
}

const MODAL_CSS = `
/* ── Designed discovery empty state ──────────────────────────────────────────
   A centered, low-contrast "keep exploring" prompt for the common case of a
   live-but-empty area. The container catches no pointer events (camera taps pass
   through); only the CTA is interactive. Calm blue, never red/amber — visually
   distinct from the error state (task 06). */
.irl-dx-empty {
	position: fixed; inset: 0; z-index: 11;
	display: flex; align-items: center; justify-content: center;
	pointer-events: none;
	opacity: 0; transition: opacity .4s ease;
}
.irl-dx-empty[hidden] { display: none; }
.irl-dx-empty.is-visible { opacity: 1; }
.irl-dx-empty-card {
	display: flex; flex-direction: column; align-items: center;
	gap: 16px; text-align: center; padding: 0 24px;
	/* Sit a touch above centre so the bottom panel never overlaps the CTA. */
	transform: translateY(-7%);
}
.irl-dx-empty-pulse { position: relative; width: 56px; height: 56px; flex-shrink: 0; }
.irl-dx-empty-pulse::before {
	content: ''; position: absolute; left: 50%; top: 50%;
	width: 12px; height: 12px; margin: -6px 0 0 -6px;
	border-radius: 50%; background: #8ec5ff; box-shadow: 0 0 10px rgba(140,197,255,0.85);
}
.irl-dx-empty-pulse::after {
	content: ''; position: absolute; inset: 0; border-radius: 50%;
	border: 1.5px solid rgba(140,197,255,0.55);
	animation: irl-dx-ripple 2.4s ease-out infinite;
}
@keyframes irl-dx-ripple {
	0%   { transform: scale(0.32); opacity: 0.9; }
	100% { transform: scale(1);    opacity: 0;   }
}
.irl-dx-empty-hint {
	margin: 0; max-width: 280px;
	font: 600 14px/1.45 system-ui, sans-serif;
	color: #c6d2e2; text-shadow: 0 1px 10px rgba(0,0,0,0.65);
}
.irl-dx-place {
	pointer-events: auto; appearance: none; cursor: pointer;
	border: 1px solid rgba(140,197,255,0.5);
	background: rgba(20,30,48,0.72); color: #eaf4ff;
	border-radius: 999px; padding: 11px 20px;
	font: 600 13.5px system-ui, sans-serif;
	-webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
	box-shadow: 0 6px 24px rgba(0,0,0,0.4);
	transition: background .15s, border-color .15s, transform .12s;
}
.irl-dx-place:hover { background: rgba(30,44,68,0.88); border-color: rgba(140,197,255,0.8); }
.irl-dx-place:active { transform: translateY(1px); }
.irl-dx-place:focus-visible { outline: 2px solid #8ec5ff; outline-offset: 2px; }

/* Re-openable "?" explainer affordance — below the topbar on the left, clear of
   the joystick (bottom) and the perm chips (top-centre). */
.irl-dx-help {
	position: fixed; left: 12px; top: calc(env(safe-area-inset-top, 0px) + 58px);
	z-index: 12; width: 30px; height: 30px; border-radius: 50%;
	display: flex; align-items: center; justify-content: center;
	appearance: none; cursor: pointer;
	font: 700 15px system-ui, sans-serif; color: #aeb6c8;
	background: rgba(18,26,40,0.7); border: 1px solid rgba(255,255,255,0.14);
	-webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
	transition: background .15s, color .15s, transform .12s;
}
.irl-dx-help[hidden] { display: none; }
/* Touch: 30px misses the 44px tap floor by a wide margin — grow the circle. */
@media (hover: none) { .irl-dx-help { width: 40px; height: 40px; font-size: 16px; } }
.irl-dx-help:hover { background: rgba(30,40,58,0.88); color: #eaf4ff; }
.irl-dx-help:active { transform: scale(0.94); }
.irl-dx-help:focus-visible { outline: 2px solid #8ec5ff; outline-offset: 2px; }

/* ── First-run explainer modal ──────────────────────────────────────────────── */
#irl-discovery-explainer {
	position: fixed; inset: 0; z-index: 130;
	display: flex; align-items: center; justify-content: center;
	padding: 24px;
	opacity: 0; pointer-events: none;
	transition: opacity .24s ease;
}
#irl-discovery-explainer[hidden] { display: none; }
#irl-discovery-explainer.is-open { opacity: 1; pointer-events: auto; }
.irl-dx-scrim {
	position: absolute; inset: 0;
	background: radial-gradient(120% 90% at 50% 0%, rgba(20,26,40,0.72), rgba(6,8,13,0.93));
	-webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
}
.irl-dx-panel {
	position: relative;
	width: min(440px, 100%);
	max-height: calc(100dvh - 48px);
	overflow-y: auto;
	background: linear-gradient(180deg, rgba(15,18,27,0.98), rgba(9,11,17,0.99));
	border: 1px solid rgba(255,255,255,0.10);
	border-radius: 22px;
	box-shadow: 0 24px 70px rgba(0,0,0,0.6);
	padding: 24px 22px 18px;
	transform: translateY(10px) scale(.99);
	transition: transform .28s cubic-bezier(.22,.61,.36,1);
}
#irl-discovery-explainer.is-open .irl-dx-panel { transform: none; }
.irl-dx-head { text-align: center; padding: 0 4px; }
.irl-dx-badge {
	display: inline-flex; align-items: center; gap: 6px;
	font: 600 11px/1 system-ui, sans-serif;
	letter-spacing: .09em; text-transform: uppercase;
	color: #7dd3fc;
	background: rgba(125,211,252,0.10);
	border: 1px solid rgba(125,211,252,0.28);
	border-radius: 999px; padding: 5px 10px; margin-bottom: 12px;
}
.irl-dx-mark { width: 15px; height: 16px; flex-shrink: 0; overflow: visible; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.irl-dx-mark .irl-dx-cube { opacity: .95; }
.irl-dx-mark .irl-dx-anchor { opacity: .55; }
.irl-dx-mark .irl-dx-dot { fill: currentColor; opacity: .8; }
.irl-dx-title { margin: 0 0 6px; font-size: 19px; font-weight: 700; letter-spacing: -.015em; color: #f1f4fa; line-height: 1.25; }
.irl-dx-sub { margin: 0; font-size: 13px; line-height: 1.5; color: #93a1b5; }
.irl-dx-lessons { list-style: none; margin: 18px 0 4px; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.irl-dx-lesson { display: flex; gap: 13px; align-items: flex-start; text-align: left; }
.irl-dx-lesson-ic {
	flex-shrink: 0; width: 38px; height: 38px; border-radius: 11px;
	display: flex; align-items: center; justify-content: center;
	color: #7dd3fc; background: rgba(125,211,252,0.09); border: 1px solid rgba(125,211,252,0.20);
}
.irl-dx-lesson-ic svg { width: 20px; height: 20px; }
.irl-dx-lesson-tx { display: flex; flex-direction: column; gap: 2px; }
.irl-dx-lesson-t { font: 600 14px/1.3 system-ui, sans-serif; color: #eef2f8; }
.irl-dx-lesson-b { font: 400 12.5px/1.5 system-ui, sans-serif; color: #93a1b5; }
.irl-dx-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.irl-dx-btn {
	width: 100%; appearance: none; cursor: pointer;
	border-radius: 12px; padding: 12px 16px;
	font: 600 14px/1 system-ui, sans-serif;
	border: 1px solid rgba(255,255,255,0.14);
	background: rgba(255,255,255,0.04); color: #e7edf6;
	transition: background .15s, border-color .15s, transform .12s;
}
.irl-dx-btn:hover { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.22); }
.irl-dx-btn:active { transform: translateY(1px); }
.irl-dx-btn:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
.irl-dx-btn--primary {
	color: #04121f; border-color: transparent;
	background: linear-gradient(180deg, #8fdcff, #51b9f2);
}
.irl-dx-btn--primary:hover { background: linear-gradient(180deg, #a3e3ff, #62c3f6); }
.irl-dx-learn {
	display: flex; align-items: center; justify-content: center; gap: 5px;
	margin-top: 13px;
	font: 500 12px/1 system-ui, sans-serif;
	color: #7dd3fc; text-decoration: none;
	transition: color .15s;
}
.irl-dx-learn:hover { color: #a6dcee; }
.irl-dx-learn:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 3px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) {
	#irl-discovery-explainer, .irl-dx-panel { transition: none; }
	.irl-dx-empty { transition: opacity .001s; }
	.irl-dx-empty-pulse::after { animation: none; opacity: 0.5; transform: scale(0.85); }
}
`;

if (typeof window !== 'undefined') {
	window.irlDiscovery = { initDiscovery, setEmpty, maybeFirstRun };
}
