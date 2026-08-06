/**
 * Declarative <img> failure handling, without inline onerror attributes.
 *
 * The site's Content-Security-Policy allows inline <script> blocks by hash and
 * nothing else, so `onerror="..."` attributes no longer run. Most of ours were
 * built inside template literals with interpolated URLs anyway, which no hash
 * could ever cover. This replaces all of them with one delegated listener.
 *
 * Load it once per page:
 *   <script src="/img-fallback.js" defer></script>
 *
 * Then describe the failure behaviour on the image itself:
 *
 *   data-fallback-src="URL"    swap to URL on the first failure. If URL also
 *                              fails, the element is removed unless
 *                              data-fallback names something else to do.
 *   data-fallback="hide"       display:none
 *   data-fallback="invisible"  visibility:hidden (keeps the layout box)
 *   data-fallback="remove"     drop the element
 *   data-fallback="sibling"    hide the image and reveal its next element
 *                              sibling (display from data-fallback-display,
 *                              default "flex")
 *   data-fallback="text"       replace the image with data-fallback-text
 *   data-fallback="parent-text" hide the image and set the parent's text to
 *                              data-fallback-text
 *
 * `error` does not bubble, so the listener is registered in the capture phase.
 * That also means images added to the DOM later are covered with no re-init:
 * a page can render markup whenever it likes and the behaviour still applies.
 */
(function () {
	'use strict';
	if (window.__imgFallbackInstalled) return;
	window.__imgFallbackInstalled = true;

	const HANDLED = '__imgFallbackDone';

	function reveal(el, display) {
		if (el instanceof HTMLElement) el.style.display = display || 'flex';
	}

	function apply(img) {
		const mode = img.dataset.fallback || '';
		switch (mode) {
			case 'hide':
				img.style.display = 'none';
				return;
			case 'invisible':
				img.style.visibility = 'hidden';
				return;
			case 'remove':
				img.remove();
				return;
			case 'sibling':
				img.style.display = 'none';
				reveal(img.nextElementSibling, img.dataset.fallbackDisplay);
				return;
			case 'text':
				img.replaceWith(document.createTextNode(img.dataset.fallbackText || ''));
				return;
			case 'parent-text':
				img.style.display = 'none';
				if (img.parentElement) img.parentElement.textContent = img.dataset.fallbackText || '';
				return;
			default:
				// A data-fallback-src that has already been tried and failed leaves
				// nothing sensible on screen, so drop the broken image.
				img.remove();
		}
	}

	document.addEventListener(
		'error',
		function (event) {
			const img = event.target;
			if (!(img instanceof HTMLImageElement)) return;
			if (img[HANDLED]) return;

			const swap = img.dataset.fallbackSrc;
			if (swap && img.getAttribute('src') !== swap) {
				// One retry only: if the fallback image is itself broken, the next
				// error runs the declared mode instead of looping.
				img.setAttribute('src', swap);
				return;
			}
			img[HANDLED] = true;
			apply(img);
		},
		true,
	);
})();
