/**
 * The shared bottom-right corner stack (public/corner-stack.js).
 *
 * Two distinct collision classes live here, and both were real regressions:
 *
 *   1. Stack MEMBERS ("Getting started", feature discovery, the language FAB)
 *      each used to hard-code `position:fixed; right; bottom` and piled onto
 *      the same pixel. The stack flows them vertically by priority instead.
 *   2. Corner NON-MEMBERS. The Walk Companion is a fixed-size WebGL canvas at
 *      a higher z-index that the visitor clicks to detach into Playground
 *      mode, so it cannot join the flex flow — and it simply covered the
 *      stack's cards on any page where both were on. Reservations fix that:
 *      the companion declares the corner height it occupies, the stack lifts
 *      clear of it.
 *
 * The module is a plain IIFE served straight from public/, so it is exercised
 * here the way a browser does: evaluated inside a JSDOM window.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

const root = resolve(__dirname, '..');
const SOURCE = readFileSync(resolve(root, 'public/corner-stack.js'), 'utf8');

/** Boot a fresh window with corner-stack.js evaluated in it. */
function boot() {
	const dom = new JSDOM('<!doctype html><html><body></body></html>', {
		runScripts: 'outside-only',
	});
	dom.window.eval(SOURCE);
	return dom.window;
}

function card(win, priority) {
	const el = win.document.createElement('div');
	if (priority != null) el.setAttribute('data-corner-priority', String(priority));
	return el;
}

/** The custom property the stack's `bottom` calc() reads. */
function reserveVar(win) {
	return win.document.documentElement.style.getPropertyValue('--tws-corner-reserve');
}

/** The custom property the stack's `right` calc() reads. */
function reserveWidthVar(win) {
	return win.document.documentElement.style.getPropertyValue('--tws-corner-reserve-w');
}

/** JSDOM reports a fixed 1024x768 viewport unless it is told otherwise. */
function setViewport(win, width) {
	Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
	win.dispatchEvent(new win.Event('resize'));
}

describe('corner stack — membership', () => {
	let win;
	beforeEach(() => {
		win = boot();
	});

	it('exposes the full API on the window', () => {
		for (const fn of ['mount', 'unmount', 'ensure', 'reserve', 'release', 'reserved']) {
			expect(typeof win.twsCornerStack[fn], fn).toBe('function');
		}
	});

	it('orders members so the highest priority sits nearest the corner', () => {
		const low = card(win, 10);
		const high = card(win, 90);
		const mid = card(win, 50);
		win.twsCornerStack.mount(high);
		win.twsCornerStack.mount(low);
		win.twsCornerStack.mount(mid);
		const order = [...win.document.getElementById('tws-corner-stack').children].map((el) =>
			Number(el.getAttribute('data-corner-priority')),
		);
		expect(order).toEqual([10, 50, 90]);
	});

	it('adopts widgets that mounted to <body> before the script ran', () => {
		// Order independence is the module's whole premise: a widget that beats
		// it to the page tags itself and appends to <body>.
		const dom = new JSDOM(
			'<!doctype html><html><body><div id="early" data-corner-priority="70"></div></body></html>',
			{ runScripts: 'outside-only' },
		);
		dom.window.eval(SOURCE);
		const early = dom.window.document.getElementById('early');
		expect(early.parentNode.id).toBe('tws-corner-stack');
		expect(early.classList.contains('tws-corner-item')).toBe(true);
	});

	it('unmount returns a member to nowhere rather than leaving a ghost', () => {
		const el = card(win, 50);
		win.twsCornerStack.mount(el);
		win.twsCornerStack.unmount(el);
		expect(win.document.getElementById('tws-corner-stack').children.length).toBe(0);
	});
});

describe('corner stack — reservations', () => {
	let win;
	beforeEach(() => {
		win = boot();
	});

	it('starts with nothing reserved', () => {
		expect(reserveVar(win)).toBe('');
		expect(win.twsCornerStack.reserved()).toBe(0);
	});

	it('lifts the stack by the reserved height', () => {
		expect(win.twsCornerStack.reserve('walk-companion', 296)).toBe(296);
		expect(reserveVar(win)).toBe('296px');
	});

	it('keeps reservations independent and lets the tallest win', () => {
		win.twsCornerStack.reserve('walk-companion', 296);
		win.twsCornerStack.reserve('other', 120);
		expect(win.twsCornerStack.reserved()).toBe(296);
		// Dropping the tall one must fall back to the short one, not to zero.
		win.twsCornerStack.release('walk-companion');
		expect(win.twsCornerStack.reserved()).toBe(120);
		win.twsCornerStack.release('other');
		expect(reserveVar(win)).toBe('');
	});

	it('ignores a zero or non-finite measurement instead of collapsing', () => {
		// The companion mounts at opacity 0 mid-transition; a height read at the
		// wrong moment must never drop the stack back on top of it.
		win.twsCornerStack.reserve('walk-companion', 296);
		win.twsCornerStack.reserve('ghost', 0);
		win.twsCornerStack.reserve('ghost2', Number.NaN);
		expect(win.twsCornerStack.reserved()).toBe(296);
	});

	it('survives a release for a key that never reserved', () => {
		expect(() => win.twsCornerStack.release('never-there')).not.toThrow();
		expect(win.twsCornerStack.reserved()).toBe(0);
	});

	it('accepts a width alongside the height without changing what it returns', () => {
		expect(win.twsCornerStack.reserve('walk-companion', { height: 296, width: 160 })).toBe(296);
	});

	it('steps aside instead of lifting when a phone leaves room beside the widget', () => {
		// The failure this prevents: on a 390px viewport the stack is full-width,
		// so a 218px lift parked its chips halfway up the page, on top of the
		// content. Beside the companion they stay pinned to the bottom.
		setViewport(win, 390);
		win.twsCornerStack.reserve('walk-companion', { height: 218, width: 160 });
		expect(reserveVar(win)).toBe('');
		expect(reserveWidthVar(win)).toBe('160px');
	});

	it('falls back to lifting when the leftover column would be unusable', () => {
		setViewport(win, 390);
		win.twsCornerStack.reserve('walk-companion', { height: 218, width: 300 });
		expect(reserveVar(win)).toBe('218px');
		expect(reserveWidthVar(win)).toBe('');
	});

	it('keeps lifting on a wide viewport, where the corner has room above it', () => {
		setViewport(win, 1440);
		win.twsCornerStack.reserve('walk-companion', { height: 296, width: 160 });
		expect(reserveVar(win)).toBe('296px');
		expect(reserveWidthVar(win)).toBe('');
	});

	it('re-decides when the viewport changes under a live reservation', () => {
		setViewport(win, 1440);
		win.twsCornerStack.reserve('walk-companion', { height: 296, width: 160 });
		setViewport(win, 390);
		expect(reserveVar(win)).toBe('');
		expect(reserveWidthVar(win)).toBe('160px');
		setViewport(win, 1440);
		expect(reserveVar(win)).toBe('296px');
		expect(reserveWidthVar(win)).toBe('');
	});

	it('drops the horizontal inset when the reservation is released', () => {
		setViewport(win, 390);
		win.twsCornerStack.reserve('walk-companion', { height: 218, width: 160 });
		win.twsCornerStack.release('walk-companion');
		expect(reserveWidthVar(win)).toBe('');
		expect(reserveVar(win)).toBe('');
	});

	it('announces itself so a widget that booted first can claim the corner', () => {
		// The companion module is injected separately by public/nav.js and can win
		// the load race. Without this event it would find no stack and silently
		// keep no reservation for the rest of the session.
		const dom = new JSDOM('<!doctype html><html><body></body></html>', {
			runScripts: 'outside-only',
		});
		let fired = false;
		dom.window.addEventListener('tws-corner-stack:ready', () => {
			fired = true;
		});
		dom.window.eval(SOURCE);
		expect(fired).toBe(true);
	});
});

describe('corner stack — stylesheet contract', () => {
	it('drives both the desktop and the narrow-viewport offset from the reserve', () => {
		// Two rules set `bottom`: the base rule and the <=640px rule that goes
		// full-width. A reservation honoured by only one of them still buries the
		// cards on the other, which is exactly how this shipped broken before.
		const bottoms = SOURCE.match(/bottom:calc\([^)]*var\(--tws-corner-reserve[^)]*\)[^)]*\)/g) || [];
		expect(bottoms.length).toBe(2);
	});

	it('caps its height against the reserve so a tall stack cannot overflow', () => {
		expect(SOURCE).toContain(
			'max-height:calc(100dvh - 36px - var(--tws-corner-reserve,0px) - var(--tws-corner-dock,0px))'
		);
	});

	it('offsets both rules by the measured page dock as well as the reserve', () => {
		// A page's own bottom chrome (the /app chat composer, a viewer action
		// bar) is not a reservation — nobody declares it — so the stack measures
		// it. Both the desktop and the narrow rule have to honour that lift or
		// the phone layout keeps parking helper widgets on the composer.
		const docked = SOURCE.match(/bottom:calc\([^;]*--tws-corner-dock/g) || [];
		expect(docked.length).toBe(2);
	});

	it('sizes members to their content on a phone instead of stretching them', () => {
		// align-items:stretch turned a 44px language control into a full-width
		// bar laid across whatever the page had at the bottom of the screen.
		expect(SOURCE).not.toContain('align-items:stretch');
	});

	it('offsets both rules horizontally too, so stepping aside works at any width', () => {
		const rights = SOURCE.match(/right:calc\([^)]*var\(--tws-corner-reserve-w[^)]*\)[^)]*\)/g) || [];
		expect(rights.length).toBe(2);
	});

	it('honours prefers-reduced-motion for the lift', () => {
		expect(SOURCE).toContain('@media (prefers-reduced-motion:reduce)');
	});
});

describe('walk companion — the reserving widget', () => {
	const companion = readFileSync(resolve(root, 'walk-sdk/src/companion.js'), 'utf8');

	it('claims the corner on mount and gives it back on unmount', () => {
		expect(companion).toContain("const CORNER_RESERVE_KEY = 'walk-companion'");
		expect(companion).toContain('stack.reserve(CORNER_RESERVE_KEY');
		expect(companion).toContain('release?.(CORNER_RESERVE_KEY)');
	});

	it('re-measures on resize and when the stack boots late', () => {
		expect(companion).toContain("window.addEventListener('resize', this._syncCornerReserve)");
		expect(companion).toContain(
			"window.addEventListener('tws-corner-stack:ready', this._syncCornerReserve)",
		);
		// Every listener it adds must come back off, or a re-mounted companion
		// stacks duplicate handlers for the life of the page.
		expect(companion).toContain("window.removeEventListener('resize', this._syncCornerReserve)");
		expect(companion).toContain(
			"window.removeEventListener('tws-corner-stack:ready', this._syncCornerReserve)",
		);
	});

	it('measures from computed style, not a rect caught mid-transition', () => {
		// The host animates in with a translateY, and getBoundingClientRect()
		// reports the transformed box — a reservation measured there would settle
		// short and leave the cards clipped.
		const start = companion.indexOf('_syncCornerReserve() {');
		expect(start).toBeGreaterThan(-1);
		const body = companion.slice(start, companion.indexOf('\n\t}', start));
		expect(body).toContain('getComputedStyle(this.host)');
		expect(body).not.toContain('getBoundingClientRect');
	});

	it('degrades silently on a page with no corner stack', () => {
		// walk-sdk publishes standalone as @three-ws/walk; the integration is
		// opt-in, never a hard dependency.
		expect(companion).toContain("typeof stack.reserve !== 'function'");
	});
});
