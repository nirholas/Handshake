/**
 * Declarative replacements for the inline handler attributes the CSP blocks.
 *
 * The site's Content-Security-Policy allows inline <script> by hash and nothing
 * else, so `onerror="..."`, `onclick="..."` and friends no longer run. Almost
 * all of ours were written inside template literals with interpolated values,
 * which no hash could ever cover. This file is where those behaviours live now:
 * markup declares its intent with a data-* attribute, and one delegated
 * listener per behaviour does the work.
 *
 * scripts/inject-inline-behaviors.mjs puts this on every built page, so any markup
 * anywhere on the site can use these attributes with nothing else to wire up.
 *
 * ── Broken images ────────────────────────────────────────────────────────────
 *   data-fallback-src="URL"     swap to URL on the first failure; if that fails
 *                               too, run data-fallback (default: remove).
 *   data-fallback="hide"        display:none
 *   data-fallback="invisible"   visibility:hidden (keeps the layout box)
 *   data-fallback="remove"      drop the element
 *   data-fallback="sibling"     hide it and reveal its next element sibling
 *                               (display from data-fallback-display, "flex")
 *   data-fallback="text"        replace it with data-fallback-text
 *   data-fallback="parent-text" hide it, set the parent's text instead
 *   data-fallback="element"     replace it with data-fallback-tag (default
 *                               "div") carrying data-fallback-class and
 *                               data-fallback-text
 *   data-fallback="closest"     remove the nearest data-fallback-closest match
 *   data-fallback="keep"        leave the broken image in place. Only useful
 *                               with data-fallback-parent-class, where CSS on
 *                               the container does the work.
 *
 *   data-fallback-parent-class  added to the parent element on failure, in
 *                               addition to whatever mode above runs. Lets CSS
 *                               restyle the container that lost its image.
 *
 * ── Clicks ───────────────────────────────────────────────────────────────────
 *   data-action="reload"        reload the page (retry buttons in error states)
 *   data-stop-propagation       a click inside this element does not reach any
 *                               ancestor listener. For a link inside a card
 *                               that is itself clickable: the link navigates,
 *                               the card does not also open.
 *
 * `error` does not bubble, so the image listener is registered in the capture
 * phase; that also means images added to the DOM later are covered with no
 * re-init. The stop-propagation listener is in the capture phase for a
 * different reason: it has to run before the ancestor listener it is cancelling.
 */
(function () {
	'use strict';
	if (window.__inlineBehaviorsInstalled) return;
	window.__inlineBehaviorsInstalled = true;

	const HANDLED = '__imgFallbackDone';

	function reveal(el, display) {
		if (el instanceof HTMLElement) el.style.display = display || 'flex';
	}

	function replacement(img) {
		const el = document.createElement(img.dataset.fallbackTag || 'div');
		if (img.dataset.fallbackClass) el.className = img.dataset.fallbackClass;
		el.textContent = img.dataset.fallbackText || '';
		return el;
	}

	// Only these values are ours. src/shared/news-render.js has its own
	// capture-phase handler that reads `data-fallback` as the initials to show,
	// so an unrecognised value means the image belongs to somebody else and this
	// listener must not touch it.
	const MODES = new Set([
		'hide',
		'invisible',
		'remove',
		'sibling',
		'text',
		'parent-text',
		'element',
		'closest',
		'keep',
	]);

	function apply(img) {
		if (img.dataset.fallbackParentClass && img.parentElement) {
			img.parentElement.classList.add(img.dataset.fallbackParentClass);
		}
		switch (img.dataset.fallback || '') {
			case 'hide':
				img.style.display = 'none';
				return;
			case 'invisible':
				img.style.visibility = 'hidden';
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
			case 'element':
				img.replaceWith(replacement(img));
				return;
			case 'closest': {
				const target = img.dataset.fallbackClosest && img.closest(img.dataset.fallbackClosest);
				(target || img).remove();
				return;
			}
			case 'keep':
				return;
			default:
				// "remove", plus an image whose data-fallback-src was tried and
				// failed: there is nothing sensible left to show, so drop it.
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
			// An image that declares nothing is not this module's business. Left
			// alone it shows the browser's own broken-image glyph, which is what it
			// did before; removing it would silently reshape layouts everywhere.
			if (!swap && !img.dataset.fallbackParentClass && !MODES.has(img.dataset.fallback)) return;
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

	document.addEventListener(
		'click',
		function (event) {
			if (event.target.closest('[data-stop-propagation]')) event.stopPropagation();
		},
		true,
	);

	document.addEventListener('click', function (event) {
		const el = event.target.closest('[data-action]');
		if (el && el.dataset.action === 'reload') {
			event.preventDefault();
			location.reload();
		}
	});
})();
