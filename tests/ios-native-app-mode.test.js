// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://three.ws/create" }
/**
 * The iOS bridge with the app actually present.
 *
 * ios-native-bridge.test.js pins the browser case, where the module must be
 * inert. This one pins the half that only ever runs on a phone, which is
 * exactly the half nobody can eyeball in a browser: it needs a real Capacitor
 * global, so without a test it is verified for the first time on a device, in
 * TestFlight, by a person who has to guess why a header is under the clock.
 *
 * The status-bar padding is the rule most worth pinning. In the app the WebView
 * runs edge to edge and the page starts at y=0 under the notch, and the site's
 * own compensation is behind `@media (display-mode: standalone)`, which a
 * WKWebView loading a remote URL does not match. If the injected stylesheet
 * stops targeting the sticky header, every page on the platform quietly renders
 * its nav under the system clock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Minimal stand-in for the plugins Capacitor registers natively. */
function fakeCapacitor() {
	const calls = [];
	const record =
		(name) =>
		(...args) => {
			calls.push([name, ...args]);
			return Promise.resolve({});
		};
	return {
		calls,
		isNativePlatform: () => true,
		getPlatform: () => 'ios',
		Plugins: {
			SplashScreen: { hide: record('SplashScreen.hide') },
			StatusBar: {
				setStyle: record('StatusBar.setStyle'),
				setOverlaysWebView: record('StatusBar.setOverlaysWebView'),
			},
			Browser: { open: record('Browser.open') },
			Share: { share: record('Share.share') },
			Filesystem: {
				writeFile: (opts) => {
					calls.push(['Filesystem.writeFile', opts]);
					return Promise.resolve({ uri: `file:///cache/${opts.path}` });
				},
			},
			Haptics: { impact: record('Haptics.impact') },
			App: {
				addListener: (event, handler) => {
					calls.push(['App.addListener', event]);
					fakeCapacitor.lastUrlHandler = handler;
					return Promise.resolve({ remove() {} });
				},
			},
		},
	};
}

describe('ios native bridge, running inside the app', () => {
	let cap;
	let mod;

	beforeEach(async () => {
		vi.resetModules();
		document.head.innerHTML = '';
		document.body.innerHTML = '';
		document.documentElement.className = '';
		cap = fakeCapacitor();
		vi.stubGlobal('Capacitor', cap);
		mod = await import('../ios/src/native-bridge.js');
		mod.bootNativeIOS();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete navigator.share;
		delete navigator.canShare;
		delete globalThis.threeWsHaptic;
	});

	it('marks the document so app-only CSS can apply', () => {
		expect(document.documentElement.classList.contains('ios-app')).toBe(true);
	});

	it('pads the sticky header out from under the status bar', () => {
		const css = document.getElementById('three-ws-ios-chrome')?.textContent ?? '';
		// `.nav`, not the <header> that wraps it: .nav is the element that is
		// position:sticky;top:0, so padding the wrapper is undone by the first
		// scroll. public/nav.css line 40 is the rule this compensates for.
		expect(css).toMatch(/html\.ios-app \.nav \{\s*padding-top: env\(safe-area-inset-top/);
	});

	it('offsets the nav drawer by the same inset it moved the header by', () => {
		const css = document.getElementById('three-ws-ios-chrome').textContent;
		expect(css).toContain('calc(57px + env(safe-area-inset-top, 0px))');
	});

	it('keeps form fields at 16px so focusing one cannot zoom the page', () => {
		const css = document.getElementById('three-ws-ios-chrome').textContent;
		expect(css).toMatch(/html\.ios-app input,[\s\S]*?font-size: max\(16px/);
	});

	it('injects the stylesheet once, however often it boots', () => {
		mod.bootNativeIOS();
		expect(document.querySelectorAll('#three-ws-ios-chrome')).toHaveLength(1);
	});

	it('gives the page a navigator.share WKWebView does not have', async () => {
		expect(typeof navigator.share).toBe('function');
		await navigator.share({ title: 'Agent', url: 'https://three.ws/agents/1' });
		const call = cap.calls.find((c) => c[0] === 'Share.share');
		expect(call[1]).toMatchObject({ title: 'Agent', url: 'https://three.ws/agents/1' });
	});

	it('writes a shared blob to cache first, because the plugin takes URIs not Blobs', async () => {
		const file = new File(['x'], 'capture.png', { type: 'image/png' });
		await navigator.share({ files: [file] });
		const written = cap.calls.find((c) => c[0] === 'Filesystem.writeFile');
		expect(written[1].directory).toBe('CACHE');
		expect(cap.calls.find((c) => c[0] === 'Share.share')[1].files).toEqual([
			'file:///cache/capture.png',
		]);
	});

	it('sends an off-site link to the Safari sheet instead of the app WebView', () => {
		document.body.innerHTML = '<a id="out" href="https://solscan.io/tx/abc">tx</a>';
		const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		document.getElementById('out').dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(cap.calls.find((c) => c[0] === 'Browser.open')[1].url).toBe('https://solscan.io/tx/abc');
	});

	it('leaves an in-app link to normal navigation', () => {
		document.body.innerHTML = '<a id="in" href="/create">create</a>';
		const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		document.getElementById('in').dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
		expect(cap.calls.some((c) => c[0] === 'Browser.open')).toBe(false);
	});

	it('leaves a download link alone, since a browser sheet cannot save a file', () => {
		document.body.innerHTML = '<a id="dl" href="https://cdn.example.com/a.glb" download>glb</a>';
		const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		document.getElementById('dl').dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
	});

	describe('haptics', () => {
		function tap(html) {
			// Count only what THIS tap produced: cap.calls accumulates for the
			// whole test, and boot itself makes plugin calls.
			const before = cap.calls.length;
			document.body.innerHTML = html;
			document.body.firstElementChild.dispatchEvent(
				new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
			);
			return cap.calls.slice(before).filter((c) => c[0] === 'Haptics.impact');
		}

		it('fires on a primary action with no markup change needed anywhere', () => {
			expect(tap('<button class="btn btn--primary">Create</button>')).toHaveLength(1);
		});

		it('hits harder on a destructive action', () => {
			expect(tap('<button class="btn btn--danger">Delete</button>')[0][1]).toEqual({
				style: 'MEDIUM',
			});
		});

		it('stays quiet on a control that did nothing', () => {
			expect(tap('<button class="btn btn--primary" disabled>Create</button>')).toHaveLength(0);
			expect(tap('<button class="btn btn--primary" aria-busy="true">Working</button>')).toHaveLength(0);
		});

		it('stays quiet on a secondary control, so the tick keeps meaning something', () => {
			expect(tap('<button class="btn btn--ghost">Cancel</button>')).toHaveLength(0);
		});

		it('honours an explicit opt-in anywhere else', () => {
			expect(tap('<div data-haptic="heavy">tip</div>')[0][1]).toEqual({ style: 'HEAVY' });
		});
	});

	it('hides the launch screen rather than holding it forever', async () => {
		vi.useFakeTimers();
		vi.resetModules();
		const fresh = await import('../ios/src/native-bridge.js');
		fresh.bootNativeIOS();
		vi.advanceTimersByTime(5000);
		vi.useRealTimers();
		expect(cap.calls.some((c) => c[0] === 'SplashScreen.hide')).toBe(true);
	});
});
