/* three.ws corner-stack — one shared home for persistent bottom-right widgets.
 *
 * The platform grew a handful of independent floating cards — the "Getting
 * started" pill, the feature-discovery prompt, the "Your agent is ready"
 * onboarding banner — and each one hard-coded its own `position: fixed;
 * right; bottom` plus a magic z-index. With no awareness of one another they
 * piled onto the same pixel and covered page content (e.g. the Deploy page's
 * Live Preview). The +80px nudge on the onboarding card was an ad-hoc patch
 * for exactly that collision.
 *
 * This module replaces those one-off hacks with a single container that flows
 * its members vertically — newest/most-important nearest the corner — so they
 * never overlap each other or the underlying page. It is framework-free,
 * idempotent, dependency-free, and order-independent: a widget that mounts
 * before this script runs tags itself with `data-corner-priority` and appends
 * to <body>; this module adopts those orphans on init.
 *
 * Priority: HIGHER number = closer to the corner (bottom). Members are ordered
 * ascending top→bottom, so the highest-priority member is the bottom-most.
 *
 * Reservations solve the other half of the problem. Some corner widgets cannot
 * join the flex flow: the Walk Companion is a fixed-size WebGL canvas that the
 * visitor clicks to detach into Playground mode, so it owns the literal corner
 * and lives at a higher z-index. Before reservations it simply sat on top of
 * the stack's cards. A reservation lets such a widget declare "I occupy this
 * many pixels of corner height", and the stack lifts itself clear of it. Keys
 * are independent and the tallest wins, so two reservations never fight.
 *
 * API (window.twsCornerStack):
 *   mount(el, { priority })  — move `el` into the stack (sets priority if given)
 *   unmount(el)              — remove `el` from the stack
 *   ensure()                 — create/return the container element
 *   reserve(key, px)         — keep `px` of corner height clear for `key`
 *   release(key)             — drop that reservation
 *   reserved()               — current reserved height in px
 */
(function () {
	'use strict';
	if (window.twsCornerStack) return;

	var STACK_ID = 'tws-corner-stack';
	var STYLE_ID = 'tws-corner-stack-css';
	var ITEM_CLASS = 'tws-corner-item';
	var DEFAULT_PRIORITY = 50;
	var stack = null;

	var CSS = [
		/* Global stacking ladder — promotes the old comment-only convention to
		   real, referenceable tokens. Wide gaps leave room for future layers. */
		':root{',
		'--z-corner-feed:2147482000;',
		'--z-corner-stack:2147482500;',
		'--z-walk-companion:2147483000;',
		'--z-overlay-modal:2147483600;',
		'}',
		'#' + STACK_ID + '{',
		'position:fixed;right:18px;bottom:calc(18px + var(--tws-corner-reserve,0px));',
		'z-index:var(--z-corner-stack,2147482500);',
		'display:flex;flex-direction:column;align-items:flex-end;',
		'gap:12px;max-width:min(380px,calc(100vw - 24px));',
		'max-height:calc(100dvh - 36px - var(--tws-corner-reserve,0px));overflow:visible;',
		/* Clicks fall through the gaps; members re-enable pointer events. */
		'pointer-events:none;',
		'transition:bottom .35s cubic-bezier(.22,1,.36,1);',
		'}',
		'@media (prefers-reduced-motion:reduce){#' + STACK_ID + '{transition:none;}}',
		'#' + STACK_ID + ':empty{display:none;}',
		/* relative (not static) keeps members in the flex flow while preserving a
		   containing block for their position:absolute children (e.g. the
		   getting-started panel, card close buttons). */
		'#' + STACK_ID + '>.' + ITEM_CLASS + '{',
		'position:relative;inset:auto;margin:0;pointer-events:auto;',
		'}',
		'@media (max-width:640px){',
		'#' +
			STACK_ID +
			'{right:12px;bottom:calc(12px + var(--tws-corner-reserve,0px));left:12px;align-items:stretch;gap:10px;max-width:none;}',
		'}'
	].join('');

	function ensureCss() {
		if (document.getElementById(STYLE_ID)) return;
		var style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = CSS;
		(document.head || document.documentElement).appendChild(style);
	}

	function ensureStack() {
		ensureCss();
		if (stack && document.body && document.body.contains(stack)) return stack;
		var existing = document.getElementById(STACK_ID);
		if (existing) { stack = existing; return stack; }
		stack = document.createElement('div');
		stack.id = STACK_ID;
		stack.setAttribute('role', 'region');
		stack.setAttribute('aria-label', 'Helper widgets');
		(document.body || document.documentElement).appendChild(stack);
		return stack;
	}

	function priorityOf(el) {
		var p = Number(el.getAttribute('data-corner-priority'));
		return Number.isFinite(p) ? p : DEFAULT_PRIORITY;
	}

	function place(el) {
		var s = ensureStack();
		el.classList.add(ITEM_CLASS);
		var p = priorityOf(el);
		var siblings = Array.prototype.slice.call(s.children);
		var before = null;
		for (var i = 0; i < siblings.length; i++) {
			if (siblings[i] === el) continue;
			if (priorityOf(siblings[i]) > p) { before = siblings[i]; break; }
		}
		s.insertBefore(el, before);
		return el;
	}

	function mount(el, opts) {
		if (!el) return el;
		if (opts && opts.priority != null) {
			el.setAttribute('data-corner-priority', String(opts.priority));
		}
		return place(el);
	}

	function unmount(el) {
		if (el && stack && el.parentNode === stack) stack.removeChild(el);
	}

	/* ── Reservations ────────────────────────────────────────────────────────
	   Corner height claimed by widgets that cannot join the flex flow. Written
	   to a custom property on <html> rather than on the stack element, so a
	   reservation made before the stack exists still applies the moment it
	   does — order independence is the whole point of this module. */
	var reservations = Object.create(null);

	function applyReserve() {
		var max = 0;
		for (var key in reservations) {
			if (reservations[key] > max) max = reservations[key];
		}
		var root = document.documentElement;
		if (max > 0) root.style.setProperty('--tws-corner-reserve', max + 'px');
		else root.style.removeProperty('--tws-corner-reserve');
		return max;
	}

	function reserve(key, px) {
		if (!key) return reservedHeight();
		var n = Number(px);
		/* Guard against a mid-transition measurement of 0 (the companion mounts
		   at opacity 0 and animates in) collapsing the stack back onto it. */
		if (!Number.isFinite(n) || n <= 0) return release(key);
		reservations[key] = Math.round(n);
		return applyReserve();
	}

	function release(key) {
		delete reservations[key];
		return applyReserve();
	}

	function reservedHeight() {
		return applyReserve();
	}

	/* Adopt widgets that mounted to <body> before this script executed. */
	function adoptOrphans() {
		if (!document.body) return;
		var orphans = document.body.querySelectorAll(':scope > [data-corner-priority]');
		for (var i = 0; i < orphans.length; i++) place(orphans[i]);
	}

	window.twsCornerStack = {
		mount: mount,
		unmount: unmount,
		ensure: ensureStack,
		reserve: reserve,
		release: release,
		reserved: reservedHeight
	};

	if (document.body) adoptOrphans();
	else document.addEventListener('DOMContentLoaded', adoptOrphans);

	/* Announce ourselves so a widget that mounted first can (re)claim its
	   reservation. Orphan adoption already covers stack MEMBERS; this covers
	   non-members like the Walk Companion, whose module is loaded separately
	   and could otherwise win the race and find no stack to reserve against. */
	try {
		window.dispatchEvent(new CustomEvent('tws-corner-stack:ready'));
	} catch (e) {
		/* CustomEvent unavailable: reservations still work for later mounts. */
	}
})();
