// Walk-aware page transitions for the corner companion.
// =====================================================
// When a visitor with the Walk Companion enabled clicks a same-origin link, the
// jump to the next page is dressed up to *match the destination*: walking to
// /walk zooms the camera into the avatar, /pricing pulls a curtain down, an
// /agent/* profile spotlights open from the click point, /marketplace dives
// through a depth corridor, /dashboard glows softly, and everything else gets a
// clean fade-and-slide. The effect is intentionally short (≈0.5s) so it reads as
// a flourish, never a wait.
//
// We can't co-render the destination DOM during a full-document navigation, so
// each preset animates over a *themed cover layer* drawn on top of the current
// page, then commits the navigation as the cover finishes. The signature stays
// `(fromEl, toEl, avatarEl) => Promise<void>` per the spec:
//   - fromEl   the outgoing page surface (a snapshot host pinned over the page)
//   - toEl     the themed destination cover the preset reveals
//   - avatarEl the companion's host element (for camera-zoom-into-avatar)
//
// Everything uses the Web Animations API (element.animate) — no libraries. With
// `prefers-reduced-motion: reduce`, or when the visitor switches the feature off
// from the companion settings, every preset collapses to a plain fade.
//
// This module is owned by src/walk-companion.js, which calls installTransitions()
// once the companion mounts. It is side-effect free on import.

import { prefersReducedMotion } from '../walk-sdk/src/internal/storage.js';

// ── Preference (persisted, mirrors the companion's localStorage convention) ────
// The companion stores its flags under `walk:companion:*`; we slot in alongside.
const PREF_KEY = 'walk:companion:transitions';

export function transitionsEnabled() {
	try {
		// Default ON: absent key means the visitor never opted out.
		return localStorage.getItem(PREF_KEY) !== '0';
	} catch {
		return true;
	}
}

function setTransitionsEnabled(on) {
	try {
		localStorage.setItem(PREF_KEY, on ? '1' : '0');
	} catch {
		/* private mode / disabled storage — non-fatal */
	}
}

// ── Motion tokens (kept in lockstep with public/tokens.css) ───────────────────
const EASE_EMPHASIZED = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_STANDARD = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const EASE_OUT = 'cubic-bezier(0, 0, 0.2, 1)';
const DUR = 480; // --duration-slow-ish; reads as a flourish, not a wait
const FADE_DUR = 280;

const Z = 2147483600; // above the companion host (2147483000)

function reduced() {
	return prefersReducedMotion();
}

// Promise wrapper around an Animation; resolves on finish *or* cancel so a
// double-navigation never leaves a dangling promise.
function done(anim) {
	return new Promise((resolve) => {
		if (!anim) return resolve();
		const fin = () => resolve();
		anim.addEventListener('finish', fin, { once: true });
		anim.addEventListener('cancel', fin, { once: true });
	});
}

// ── Layer construction ────────────────────────────────────────────────────────
// A full-viewport fixed layer used as a transition surface. Pointer-events are
// off so a stray click during the (very short) animation can't be hijacked.
function makeLayer(extra) {
	const el = document.createElement('div');
	el.style.cssText =
		`position:fixed;inset:0;z-index:${Z};pointer-events:none;` +
		`transform:translateZ(0);will-change:transform,opacity,clip-path;` +
		(extra || '');
	return el;
}

// The themed "destination" cover. We pull the brand surface colours straight
// from the live CSS custom properties so the cover matches the site's theme
// (and flips automatically under [data-theme='light']).
function destinationColor() {
	try {
		const cs = getComputedStyle(document.documentElement);
		return cs.getPropertyValue('--bg-0').trim() || '#0a0a0a';
	} catch {
		return '#0a0a0a';
	}
}
function accentColor() {
	try {
		const cs = getComputedStyle(document.documentElement);
		return cs.getPropertyValue('--accent').trim() || '#ffffff';
	} catch {
		return '#ffffff';
	}
}

// ── Presets ───────────────────────────────────────────────────────────────────
// Each: (fromEl, toEl, avatarEl) => Promise<void>. Under reduced motion they all
// route through `simpleFade`.

async function simpleFade(_fromEl, toEl) {
	toEl.style.background = destinationColor();
	toEl.style.opacity = '0';
	return done(
		toEl.animate([{ opacity: 0 }, { opacity: 1 }], {
			duration: reduced() ? 180 : FADE_DUR,
			easing: EASE_OUT,
			fill: 'forwards',
		}),
	);
}

// default → simple fade + slide (task 32's baseline flourish)
async function fadeSlide(_fromEl, toEl) {
	if (reduced()) return simpleFade(_fromEl, toEl);
	toEl.style.background = destinationColor();
	return done(
		toEl.animate(
			[
				{ opacity: 0, transform: 'translateY(14px)' },
				{ opacity: 1, transform: 'translateY(0)' },
			],
			{ duration: DUR, easing: EASE_EMPHASIZED, fill: 'forwards' },
		),
	);
}

// /walk → camera-zoom-into-avatar: the avatar grows to fill the viewport, then
// crossfades into the destination surface.
async function cameraZoomIntoAvatar(fromEl, toEl, avatarEl) {
	if (reduced() || !avatarEl) return simpleFade(fromEl, toEl);

	toEl.style.background = destinationColor();
	toEl.style.opacity = '0';

	// Compute the scale that blows the avatar host up to cover the viewport.
	let scale = 8;
	let originX = 50;
	let originY = 50;
	try {
		const r = avatarEl.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = r.top + r.height * 0.42; // head/torso, not feet
		originX = (cx / window.innerWidth) * 100;
		originY = (cy / window.innerHeight) * 100;
		scale = Math.ceil((Math.max(window.innerWidth, window.innerHeight) / Math.min(r.width, r.height)) * 1.4);
	} catch {
		/* use defaults */
	}

	const prevTransform = avatarEl.style.transform;
	const prevOrigin = avatarEl.style.transformOrigin;
	const prevZ = avatarEl.style.zIndex;
	avatarEl.style.transformOrigin = `${originX}% ${originY}%`;
	avatarEl.style.zIndex = String(Z + 1);

	const grow = avatarEl.animate(
		[
			{ transform: 'scale(1)', opacity: 1 },
			{ transform: `scale(${scale})`, opacity: 0.85, offset: 0.72 },
			{ transform: `scale(${scale})`, opacity: 0 },
		],
		{ duration: DUR + 120, easing: EASE_EMPHASIZED, fill: 'forwards' },
	);

	const reveal = toEl.animate(
		[
			{ opacity: 0, offset: 0 },
			{ opacity: 0, offset: 0.55 },
			{ opacity: 1, offset: 1 },
		],
		{ duration: DUR + 120, easing: EASE_OUT, fill: 'forwards' },
	);

	await Promise.all([done(grow), done(reveal)]);
	// Best-effort restore — the page is about to be replaced anyway.
	avatarEl.style.transform = prevTransform;
	avatarEl.style.transformOrigin = prevOrigin;
	avatarEl.style.zIndex = prevZ;
}

// /pricing → curtain-pull from the top.
async function curtainPull(fromEl, toEl) {
	if (reduced()) return simpleFade(fromEl, toEl);
	toEl.style.background = destinationColor();
	toEl.style.borderBottom = `2px solid ${accentColor()}`;
	toEl.style.opacity = '1';
	return done(
		toEl.animate(
			[
				{ transform: 'translateY(-100%)' },
				{ transform: 'translateY(0)' },
			],
			{ duration: DUR, easing: EASE_EMPHASIZED, fill: 'forwards' },
		),
	);
}

// /agent/* → spotlight expand from the click origin point.
async function spotlightExpand(fromEl, toEl, _avatarEl, origin) {
	if (reduced()) return simpleFade(fromEl, toEl);
	toEl.style.background = destinationColor();
	toEl.style.opacity = '1';
	const x = origin ? origin.x : window.innerWidth / 2;
	const y = origin ? origin.y : window.innerHeight / 2;
	const r = Math.hypot(
		Math.max(x, window.innerWidth - x),
		Math.max(y, window.innerHeight - y),
	);
	return done(
		toEl.animate(
			[
				{ clipPath: `circle(0px at ${x}px ${y}px)` },
				{ clipPath: `circle(${Math.ceil(r)}px at ${x}px ${y}px)` },
			],
			{ duration: DUR, easing: EASE_EMPHASIZED, fill: 'forwards' },
		),
	);
}

// /marketplace → corridor depth zoom: the outgoing page recedes into the
// distance while the destination rushes forward.
async function corridorDepthZoom(fromEl, toEl) {
	if (reduced()) return simpleFade(fromEl, toEl);
	toEl.style.background = destinationColor();
	toEl.style.opacity = '0';

	const recede = fromEl
		? fromEl.animate(
				[
					{ transform: 'perspective(1200px) translateZ(0) scale(1)', opacity: 1 },
					{ transform: 'perspective(1200px) translateZ(-600px) scale(0.78)', opacity: 0 },
				],
				{ duration: DUR, easing: EASE_STANDARD, fill: 'forwards' },
			)
		: null;

	const rush = toEl.animate(
		[
			{ transform: 'perspective(1200px) translateZ(420px) scale(1.25)', opacity: 0, offset: 0 },
			{ transform: 'perspective(1200px) translateZ(0) scale(1)', opacity: 1, offset: 1 },
		],
		{ duration: DUR, easing: EASE_EMPHASIZED, fill: 'forwards' },
	);

	await Promise.all([done(recede), done(rush)]);
}

// /dashboard → softer fade with a subtle glow bloom.
async function softGlowFade(fromEl, toEl) {
	if (reduced()) return simpleFade(fromEl, toEl);
	const accent = accentColor();
	toEl.style.background =
		`radial-gradient(120% 120% at 50% 30%, ${accent}14, transparent 60%), ${destinationColor()}`;
	return done(
		toEl.animate(
			[
				{ opacity: 0, filter: 'brightness(1.6) blur(6px)' },
				{ opacity: 1, filter: 'brightness(1) blur(0px)' },
			],
			{ duration: DUR + 60, easing: EASE_OUT, fill: 'forwards' },
		),
	);
}

// ── Route → preset registry ───────────────────────────────────────────────────
// First matching pattern wins; `*` is a path-segment-spanning glob. The default
// entry (pattern '*') always matches last.
export const PRESETS = [
	{ pattern: '/walk', preset: cameraZoomIntoAvatar, name: 'camera-zoom-into-avatar' },
	{ pattern: '/pricing', preset: curtainPull, name: 'curtain-pull' },
	{ pattern: '/agents/*', preset: spotlightExpand, name: 'spotlight-expand' },
	{ pattern: '/agent/*', preset: spotlightExpand, name: 'spotlight-expand' },
	{ pattern: '/marketplace', preset: corridorDepthZoom, name: 'corridor-depth-zoom' },
	{ pattern: '/dashboard', preset: softGlowFade, name: 'soft-glow-fade' },
	{ pattern: '*', preset: fadeSlide, name: 'fade-slide' },
];

// Glob match: '/agent/*' matches '/agent/abc' and '/agent/abc/x'; '/walk'
// matches '/walk' and '/walk/anything'. '*' matches everything.
function pathMatches(pattern, path) {
	if (pattern === '*') return true;
	if (pattern.endsWith('/*')) {
		const base = pattern.slice(0, -2);
		return path === base || path.startsWith(base + '/');
	}
	return path === pattern || path.startsWith(pattern + '/');
}

export function presetForPath(path) {
	const clean = (path || '/').replace(/\/+$/, '') || '/';
	for (const entry of PRESETS) {
		if (pathMatches(entry.pattern, clean)) return entry;
	}
	return PRESETS[PRESETS.length - 1];
}

// ── Runner ────────────────────────────────────────────────────────────────────
// Builds the from/to layers, runs the matched preset, then commits the
// navigation. Resolves only after the navigation is committed (or immediately if
// the destination ends up being the same path). The outgoing layer is left in
// place so the freshly-revealed cover hides the old page until the unload paints.
let _running = false;

export async function runTransition(destUrl, origin, getAvatarEl) {
	if (_running) return; // a second click during the flourish is ignored
	_running = true;

	const path = destUrl.pathname;
	const { preset } = presetForPath(path);

	// Outgoing surface: we don't clone the DOM (expensive + fragile); the live
	// page *is* the from-surface, so fromEl is a transparent layer the depth-zoom
	// preset can transform if it wants a recede effect. Presets that don't use it
	// simply ignore it.
	const fromEl = makeLayer('background:transparent;');
	const toEl = makeLayer('opacity:0;');
	document.body.appendChild(fromEl);
	document.body.appendChild(toEl);

	const avatarEl = (() => {
		try {
			return getAvatarEl?.() || null;
		} catch {
			return null;
		}
	})();

	const cleanup = () => {
		fromEl.remove();
		toEl.remove();
		_running = false;
	};

	try {
		await preset(fromEl, toEl, avatarEl, origin);
	} catch {
		// Animation failure must never strand the visitor — fall through to nav.
		cleanup();
		window.location.href = destUrl.href;
		return;
	}

	// Hold the cover in place and commit the navigation. We do NOT remove the
	// layers here: the cover should mask the current page right up until the new
	// document paints, which avoids a flash of the old page during unload.
	window.location.href = destUrl.href;

	// Safety valve: if the navigation is somehow cancelled (e.g. beforeunload
	// prompt declined), tear the cover back down so the page stays usable.
	setTimeout(() => {
		if (document.visibilityState === 'visible') cleanup();
	}, 2500);
}

// ── Link interception ─────────────────────────────────────────────────────────
// Capture-phase, registered ahead of the SDK companion's own click handler so we
// see the click first. The companion's handler still runs (it plays the wave and
// sets the greet flag from task 32) — we only *defer* the actual navigation, we
// never preventDefault its wave. We let the native link default happen too, so
// non-companion navigation paths are untouched when transitions are off.

function isEligibleLink(e) {
	if (e.defaultPrevented || e.button !== 0) return null;
	if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
	const a = e.target.closest?.('a[href]');
	if (!a) return null;
	if (a.target && a.target !== '_self') return null;
	if (a.hasAttribute('download')) return null;
	if (a.dataset?.noTransition === '1') return null;
	const href = a.getAttribute('href');
	if (!href || href.startsWith('#')) return null;
	let url;
	try {
		url = new URL(href, location.href);
	} catch {
		return null;
	}
	if (url.origin !== location.origin) return null;
	const here = location.pathname.replace(/\/+$/, '') || '/';
	const there = url.pathname.replace(/\/+$/, '') || '/';
	if (there === here) return null; // same page — nothing to transition to
	return url;
}

let _clickHandler = null;
let _getAvatarEl = null;
let _onNavStart = null;

function onClickCapture(e) {
	if (!transitionsEnabled()) return; // honour the toggle; native nav proceeds
	// Note: reduced-motion is NOT a reason to skip — the preset itself degrades to
	// a plain fade, which is still smoother than a hard cut.
	const url = isEligibleLink(e);
	if (!url) return;
	// Take ownership of the navigation so we can play the themed cover first.
	// Because we run in the capture phase *and* preventDefault, the SDK
	// companion's own _onLinkClick (task 32: wave + greet flag) would otherwise
	// bail on `e.defaultPrevented`. So we drive that behaviour explicitly via the
	// onNavStart hook — exactly once, no double-trigger.
	e.preventDefault();
	try {
		_onNavStart?.(url);
	} catch {
		/* greeting is a nicety — never let it block navigation */
	}
	runTransition(url, { x: e.clientX, y: e.clientY }, _getAvatarEl);
}

// ── Settings toggle (injected into the companion's own control cluster) ────────
// The companion host carries a close (×) and swap (⇄) button in its top-right.
// We add a matching pill that flips "Themed transitions" and persists it.
function injectSettingsToggle(hostEl) {
	if (!hostEl || hostEl.querySelector('.walk-companion-fx-toggle')) return;
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'walk-companion-swap walk-companion-fx-toggle';
	btn.setAttribute('aria-label', 'Toggle themed page transitions');
	btn.setAttribute('aria-pressed', transitionsEnabled() ? 'true' : 'false');
	btn.title = transitionsEnabled() ? 'Themed transitions: on' : 'Themed transitions: off';
	btn.textContent = '✦';

	// Position it to the left of the existing swap/close buttons. The host already
	// styles `.walk-companion-swap` at right:28px; a stylesheet (not an inline
	// style) nudges this one further left so the three controls sit in a neat
	// row, because the coarse-pointer rule below has to move it again once the
	// buttons grow a transparent border to reach a 44px hit area.
	injectToggleStyle();
	syncToggleVisual(btn);

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		const next = !transitionsEnabled();
		setTransitionsEnabled(next);
		syncToggleVisual(btn);
	});
	hostEl.appendChild(btn);
}

const TOGGLE_STYLE_ID = 'walk-companion-fx-toggle-style';
function injectToggleStyle() {
	if (document.getElementById(TOGGLE_STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = TOGGLE_STYLE_ID;
	s.textContent =
		'.walk-companion-swap.walk-companion-fx-toggle{right:54px}' +
		'@media (pointer:coarse){.walk-companion-swap.walk-companion-fx-toggle{right:53px}}';
	document.head.appendChild(s);
}

function syncToggleVisual(btn) {
	const on = transitionsEnabled();
	btn.setAttribute('aria-pressed', on ? 'true' : 'false');
	btn.title = on ? 'Themed transitions: on' : 'Themed transitions: off';
	btn.style.opacity = ''; // let the host's hover/focus rules own visibility
	btn.style.color = on ? '#fff' : 'rgba(255,255,255,.5)';
	// Longhand on purpose: the `background` shorthand resets background-clip,
	// which the coarse-pointer rule relies on to keep the glyph disc at 26px
	// inside the 44px tap box.
	btn.style.backgroundColor = on ? 'rgba(122,162,255,.35)' : 'rgba(12,14,20,.55)';
}

// ── Public install / uninstall ────────────────────────────────────────────────
/**
 * Wire themed page transitions to the companion.
 * @param {object} opts
 * @param {() => (HTMLElement|null)} opts.getAvatarEl  returns the companion host
 *        element used by the camera-zoom-into-avatar preset.
 * @param {() => (HTMLElement|null)} [opts.getHostEl]  returns the companion host
 *        for injecting the settings toggle (defaults to getAvatarEl).
 * @param {(destUrl: URL) => void} [opts.onNavStart]  called once when a themed
 *        navigation begins, so the caller can reproduce the task-32 wave + greet
 *        flag the SDK's own link handler would have run.
 * @returns {() => void} uninstall function.
 */
export function installTransitions({ getAvatarEl, getHostEl, onNavStart } = {}) {
	if (typeof document === 'undefined') return () => {};
	_getAvatarEl = typeof getAvatarEl === 'function' ? getAvatarEl : () => null;
	_onNavStart = typeof onNavStart === 'function' ? onNavStart : null;

	// Idempotent: a re-mount (playground return) shouldn't double-bind.
	if (!_clickHandler) {
		_clickHandler = onClickCapture;
		// Capture phase so we run before the SDK companion's bubble/capture click
		// listeners and before the link's default navigation.
		document.addEventListener('click', _clickHandler, { capture: true });
	}

	// The host may not exist yet on the very first tick after mount; poll briefly.
	const hostGetter = typeof getHostEl === 'function' ? getHostEl : _getAvatarEl;
	let tries = 0;
	const tryInject = () => {
		const host = (() => {
			try {
				return hostGetter();
			} catch {
				return null;
			}
		})();
		if (host) {
			injectSettingsToggle(host);
			return;
		}
		if (tries++ < 30) requestAnimationFrame(tryInject);
	};
	tryInject();

	return function uninstall() {
		if (_clickHandler) {
			document.removeEventListener('click', _clickHandler, { capture: true });
			_clickHandler = null;
		}
	};
}
