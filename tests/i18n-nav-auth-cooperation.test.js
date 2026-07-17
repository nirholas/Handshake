// @vitest-environment jsdom
//
// nav-auth and the i18n runtime both write to the text of the console pill: the
// element carries data-auth-name (nav-auth swaps in the signed-in visitor's
// display name) AND data-i18n (i18n swaps in a translated label). Whoever runs
// last used to win, so on any annotated page the i18n pass clobbered the name
// with "Dashboard" for signed-in users. These tests pin the cooperation: the
// name is never a translatable string, but the label still localizes when
// signed out.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyCatalog } from '../src/i18n.js';
import navAuth from '../public/nav-auth.js';

const { applyAuthState } = navAuth;

// A catalog function like the runtime's `t`: maps the pill key to a localized
// label, everything else passes through unchanged.
const es = (key) => (key === 'nav.console' ? 'Panel →' : key);

function pill() {
	document.body.innerHTML =
		'<a class="console" data-auth-name data-i18n="nav.console">Dashboard →</a>';
	return document.querySelector('.console');
}

describe('nav-auth ⇄ i18n cooperation on a shared element', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('i18n does not clobber a live display name (the regression)', () => {
		const el = pill();
		applyAuthState(document, true, 'Catherine Maerial');
		expect(el.textContent).toBe('Catherine Maerial');
		// i18n runs afterward (its catalog fetch resolves late); name must survive.
		applyCatalog(document, es);
		expect(el.textContent).toBe('Catherine Maerial');
		// The translation is retained as the signed-out fallback.
		expect(el.dataset.authNameOriginal).toBe('Panel →');
	});

	it('signed-out visitor still gets the translated label', () => {
		const el = pill();
		applyCatalog(document, es);
		expect(el.textContent).toBe('Panel →');
		applyAuthState(document, false, null);
		expect(el.textContent).toBe('Panel →');
	});

	it('converges regardless of which runtime paints first', () => {
		// i18n first, then auth.
		let el = pill();
		applyCatalog(document, es);
		applyAuthState(document, true, 'Ada');
		expect(el.textContent).toBe('Ada');

		// auth first, then i18n.
		el = pill();
		applyAuthState(document, true, 'Ada');
		applyCatalog(document, es);
		expect(el.textContent).toBe('Ada');
	});

	it('the data-i18n-html loop also refuses to clobber a live name', () => {
		document.body.innerHTML =
			'<a class="console" data-auth-name data-i18n-html="nav.console">Dashboard →</a>';
		const el = document.querySelector('.console');
		const esHtml = (key) => (key === 'nav.console' ? '<span>Panel</span> →' : key);
		applyAuthState(document, true, 'Marie Curie');
		applyCatalog(document, esHtml);
		expect(el.textContent).toBe('Marie Curie');
		expect(el.querySelector('span')).toBeNull(); // markup never painted over the name
	});

	it('a runtime locale switch keeps the name and refreshes the fallback', () => {
		const el = pill();
		applyAuthState(document, true, 'Grace');
		applyCatalog(document, es); // switch to Spanish
		expect(el.textContent).toBe('Grace');
		expect(el.dataset.authNameOriginal).toBe('Panel →');
		// Sign out now → the localized label, not the stale English original.
		applyAuthState(document, false, null);
		expect(el.textContent).toBe('Panel →');
	});
});
