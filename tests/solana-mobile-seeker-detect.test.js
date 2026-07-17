// @vitest-environment jsdom
//
// Coverage for the Seeker/TWA detection heuristics in
// solana-mobile/src/seeker-detect.js. The load-bearing property: zero false
// positives on desktop and plain mobile PWAs (they must keep using the injected
// browser wallet), while a real Seeker TWA is detected even when its UA carries
// no "Seeker"/"SAGA" hint (the referrer-based fix).

import { describe, it, expect, afterEach } from 'vitest';
import { isSolanaMobileTwa, isSolanaMobileDevice } from '../solana-mobile/src/seeker-detect.js';

function setEnv({ ua = '', referrer = '', standalone = false } = {}) {
	Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
	Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
	window.matchMedia = (q) => ({ matches: standalone && /standalone|fullscreen/.test(q) });
}

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

afterEach(() => {
	delete window.matchMedia;
});

describe('isSolanaMobileTwa', () => {
	it('is false on desktop Chrome', () => {
		setEnv({ ua: DESKTOP_CHROME, standalone: true });
		expect(isSolanaMobileTwa()).toBe(false);
	});

	it('is false for a plain installed Android PWA (standalone, empty referrer, no hint)', () => {
		setEnv({ ua: ANDROID_CHROME, referrer: '', standalone: true });
		expect(isSolanaMobileTwa()).toBe(false);
	});

	it('is true when the referrer is our exact TWA package', () => {
		setEnv({ ua: ANDROID_CHROME, referrer: 'android-app://ws.three.app', standalone: false });
		expect(isSolanaMobileTwa()).toBe(true);
	});

	it('is true for a Seeker TWA with NO UA hint via a generic android-app referrer', () => {
		// Real-world false-negative the old AND-of-UA-hint gate dropped: a TWA
		// whose launcher package differs and whose UA lacks "Seeker".
		setEnv({ ua: ANDROID_CHROME, referrer: 'android-app://com.solanamobile.seedvault', standalone: true });
		expect(isSolanaMobileTwa()).toBe(true);
	});

	it('is true for standalone Android Chrome with a device hint', () => {
		setEnv({ ua: `${ANDROID_CHROME} Seeker`, referrer: '', standalone: true });
		expect(isSolanaMobileTwa()).toBe(true);
	});

	it('does not treat a generic android-app referrer as TWA without standalone', () => {
		setEnv({ ua: ANDROID_CHROME, referrer: 'android-app://com.random.app', standalone: false });
		expect(isSolanaMobileTwa()).toBe(false);
	});
});

describe('isSolanaMobileDevice', () => {
	it('is true for an Android UA advertising a Seeker hint', () => {
		setEnv({ ua: `${ANDROID_CHROME} SolanaMobile` });
		expect(isSolanaMobileDevice()).toBe(true);
	});

	it('is false for plain Android without a hint', () => {
		setEnv({ ua: ANDROID_CHROME });
		expect(isSolanaMobileDevice()).toBe(false);
	});
});
