// iOS Quick Look — opens a USDZ companion using the <a rel="ar"> trick.
// Safari activates Quick Look when an anchor with rel="ar" is activated
// programmatically, which avoids requiring a real user gesture on a link.

import { QUICK_LOOK_BANNER_TAPPED } from './quicklook-banner.js';

function isIOS() {
	return (
		/iphone|ipad|ipod/i.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

export function canUseQuickLook() {
	return isIOS();
}

// Safari delivers the Quick Look banner-tap `message` event on the anchor that
// launched the session, so the anchor must stay in the DOM while the viewer is
// open. One live anchor at a time: replacing it on the next launch drops the
// previous listener with it.
let _anchor = null;

export function openQuickLook(usdzURI, { onBannerTap } = {}) {
	if (_anchor) { _anchor.remove(); _anchor = null; }
	const a = document.createElement('a');
	a.rel = 'ar';
	a.href = usdzURI;
	// iOS requires a child element to trigger Quick Look on programmatic .click()
	a.appendChild(document.createElement('img'));
	// Present but invisible. Not display:none: hidden-from-layout anchors are
	// not reliably activated by Quick Look, so park it off-interaction instead.
	a.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
	a.setAttribute('aria-hidden', 'true');
	if (typeof onBannerTap === 'function') {
		a.addEventListener('message', (e) => {
			if (e.data === QUICK_LOOK_BANNER_TAPPED) onBannerTap();
		});
	}
	document.body.appendChild(a);
	_anchor = a;
	a.click();
}
