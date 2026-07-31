// three.ws tooltips: one accessible primitive, driven by a `data-tip` attribute.
//
// Every surface that wanted a hint had been reaching for the native `title`
// attribute, which no touch device shows, screen readers announce
// inconsistently, and no stylesheet can reach. This replaces it with one
// delegated implementation:
//
//     <button data-tip="Cycle the camera">C</button>
//     import { initTooltips } from '/src/shared/tooltip.js';
//     initTooltips();
//
// Delegation (not per-element listeners) is deliberate: elements added after
// init, re-rendered lists, and anything inside a dialog all get tooltips with
// no re-scan and no MutationObserver.
//
// Behaviour:
//   - Pointer hover opens after a short delay, closes immediately on leave.
//   - Keyboard focus opens with no delay: a keyboard user has already committed.
//   - Touch long-press opens; the next tap anywhere closes.
//   - Escape closes; scrolling or resizing closes rather than leaving a
//     tooltip stranded away from its anchor.
//   - The bubble flips above/below and clamps horizontally so it is never
//     partly off-screen.
//   - `prefers-reduced-motion` drops the fade.
//
// Accessibility: the bubble carries role="tooltip" and the anchor gets
// aria-describedby while it is open, so the text is announced as a description
// of the control rather than as a separate stray node.

const BUBBLE_ID = 'tw-tooltip';
const STYLE_ID = 'tw-tooltip-css';
const OPEN_DELAY = 380;
const TOUCH_DELAY = 420;
const EDGE = 10;
const GAP = 9;

let bubble = null;
let anchor = null;
let openTimer = 0;
let touchTimer = 0;
let installed = false;

function injectStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
#${BUBBLE_ID} {
	position: fixed;
	z-index: 2147483000;
	max-width: min(280px, calc(100vw - 24px));
	padding: 7px 10px;
	border-radius: 8px;
	background: var(--tw-tip-bg, #16161f);
	color: var(--tw-tip-ink, #f2f0ff);
	border: 1px solid var(--tw-tip-border, rgba(255, 255, 255, 0.14));
	box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
	font: 500 12.5px/1.45 Inter, system-ui, -apple-system, sans-serif;
	letter-spacing: 0.005em;
	pointer-events: none;
	opacity: 0;
	transform: translateY(3px);
	transition: opacity .13s ease, transform .13s ease;
	white-space: normal;
	overflow-wrap: anywhere;
}
#${BUBBLE_ID}[data-open="1"] { opacity: 1; transform: none; }
#${BUBBLE_ID} kbd {
	font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
	padding: 2px 5px;
	margin: 0 1px;
	border-radius: 4px;
	background: rgba(255, 255, 255, 0.1);
	border: 1px solid rgba(255, 255, 255, 0.16);
}
:root[data-theme="light"] #${BUBBLE_ID} {
	--tw-tip-bg: #1c1c24;
	--tw-tip-ink: #f7f6ff;
}
@media (prefers-reduced-motion: reduce) {
	#${BUBBLE_ID} { transition: none; transform: none; }
}
`;
	document.head.appendChild(style);
}

function ensureBubble() {
	if (bubble && bubble.isConnected) return bubble;
	injectStyles();
	bubble = document.createElement('div');
	bubble.id = BUBBLE_ID;
	bubble.setAttribute('role', 'tooltip');
	document.body.appendChild(bubble);
	return bubble;
}

/** Nearest ancestor (inclusive) carrying a non-empty data-tip. */
function tipTarget(node) {
	let el = node instanceof Element ? node : null;
	while (el) {
		if (el.dataset && el.dataset.tip) return el;
		el = el.parentElement;
	}
	return null;
}

function place(el) {
	const b = ensureBubble();
	const r = el.getBoundingClientRect();
	const bw = b.offsetWidth;
	const bh = b.offsetHeight;
	const vw = window.innerWidth;
	const vh = window.innerHeight;

	// Prefer below when the anchor sits in the top third (a header chip's tooltip
	// belongs under it, not clipped off the top of the viewport), above otherwise.
	const wantsBelow = r.top < vh * 0.34;
	const fitsBelow = r.bottom + GAP + bh <= vh - EDGE;
	const fitsAbove = r.top - GAP - bh >= EDGE;
	const below = wantsBelow ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;

	const top = below ? r.bottom + GAP : r.top - GAP - bh;
	const left = r.left + r.width / 2 - bw / 2;

	b.style.top = Math.max(EDGE, Math.min(top, vh - bh - EDGE)) + 'px';
	b.style.left = Math.max(EDGE, Math.min(left, vw - bw - EDGE)) + 'px';
}

/**
 * Show the tooltip for `el` immediately.
 * @param {Element} el an element carrying data-tip
 */
export function showTooltip(el) {
	const text = el?.dataset?.tip;
	if (!text) return;
	const b = ensureBubble();
	hideTooltip();

	// <kbd> is the one tag worth honouring here (key hints are most of what
	// tooltips say on this platform); everything else is escaped as text.
	b.innerHTML = escapeHtml(text).replace(/\[\[(.+?)\]\]/g, '<kbd>$1</kbd>');

	// The anchor keeps its own id if it has one, so we never rewrite page state.
	b.dataset.open = '1';
	anchor = el;
	el.setAttribute('aria-describedby', BUBBLE_ID);
	// Measure after content is in, before positioning.
	place(el);
}

/** Hide the tooltip and release the anchor. */
export function hideTooltip() {
	clearTimeout(openTimer);
	clearTimeout(touchTimer);
	if (anchor) {
		anchor.removeAttribute('aria-describedby');
		anchor = null;
	}
	if (bubble) bubble.dataset.open = '0';
}

function scheduleShow(el, delay) {
	clearTimeout(openTimer);
	openTimer = setTimeout(() => showTooltip(el), delay);
}

/**
 * Give `el` a tooltip. Equivalent to setting data-tip in markup; use this for
 * elements built in JS. Wrap a key name in [[…]] to render it as a <kbd>.
 *
 * @param {Element} el
 * @param {string} text
 */
export function attachTooltip(el, text) {
	if (!el) return;
	if (text) el.dataset.tip = text;
	else delete el.dataset.tip;
	// A native title would double up with the bubble on desktop, showing both.
	if (el.hasAttribute('title')) el.removeAttribute('title');
}

/**
 * Install the delegated listeners. Safe to call more than once; only the first
 * call does anything, so every module on a page can call it defensively.
 */
export function initTooltips() {
	if (installed) return;
	installed = true;
	injectStyles();

	document.addEventListener(
		'pointerover',
		(e) => {
			if (e.pointerType === 'touch') return; // touch is handled by long-press
			const el = tipTarget(e.target);
			if (!el || el === anchor) return;
			hideTooltip();
			scheduleShow(el, OPEN_DELAY);
		},
		true,
	);

	document.addEventListener(
		'pointerout',
		(e) => {
			const el = tipTarget(e.target);
			if (!el) return;
			// Moving within the same anchor (over a child) is not a leave.
			if (tipTarget(e.relatedTarget) === el) return;
			hideTooltip();
		},
		true,
	);

	document.addEventListener(
		'focusin',
		(e) => {
			const el = tipTarget(e.target);
			if (!el) return;
			hideTooltip();
			showTooltip(el);
		},
		true,
	);

	document.addEventListener('focusout', hideTooltip, true);

	document.addEventListener(
		'pointerdown',
		(e) => {
			if (e.pointerType !== 'touch') {
				// A click means the user acted; the hint has served its purpose.
				hideTooltip();
				return;
			}
			const el = tipTarget(e.target);
			hideTooltip();
			if (el) {
				touchTimer = setTimeout(() => showTooltip(el), TOUCH_DELAY);
			}
		},
		true,
	);

	document.addEventListener('pointerup', () => clearTimeout(touchTimer), true);
	document.addEventListener('pointercancel', hideTooltip, true);

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') hideTooltip();
	});

	// A tooltip is positioned against a rect that scrolling or resizing
	// invalidates; reposition rather than leaving it floating in the wrong place.
	addEventListener(
		'scroll',
		() => {
			if (anchor) place(anchor);
		},
		{ passive: true, capture: true },
	);
	addEventListener(
		'resize',
		() => {
			if (anchor) place(anchor);
		},
		{ passive: true },
	);
	// A tab switch leaves a tooltip pinned over the page on return.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) hideTooltip();
	});
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
