/**
 * doc-figures.js — turns plain markdown images into first-class documentation figures.
 *
 * Both documentation surfaces render the same markdown files with `marked`: the
 * docs shell (/docs/…) and the standalone tutorial viewer (/tutorials/…). Left
 * alone, `marked` emits a bare `<img>`: no caption, no intrinsic size (so the
 * article jumps when it decodes), no way to see detail in a 1200px screenshot
 * squeezed into a 720px column, and no answer to the reader's real question,
 * "is this what the product looks like *now*?".
 *
 * This upgrades every image the docs own into a <figure> that answers all four:
 *
 *   • Intrinsic dimensions come from /docs/media-manifest.json before the image
 *     loads, so the box is reserved and nothing shifts.
 *   • The markdown title becomes a real <figcaption>.
 *   • Provenance ("captured from /create/prompt") links to the live route, so a
 *     reader can check the screenshot against the product in one click.
 *   • Click or press Enter to open a lightbox with zoom, arrow-key paging
 *     between every figure on the page, and a focus trap.
 *
 * Authors write nothing but ordinary markdown:
 *
 *     ![Alt text that describes the UI](/docs/img/forge-prompt-panel.webp 'Caption')
 *
 * so the same file still renders correctly on GitHub, in an LLM's plain-text
 * fetch, and in any other markdown viewer. Progressive enhancement only: with
 * this script blocked, every image is still a working image.
 *
 * Usage (both viewers do exactly this after setting innerHTML):
 *
 *     DocFigures.upgrade(document.getElementById('docs-content'));
 */
(function () {
	'use strict';

	var MANIFEST_URL = '/docs/media-manifest.json';
	var OWNED_PREFIX = '/docs/img/';
	var manifestPromise = null;

	function loadManifest() {
		if (!manifestPromise) {
			manifestPromise = fetch(MANIFEST_URL)
				.then(function (res) {
					return res.ok ? res.json() : { shots: {} };
				})
				.catch(function () {
					// The manifest is an enhancement, not a dependency: without it the
					// figures still render, they just size themselves on decode.
					return { shots: {} };
				});
		}
		return manifestPromise;
	}

	function shotIdFor(src) {
		var path = src.split('?')[0].split('#')[0];
		if (path.indexOf(OWNED_PREFIX) === -1) return null;
		var file = path.slice(path.indexOf(OWNED_PREFIX) + OWNED_PREFIX.length);
		return file.replace(/\.(webp|png|jpe?g|gif|avif)$/i, '') || null;
	}

	function prefersReducedMotion() {
		return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	function formatCapturedAt(iso) {
		var date = new Date(iso);
		if (isNaN(date.getTime())) return null;
		return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	// ── Lightbox ────────────────────────────────────────────────────────────────
	// One instance per page, built on first open and reused. It owns the figures
	// of whichever article opened it, so arrow keys page through that article.

	var lightbox = null;

	function buildLightbox() {
		var overlay = document.createElement('div');
		overlay.className = 'doc-lightbox';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', 'Image viewer');
		overlay.hidden = true;
		overlay.innerHTML =
			'<div class="doc-lightbox-backdrop" data-close></div>' +
			'<div class="doc-lightbox-frame">' +
			'<figure class="doc-lightbox-figure">' +
			'<img class="doc-lightbox-img" alt="" />' +
			'<figcaption class="doc-lightbox-caption"><span class="doc-lightbox-text"></span> <a class="doc-lightbox-source" target="_blank" rel="noopener"></a></figcaption>' +
			'</figure>' +
			'<button type="button" class="doc-lightbox-close" data-close aria-label="Close image viewer">' +
			'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
			'</button>' +
			'<button type="button" class="doc-lightbox-nav doc-lightbox-prev" aria-label="Previous image">' +
			'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>' +
			'</button>' +
			'<button type="button" class="doc-lightbox-nav doc-lightbox-next" aria-label="Next image">' +
			'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>' +
			'</button>' +
			'<div class="doc-lightbox-count" aria-live="polite"></div>' +
			'</div>';
		document.body.appendChild(overlay);

		var state = { items: [], index: 0, opener: null, zoomed: false };
		var img = overlay.querySelector('.doc-lightbox-img');
		var text = overlay.querySelector('.doc-lightbox-text');
		var source = overlay.querySelector('.doc-lightbox-source');
		var count = overlay.querySelector('.doc-lightbox-count');
		var prev = overlay.querySelector('.doc-lightbox-prev');
		var next = overlay.querySelector('.doc-lightbox-next');
		var closeBtn = overlay.querySelector('.doc-lightbox-close');

		function setZoom(on) {
			state.zoomed = on;
			img.classList.toggle('zoomed', on);
			img.setAttribute('aria-label', on ? 'Zoomed in. Click to zoom out.' : 'Click to zoom in.');
		}

		function show(index) {
			if (!state.items.length) return;
			state.index = (index + state.items.length) % state.items.length;
			var item = state.items[state.index];
			setZoom(false);
			img.src = item.src;
			img.alt = item.alt || '';
			text.textContent = item.caption || item.alt || '';
			if (item.route) {
				source.textContent = 'View ' + item.route;
				source.href = item.route;
				source.hidden = false;
			} else {
				source.hidden = true;
			}
			count.textContent = state.items.length > 1 ? state.index + 1 + ' / ' + state.items.length : '';
			var multiple = state.items.length > 1;
			prev.hidden = !multiple;
			next.hidden = !multiple;
		}

		function close() {
			overlay.hidden = true;
			overlay.classList.remove('open');
			document.documentElement.classList.remove('doc-lightbox-locked');
			img.src = '';
			if (state.opener && document.contains(state.opener)) state.opener.focus();
			state.opener = null;
		}

		function onKey(event) {
			if (overlay.hidden) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				close();
			} else if (event.key === 'ArrowRight') {
				event.preventDefault();
				show(state.index + 1);
			} else if (event.key === 'ArrowLeft') {
				event.preventDefault();
				show(state.index - 1);
			} else if (event.key === 'Tab') {
				// Focus trap: the overlay is modal, so Tab must never reach the
				// article behind it.
				var focusable = Array.prototype.filter.call(
					overlay.querySelectorAll('button:not([hidden]), a[href]:not([hidden])'),
					function (el) {
						return el.offsetParent !== null;
					},
				);
				if (!focusable.length) return;
				var first = focusable[0];
				var last = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}
		}

		overlay.addEventListener('click', function (event) {
			if (event.target.hasAttribute('data-close') || event.target.closest('[data-close]')) close();
		});
		prev.addEventListener('click', function () {
			show(state.index - 1);
		});
		next.addEventListener('click', function () {
			show(state.index + 1);
		});
		img.addEventListener('click', function () {
			setZoom(!state.zoomed);
		});
		img.addEventListener('mousemove', function (event) {
			if (!state.zoomed) return;
			var rect = img.getBoundingClientRect();
			img.style.transformOrigin =
				((event.clientX - rect.left) / rect.width) * 100 +
				'% ' +
				((event.clientY - rect.top) / rect.height) * 100 +
				'%';
		});
		document.addEventListener('keydown', onKey);

		return {
			open: function (items, index, opener) {
				state.items = items;
				state.opener = opener || null;
				overlay.hidden = false;
				document.documentElement.classList.add('doc-lightbox-locked');
				if (!prefersReducedMotion()) {
					requestAnimationFrame(function () {
						overlay.classList.add('open');
					});
				} else {
					overlay.classList.add('open');
				}
				show(index);
				closeBtn.focus();
			},
		};
	}

	// ── Figure upgrade ──────────────────────────────────────────────────────────

	function upgradeImage(img, shot, group) {
		var caption = img.getAttribute('title') || (shot && shot.caption) || '';
		var figure = document.createElement('figure');
		figure.className = 'doc-figure';
		if (shot && shot.animated) figure.classList.add('is-animated');

		var button = document.createElement('button');
		button.type = 'button';
		button.className = 'doc-figure-open';
		button.setAttribute(
			'aria-label',
			'Open image' + (img.alt ? ': ' + img.alt : '') + ' in the full-size viewer',
		);

		var media = document.createElement('span');
		media.className = 'doc-figure-media';
		if (shot && shot.width && shot.height) {
			// Reserve the exact box the image will occupy. This is the whole
			// reason the manifest carries dimensions.
			media.style.aspectRatio = shot.width + ' / ' + shot.height;
		}

		img.removeAttribute('title');
		img.loading = 'lazy';
		img.decoding = 'async';
		if (shot && shot.width) img.width = shot.width;
		if (shot && shot.height) img.height = shot.height;
		if (!img.alt && shot && shot.alt) img.alt = shot.alt;

		img.parentNode.insertBefore(figure, img);
		media.appendChild(img);
		button.appendChild(media);

		if (shot && shot.animated) {
			var badge = document.createElement('span');
			badge.className = 'doc-figure-badge';
			badge.textContent = 'Live capture';
			button.appendChild(badge);
		}

		var zoomHint = document.createElement('span');
		zoomHint.className = 'doc-figure-zoom';
		zoomHint.setAttribute('aria-hidden', 'true');
		zoomHint.innerHTML =
			'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6M11 8.4v5.2M8.4 11h5.2"/></svg>';
		button.appendChild(zoomHint);
		figure.appendChild(button);

		if (caption || (shot && shot.route)) {
			var figcaption = document.createElement('figcaption');
			figcaption.className = 'doc-figure-caption';
			if (caption) {
				var span = document.createElement('span');
				span.className = 'doc-figure-text';
				span.textContent = caption;
				figcaption.appendChild(span);
			}
			if (shot && shot.route) {
				var meta = document.createElement('a');
				meta.className = 'doc-figure-source';
				meta.href = shot.route;
				var when = shot.capturedAt ? formatCapturedAt(shot.capturedAt) : null;
				meta.textContent = 'Captured from ' + shot.route + (when ? ' · ' + when : '');
				meta.title = 'Open the live page this image was captured from';
				figcaption.appendChild(meta);
			}
			figure.appendChild(figcaption);
		}

		var item = {
			src: img.currentSrc || img.src,
			alt: img.alt,
			caption: caption,
			route: shot ? shot.route : null,
		};
		group.push(item);
		var index = group.length - 1;
		button.addEventListener('click', function () {
			if (!lightbox) lightbox = buildLightbox();
			lightbox.open(group, index, button);
		});
	}

	/**
	 * Upgrade every markdown image inside `root`. Safe to call repeatedly; an
	 * already-upgraded image is skipped.
	 *
	 * @param {Element} root container holding freshly rendered markdown
	 * @returns {Promise<number>} how many figures were upgraded
	 */
	function upgrade(root) {
		if (!root) return Promise.resolve(0);
		return loadManifest().then(function (manifest) {
			var shots = (manifest && manifest.shots) || {};
			var images = Array.prototype.slice.call(root.querySelectorAll('img'));
			var group = [];
			var upgraded = 0;
			images.forEach(function (img) {
				if (img.closest('.doc-figure')) return;
				// Inline badges (shields, icons) are not figures; only images the
				// docs own, or any image an author explicitly opted in, qualify.
				var src = img.getAttribute('src') || '';
				var id = shotIdFor(src);
				var optedIn = img.hasAttribute('data-figure');
				if (!id && !optedIn) return;
				upgradeImage(img, id ? shots[id] : null, group);
				upgraded++;
			});
			return upgraded;
		});
	}

	window.DocFigures = { upgrade: upgrade, loadManifest: loadManifest };
})();
