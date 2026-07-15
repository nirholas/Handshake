// Apple AR Quick Look banner. Quick Look is a sealed native viewer: no DOM, no
// JS, no tap-on-model events. The ONE piece of page-controlled UI Apple allows
// inside it is a bottom banner, declared as URL-fragment parameters on the USDZ
// link (checkoutTitle / checkoutSubtitle / callToAction). Tapping that banner
// fires a `message` event back on the <a rel="ar"> anchor that launched the
// session, which is the only in-AR tap a web page can ever receive on iOS.
// https://developer.apple.com/documentation/arkit/adding-an-apple-pay-button-or-a-custom-action-in-ar-quick-look

// Quick Look renders the banner on one line on a phone and truncates long
// strings itself; clamp fields so a runaway prompt-as-name can't fill the URL.
const FIELD_MAX = 80;

// The literal `message` event data Safari delivers on a banner tap.
export const QUICK_LOOK_BANNER_TAPPED = '_apple_ar_quicklook_button_tapped';

// Append banner fields to a USDZ URL as Quick Look fragment parameters,
// preserving any fragment already present (Quick Look reads params joined by
// `&`). Plain string surgery, never `new URL()`: the USDZ here is often a
// blob: object URL from the in-browser bake, which URL parsing would mangle.
// No usable fields returns the URL untouched, so callers can pass options
// unconditionally.
export function withQuickLookBanner(url, { title, subtitle, callToAction } = {}) {
	if (typeof url !== 'string' || !url) return url;
	const params = [];
	const push = (key, value) => {
		const v = typeof value === 'string' ? value.trim().slice(0, FIELD_MAX) : '';
		if (v) params.push(`${key}=${encodeURIComponent(v)}`);
	};
	push('checkoutTitle', title);
	push('checkoutSubtitle', subtitle);
	push('callToAction', callToAction);
	if (!params.length) return url;
	const joined = params.join('&');
	return url.includes('#') ? `${url}&${joined}` : `${url}#${joined}`;
}
