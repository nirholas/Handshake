// Web-side half of the three.ws iOS app.
//
// The iOS app is a Capacitor shell whose WebView loads the live product at
// https://three.ws (see ios/capacitor.config.ts for why it is not a baked-in
// copy of dist/). Capacitor injects its native bridge into that page at document
// start, so `window.Capacitor` is present on the real site whenever it is being
// viewed inside the app and absent in every browser. This module is what turns
// that fact into app behaviour: it repairs the WKWebView APIs that a website
// normally gets for free, routes off-site links out to Safari, handles deep
// links, and hides the launch screen once there is something to look at.
//
// It is a no-op outside the app, which is why it is safe to load on every page.
// Wired in by the `three-ws-ios-native-bridge` plugin in vite.config.js.
//
// The Android/Seeker equivalent is solana-mobile/src/, which follows the same
// shape: detection first, then capability shims, then a single boot function.

let cachedNative = null;

/**
 * True when this page is running inside the three.ws iOS app.
 *
 * `Capacitor.isNativePlatform()` is the only honest signal. User-agent sniffing
 * cannot tell the app from Safari (WKWebView sends the same UA), and
 * `navigator.standalone` reports true for a home-screen PWA, which is a
 * different runtime with none of these plugins.
 *
 * @returns {boolean}
 */
export function isNativeIOS() {
	if (cachedNative !== null) return cachedNative;
	const cap = globalThis.Capacitor;
	cachedNative = Boolean(cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'ios');
	return cachedNative;
}

/**
 * Load a Capacitor plugin only inside the app.
 *
 * Every plugin package is a dependency of ios/package.json, not of the site
 * bundle, so these imports must never be statically analysable: a bare
 * `import '@capacitor/share'` in site code fails the Vite build on a machine
 * that has never touched the iOS project. Inside the app the plugins are
 * already registered natively and exposed on `Capacitor.Plugins`, so reading
 * them off the global is both correct and free.
 *
 * @param {string} name Registered plugin name, e.g. 'Share'.
 * @returns {object|null}
 */
function plugin(name) {
	if (!isNativeIOS()) return null;
	return globalThis.Capacitor?.Plugins?.[name] ?? null;
}

// App-only chrome, injected as one stylesheet rather than shipped in the site's
// CSS, so it is loaded exactly where it applies and nowhere else.
//
// The bug it fixes is not cosmetic. In the app the WebView runs edge to edge
// (`contentInset: 'never'` here, `contentInsetAdjustmentBehavior = .never` in
// MainViewController.swift, `overlaysWebView` on the status bar), so the page
// begins at y=0 underneath the notch and the clock. The site's own status-bar
// padding lives behind `@media (display-mode: standalone)` in public/mobile.css,
// which matches an installed PWA and NOT a WKWebView loading a remote URL, so
// none of it applies here and the sticky header renders under the system clock.
//
// It targets `.nav` rather than the `<header>` that wraps it because `.nav` is
// the element that is `position: sticky; top: 0`: padding the wrapper moves the
// bar down once and then the sticky child slides back under the clock on the
// first scroll.
const APP_CHROME_CSS = `
html.ios-app .nav {
	padding-top: env(safe-area-inset-top, 0px);
}
/* The drawer opens below a header whose height is now inset by the status bar,
   and 57px is the bar height public/nav.css hard-codes for the browser case. */
html.ios-app .nav-drawer {
	inset: calc(57px + env(safe-area-inset-top, 0px)) 0 0;
}
/* Anything pinned to the bottom edge has to clear the home indicator. */
html.ios-app main,
html.ios-app .stage {
	padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px));
}
/* Installing the app is the one thing a visitor inside the app cannot do. */
html.ios-app [data-install-prompt],
html.ios-app .pwa-install-prompt {
	display: none !important;
}
/* iOS zooms the whole page when a font-size under 16px takes focus, and never
   zooms back out. Every form on the platform is reachable in the app. */
html.ios-app input,
html.ios-app select,
html.ios-app textarea {
	font-size: max(16px, 1em);
}
`;

/**
 * Marks the document and installs the app-only stylesheet.
 *
 * `html.ios-app` is also a hook for any surface that needs to know: the
 * `--ios-safe-top` / `--ios-safe-bottom` custom properties mirror the env()
 * values so they can be used in nested calc(), which some WebKit versions still
 * mis-handle when env() is written inline.
 */
function markDocument() {
	const root = document.documentElement;
	root.classList.add('ios-app', 'native-app');
	root.style.setProperty('--ios-safe-top', 'env(safe-area-inset-top, 0px)');
	root.style.setProperty('--ios-safe-bottom', 'env(safe-area-inset-bottom, 0px)');

	if (document.getElementById('three-ws-ios-chrome')) return;
	const style = document.createElement('style');
	style.id = 'three-ws-ios-chrome';
	style.textContent = APP_CHROME_CSS;
	// Into <head> ahead of nothing in particular: these are single-class rules
	// that already outrank the element and utility selectors they correct.
	(document.head || root).appendChild(style);
}

/**
 * Hides the launch screen once the first real frame is on screen.
 *
 * capacitor.config.ts sets `launchAutoHide: false` deliberately. Auto-hide fires
 * on WebView load, which on a three.js page is minutes before anything is
 * rendered, so the user watches a black void instead of the launch screen. The
 * WebGL surfaces here mount asynchronously, so the trigger is the first paint of
 * real content plus a hard ceiling: a page that never paints must still reveal
 * itself rather than hold the launch screen forever.
 */
function hideSplashWhenPainted() {
	const splash = plugin('SplashScreen');
	if (!splash) return;
	let done = false;
	const hide = () => {
		if (done) return;
		done = true;
		splash.hide({ fadeOutDuration: 220 }).catch(() => {});
	};
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(() => requestAnimationFrame(hide));
	}
	// Ceiling. A failed fetch, a WebGL context that never initialises, or a
	// backgrounded tab can all starve rAF; none of them justify a stuck splash.
	setTimeout(hide, 4000);
	window.addEventListener('pageshow', hide, { once: true });
}

/** Chooses the light status bar content the dark product needs. */
function styleStatusBar() {
	const bar = plugin('StatusBar');
	if (!bar) return;
	// 'DARK' in Capacitor's vocabulary means dark *background*, i.e. light text.
	bar.setStyle({ style: 'DARK' }).catch(() => {});
	bar.setOverlaysWebView({ overlay: true }).catch(() => {});
}

const INTERNAL_HOSTS = new Set(['three.ws', 'www.three.ws']);

/**
 * @param {string} href
 * @returns {boolean} true when the URL belongs to the product itself.
 */
export function isInternalUrl(href) {
	try {
		const url = new URL(href, location.href);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
		return INTERNAL_HOSTS.has(url.hostname);
	} catch {
		// A malformed href is a same-document anchor or a broken link; either way
		// it is not something to hand to the system browser.
		return true;
	}
}

/**
 * Sends off-site links to an in-app Safari sheet instead of replacing the app.
 *
 * Without this, tapping a link to a block explorer, a docs site, or an X post
 * navigates the app's only WebView away from three.ws with no way back: iOS has
 * no back button and Capacitor's WebView ships with back/forward gestures off.
 * Apple also rejects apps that run third-party sign-in inside an embedded
 * WebView, which is the other reason this cannot be left to the WebView.
 */
function routeExternalLinks() {
	const browser = plugin('Browser');
	if (!browser) return;
	document.addEventListener(
		'click',
		(ev) => {
			if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey) return;
			const anchor = ev.target?.closest?.('a[href]');
			if (!anchor) return;
			const href = anchor.getAttribute('href');
			if (!href || href.startsWith('#') || isInternalUrl(href)) return;
			// download links are the one external case that must stay native: the
			// share sheet handles them, an in-app browser sheet cannot.
			if (anchor.hasAttribute('download')) return;
			ev.preventDefault();
			browser
				.open({ url: new URL(href, location.href).href, presentationStyle: 'popover' })
				.catch(() => {
					// Sheet refused (no network, malformed scheme): fall back to the
					// plain navigation rather than swallowing the user's tap.
					location.href = href;
				});
		},
		// Capture, so this wins over per-surface click handlers that would
		// otherwise stopPropagation() before the link is ever seen.
		true,
	);
}

/**
 * Gives the app a working `navigator.share`.
 *
 * WKWebView does not implement the Web Share API: it exists only in Safari
 * proper. Every share affordance on the platform (an AR capture, an /irl/s/
 * link, an agent profile) calls navigator.share and silently does nothing
 * inside the app. This maps it onto the native share sheet, including the file
 * case, which needs the blob written to disk first because the Share plugin
 * takes file URIs and not Blobs.
 */
function installShare() {
	const share = plugin('Share');
	const fs = plugin('Filesystem');
	if (!share) return;
	if (typeof navigator.share === 'function') return;

	async function blobToCacheUri(file) {
		if (!fs) return null;
		const base64 = await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(reader.error ?? new Error('read failed'));
			reader.onload = () => {
				const result = String(reader.result ?? '');
				// FileReader hands back a data: URL; the plugin wants raw base64.
				resolve(result.slice(result.indexOf(',') + 1));
			};
			reader.readAsDataURL(file);
		});
		const name = file.name || `three-ws-${Date.now()}`;
		// CACHE, not DOCUMENTS: these are transient artefacts of one share and
		// should not accumulate in a directory the user can browse or back up.
		const written = await fs.writeFile({ path: name, data: base64, directory: 'CACHE' });
		return written?.uri ?? null;
	}

	navigator.share = async (data = {}) => {
		const files = Array.isArray(data.files) ? data.files : [];
		const uris = [];
		for (const file of files) {
			const uri = await blobToCacheUri(file);
			if (uri) uris.push(uri);
		}
		await share.share({
			title: data.title || undefined,
			text: data.text || undefined,
			url: data.url || undefined,
			files: uris.length ? uris : undefined,
			dialogTitle: data.title || 'Share',
		});
	};

	// Callers feature-detect with canShare before offering the affordance.
	navigator.canShare = (data = {}) => {
		if (!data || typeof data !== 'object') return false;
		if (Array.isArray(data.files) && data.files.length) return Boolean(fs);
		return Boolean(data.url || data.text || data.title);
	};
}

/**
 * Routes universal links and threews:// deep links to the right page.
 *
 * An https://three.ws link caught by the associated-domains entitlement, and a
 * threews://<path> link from a wallet or OAuth redirect, both arrive here rather
 * than as a navigation. Anything off-domain is refused outright: appUrlOpen is
 * an entry point another app can call, so treating its payload as a navigation
 * target without checking the host would let any installed app push the WebView
 * wherever it liked.
 */
function routeDeepLinks() {
	const app = plugin('App');
	if (!app) return;
	app.addListener('appUrlOpen', (event) => {
		const raw = event?.url;
		if (!raw) return;
		let target = null;
		try {
			const url = new URL(raw);
			if (url.protocol === 'threews:') {
				// threews://create?x=1 -> /create?x=1. The custom scheme puts the
				// first path segment in `hostname`, which is a URL parsing quirk and
				// not a host in any meaningful sense.
				const path = `${url.hostname ? `/${url.hostname}` : ''}${url.pathname}`;
				// threews://glance/link?token=glw_... is the home screen widget's
				// credential, and SceneDelegate.swift has already taken it into the
				// keychain. It is not a page, and navigating here would put a live
				// token in the address bar of a WebView, so it stops at this line.
				if (path === '/glance/link') return;
				target = `https://three.ws${path || '/'}${url.search}${url.hash}`;
			} else if (INTERNAL_HOSTS.has(url.hostname)) {
				target = url.href;
			}
		} catch {
			return;
		}
		if (!target) return;
		if (target === location.href) return;
		location.assign(target);
	});
}

/**
 * Short haptic tick for primary actions.
 *
 * Exposed as `window.threeWsHaptic` so surfaces can call it without importing
 * anything, and wired to `[data-haptic]` so the common case needs no JS at all.
 * Silently absent outside the app, which is the correct behaviour: a browser
 * has nothing to buzz.
 *
 * @param {'light'|'medium'|'heavy'} [strength]
 */
export async function haptic(strength = 'light') {
	const haptics = plugin('Haptics');
	if (!haptics) return;
	const style = { light: 'LIGHT', medium: 'MEDIUM', heavy: 'HEAVY' }[strength] ?? 'LIGHT';
	await haptics.impact({ style }).catch(() => {});
}

// Actions worth a tick, and how hard. `[data-haptic]` is the explicit opt-in for
// a surface that wants one somewhere else; the rest are the platform's real
// primary-action classes from public/buttons.css, so the feedback arrives on
// the buttons that commit something without any page having to be edited.
// Deliberately not every button: a tick on a tab, a filter chip or a disclosure
// toggle stops meaning anything, which is worse than no haptics at all.
const HAPTIC_TARGETS = [
	['[data-haptic]', null],
	['.btn--danger', 'medium'],
	['.btn--forge', 'medium'],
	['.btn--primary', 'light'],
	['button[type="submit"]', 'light'],
];

function installHaptics() {
	if (!isNativeIOS()) return;
	globalThis.threeWsHaptic = haptic;
	document.addEventListener(
		'click',
		(ev) => {
			const target = ev.target;
			if (!target?.closest) return;
			for (const [selector, strength] of HAPTIC_TARGETS) {
				const el = target.closest(selector);
				if (!el) continue;
				// A disabled or busy control did not do anything, so it must not
				// feel as though it did.
				if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
				if (el.getAttribute('aria-busy') === 'true') return;
				haptic(strength ?? el.getAttribute('data-haptic') ?? 'light');
				return;
			}
		},
		true,
	);
}

let booted = false;

/**
 * Boots every app-only behaviour. Safe to call more than once and on every page.
 *
 * @returns {boolean} true if the app layer was installed, false in a browser.
 */
export function bootNativeIOS() {
	if (booted) return isNativeIOS();
	booted = true;
	if (!isNativeIOS()) return false;
	markDocument();
	styleStatusBar();
	installShare();
	installHaptics();
	routeExternalLinks();
	routeDeepLinks();
	hideSplashWhenPainted();
	return true;
}

// Auto-boot. This module is injected into every page of the built site, and the
// behaviours it installs (share, external links, splash) are all things a page
// can need before any of its own code runs.
if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bootNativeIOS, { once: true });
	} else {
		bootNativeIOS();
	}
}
