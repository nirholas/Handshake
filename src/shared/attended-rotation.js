// Spin a <model-viewer> while someone is actually looking at it.
//
// `auto-rotate` runs forever. model-viewer draws every element through one
// shared WebGL canvas and blits the result into the element's own canvas each
// frame (its `copyPixels`), so a decorative preview that never stops rotating
// keeps the main thread busy for as long as the tab is open: 2.4 s of scripting
// per 35 s on /create, from a single card in the hero, and the page never
// quiets down enough to read as interactive.
//
// A preview only has to move while it is being looked at. This keeps the spin
// where it earns its place (the element is on screen, the tab is in front) and
// retires it once it has turned far enough to read as 3D, then brings it back
// on hover, focus, or the next time the element scrolls into view. Nothing is
// removed from the page and no interaction changes.
//
// Two entry points: `attendRotation` takes one viewer element, and
// `attendRotationIn` takes a root and claims every `[data-attended-rotate]`
// viewer under it (safe to call again after new cards render). A viewer
// authored with `data-src` + `poster` instead of `src` also has its model
// loaded on first attention, so an untouched card costs a poster and nothing
// else.
//
// Only elements authored with `auto-rotate` are touched, so marking a viewer is
// opt-in and reversible.
//
// A `data-src` viewer also defers the <model-viewer> ELEMENT BUNDLE, not just
// its model: a page whose only viewer is a decorative card has no reason to
// build a WebGL renderer during load. First attention asks
// model-viewer-loader.js for the element and sets `src` in the same breath, so
// the bundle and the GLB arrive together and the card upgrades once. The loader
// is shared and idempotent, so on a page that already loaded the element this
// resolves without a request.

import { ensureModelViewerOrFallback } from './model-viewer-loader.js';

// Long enough to read as a deliberate turn (a 20deg/s viewer sweeps ~240
// degrees), short enough that an unattended tab stops working.
const DEFAULT_SETTLE_MS = 12_000;
// Rotation resumes a little before the element scrolls back in, so the first
// frame a visitor sees is already moving.
const ROOT_MARGIN = '100px 0px';

function prefersReducedMotion() {
	try {
		return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
	} catch {
		return false;
	}
}

/**
 * Manage one <model-viewer>'s `auto-rotate` so it only spins while attended.
 * @param {Element|null} el a <model-viewer> authored with `auto-rotate`
 * @param {{ settleMs?: number, attention?: Element|null }} [opts]
 *   `settleMs` is how long an unattended spin runs. `attention` is the element
 *   whose hover and focus count as attention, for a viewer that sits inside a
 *   larger card: a visitor aims at the card, not at the canvas, and a viewer
 *   with no camera controls cannot take keyboard focus itself.
 * @returns {() => void} detaches every listener and leaves rotation on
 */
export function attendRotation(el, { settleMs = DEFAULT_SETTLE_MS, attention = null } = {}) {
	const noop = () => {};
	if (!el || typeof el.hasAttribute !== 'function' || !el.hasAttribute('auto-rotate')) return noop;
	if (el.dataset.attendedRotateBound === '1') return noop;
	el.dataset.attendedRotateBound = '1';

	// A viewer can also defer its model until someone engages with it: author it
	// with `data-src` instead of `src` and give it a poster. Decoding a GLB is
	// one long, unbreakable main-thread task (852 ms for /create's 748 KB base
	// avatar), so a card that may never be looked at should not spend it during
	// page load. The poster shows the finished frame either way.
	const promoteSource = () => {
		if (!el.dataset.src || el.getAttribute('src')) return;
		el.setAttribute('src', el.dataset.src);
		delete el.dataset.src;
		// The attribute is read when the element upgrades, so ordering is free:
		// whether the bundle is already here or still in flight, this viewer ends
		// up loading exactly the model it was authored with. On failure the loader
		// swaps in the poster, which is the frame this card was showing anyway.
		ensureModelViewerOrFallback(el.parentNode || document);
	};

	// Reduced motion: never spin. The model still renders, poses, and answers
	// camera controls; it just does not move on its own. That promise was only
	// half true for a `data-src` viewer: nothing ever promoted its source, so a
	// visitor who asks for reduced motion got a poster and no model, for good.
	// Load it here instead: a still model is the whole point of the setting.
	if (prefersReducedMotion()) {
		el.removeAttribute('auto-rotate');
		promoteSource();
		return noop;
	}

	let onScreen = typeof IntersectionObserver === 'undefined';
	let attended = false;
	let settled = false;
	let timer = 0;
	let rotating = true;

	const apply = () => {
		const want = onScreen && document.visibilityState !== 'hidden' && (attended || !settled);
		if (want === rotating) return;
		rotating = want;
		if (want) el.setAttribute('auto-rotate', '');
		else el.removeAttribute('auto-rotate');
	};
	// The settle timer starts when a turn starts, so an element that spends its
	// first ten seconds off screen still gets its full turn on arrival.
	const arm = () => {
		clearTimeout(timer);
		settled = false;
		if (settleMs > 0) timer = setTimeout(() => { settled = true; apply(); }, settleMs);
		apply();
	};
	const attend = () => { attended = true; promoteSource(); arm(); };
	const release = (e) => {
		if (e?.relatedTarget && (attention || el).contains(e.relatedTarget)) return;
		attended = false;
		apply();
	};

	const host = attention || el;
	host.addEventListener('pointerenter', attend);
	host.addEventListener('pointerleave', release);
	host.addEventListener('focusin', attend);
	host.addEventListener('focusout', release);
	document.addEventListener('visibilitychange', apply);

	let io = null;
	if (typeof IntersectionObserver !== 'undefined') {
		io = new IntersectionObserver((entries) => {
			const next = entries.some((entry) => entry.isIntersecting);
			if (next === onScreen) return;
			onScreen = next;
			// Arriving on screen is what starts a turn; leaving just stops it.
			if (next) arm();
			else apply();
		}, { rootMargin: ROOT_MARGIN });
		io.observe(el);
	} else {
		arm();
	}

	return () => {
		clearTimeout(timer);
		io?.disconnect();
		host.removeEventListener('pointerenter', attend);
		host.removeEventListener('pointerleave', release);
		host.removeEventListener('focusin', attend);
		host.removeEventListener('focusout', release);
		document.removeEventListener('visibilitychange', apply);
		delete el.dataset.attendedRotateBound;
		el.setAttribute('auto-rotate', '');
	};
}

/**
 * Apply attended rotation to every `[data-attended-rotate]` viewer under `root`.
 * Safe to call again after new cards render: bound elements are skipped.
 * @param {ParentNode} [root]
 * @param {{ settleMs?: number }} [opts]
 */
export function attendRotationIn(root = document, opts) {
	if (!root || typeof root.querySelectorAll !== 'function') return;
	for (const el of root.querySelectorAll('model-viewer[data-attended-rotate]')) {
		// `data-attended-rotate="<selector>"` names the card that owns the
		// viewer, so hovering or tabbing to the card is what wakes it.
		const sel = el.getAttribute('data-attended-rotate');
		const attention = sel ? el.closest(sel) : null;
		attendRotation(el, { ...opts, attention });
	}
}
