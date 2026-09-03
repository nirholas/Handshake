// Surface presets for /drive.
//
// The same page renders on four physically different panels: a CarPlay-era
// phone in a cradle, an Android Auto phone, a built-in head unit browser
// (Tesla, Android Automotive), and a desktop preview. They differ in viewing
// distance, safe area, and whether a keyboard is reachable at all, so the page
// reads one preset at boot and everything else scales off it.
//
// `?surface=` wins when present, because the native shells pass it explicitly.

/** @typedef {'carplay'|'androidauto'|'headunit'|'cradle'|'browser'} SurfaceName */

const NAMES = new Set(['carplay', 'androidauto', 'headunit', 'cradle', 'browser']);

/**
 * Which panel are we on? An explicit `?surface=` beats detection; a native
 * shell that injected its message channel identifies itself; a standalone
 * install on a coarse pointer is a phone in a mount; everything else is a
 * browser preview.
 * @returns {SurfaceName}
 */
export function detectSurface(search = typeof location !== 'undefined' ? location.search : '') {
	const asked = new URLSearchParams(search).get('surface');
	if (asked && NAMES.has(asked)) return /** @type {SurfaceName} */ (asked);
	if (typeof window === 'undefined') return 'browser';
	if (window.webkit?.messageHandlers?.threeWsDrive) return 'carplay';
	if (window.ThreeWsDriveNative) return 'androidauto';
	const standalone =
		window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone;
	const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
	if (standalone && coarse) return 'cradle';
	return 'browser';
}

/**
 * Glyph scale. A head unit is roughly a metre from the driver's eyes, twice a
 * phone's distance, so it gets a bigger multiplier; a short dash panel gets a
 * smaller one because the vertical budget, not legibility, is the constraint.
 */
export function scaleFor(surface, width, height) {
	let scale = 1;
	if (height < 420) scale = 0.78;
	else if (height < 560) scale = 0.9;
	else if (height >= 900) scale = 1.12;
	if (surface === 'headunit') scale += 0.1;
	if (surface === 'browser' && width >= 1400) scale = Math.min(scale, 1);
	return Math.round(scale * 100) / 100;
}

/**
 * Everything the page needs to know about the panel it is on.
 * `keyboard` is whether a keyboard is reachable at all: on a CarPlay or Android
 * Auto shell the web view lives on the phone, which is in a mount and out of
 * reach, so the Type affordance is hidden rather than merely disabled.
 */
export function surfaceProfile(surface = detectSurface()) {
	return {
		surface,
		keyboard: surface !== 'carplay' && surface !== 'androidauto',
		// A native shell owns the car screen's own listening indicator, so the
		// page mirrors its state outward instead of assuming it is alone.
		native: surface === 'carplay' || surface === 'androidauto',
		// Hands free is opt-in everywhere, but a car panel is the only place it
		// is the better default once the driver has enabled it once.
		remembersHandsFree: surface !== 'browser',
	};
}

/**
 * Apply the preset to the document: a `data-drive-surface` hook for CSS and the
 * `--dr-scale` multiplier every size in the stylesheet is expressed in.
 * Returns a teardown that removes the resize listener.
 */
export function applySurface(profile, doc = document, win = window) {
	const root = doc.documentElement;
	root.setAttribute('data-drive-surface', profile.surface);
	const sync = () => {
		const scale = scaleFor(profile.surface, win.innerWidth, win.innerHeight);
		root.style.setProperty('--dr-scale', String(scale));
	};
	sync();
	win.addEventListener('resize', sync, { passive: true });
	return () => win.removeEventListener('resize', sync);
}
