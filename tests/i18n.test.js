/**
 * i18n pipeline — unit tests.
 *
 * Covers the three pure, security-relevant layers of the LobeHub-style
 * translation pipeline, with no network and no DOM:
 *   1. extraction   — annotated HTML → source catalog
 *   2. glossary mask — brand/protocol terms survive a translation round-trip
 *   3. lint          — structural validation that gates the build
 *   4. runtime       — key resolution, interpolation, and English fallback
 *   5. merge         — stale translations are pruned, prior ones preserved
 */

import { describe, it, expect } from 'vitest';
import { extractFromHtml } from '../scripts/i18n-extract.mjs';
import {
	buildMasker,
	lintLocale,
	mergeOrdered,
	missingKeys,
	untranslatedCount,
	flatten,
	setDeep,
	getDeep,
} from '../scripts/lib/i18n-shared.mjs';
import { resolveKey, interpolate, translate, pickLocale } from '../src/i18n.js';

describe('extractFromHtml', () => {
	it('pulls text, html, and attribute keys with their English source values', () => {
		const html = `
			<title data-i18n="home.title">three.ws</title>
			<meta name="description" data-i18n-attr="content:home.desc" content="Build agents." />
			<h1 data-i18n-html="home.h1">The <em>3D</em> agent layer</h1>
			<a data-i18n="common.tour" data-i18n-attr="aria-label:common.tour_aria" aria-label="Start the tour">Take the tour</a>`;
		const map = extractFromHtml(html);
		expect(map.get('home.title')).toBe('three.ws');
		expect(map.get('home.desc')).toBe('Build agents.');
		expect(map.get('home.h1')).toBe('The <em>3D</em> agent layer');
		expect(map.get('common.tour')).toBe('Take the tour');
		expect(map.get('common.tour_aria')).toBe('Start the tour');
	});

	it('collapses whitespace runs so catalogs stay clean', () => {
		const map = extractFromHtml('<p data-i18n="k">  hello\n\t\tworld  </p>');
		expect(map.get('k')).toBe('hello world');
	});
});

describe('glossary masking', () => {
	const masker = buildMasker(['$THREE', 'USDC', 'IBM watsonx.ai', 'watsonx.ai']);

	it('round-trips brand terms, placeholders, and tags byte-for-byte', () => {
		const src = 'Earn {{amount}} USDC with <strong>$THREE</strong> on IBM watsonx.ai';
		const { masked, tokens } = masker.mask(src);
		// The model never sees the protected substrings.
		expect(masked).not.toContain('$THREE');
		expect(masked).not.toContain('USDC');
		expect(masked).not.toContain('{{amount}}');
		expect(masked).not.toContain('<strong>');
		// Restoration is exact.
		expect(masker.unmask(masked, tokens)).toBe(src);
	});

	it('masks the longest term first (IBM watsonx.ai before watsonx.ai)', () => {
		const { masked, tokens } = masker.mask('Runs on IBM watsonx.ai today');
		expect(masker.unmask(masked, tokens)).toBe('Runs on IBM watsonx.ai today');
		// Exactly one sentinel — the longer term consumed the whole phrase.
		expect(tokens).toEqual(['IBM watsonx.ai']);
	});

	it('does not corrupt literal numbers in the copy', () => {
		const { masked, tokens } = masker.mask('Pay 60 USDC in 2 minutes');
		const restored = masker.unmask(masked, tokens);
		expect(restored).toBe('Pay 60 USDC in 2 minutes');
	});
});

describe('lintLocale', () => {
	const source = { home: { title: 'Hi {{name}}', cta: 'Earn $THREE' } };

	it('passes a complete, faithful translation', () => {
		const target = { home: { title: 'Hola {{name}}', cta: 'Gana $THREE' } };
		expect(lintLocale(source, target, { code: 'es', doNotTranslate: ['$THREE'] })).toEqual([]);
	});

	it('flags missing keys, empty values, placeholder drift, and dropped glossary terms', () => {
		const target = { home: { title: 'Hola', cta: 'Gana monedas' } };
		const problems = lintLocale(source, target, { code: 'es', doNotTranslate: ['$THREE'] });
		expect(problems.join('\n')).toMatch(/placeholder drift in home.title/);
		expect(problems.join('\n')).toMatch(/glossary term dropped in home.cta/);
	});

	it('flags stale keys that no longer exist in the source', () => {
		const target = { home: { title: 'Hola {{name}}', cta: 'Gana $THREE', gone: 'x' } };
		const problems = lintLocale(source, target, { code: 'es', doNotTranslate: ['$THREE'] });
		expect(problems.join('\n')).toMatch(/stale key.*home.gone/);
	});
});

describe('locale detection priority', () => {
	const manifest = {
		default: 'en',
		locales: [
			{ code: 'en', name: 'English', dir: 'ltr' },
			{ code: 'te', name: 'తెలుగు', dir: 'ltr' },
			{ code: 'pt-BR', name: 'Português (BR)', dir: 'ltr' },
		],
	};

	it('honors an explicit ?lang= over a stored preference (deep links win)', () => {
		// Regression: a returning visitor's stored 'en' used to silently override
		// every ?lang= deep link from the sitemap's hreflang alternates.
		expect(pickLocale({ query: 'te', stored: 'en', navLangs: ['en-US'] }, manifest)).toBe('te');
	});

	it('falls back to the stored preference when the URL has no ?lang=', () => {
		expect(pickLocale({ query: null, stored: 'te', navLangs: ['en-US'] }, manifest)).toBe('te');
	});

	it('ignores an unsupported ?lang= value', () => {
		expect(pickLocale({ query: 'xx', stored: 'te', navLangs: [] }, manifest)).toBe('te');
	});

	it('matches navigator languages by base code (pt → pt-BR)', () => {
		expect(pickLocale({ query: null, stored: null, navLangs: ['pt'] }, manifest)).toBe('pt-BR');
	});

	it('returns the manifest default when nothing matches', () => {
		expect(pickLocale({ query: null, stored: null, navLangs: ['xx-YY'] }, manifest)).toBe('en');
	});
});

describe('runtime resolution', () => {
	const catalog = { home: { hi: 'Hola {{name}}' } };
	const fallback = { home: { hi: 'Hi {{name}}', only_en: 'English only' } };

	it('resolves nested keys', () => {
		expect(resolveKey(catalog, 'home.hi')).toBe('Hola {{name}}');
		expect(resolveKey(catalog, 'home.missing')).toBeUndefined();
	});

	it('interpolates and leaves unknown vars visible', () => {
		expect(interpolate('Hola {{name}}', { name: 'Ana' })).toBe('Hola Ana');
		expect(interpolate('Hola {{name}}', {})).toBe('Hola {{name}}');
	});

	it('falls back active → entryLocale → key', () => {
		expect(translate('home.hi', { name: 'Ana' }, { catalog, fallback })).toBe('Hola Ana');
		expect(translate('home.only_en', {}, { catalog, fallback })).toBe('English only');
		expect(translate('home.nope', {}, { catalog, fallback })).toBe('home.nope');
	});
});

describe('merge + diff', () => {
	const source = { a: '1', b: { c: '2', d: '3' } };

	it('reports only missing/empty target keys', () => {
		const target = { a: 'uno', b: { c: '' } };
		expect(missingKeys(source, target).sort()).toEqual(['b.c', 'b.d']);
	});

	// A run killed partway leaves the full key skeleton with empty values, so a
	// key-count check calls it finished while the page renders half-translated.
	// The manifest gate uses this to tell "complete" from "merely present".
	it('counts skeleton-only keys as untranslated so partial catalogs are detectable', () => {
		expect(untranslatedCount({ a: 'uno', b: { c: 'dos' } })).toBe(0);
		expect(untranslatedCount({ a: 'uno', b: { c: '', d: '   ' } })).toBe(2);
		expect(untranslatedCount({})).toBe(0);
	});

	it('agrees with missingKeys, so a complete catalog leaves a resumed run nothing to do', () => {
		const partial = { a: 'uno', b: { c: '', d: '' } };
		expect(untranslatedCount(partial)).toBe(missingKeys(source, partial).length);
	});

	it('keeps prior translations, applies fresh ones, and prunes stale keys', () => {
		const existing = { a: 'uno', b: { c: 'dos', d: 'tres' }, stale: 'x' };
		const fresh = {};
		setDeep(fresh, 'b.c', 'DOS');
		const merged = mergeOrdered(source, existing, fresh);
		expect(merged.a).toBe('uno'); // preserved
		expect(getDeep(merged, 'b.c')).toBe('DOS'); // fresh wins
		expect(getDeep(merged, 'b.d')).toBe('tres'); // preserved
		expect('stale' in merged).toBe(false); // pruned (not in source)
		expect(Object.keys(flatten(merged)).sort()).toEqual(['a', 'b.c', 'b.d']);
	});
});
