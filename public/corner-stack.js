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
 * Lifting is the right answer on a wide viewport and the wrong one on a phone:
 * the stack goes full-width below 640px, so a 220px companion pushed a couple
 * of small chips into the middle of the screen, on top of the page's content
 * (seen on /create). When a reservation also declares a WIDTH and the narrow
 * layout leaves a usable column beside it, the stack steps sideways instead
 * and stays pinned to the bottom, where a helper widget belongs.
 *
 * API (window.twsCornerStack):
 *   mount(el, { priority })  — move `el` into the stack (sets priority if given)
 *   unmount(el)              — remove `el` from the stack
 *   ensure()                 — create/return the container element
 *   reserve(key, px)         - keep `px` of corner height clear for `key`;
 *                              pass { height, width } to declare both
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
		'position:fixed;right:calc(18px + var(--tws-corner-reserve-w,0px));',
		'bottom:calc(18px + var(--tws-corner-reserve,0px) + var(--tws-corner-dock,0px));',
		'z-index:var(--z-corner-stack,2147482500);',
		'display:flex;flex-direction:column;align-items:flex-end;',
		'gap:12px;max-width:min(380px,calc(100vw - 24px));',
		'max-height:calc(100dvh - 36px - var(--tws-corner-reserve,0px) - var(--tws-corner-dock,0px));overflow:visible;',
		/* Clicks fall through the gaps; members re-enable pointer events. */
		'pointer-events:none;',
		'transition:bottom .35s cubic-bezier(.22,1,.36,1),right .35s cubic-bezier(.22,1,.36,1);',
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
		/* Phone layout: the stack still spans the width so a wide card can grow
		   leftward, but members size to their content and hug the right edge.
		   Stretching every member edge-to-edge turned a 44px language control
		   into a full-width bar laid over the page's own bottom controls. */
		'#' +
			STACK_ID +
			'{right:calc(12px + var(--tws-corner-reserve-w,0px));bottom:calc(12px + var(--tws-corner-reserve,0px) + var(--tws-corner-dock,0px));left:12px;align-items:flex-end;gap:10px;max-width:none;}',
		'#' + STACK_ID + '>.' + ITEM_CLASS + '{max-width:100%;}',
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
		scheduleDocks();
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
		scheduleDocks();
	}

	/* ── Reservations ────────────────────────────────────────────────────────
	   Corner height claimed by widgets that cannot join the flex flow. Written
	   to a custom property on <html> rather than on the stack element, so a
	   reservation made before the stack exists still applies the moment it
	   does — order independence is the whole point of this module. */
	var reservations = Object.create(null);

	/* Narrow layout only: below this viewport width the stack stretches
	   edge-to-edge, so lifting it over a corner widget parks it mid-screen. */
	var SIDE_BY_SIDE_MAX_VW = 640;
	/* A column narrower than this is not worth stepping aside for: the chips
	   would wrap into taller blocks than the lift they replaced. */
	var SIDE_BY_SIDE_MIN_COL = 160;
	var NARROW_GUTTERS = 24; /* the 12px inset on each side of the narrow rule */
	/* Never park the stack past mid-screen, whether the offset came from a
	   declared reservation, a measured page dock, or both together. */
	var DOCK_MAX_RATIO = 0.45;

	function applyReserve() {
		var maxH = 0;
		var maxW = 0;
		for (var key in reservations) {
			var r = reservations[key];
			if (r.height > maxH) maxH = r.height;
			if (r.width > maxW) maxW = r.width;
		}
		var vw = typeof window !== 'undefined' ? window.innerWidth || 0 : 0;
		var beside =
			maxW > 0 &&
			vw > 0 &&
			vw <= SIDE_BY_SIDE_MAX_VW &&
			vw - NARROW_GUTTERS - maxW >= SIDE_BY_SIDE_MIN_COL;
		/* A claim taller than half the screen (a landscape phone, a short
		   window) would strand the stack above the fold. Overlapping the
		   bottom of the claiming widget is the lesser evil: the widget knows
		   it owns the corner, the page's own controls do not. */
		var vh = typeof window !== 'undefined' ? window.innerHeight || 0 : 0;
		var liftCap = vh > 0 ? Math.round(vh * DOCK_MAX_RATIO) : Infinity;
		var lift = beside ? 0 : Math.min(maxH, liftCap);
		var inset = beside ? maxW : 0;
		var root = document.documentElement;
		if (lift > 0) root.style.setProperty('--tws-corner-reserve', lift + 'px');
		else root.style.removeProperty('--tws-corner-reserve');
		if (inset > 0) root.style.setProperty('--tws-corner-reserve-w', inset + 'px');
		else root.style.removeProperty('--tws-corner-reserve-w');
		/* The claim itself, whichever way the stack chose to dodge it. A member
		   that opens a panel too wide to fit the side-by-side column (the
		   Getting started checklist) reads this instead and lifts over the
		   claim rather than squeezing beside it. */
		if (maxH > 0) root.style.setProperty('--tws-corner-claim', maxH + 'px');
		else root.style.removeProperty('--tws-corner-claim');
		return maxH;
	}

	/* Elements whose claim is already declared, keyed the same way as the
	   reservation that owns them. A declared widget must never ALSO be counted
	   by the dock probe below: the Walk Companion is a bottom-anchored fixed
	   box, so it matched both paths and the stack was lifted twice, landing
	   mid-screen. On a 320px /forge that put the language control and the
	   Getting started pill exactly over the "From photos" and "From a sketch"
	   tabs, making two of the three input modes unclickable on a phone. */
	var reservedEls = Object.create(null);

	function markReserved(key, el) {
		var prev = reservedEls[key];
		if (prev && prev !== el && prev.removeAttribute) prev.removeAttribute('data-corner-ignore');
		if (el && el.setAttribute) {
			el.setAttribute('data-corner-ignore', '');
			reservedEls[key] = el;
		} else {
			delete reservedEls[key];
		}
	}

	function unmarkReserved(key) {
		var el = reservedEls[key];
		if (el && el.removeAttribute) el.removeAttribute('data-corner-ignore');
		delete reservedEls[key];
	}

	/* px: a height in pixels, or { height, width, el } for a widget that can
	   also be stepped around horizontally. `el` is the widget itself, so the
	   dock probe can skip a claim that is already declared. */
	function reserve(key, px) {
		if (!key) return reservedHeight();
		var spec = px && typeof px === 'object' ? px : { height: px };
		var h = Number(spec.height);
		var w = Number(spec.width);
		/* Guard against a mid-transition measurement of 0 (the companion mounts
		   at opacity 0 and animates in) collapsing the stack back onto it. */
		if (!Number.isFinite(h) || h <= 0) return release(key);
		reservations[key] = {
			height: Math.round(h),
			width: Number.isFinite(w) && w > 0 ? Math.round(w) : 0
		};
		markReserved(key, spec.el || null);
		return applyReserve();
	}

	function release(key) {
		delete reservations[key];
		unmarkReserved(key);
		return applyReserve();
	}

	function reservedHeight() {
		return applyReserve();
	}

	/* ── Page docks (measured, not declared) ─────────────────────────────────
	   Reservations cover widgets that know about this module. They do nothing
	   for the chrome a PAGE owns: the /app chat composer, a viewer's action
	   bar, an editor's toolbar. Those are plain `position: fixed` boxes pinned
	   to the bottom edge, and the stack used to sit right on top of them. On a
	   phone the language control landed inside the "Ask the agent…" field and
	   the Getting started pill covered the save button.

	   Rather than ask every such page to opt in (which is the wiring this
	   module exists to avoid), measure it: probe the bottom band of the
	   viewport with elementsFromPoint, keep the hits that resolve to a
	   bottom-anchored fixed/sticky box which is not part of the stack, and lift
	   the stack above the tallest one. elementsFromPoint costs a few
	   microseconds and needs no tree walk, so this stays cheap enough to re-run
	   on every resize and DOM change. */
	var DOCK_VAR = '--tws-corner-dock';
	var DOCK_GAP = 10; /* breathing room between the dock and the stack */
	var dockLift = 0;

	/* The fixed/sticky box `el` belongs to, or null when it is ordinary
	   in-flow content that merely happens to sit at the bottom of the page. */
	function fixedRootOf(el) {
		for (var node = el; node && node !== document.body; node = node.parentElement) {
			if (node.nodeType !== 1) continue;
			var pos = getComputedStyle(node).position;
			if (pos === 'fixed' || pos === 'sticky') return node;
		}
		return null;
	}

	function isStackPart(el) {
		return !!(stack && (el === stack || stack.contains(el)));
	}

	/* Tallest dock intersecting the band that starts `from` pixels above the
	   viewport bottom, expressed as the clearance the stack would need. */
	function probeBand(from, left, right, vw, vh) {
		var xs = [left + 4, (left + right) / 2, right - 4];
		var ys = [vh - from - 4, vh - from - 24, vh - from - 48];
		var need = from;
		for (var yi = 0; yi < ys.length; yi++) {
			var y = ys[yi];
			if (y < vh * 0.4) continue;
			for (var xi = 0; xi < xs.length; xi++) {
				var x = Math.max(1, Math.min(vw - 1, xs[xi]));
				var hits = document.elementsFromPoint(x, y) || [];
				for (var hi = 0; hi < hits.length; hi++) {
					var hit = hits[hi];
					if (isStackPart(hit)) continue;
					var root = fixedRootOf(hit);
					if (!root || isStackPart(root)) break; /* plain page content under here */
					if (root.hasAttribute('data-corner-ignore')) break;
					var r = root.getBoundingClientRect();
					/* Anchored to the band we are probing, not a full-viewport
					   scrim, and actually in the stack's column. */
					if (r.bottom < vh - from - 56) break;
					if (r.height > vh * 0.5 || r.height < 8) break;
					if (r.right <= left || r.left >= right) break;
					var lift = vh - r.top + DOCK_GAP;
					if (lift > need) need = lift;
					break; /* the topmost dock at this point is the one that matters */
				}
			}
		}
		return need;
	}

	function measureDocks() {
		if (!document.body || !stack || !stack.children.length) return 0;
		if (typeof document.elementsFromPoint !== 'function') return 0;
		var vw = window.innerWidth || document.documentElement.clientWidth || 0;
		var vh = window.innerHeight || document.documentElement.clientHeight || 0;
		if (!vw || !vh) return 0;
		var band = stack.getBoundingClientRect();
		/* An empty/collapsed stack gives no band to compare against: fall back
		   to the corner it is anchored to. */
		var left = band.width > 0 ? band.left : vw * 0.6;
		var right = band.width > 0 ? band.right : vw;
		/* The cap belongs to the TOTAL offset, not to the measured half of it.
		   A reservation already lifts the stack, and the two used to be capped
		   independently and then summed, so a declared 218px claim plus a
		   measured 228px dock put the stack 64% of the way up a phone screen,
		   on top of the page's own controls. Whatever the reservation already
		   took comes out of the dock's budget. */
		var reserveLift = parseFloat(
			document.documentElement.style.getPropertyValue('--tws-corner-reserve')
		) || 0;
		var cap = Math.max(0, Math.round(vh * DOCK_MAX_RATIO) - reserveLift);
		/* Docks stack: /app pins an action bar under a chat composer. Climb one
		   band at a time until nothing new appears above, so clearing the first
		   one never parks the stack on the second. */
		var lift = 0;
		for (var pass = 0; pass < 4; pass++) {
			var next = probeBand(lift, left, right, vw, vh);
			if (next <= lift) break;
			lift = Math.min(next, cap);
			if (lift >= cap) break;
		}
		return Math.min(Math.round(lift), cap);
	}

	function applyDocks() {
		var next = measureDocks();
		if (next === dockLift) return dockLift;
		dockLift = next;
		if (next > 0) document.documentElement.style.setProperty(DOCK_VAR, next + 'px');
		else document.documentElement.style.removeProperty(DOCK_VAR);
		return dockLift;
	}

	/* Coalesce bursts into one measurement. A 3D page mutates its DOM every
	   frame, and each measurement forces a layout flush, so this throttles to a
	   trailing call a few frames later rather than running per mutation. */
	var dockTimer = 0;
	var DOCK_THROTTLE_MS = 250;
	function scheduleDocks() {
		if (dockTimer) return;
		dockTimer = setTimeout(function () {
			dockTimer = 0;
			applyDocks();
		}, DOCK_THROTTLE_MS);
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
		reserved: reservedHeight,
		remeasure: applyDocks
	};

	if (document.body) adoptOrphans();
	else document.addEventListener('DOMContentLoaded', adoptOrphans);

	/* Lift-vs-step-aside is a function of viewport width, so re-decide whenever
	   that changes (rotation, a resized window, a phone's URL bar collapsing).
	   A page's own bottom dock moves with the same events, plus whenever the
	   page renders one, so it is re-measured there too. */
	if (typeof window.addEventListener === 'function') {
		var onViewportChange = function () {
			applyReserve();
			scheduleDocks();
		};
		window.addEventListener('resize', onViewportChange);
		window.addEventListener('orientationchange', onViewportChange);
	}

	/* Docks mount on their own schedule: after a fetch, after a WebGL boot,
	   when a chat panel opens. Watch the document rather than asking each page
	   to announce itself, and re-measure on a settle timer for the first few
	   seconds so a late dock never leaves the stack parked on top of it. */
	function watchDocks() {
		if (!document.body) return;
		scheduleDocks();
		if (typeof MutationObserver === 'function') {
			var observer = new MutationObserver(scheduleDocks);
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['style', 'class', 'hidden']
			});
		}
		[400, 1500, 4000].forEach(function (ms) { setTimeout(scheduleDocks, ms); });
	}
	if (document.body) watchDocks();
	else document.addEventListener('DOMContentLoaded', watchDocks);

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
