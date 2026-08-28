/**
 * The iOS app's web-side bridge (ios/src/native-bridge.js).
 *
 * This module ships with the SITE, not the .ipa: Capacitor injects its native
 * bridge into the remote page, so `window.Capacitor` exists on three.ws only
 * when the site is being viewed inside the iOS app. Two properties matter more
 * than the rest and are pinned here.
 *
 * First, it must be inert in a browser. It is injected into 671 built pages, so
 * anything it does unconditionally, it does to every visitor on every surface.
 *
 * Second, isInternalUrl decides which links stay in the app's only WebView. Get
 * it wrong in the permissive direction and a tap on an off-site link navigates
 * the app away from three.ws with no back button to return; get it wrong in the
 * strict direction and ordinary in-app navigation bounces out to Safari.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ios native bridge', () => {
	let mod;

	beforeEach(async () => {
		vi.resetModules();
		vi.stubGlobal('document', {
			readyState: 'complete',
			addEventListener: vi.fn(),
			documentElement: { classList: { add: vi.fn() }, style: { setProperty: vi.fn() } },
		});
		vi.stubGlobal('location', { href: 'https://three.ws/create' });
		mod = await import('../ios/src/native-bridge.js');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reports a plain browser as not native', () => {
		expect(mod.isNativeIOS()).toBe(false);
	});

	it('installs nothing in a browser', () => {
		expect(mod.bootNativeIOS()).toBe(false);
		expect(document.documentElement.classList.add).not.toHaveBeenCalled();
	});

	it('leaves navigator untouched in a browser', async () => {
		// haptic() must be safe to call anywhere: surfaces invoke it directly.
		await expect(mod.haptic('heavy')).resolves.toBeUndefined();
		expect(globalThis.threeWsHaptic).toBeUndefined();
	});

	describe('isInternalUrl', () => {
		for (const href of [
			'/create',
			'#gallery',
			'?tab=agents',
			'https://three.ws/viewer?src=x',
			'https://www.three.ws/agents/1',
			'mailto:hi@three.ws',
			'threews://create',
		]) {
			it(`keeps ${href} in the app`, () => {
				expect(mod.isInternalUrl(href)).toBe(true);
			});
		}

		for (const href of [
			'https://solscan.io/tx/abc',
			'https://x.com/threews',
			'http://example.com',
			// A lookalike host is the case worth being explicit about: substring
			// matching on "three.ws" would hand the WebView to an attacker.
			'https://three.ws.evil.com/phish',
			'https://notthree.ws/',
		]) {
			it(`sends ${href} out to Safari`, () => {
				expect(mod.isInternalUrl(href)).toBe(false);
			});
		}
	});
});
