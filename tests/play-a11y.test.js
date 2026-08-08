// @vitest-environment jsdom
//
// The /play accessibility contract (audit 09).
//
// These pin the four behaviours that made the world reachable but not operable
// for a keyboard or screen-reader player, each of which regressed silently
// before because nothing asserted it:
//
//   1. The shared modal contract (src/game/a11y.js): Escape closes the TOP
//      panel only, Tab stays inside an open dialog, focus moves in on open and
//      returns to the opener on close.
//   2. The live announcer: a message with the same text twice still re-reads,
//      because a screen reader only speaks a live region when its text changes.
//   3. `isActivationTarget`, the guard that stops the world's global Enter/Space
//      bindings ("open chat", "jump") from swallowing the browser's activation
//      gesture for whatever HUD control has focus.
//   4. Play copy actually goes through the i18n layer: every `play.*` key the
//      HUD references exists in the source catalog, and `t()` falls back to the
//      English source instead of printing a raw key when it does not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
	openModal, registerOverlay, trapFocus, focusableIn, announce, hasOpenOverlay,
} from '../src/game/a11y.js';
import { t } from '../src/game/i18n-play.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// jsdom gives every element a zero-size box, which the module's own visibility
// filter would (correctly, in a browser) treat as hidden. Stub a real box so
// the focus helpers see the controls under test.
function withLayout() {
	const spy = vi
		.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect')
		.mockReturnValue({ width: 100, height: 24, top: 0, left: 0, right: 100, bottom: 24, x: 0, y: 0, toJSON() {} });
	return () => spy.mockRestore();
}

// requestAnimationFrame drives the deferred initial focus in trapFocus.
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function dialog(id, buttons = ['one', 'two']) {
	const card = document.createElement('div');
	card.id = id;
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-modal', 'true');
	for (const label of buttons) {
		const b = document.createElement('button');
		b.type = 'button';
		b.textContent = label;
		card.appendChild(b);
	}
	document.body.appendChild(card);
	return card;
}

const esc = (opts = {}) =>
	document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...opts }));

describe('play a11y: modal contract', () => {
	let restore;
	beforeEach(() => { document.body.innerHTML = ''; restore = withLayout(); });
	afterEach(() => { restore(); });

	it('Escape closes the top panel only, then the one beneath it', () => {
		const first = dialog('first');
		const second = dialog('second');
		const closed = [];
		const relA = registerOverlay(first, () => { closed.push('first'); relA(); });
		const relB = registerOverlay(second, () => { closed.push('second'); relB(); });

		expect(hasOpenOverlay()).toBe(true);
		esc();
		expect(closed).toEqual(['second']);
		esc();
		expect(closed).toEqual(['second', 'first']);
		expect(hasOpenOverlay()).toBe(false);
		// Nothing open: Escape is the world's again.
		esc();
		expect(closed).toEqual(['second', 'first']);
	});

	it('does not let the world hotkey handler see a panel Escape', () => {
		const card = dialog('trapped');
		const worldSaw = vi.fn();
		window.addEventListener('keydown', worldSaw);
		const release = registerOverlay(card, () => {});
		esc();
		expect(worldSaw).not.toHaveBeenCalled();
		release();
		window.removeEventListener('keydown', worldSaw);
	});

	it('moves focus into the dialog and back to the opener on close', async () => {
		const opener = document.createElement('button');
		opener.type = 'button';
		document.body.appendChild(opener);
		opener.focus();
		expect(document.activeElement).toBe(opener);

		const card = dialog('focus-me');
		const release = openModal(card, { close: () => {} });
		await nextFrame();
		expect(card.contains(document.activeElement)).toBe(true);

		release();
		expect(document.activeElement).toBe(opener);
	});

	it('honours an explicit initialFocus', async () => {
		const card = dialog('initial', ['first', 'close']);
		const closeBtn = card.lastElementChild;
		const release = openModal(card, { close: () => {}, initialFocus: closeBtn });
		await nextFrame();
		expect(document.activeElement).toBe(closeBtn);
		release();
	});

	it('cycles Tab inside the dialog instead of escaping to the page behind it', async () => {
		const outside = document.createElement('button');
		outside.type = 'button';
		document.body.appendChild(outside);

		const card = dialog('cycle', ['a', 'b', 'c']);
		const release = trapFocus(card);
		await nextFrame();

		const items = focusableIn(card);
		expect(items).toHaveLength(3);

		// Forward past the last control wraps to the first.
		items[2].focus();
		const fwd = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		card.dispatchEvent(fwd);
		expect(fwd.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(items[0]);

		// Backward past the first wraps to the last.
		const back = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
		card.dispatchEvent(back);
		expect(back.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(items[2]);

		release();
	});

	it('leaves focus alone when the player already moved it elsewhere', async () => {
		const opener = document.createElement('button');
		const elsewhere = document.createElement('button');
		document.body.append(opener, elsewhere);
		opener.focus();

		const card = dialog('no-steal');
		const release = openModal(card, { close: () => {} });
		await nextFrame();
		elsewhere.focus();
		release();
		expect(document.activeElement).toBe(elsewhere);
	});

	it('releases are idempotent, so a double close cannot unstack a sibling panel', () => {
		const a = dialog('a');
		const b = dialog('b');
		const closed = [];
		const relA = openModal(a, { close: () => closed.push('a') });
		const relB = openModal(b, { close: () => closed.push('b') });
		relB();
		relB();
		relB();
		esc();
		expect(closed).toEqual(['a']);
		relA();
	});
});

describe('play a11y: live announcer', () => {
	beforeEach(() => { document.body.innerHTML = ''; document.head.innerHTML = ''; });

	it('creates one polite and one assertive region, lazily', () => {
		expect(document.querySelectorAll('.cc-sr-live')).toHaveLength(0);
		announce('Cash on hand 120.');
		const regions = [...document.querySelectorAll('.cc-sr-live')];
		expect(regions).toHaveLength(2);
		expect(regions.map((r) => r.getAttribute('aria-live')).sort()).toEqual(['assertive', 'polite']);
		const polite = regions.find((r) => r.getAttribute('aria-live') === 'polite');
		expect(polite.textContent).toContain('Cash on hand 120.');
	});

	it('re-reads an identical message by changing the text node', () => {
		announce('Spent 30.');
		const polite = document.querySelector('[aria-live="polite"]');
		const first = polite.textContent;
		announce('Spent 30.');
		expect(polite.textContent).not.toBe(first);
		expect(polite.textContent).toContain('Spent 30.');
	});

	it('routes assertive messages to the alert region, not the polite one', () => {
		announce('Removed from the world.', { assertive: true });
		expect(document.querySelector('[aria-live="assertive"]').textContent).toContain('Removed from the world.');
		expect(document.querySelector('[aria-live="polite"]').textContent).toBe('');
	});

	it('ignores empty messages rather than blanking a region mid-read', () => {
		announce('Jobs Board');
		const polite = document.querySelector('[aria-live="polite"]');
		const before = polite.textContent;
		announce('');
		announce(null);
		expect(polite.textContent).toBe(before);
	});
});

// The world binds Enter and Space globally (open chat / jump). Those are also
// the browser's activation gesture, so the handler has to stand down whenever a
// control has focus. This is the exact predicate coincommunities.js uses; it
// lives there rather than in a11y.js, so assert it against the same source.
describe('play a11y: hotkeys never swallow a focused control', () => {
	const src = readFileSync(join(ROOT, 'src', 'game', 'coincommunities.js'), 'utf8');

	it('defines an activation-target guard covering buttons, links and ARIA widgets', () => {
		const sel = src.match(/const ACTIVATION_TARGET = '([^']+)'/)?.[1];
		expect(sel, 'coincommunities.js must define ACTIVATION_TARGET').toBeTruthy();
		for (const part of ['button', 'a[href]', '[role="button"]', '[role="tab"]', '[role="menuitem"]']) {
			expect(sel).toContain(part);
		}
	});

	it('matches a focused HUD button but not the world canvas', () => {
		const sel = src.match(/const ACTIVATION_TARGET = '([^']+)'/)[1];
		document.body.innerHTML = `
			<canvas id="kx-canvas" tabindex="0" role="application"></canvas>
			<div id="cc-hud"><button class="cc-shop-btn"><span class="cc-shop-btn-ico">S</span><span>Shop</span></button></div>`;
		const icon = document.querySelector('.cc-shop-btn-ico');
		const canvas = document.getElementById('kx-canvas');
		// A click/keypress lands on the icon span inside the button, so the guard
		// has to walk up, not just test the target itself.
		expect(icon.closest(sel)).toBe(document.querySelector('.cc-shop-btn'));
		expect(canvas.closest(sel)).toBe(null);
	});

	it('gates both activation keys and the overlay check on that guard', () => {
		expect(src).toContain('const onControl = isActivationTarget(e.target);');
		expect(src).toMatch(/e\.key === 'Enter' && this\.phase === 'world' && !onControl/);
		expect(src).toMatch(/e\.code === 'Space' && !onControl/);
		// A modal panel owns the keyboard while it is open.
		expect(src).toContain('if (hasOpenOverlay()) return;');
	});
});

describe('play a11y: HUD copy goes through the i18n layer', () => {
	const catalog = JSON.parse(readFileSync(join(ROOT, 'public', 'locales', 'en.json'), 'utf8'));
	const sources = [
		'src/game/coincommunities-ui.js',
		'src/game/economy-ui.js',
		'src/game/quests-ui.js',
		'src/game/spin-wheel-ui.js',
		'src/game/cosmetics-shop.js',
		'src/game/cosmetics-wardrobe.js',
		'pages/play.html',
	].map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n');

	it('every play.* key the world references exists in the source catalog', () => {
		// Quoted or `attr:key`-delimited only, so a filename in a comment
		// ("pages/play.html") is not mistaken for a catalog key.
		const referenced = new Set(
			[...sources.matchAll(/['":;](play\.[a-z0-9_]+)(?=['";]|$)/gm)].map((m) => m[1]),
		);
		expect(referenced.size).toBeGreaterThan(40);
		const missing = [...referenced].filter((key) => catalog.play?.[key.slice('play.'.length)] === undefined);
		expect(missing, `keys used by /play but absent from public/locales/en.json: ${missing.join(', ')}`).toEqual([]);
	});

	it('annotates the HUD, not just the page metadata', () => {
		const hud = readFileSync(join(ROOT, 'src', 'game', 'coincommunities-ui.js'), 'utf8');
		// Before this audit the whole in-world HUD was hardcoded English and the
		// only annotated strings on /play were the <meta> tags.
		expect((hud.match(/data-i18n/g) || []).length).toBeGreaterThan(20);
	});

	it('the world canvas carries a translatable text alternative', () => {
		const html = readFileSync(join(ROOT, 'pages', 'play.html'), 'utf8');
		const canvas = html.match(/<canvas[^>]*id="kx-canvas"[\s\S]*?>/)[0];
		expect(canvas).toContain('role="application"');
		expect(canvas).toContain('tabindex="0"');
		expect(canvas).toContain('aria-label=');
		expect(canvas).toContain('aria-label:play.canvas_label');
		expect(catalog.play.canvas_label).toMatch(/W A S D/);
	});

	it('t() falls back to the English source rather than printing a raw key', () => {
		delete globalThis.threewsI18n;
		expect(t('play.nope_not_a_key', 'Free spin')).toBe('Free spin');
		expect(t('play.online', '{{n}} online', { n: 7 })).toBe('7 online');
	});

	it('t() prefers the runtime catalog once /i18n.js has loaded', () => {
		globalThis.threewsI18n = { t: (key, vars) => (key === 'play.online' ? `${vars.n} en ligne` : key) };
		expect(t('play.online', '{{n}} online', { n: 7 })).toBe('7 en ligne');
		// A key the catalog does not carry echoes back, and must not reach the UI.
		expect(t('play.unknown', 'Shop')).toBe('Shop');
		delete globalThis.threewsI18n;
	});
});
