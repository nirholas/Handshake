// Accessibility primitives shared by every /play surface.
//
// The world chrome is built entirely in JS across ~15 modules (HUD, store,
// bank, jobs board, wheel, cosmetics, wardrobe, friends, buy). Each one had
// grown its own half of the modal contract: one had `aria-modal` but never
// moved focus into the card, another bound Escape to `window` and leaked the
// listener, a third had neither, so keyboard and screen-reader players could
// open a panel and then be stranded outside it with no way back.
//
// This module owns that contract once:
//
//   openModal(card, { close })  focus moves in, Tab cycles inside, Escape and
//                               the overlay stack close the TOP panel only,
//                               and focus returns to whatever opened it.
//   announce(text)              one polite live region for transient world
//                               events (balance changes, incoming chat,
//                               connection state) that have no visible
//                               text node a screen reader would land on.
//
// Everything degrades safely: a missing/detached element is a no-op, and every
// registration hands back an idempotent release function.

const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
	'[role="button"]:not([aria-disabled="true"])',
].join(',');

function visible(el) {
	if (!el || el.hidden) return false;
	const r = el.getBoundingClientRect();
	if (!r.width && !r.height) return false;
	const s = getComputedStyle(el);
	return s.visibility !== 'hidden' && s.display !== 'none';
}

/** Every keyboard-reachable control inside `root`, in DOM order. */
export function focusableIn(root) {
	if (!root?.querySelectorAll) return [];
	return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
}

// ── overlay stack ───────────────────────────────────────────────────────────
// Escape closes the TOP overlay, never all of them: the shop opened from the
// wardrobe has to hand control back to the wardrobe, not dump the player onto
// the bare world.

const stack = [];
let escBound = false;

function onEscape(e) {
	if (e.key !== 'Escape' || !stack.length) return;
	const top = stack[stack.length - 1];
	e.preventDefault();
	e.stopPropagation();
	try { top.close(); } catch { /* a panel that already tore itself down */ }
}

function bindEscape() {
	if (escBound || typeof document === 'undefined') return;
	// Capture phase so the world's movement/hotkey handler on `window` never
	// sees the Escape that belongs to an open panel.
	document.addEventListener('keydown', onEscape, true);
	escBound = true;
}

/**
 * Put a panel on the Escape stack. Returns a release function; calling it more
 * than once is safe.
 * @param {HTMLElement} el
 * @param {() => void} close
 */
export function registerOverlay(el, close) {
	if (typeof close !== 'function') return () => {};
	bindEscape();
	const entry = { el, close };
	stack.push(entry);
	return () => {
		const i = stack.indexOf(entry);
		if (i >= 0) stack.splice(i, 1);
	};
}

/** Is any panel currently claiming Escape? Used by the world hotkey handler. */
export function hasOpenOverlay() {
	return stack.length > 0;
}

// ── focus trap ──────────────────────────────────────────────────────────────

/**
 * Keep Tab inside `root` while it is open, move focus in on mount, and restore
 * it to the previously focused element on release.
 * @param {HTMLElement} root
 * @param {{ initialFocus?: HTMLElement }} [opts]
 * @returns {() => void} release
 */
export function trapFocus(root, { initialFocus } = {}) {
	if (!root) return () => {};
	const previous = document.activeElement;

	const onKey = (e) => {
		if (e.key !== 'Tab') return;
		const items = focusableIn(root);
		if (!items.length) {
			// Nothing focusable yet (a panel still loading its first snapshot):
			// hold focus on the card rather than letting Tab escape to the page.
			e.preventDefault();
			root.focus?.();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || !root.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !root.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	};
	root.addEventListener('keydown', onKey);

	// The card itself must be focusable so focus has somewhere to land before
	// the panel's async content arrives; -1 keeps it out of the Tab order.
	if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
	const target = initialFocus || focusableIn(root)[0] || root;
	// Defer one frame: panels focus-trap in their constructor, before the card
	// has been laid out, and focusing a zero-size element is a silent no-op.
	requestAnimationFrame(() => {
		if (root.isConnected) try { target.focus({ preventScroll: true }); } catch { /* detached */ }
	});

	let released = false;
	return () => {
		if (released) return;
		released = true;
		root.removeEventListener('keydown', onKey);
		// Only pull focus back if it is still inside the panel we are closing:
		// if the player already clicked elsewhere, stealing it would be worse
		// than leaving it.
		if (root.contains(document.activeElement) || document.activeElement === document.body) {
			try { previous?.focus?.({ preventScroll: true }); } catch { /* gone */ }
		}
	};
}

/**
 * The full modal contract: Escape stack + focus trap + focus restore.
 * @param {HTMLElement} card the dialog element (the thing with role="dialog")
 * @param {{ close: () => void, initialFocus?: HTMLElement }} opts
 * @returns {() => void} release, safe to call from the panel's own close()
 */
export function openModal(card, { close, initialFocus } = {}) {
	const unstack = registerOverlay(card, close);
	const untrap = trapFocus(card, { initialFocus });
	let released = false;
	return () => {
		if (released) return;
		released = true;
		unstack();
		untrap();
	};
}

// ── live announcer ──────────────────────────────────────────────────────────
// A single pair of visually-hidden regions, created lazily. Screen readers only
// announce a live region when its text CHANGES, so repeated identical messages
// get a zero-width marker appended to force a re-read.

let politeEl = null;
let assertiveEl = null;
let flip = false;

function ensureRegions() {
	if (typeof document === 'undefined' || !document.body) return;
	// Re-create when the regions have been torn out from under us. /play replaces
	// whole subtrees (leaving a world, the zen teardown), and a cached reference
	// to a detached node announces into nothing, silently and forever.
	if (politeEl?.isConnected && assertiveEl?.isConnected) return;
	const style = document.createElement('style');
	style.textContent =
		'.cc-sr-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;' +
		'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}';
	document.head.appendChild(style);
	const make = (live) => {
		const n = document.createElement('div');
		n.className = 'cc-sr-live';
		n.setAttribute('aria-live', live);
		n.setAttribute('aria-atomic', 'true');
		n.setAttribute('role', live === 'assertive' ? 'alert' : 'status');
		document.body.appendChild(n);
		return n;
	};
	politeEl = make('polite');
	assertiveEl = make('assertive');
}

// ── reduced motion ──────────────────────────────────────────────────────────
// CSS handles the DOM chrome (see the accessibility floor in
// coincommunities.css). The parts of /play that CSS cannot reach (camera
// shake, the wheel's spin flourish, ambient idle motion) read this instead.
// Live-updating: a visitor who flips the OS setting mid-session gets the calm
// world immediately, without a reload.

const motionQuery = typeof matchMedia === 'function'
	? matchMedia('(prefers-reduced-motion: reduce)')
	: null;

/** True when the visitor has asked the OS for reduced motion. */
export function prefersReducedMotion() {
	return !!motionQuery?.matches;
}

/**
 * Subscribe to changes. Fires immediately with the current value.
 * @param {(reduced: boolean) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onReducedMotionChange(fn) {
	if (typeof fn !== 'function') return () => {};
	fn(prefersReducedMotion());
	if (!motionQuery?.addEventListener) return () => {};
	const handler = (e) => fn(!!e.matches);
	motionQuery.addEventListener('change', handler);
	return () => motionQuery.removeEventListener('change', handler);
}

/**
 * Announce a transient world event to screen readers.
 * @param {string} text
 * @param {{ assertive?: boolean }} [opts] assertive interrupts; reserve it for
 *   things the player must act on (kicked from the room, gate refusal).
 */
export function announce(text, { assertive = false } = {}) {
	const msg = String(text || '').trim();
	if (!msg) return;
	ensureRegions();
	const node = assertive ? assertiveEl : politeEl;
	if (!node) return;
	flip = !flip;
	node.textContent = flip ? msg : msg + '​';
}
