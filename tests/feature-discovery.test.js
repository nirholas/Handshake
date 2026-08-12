/**
 * The in-product feature-discovery layer (public/feature-discovery.js).
 *
 * The passive "Have you tried…" prompt shares the bottom-right corner with the
 * Walk Companion, and both auto-start for a first-time visitor. Two regressions
 * are pinned here, both observed on the live /create page:
 *
 *   1. The companion guard read `walk:companion:enabled` once, 6.5s in. nav.js
 *      summons the companion from an idle callback that lands later than that,
 *      so the flag was still absent and BOTH helpers ended up on screen, the
 *      pair of them covering the fourth intent card.
 *   2. The prompt suggested a feature the page already links to (/create shows
 *      a "Generate a 3D model" card pointing at /forge), which is noise rather
 *      than discovery.
 *
 * The module is a plain IIFE served straight from public/, so it is exercised
 * here the way a browser does: evaluated inside a JSDOM window.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

const root = resolve(__dirname, '..');
const SOURCE = readFileSync(resolve(root, 'public/feature-discovery.js'), 'utf8');

const REVEAL_MS = 6500; // must match REVEAL_DELAY_MS in the module

/**
 * Boot a window with the module evaluated in it, holding every timer the module
 * schedules so the test drives the clock instead of waiting on it.
 */
async function boot(bodyHtml = '') {
	const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
		runScripts: 'outside-only',
		url: 'https://three.ws/create',
		pretendToBeVisual: true,
	});
	const win = dom.window;
	const timers = [];
	win.setTimeout = function (fn, ms) {
		timers.push({ fn, ms });
		return timers.length;
	};
	win.clearTimeout = function () {};
	win.eval(SOURCE);
	// The module defers init to DOMContentLoaded, which JSDOM fires a tick after
	// construction, exactly like a browser parsing the document.
	if (win.document.readyState === 'loading') {
		await new Promise((done) => win.addEventListener('DOMContentLoaded', done, { once: true }));
	}
	const run = (ms) => {
		timers.filter((t) => t.ms === ms).forEach((t) => t.fn());
	};
	return { win, doc: win.document, run, reveal: () => run(REVEAL_MS) };
}

const card = (doc) => doc.querySelector('.tws-disc-card');
const companionHost = '<div class="walk-companion" role="complementary"></div>';

describe('feature discovery: passive prompt vs. the walk companion', () => {
	it('stands down when the companion is already mounted, flag or no flag', async () => {
		// The early half of the race: the companion beat us onto the page but
		// nav.js has not written the enabled key yet.
		const { doc, reveal } = await boot(companionHost);
		reveal();
		expect(card(doc)).toBeNull();
	});

	it('stands down when the companion flag is set', async () => {
		const { win, doc, reveal } = await boot();
		win.localStorage.setItem('walk:companion:enabled', '1');
		reveal();
		expect(card(doc)).toBeNull();
	});

	it('retracts an on-screen prompt when the companion arrives late', async () => {
		const { win, doc, reveal, run } = await boot();
		reveal();
		expect(card(doc)).not.toBeNull();

		// nav.js: sets the flag, then announces the summon.
		win.localStorage.setItem('walk:companion:enabled', '1');
		win.dispatchEvent(new win.CustomEvent('walk-companion:change'));
		run(240); // the dismissal transition
		expect(card(doc)).toBeNull();
	});

	it('does not mark the retracted feature as tried', async () => {
		// A retraction is not a rejection: the visitor never saw a choice, so the
		// suggestion must remain available on a later visit.
		const { win, doc, reveal, run } = await boot();
		reveal();
		win.localStorage.setItem('walk:companion:enabled', '1');
		win.dispatchEvent(new win.CustomEvent('walk-companion:change'));
		run(240);
		expect(card(doc)).toBeNull();
		expect(win.localStorage.getItem('threews:fd:tried')).toBeNull();
	});

	it('leaves a contextual cross-link card alone when the companion arrives', async () => {
		// Cross-links are user-earned (they follow a finished generation), so they
		// are not the ambient clutter the retraction targets.
		const { win, doc, run } = await boot();
		win.twsDiscovery.crossLink('forge');
		expect(card(doc)).not.toBeNull();
		win.localStorage.setItem('walk:companion:enabled', '1');
		win.dispatchEvent(new win.CustomEvent('walk-companion:change'));
		run(240);
		expect(card(doc)).not.toBeNull();
	});
});

describe('feature discovery: suggestion picking', () => {
	it('skips a feature the page already links to in its content', async () => {
		// /forge is the first hidden gem; /create links straight to it.
		const { doc, reveal } = await boot('<main><a href="/forge">Generate a 3D model</a></main>');
		reveal();
		const c = card(doc);
		expect(c).not.toBeNull();
		expect(c.querySelector('.tws-disc-cta').getAttribute('href')).not.toBe('/forge');
	});

	it('still suggests a feature that only the nav and footer link to', async () => {
		// The nav links to nearly everything; counting it would silence the prompt
		// site-wide.
		const { doc, reveal } = await boot(
			'<div id="nav-container"><a href="/forge">Forge</a></div><footer><a href="/forge">Forge</a></footer>',
		);
		reveal();
		expect(card(doc).querySelector('.tws-disc-cta').getAttribute('href')).toBe('/forge');
	});

	it('suggests nothing twice in a session', async () => {
		const { win, doc, reveal, run } = await boot();
		reveal();
		expect(card(doc)).not.toBeNull();
		win.twsDiscovery.dismiss();
		run(240);
		reveal();
		expect(card(doc)).toBeNull();
	});
});
