// @vitest-environment jsdom
//
// A catalog miss must never clobber the DOM. translate() echoes the key back
// when a string is in neither the active catalog nor the English fallback
// (visible-in-QA behavior for programmatic t() calls), but applyCatalog used
// to write that echo into the element, replacing real English source text with
// "nav.c3spxn". Seen live when nav-data.js gained items ("Daily Match") after
// the last i18n-nav-harvest run: the mega-menu rendered raw hashed keys.
// These tests pin the rule: translated values swap in, misses leave the
// element exactly as rendered.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyCatalog, translate } from '../src/i18n.js';

// Runtime-shaped t: one known key, everything else is a total miss that echoes
// the key, exactly like translate() with the key absent from both catalogs.
const t = (key) => (key === 'nav.known' ? 'Conocido' : key);

describe('applyCatalog on catalog misses', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('keeps the English source text when a data-i18n key misses', () => {
		document.body.innerHTML =
			'<span data-i18n="nav.c3spxn">Daily Match</span>' +
			'<span data-i18n="nav.known">Known</span>';
		applyCatalog(document, t);
		const [miss, hit] = document.querySelectorAll('span');
		expect(miss.textContent).toBe('Daily Match');
		expect(hit.textContent).toBe('Conocido');
	});

	it('keeps existing markup when a data-i18n-html key misses', () => {
		document.body.innerHTML =
			'<p data-i18n-html="home.gone">real <strong>english</strong> copy</p>';
		applyCatalog(document, t);
		expect(document.querySelector('p').innerHTML).toBe('real <strong>english</strong> copy');
	});

	it('keeps existing attribute values when a data-i18n-attr key misses', () => {
		document.body.innerHTML =
			'<a data-i18n-attr="aria-label:nav.7ue3ei" aria-label="Daily Match standings">x</a>';
		applyCatalog(document, t);
		expect(document.querySelector('a').getAttribute('aria-label')).toBe(
			'Daily Match standings',
		);
	});

	it('translate() still echoes the key for programmatic callers', () => {
		expect(translate('nav.nope', {}, { catalog: {}, fallback: {} })).toBe('nav.nope');
	});
});
