/**
 * hreflang coverage, unit tests.
 *
 * public/locales/localized-pages.json drives the <xhtml:link hreflang> alternates
 * the dynamic sitemap emits, and it is derived by resolving each registered page
 * path to the HTML file that serves it and checking for a data-i18n annotation.
 * The resolution is the fragile half: a page whose file is not found is treated
 * as "not localized", so a fully translated page quietly tells search engines it
 * has no alternates. These pin every clean-URL shape the server actually serves.
 */

import { describe, expect, it } from 'vitest';

import { localizedPageFile } from '../scripts/build-page-index.mjs';

const at = (...present) => {
	const set = new Set(present.map((p) => `/repo/${p}`));
	return (file) => set.has(file);
};

describe('localizedPageFile', () => {
	it('resolves the common case, pages/<slug>.html', () => {
		expect(localizedPageFile('/what-is', at('pages/what-is.html'), '/repo')).toBe(
			'/repo/pages/what-is.html',
		);
	});

	it('maps / to the home page', () => {
		expect(localizedPageFile('/', at('pages/home.html'), '/repo')).toBe('/repo/pages/home.html');
	});

	it('resolves a nested index under pages/ (/openai)', () => {
		expect(localizedPageFile('/openai', at('pages/openai/index.html'), '/repo')).toBe(
			'/repo/pages/openai/index.html',
		);
	});

	it('resolves a page served straight out of public/ (/viewer)', () => {
		expect(localizedPageFile('/viewer', at('public/viewer.html'), '/repo')).toBe(
			'/repo/public/viewer.html',
		);
	});

	it('resolves a nested index under public/ (/cookbook)', () => {
		expect(localizedPageFile('/cookbook', at('public/cookbook/index.html'), '/repo')).toBe(
			'/repo/public/cookbook/index.html',
		);
	});

	it('prefers pages/ over public/ when both exist', () => {
		expect(
			localizedPageFile('/create', at('pages/create.html', 'public/create.html'), '/repo'),
		).toBe('/repo/pages/create.html');
	});

	it('tolerates surrounding slashes', () => {
		expect(localizedPageFile('/features/ar/', at('pages/features/ar.html'), '/repo')).toBe(
			'/repo/pages/features/ar.html',
		);
	});

	it('returns null for an external link, so it never lands in the alternates list', () => {
		expect(localizedPageFile('https://example.com/x', () => true, '/repo')).toBeNull();
	});

	it('returns null for a path with no file behind it (a dynamic route)', () => {
		expect(localizedPageFile('/agent/123', at(), '/repo')).toBeNull();
	});
});
