// Apple AR Quick Look banner fragment builder (src/ar/quicklook-banner.js).
//
// The contract these tests pin: banner fields ride the USDZ link as fragment
// parameters (checkoutTitle / checkoutSubtitle / callToAction), URL-encoded,
// joined with `&`, appended after any fragment already present. The builder is
// plain string surgery because the /irl bake hands it blob: object URLs that
// `new URL()` would mangle. No usable fields must return the URL untouched so
// callers can pass options unconditionally. Pure string logic, no DOM.

import { describe, it, expect } from 'vitest';

import { withQuickLookBanner, QUICK_LOOK_BANNER_TAPPED } from '../src/ar/quicklook-banner.js';

describe('withQuickLookBanner', () => {
	it('appends all three banner fields as encoded fragment params', () => {
		const out = withQuickLookBanner('https://cdn.three.ws/a.usdz', {
			title: 'Scout the Fox',
			subtitle: 'Living agent on three.ws',
			callToAction: 'Pin it here for people nearby',
		});
		expect(out).toBe(
			'https://cdn.three.ws/a.usdz' +
			'#checkoutTitle=Scout%20the%20Fox' +
			'&checkoutSubtitle=Living%20agent%20on%20three.ws' +
			'&callToAction=Pin%20it%20here%20for%20people%20nearby'
		);
	});

	it('skips blank fields and emits only what is present', () => {
		const out = withQuickLookBanner('https://cdn.three.ws/a.usdz', {
			title: '  ',
			callToAction: 'Meet this agent',
		});
		expect(out).toBe('https://cdn.three.ws/a.usdz#callToAction=Meet%20this%20agent');
	});

	it('returns the URL untouched when no usable fields are given', () => {
		expect(withQuickLookBanner('https://cdn.three.ws/a.usdz')).toBe('https://cdn.three.ws/a.usdz');
		expect(withQuickLookBanner('https://cdn.three.ws/a.usdz', {})).toBe('https://cdn.three.ws/a.usdz');
		expect(withQuickLookBanner('https://cdn.three.ws/a.usdz', { title: '' })).toBe('https://cdn.three.ws/a.usdz');
	});

	it('joins onto an existing fragment with & instead of a second #', () => {
		const out = withQuickLookBanner('https://cdn.three.ws/a.usdz#allowsContentScaling=0', { title: 'Scout' });
		expect(out).toBe('https://cdn.three.ws/a.usdz#allowsContentScaling=0&checkoutTitle=Scout');
	});

	it('works on blob: object URLs from the in-browser bake', () => {
		const blob = 'blob:https://three.ws/1f2e3d4c';
		expect(withQuickLookBanner(blob, { title: 'Scout' })).toBe(`${blob}#checkoutTitle=Scout`);
	});

	it('encodes characters that would break the fragment', () => {
		const out = withQuickLookBanner('https://cdn.three.ws/a.usdz', { title: 'a #1 fox & friend?' });
		expect(out).toBe('https://cdn.three.ws/a.usdz#checkoutTitle=a%20%231%20fox%20%26%20friend%3F');
	});

	it('clamps runaway fields to 80 characters before encoding', () => {
		const long = 'x'.repeat(200);
		const out = withQuickLookBanner('https://cdn.three.ws/a.usdz', { title: long });
		expect(out).toBe(`https://cdn.three.ws/a.usdz#checkoutTitle=${'x'.repeat(80)}`);
	});

	it('passes non-string and empty urls through unchanged', () => {
		expect(withQuickLookBanner('', { title: 'Scout' })).toBe('');
		expect(withQuickLookBanner(null, { title: 'Scout' })).toBe(null);
		expect(withQuickLookBanner(undefined, { title: 'Scout' })).toBe(undefined);
	});
});

describe('QUICK_LOOK_BANNER_TAPPED', () => {
	it('is the literal message data Safari sends on a banner tap', () => {
		expect(QUICK_LOOK_BANNER_TAPPED).toBe('_apple_ar_quicklook_button_tapped');
	});
});
