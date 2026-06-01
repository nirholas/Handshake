/**
 * three.ws — universal top-left brand mark.
 *
 * Guarantees a single, consistent top-left logo on every standalone page.
 * The site grew a dozen different header treatments (wordmark lockups, dashboard
 * rails, `header-logo`, bare `<img>`s, page-specific classes, and pages with no
 * logo at all). Rather than rewrite every header, this fills the gap: if a page
 * already shows a top-left brand it is left untouched; if it shows none, a
 * tasteful fixed brand chip is injected linking back home.
 *
 * Chromeless surfaces (embeds, widgets, iframes) opt out with either:
 *     <html data-no-brand-mark>
 *     <meta name="brand-mark" content="off" />
 */
(function () {
	if (window.__threeBrandMark) return;
	window.__threeBrandMark = true;

	if (document.documentElement.hasAttribute('data-no-brand-mark')) return;
	if (document.querySelector('meta[name="brand-mark"][content="off"]')) return;
	// Inside an iframe the host already frames us — never overlay a logo.
	try {
		if (window.self !== window.top) return;
	} catch (_) {
		return;
	}

	// Known brand classes used across the site's many headers/shells.
	var BRAND_SELECTORS = [
		'.brand-mark',
		'.wordmark-logo',
		'.header-logo',
		'.dn-rail-full',
		'.nxt-brand-mark',
		'.agent-header-logo',
		'.pg-header-logo',
		'[data-brand-mark]',
	].join(',');

	// Things that, when they sit in the top-left corner, mean the corner is
	// already taken — either by an existing brand or by a control (hamburger,
	// back/close button, home link) the chip must not cover.
	var CORNER_OCCUPANTS =
		'a[href="/"],a[href="/home"],button,summary,[class*="burger" i],[class*="hamburger" i],[class*="menu-toggle" i],[aria-label*="menu" i],[aria-label*="back" i],[aria-label*="home" i]';

	function inOwnChip(el) {
		return !!(el.closest && el.closest('.brand-mark-chip'));
	}

	// True when the element is rendered in the top-left corner. `maxWidth` lets
	// us treat only logo/icon-sized images as brands (a full-bleed hero that
	// happens to start at 0,0 should not block the mark).
	function inCorner(el, maxWidth) {
		if (inOwnChip(el)) return false;
		var r = el.getBoundingClientRect();
		if (!(r.width > 0 && r.height > 0)) return false;
		if (maxWidth && r.width > maxWidth) return false;
		return r.top < 104 && r.left < 232;
	}

	function anyInCorner(selector, maxWidth) {
		var nodes = document.querySelectorAll(selector);
		for (var i = 0; i < nodes.length; i++) {
			if (inCorner(nodes[i], maxWidth)) return true;
		}
		return false;
	}

	function hasExistingBrand() {
		// 1. A known brand element exists anywhere — the page is already branded.
		var named = document.querySelectorAll(BRAND_SELECTORS);
		for (var i = 0; i < named.length; i++) {
			if (!inOwnChip(named[i])) return true;
		}
		// 2. A logo/icon image or inline SVG occupies the top-left corner.
		if (anyInCorner('img,svg', 360)) return true;
		// 3. A brand wordmark or nav control occupies the top-left corner.
		if (anyInCorner(CORNER_OCCUPANTS)) return true;
		return false;
	}

	function ensureStyles() {
		if (document.getElementById('three-brand-mark-style')) return;
		var style = document.createElement('style');
		style.id = 'three-brand-mark-style';
		style.textContent = [
			'.brand-mark-chip{',
			'position:fixed;top:14px;left:16px;z-index:60;',
			'display:inline-flex;align-items:center;justify-content:center;',
			'width:36px;height:36px;border-radius:9px;',
			'background:rgba(12,12,16,.55);',
			'-webkit-backdrop-filter:blur(10px) saturate(140%);',
			'backdrop-filter:blur(10px) saturate(140%);',
			'box-shadow:0 1px 2px rgba(0,0,0,.28),inset 0 0 0 1px rgba(255,255,255,.07);',
			'opacity:0;transform:translateY(-4px);',
			'transition:opacity .22s ease,transform .22s ease,box-shadow .18s ease,background .18s ease;',
			'-webkit-tap-highlight-color:transparent;',
			'}',
			'.brand-mark-chip.is-in{opacity:1;transform:none;}',
			'.brand-mark-chip:hover{background:rgba(12,12,16,.72);box-shadow:0 6px 18px rgba(0,0,0,.32),inset 0 0 0 1px rgba(255,255,255,.12);}',
			'.brand-mark-chip:focus-visible{outline:2px solid #6e8bff;outline-offset:2px;}',
			'.brand-mark-chip .brand-mark{display:block;width:24px;height:24px;border-radius:5px;}',
			'@media (max-width:560px){.brand-mark-chip{top:10px;left:10px;width:34px;height:34px;}}',
			'@media (prefers-reduced-motion:reduce){.brand-mark-chip{transition:none;transform:none;}}',
			'@media print{.brand-mark-chip{display:none;}}',
		].join('');
		document.head.appendChild(style);
	}

	function injectChip() {
		if (document.querySelector('.brand-mark-chip')) return;
		var a = document.createElement('a');
		a.className = 'brand-mark-chip';
		a.href = '/';
		a.setAttribute('aria-label', 'three.ws — home');
		a.innerHTML =
			'<img class="brand-mark" src="/three.svg" alt="three.ws" width="24" height="24" />';
		document.body.appendChild(a);
		requestAnimationFrame(function () {
			a.classList.add('is-in');
		});
	}

	function removeChip() {
		var chip = document.querySelector('.brand-mark-chip');
		if (chip) chip.remove();
	}

	function run() {
		ensureStyles();
		if (hasExistingBrand()) return;
		injectChip();
		// Some pages render their chrome asynchronously (JS-mounted dashboard
		// rails, hydrated headers). Re-check briefly and retract the chip if a
		// real brand appears, so the page never shows two logos.
		var checks = 0;
		var timer = setInterval(function () {
			checks++;
			if (hasExistingBrand()) {
				removeChip();
				clearInterval(timer);
			} else if (checks >= 8) {
				clearInterval(timer);
			}
		}, 250);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', run);
	} else {
		run();
	}
})();
