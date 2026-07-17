// Conservative detection for "we are running inside a Solana Mobile TWA on a
// Seeker or Saga device". Used to gate Mobile Wallet Adapter (MWA) signing —
// when this returns true, we should NOT touch window.solana and should route
// every signing call through the MWA protocol to the on-device Seed Vault.
//
// We deliberately AND multiple signals together. Any single one (matchMedia
// standalone, a UA substring, document.referrer) can false-positive on
// installed PWAs in regular Chrome. We want zero false positives on desktop,
// at the cost of a few false negatives on weird Android setups (in which
// case the user just falls back to the standard browser wallet flow).

const TWA_PACKAGE_ID = 'ws.three.app';
const SEEKER_HINTS = [
	'Seeker',
	'SAGA',
	'solana mobile',
	'SolanaMobile',
];

function safeMatchMedia(query) {
	try {
		return typeof window !== 'undefined' && window.matchMedia(query).matches;
	} catch {
		return false;
	}
}

function isStandalone() {
	if (typeof window === 'undefined') return false;
	if (safeMatchMedia('(display-mode: standalone)')) return true;
	if (safeMatchMedia('(display-mode: fullscreen)')) return true;
	// iOS only — TWAs are Android, but harmless guard.
	if (window.navigator?.standalone === true) return true;
	return false;
}

function isAndroidWebView() {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent || '';
	if (!/Android/i.test(ua)) return false;
	// TWAs run inside Chrome Custom Tabs / Trusted Web Activity. The
	// `Chrome/` token is present and `wv` (the classic WebView marker) is
	// absent in TWAs — but we don't strictly require that, since some OEM
	// stacks add `; wv`.
	return /Chrome\//.test(ua);
}

function isFromTwaReferrer() {
	if (typeof document === 'undefined') return false;
	const ref = document.referrer || '';
	if (ref.startsWith(`android-app://${TWA_PACKAGE_ID}`)) return true;
	return false;
}

// Any Android app referrer (not necessarily our exact package id). A TWA always
// sets document.referrer to `android-app://<launcher-package>`; a plain
// installed PWA has an empty referrer and desktop never sets this. Combined
// with standalone + Android below, this catches real Seeker TWAs whose UA does
// NOT carry a "Seeker"/"SAGA" hint — the previous AND-of-UA-hint gate
// false-negatived those and silently dropped them onto the browser-wallet path.
function isFromAnyAndroidAppReferrer() {
	if (typeof document === 'undefined') return false;
	return (document.referrer || '').startsWith('android-app://');
}

function isDeviceHintedSeeker() {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent || '';
	const model = navigator.userAgentData?.platform || '';
	return SEEKER_HINTS.some((hint) => ua.includes(hint) || model.includes(hint));
}

function hasMwaIntent() {
	// Solana Mobile Stack devices register a content provider that the MWA
	// JS library probes via fetch('intent:#Intent;...'). We can't probe it
	// from this synchronous helper, but presence of the global the SMS
	// browser polyfill exposes is a strong signal.
	if (typeof window === 'undefined') return false;
	// @solana-mobile/wallet-adapter-mobile sets these once initialised; in a
	// fresh TWA they're not yet present, so we don't require them.
	return Boolean(
		window.__solana_mobile_wallet_adapter_session__
			|| window.__SOLANA_MOBILE_STACK__
			|| window.SolanaMobileWalletAdapter,
	);
}

/**
 * Returns true when the page is rendered inside the three.ws Solana Mobile
 * TWA (Seeker / Saga). Safe to call before any wallet code loads.
 */
export function isSolanaMobileTwa() {
	if (typeof window === 'undefined') return false;
	// Hard signal: direct referrer from our TWA package.
	if (isFromTwaReferrer()) return true;
	// Combined signals under standalone Android Chrome. Standalone alone isn't
	// enough (installed PWAs on phones look identical) — each needs a second
	// Android-app-context signal so desktop and plain mobile PWAs never match:
	//   • launched from an Android app (TWA referrer, any package), or
	//   • the device advertises a Seeker/SAGA hint, or
	//   • the MWA runtime is already present.
	if (isStandalone() && isAndroidWebView()) {
		if (isFromAnyAndroidAppReferrer()) return true;
		if (isDeviceHintedSeeker()) return true;
		if (hasMwaIntent()) return true;
	}
	return false;
}

/**
 * Async capability probe: "could Mobile Wallet Adapter actually be used here?"
 * MWA needs a secure context, an Android browser, and the transport library to
 * load. Unlike isSolanaMobileTwa() (which gates whether we OWN window.solana),
 * this answers whether it's worth OFFERING a "Sign with Seed Vault" affordance
 * — e.g. on a Seeker's regular browser outside the TWA shell.
 *
 * @returns {Promise<boolean>}
 */
export async function isMwaSupported() {
	if (typeof window === 'undefined') return false;
	if (!isAndroidMobile()) return false;
	// MWA association requires a secure context (https or localhost).
	if (window.isSecureContext === false) return false;
	try {
		const mod = await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
		return typeof mod.transact === 'function';
	} catch {
		return false;
	}
}

/**
 * Looser check: just "is this an Android browser context where MWA could be
 * available?" — used to decide whether it's worth lazy-loading the MWA
 * libraries. Returns true for Seeker browser sessions as well as in-TWA.
 */
export function isAndroidMobile() {
	if (typeof navigator === 'undefined') return false;
	return /Android/i.test(navigator.userAgent || '');
}

/**
 * Returns true when the device is *likely* a Solana Mobile device (Seeker or
 * Saga). May be used to surface "Sign with Seed Vault" affordances even
 * outside the TWA shell.
 */
export function isSolanaMobileDevice() {
	return isAndroidMobile() && isDeviceHintedSeeker();
}
