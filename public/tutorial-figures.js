/*
 * tutorial-figures.js — resolves the `figure:` directives in tutorial markdown
 * into real, captioned, zoomable media.
 *
 * A tutorial author writes an ordinary markdown image:
 *
 *   ![The Forge with a prompt typed in](figure:page:/forge)
 *   ![Michelle, the default rigged avatar](figure:glb:/avatars/michelle.glb)
 *   ![Drag to orbit the model](figure:live:/avatars/michelle.glb)
 *   ![The chest this recipe built](figure:img:/cookbook/posters/text-to-3d-cli.png)
 *
 * Left alone, marked turns that into <img src="figure:page:/forge">, and the
 * browser immediately tries to fetch it: one guaranteed-failing request per
 * figure and an ERR_UNKNOWN_URL_SCHEME in the console before any script gets a
 * chance to intervene. So the directives are rewritten to inert slot elements
 * BEFORE the parse (preprocess), and mount() fills those slots afterwards with
 * a <figure>: a numbered caption, an intrinsic-size box so the page never
 * shifts, a blurred placeholder that resolves into the real capture, and
 * click-to-zoom. mount() still upgrades a raw <img src="figure:…"> if one
 * reaches the DOM, so a viewer that forgets to preprocess degrades to the old
 * behaviour rather than showing nothing.
 *
 * Media comes from /tutorial-media.json, written by
 * scripts/capture-tutorial-media.mjs from real screenshots of the deployed site
 * and real renders from /api/render/glb. Nothing is drawn or stock-sourced.
 *
 * Every kind has a real fallback, so a missing capture degrades instead of
 * breaking: a model figure falls back to the interactive <model-viewer> of the
 * same GLB, a page figure falls back to a link card that opens the real page,
 * and an `img` figure falls back to the committed file it names. A tutorial
 * never renders a broken image icon.
 *
 * The kind list here must match KINDS in scripts/capture-tutorial-media.mjs.
 * When it did not, every `figure:img:` in the cookbook was parsed as unknown,
 * mountFigure returned null, and mount() removed the slot: four recipe posters
 * and a tutorial's figures vanished from the rendered page with nothing in the
 * console to say so.
 */
(function () {
	'use strict';

	var MANIFEST_URL = '/tutorial-media.json';
	var manifestPromise = null;

	// ![caption](figure:kind:/target?opts) anywhere in the markdown source.
	var DIRECTIVE_RE = /!\[([^\]]*)\]\((figure:[^)\s]+)\)/g;

	function escapeAttr(value) {
		return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	/**
	 * Rewrite figure directives into inert slots. Call this on the raw markdown
	 * before handing it to marked; the slot is block-level HTML, so marked leaves
	 * it alone instead of wrapping it in a paragraph.
	 */
	function preprocess(markdown) {
		if (typeof markdown !== 'string' || markdown.indexOf('figure:') === -1) return markdown;
		return markdown.replace(DIRECTIVE_RE, function (whole, alt, raw) {
			if (!alt.trim()) return whole;
			return '<div class="tfig-slot" data-figure="' + escapeAttr(raw) + '" data-alt="' + escapeAttr(alt.trim()) + '"></div>';
		});
	}

	function loadManifest() {
		if (!manifestPromise) {
			manifestPromise = fetch(MANIFEST_URL, { headers: { accept: 'application/json' } })
				.then(function (res) {
					if (!res.ok) throw new Error('HTTP ' + res.status);
					return res.json();
				})
				.then(function (json) {
					return (json && json.figures) || {};
				})
				.catch(function () {
					// A missing manifest is not a page failure: every figure has a
					// live fallback, so the tutorial still renders completely.
					return {};
				});
		}
		return manifestPromise;
	}

	function parseDirective(raw) {
		var body = raw.slice('figure:'.length);
		var colon = body.indexOf(':');
		if (colon === -1) return null;
		var kind = body.slice(0, colon);
		if (kind !== 'page' && kind !== 'glb' && kind !== 'live' && kind !== 'img') return null;
		var rest = body.slice(colon + 1);
		var q = rest.indexOf('?');
		return {
			kind: kind,
			target: q === -1 ? rest : rest.slice(0, q),
			params: new URLSearchParams(q === -1 ? '' : rest.slice(q + 1)),
		};
	}

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	var ICON_ZOOM =
		'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M11 8v6M8 11h6"/></svg>';
	var ICON_ORBIT =
		'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-24 12 12)"/></svg>';
	var ICON_LINK =
		'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
	var ICON_CLOSE =
		'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

	function badge(icon, label) {
		var span = el('span', 'tfig-badge');
		span.innerHTML = icon;
		span.appendChild(el('span', null, label));
		return span;
	}

	/** An interactive viewer, used both as the `live` kind and as the model fallback. */
	function buildViewer(target, orbit) {
		var viewer = document.createElement('model-viewer');
		viewer.setAttribute('src', target);
		viewer.setAttribute('camera-controls', '');
		// A turntable that never stops is motion the reader did not ask for.
		// Orbiting by hand still works; only the automatic spin is dropped.
		var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!reduce) {
			viewer.setAttribute('auto-rotate', '');
			viewer.setAttribute('auto-rotate-delay', '600');
		}
		viewer.setAttribute('rotation-per-second', '16deg');
		viewer.setAttribute('interaction-prompt', 'none');
		viewer.setAttribute('shadow-intensity', '0');
		viewer.setAttribute('exposure', '0.95');
		viewer.setAttribute('environment-image', 'neutral');
		viewer.setAttribute('camera-orbit', orbit || '0deg 78deg 4.5m');
		viewer.setAttribute('field-of-view', '32deg');
		viewer.setAttribute('loading', 'lazy');
		viewer.setAttribute('alt', '');
		viewer.setAttribute('tabindex', '0');
		return viewer;
	}

	function buildImage(record, alt) {
		var frame = el('div', 'tfig-frame tfig-frame-img');
		// An adopted `img` with no capture yet carries a src and nothing else, so
		// the intrinsic-size box and the blur-up placeholder are both optional.
		if (record.width && record.height) frame.style.aspectRatio = record.width + ' / ' + record.height;
		if (record.placeholder) {
			frame.style.backgroundImage = 'url("' + record.placeholder + '")';
			frame.classList.add('is-loading');
		}
		var img = new Image();
		img.src = record.src;
		img.alt = alt;
		if (record.width) img.width = record.width;
		if (record.height) img.height = record.height;
		img.loading = 'lazy';
		img.decoding = 'async';
		img.className = 'tfig-img';
		img.addEventListener('load', function () {
			frame.classList.remove('is-loading');
			frame.classList.add('is-ready');
		});
		img.addEventListener('error', function () {
			frame.classList.remove('is-loading');
			frame.classList.add('is-broken');
		});
		frame.appendChild(img);
		return { frame: frame, img: img };
	}

	/** The honest fallback for a page figure with no capture yet: go see the real thing. */
	function buildPageCard(target, alt) {
		var frame = el('div', 'tfig-frame tfig-frame-card');
		var link = el('a', 'tfig-card');
		link.href = target;
		link.rel = 'noopener';
		link.innerHTML =
			'<span class="tfig-card-eyebrow">Live page</span>' +
			'<span class="tfig-card-path"></span>' +
			'<span class="tfig-card-cta">Open it and follow along ' +
			ICON_LINK +
			'</span>';
		link.querySelector('.tfig-card-path').textContent = target;
		link.setAttribute('aria-label', alt + ' (opens ' + target + ')');
		frame.appendChild(link);
		return frame;
	}

	function mountFigure(raw, altText, record, index, lightbox) {
		var directive = parseDirective(raw);
		if (!directive) return null;

		var alt = (altText || '').trim() || 'Figure ' + index;
		var figure = el('figure', 'tfig');
		figure.id = 'figure-' + index;
		var body = el('div', 'tfig-body');
		var zoomable = null;
		var kindBadge = null;

		// An `img` names a file already committed under public/, so it has an
		// honest fallback of its own: the committed file. Without this it would
		// fall through to the page card and offer to "open the page" at a .png.
		var shot = record;
		if (!shot && directive.kind === 'img') shot = { src: directive.target };

		if (directive.kind === 'live' || (!record && (directive.kind === 'glb' || directive.kind === 'live'))) {
			var orbit = (record && record.orbit) || directive.params.get('orbit');
			var frame = el('div', 'tfig-frame tfig-frame-live');
			frame.appendChild(buildViewer(directive.target, orbit));
			body.appendChild(frame);
			kindBadge = badge(ICON_ORBIT, 'Drag to orbit');
		} else if (shot && shot.src) {
			var built = buildImage(shot, alt);
			body.appendChild(built.frame);
			zoomable = built;
			kindBadge = badge(ICON_ZOOM, 'Click to enlarge');
		} else {
			body.appendChild(buildPageCard(directive.target, alt));
			kindBadge = badge(ICON_LINK, 'Open the page');
		}

		if (zoomable) {
			var button = el('button', 'tfig-zoom');
			button.type = 'button';
			button.setAttribute('aria-label', 'Enlarge figure ' + index + ': ' + alt);
			button.innerHTML = ICON_ZOOM;
			body.appendChild(button);
			body.classList.add('is-zoomable');
			var open = function () {
				lightbox.open(index);
			};
			button.addEventListener('click', open);
			zoomable.img.addEventListener('click', open);
		}

		figure.appendChild(body);

		var caption = el('figcaption', 'tfig-caption');
		var num = el('span', 'tfig-num', 'Figure ' + index);
		caption.appendChild(num);
		caption.appendChild(el('span', 'tfig-text', alt));
		if (kindBadge) caption.appendChild(kindBadge);
		figure.appendChild(caption);

		return { figure: figure, alt: alt, record: shot, kind: directive.kind, target: directive.target };
	}

	// ── Lightbox ───────────────────────────────────────────────────────────────
	// One dialog for the whole page. Arrow keys move between figures, Escape
	// closes, and focus returns to the control that opened it.

	function createLightbox() {
		var shots = [];
		var current = 0;
		var opener = null;
		var dialog = el('div', 'tfig-lightbox');
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', 'Figure viewer');
		dialog.hidden = true;
		dialog.innerHTML =
			'<div class="tfig-lb-inner">' +
			'<img class="tfig-lb-img" alt="" />' +
			'<div class="tfig-lb-bar">' +
			'<span class="tfig-lb-caption"></span>' +
			'<span class="tfig-lb-count"></span>' +
			'</div>' +
			'</div>' +
			'<button type="button" class="tfig-lb-close" aria-label="Close figure viewer">' +
			ICON_CLOSE +
			'</button>' +
			'<button type="button" class="tfig-lb-nav prev" aria-label="Previous figure">&#8592;</button>' +
			'<button type="button" class="tfig-lb-nav next" aria-label="Next figure">&#8594;</button>';

		var lbImg = dialog.querySelector('.tfig-lb-img');
		var lbCaption = dialog.querySelector('.tfig-lb-caption');
		var lbCount = dialog.querySelector('.tfig-lb-count');
		var closeBtn = dialog.querySelector('.tfig-lb-close');
		var prevBtn = dialog.querySelector('.tfig-lb-nav.prev');
		var nextBtn = dialog.querySelector('.tfig-lb-nav.next');

		function show(i) {
			if (!shots.length) return;
			current = (i + shots.length) % shots.length;
			var shot = shots[current];
			lbImg.src = shot.record.src;
			lbImg.alt = shot.alt;
			lbCaption.textContent = shot.alt;
			lbCount.textContent = shots.length > 1 ? current + 1 + ' of ' + shots.length : '';
			var multi = shots.length > 1;
			prevBtn.hidden = !multi;
			nextBtn.hidden = !multi;
		}

		function close() {
			dialog.hidden = true;
			document.documentElement.classList.remove('tfig-lb-open');
			document.removeEventListener('keydown', onKey, true);
			if (opener && typeof opener.focus === 'function') opener.focus();
			opener = null;
		}

		function onKey(ev) {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				close();
			} else if (ev.key === 'ArrowRight') {
				ev.preventDefault();
				show(current + 1);
			} else if (ev.key === 'ArrowLeft') {
				ev.preventDefault();
				show(current - 1);
			} else if (ev.key === 'Tab') {
				// Keep focus inside the dialog while it is modal.
				var focusable = [closeBtn, prevBtn, nextBtn].filter(function (b) {
					return !b.hidden;
				});
				var at = focusable.indexOf(document.activeElement);
				ev.preventDefault();
				var nextIndex = ev.shiftKey ? at - 1 : at + 1;
				focusable[(nextIndex + focusable.length) % focusable.length].focus();
			}
		}

		closeBtn.addEventListener('click', close);
		prevBtn.addEventListener('click', function () {
			show(current - 1);
		});
		nextBtn.addEventListener('click', function () {
			show(current + 1);
		});
		dialog.addEventListener('click', function (ev) {
			if (ev.target === dialog || ev.target.classList.contains('tfig-lb-inner')) close();
		});

		return {
			node: dialog,
			register: function (shot) {
				shots.push(shot);
				return shots.length - 1;
			},
			open: function (figureIndex) {
				var at = shots.findIndex(function (s) {
					return s.figureIndex === figureIndex;
				});
				if (at === -1) return;
				opener = document.activeElement;
				dialog.hidden = false;
				document.documentElement.classList.add('tfig-lb-open');
				show(at);
				closeBtn.focus();
				document.addEventListener('keydown', onKey, true);
			},
		};
	}

	// ── Mount ──────────────────────────────────────────────────────────────────

	/**
	 * Collect the placeholders left for us, in document order, whichever form
	 * they arrived in: the slots preprocess() wrote, and any raw <img> from a
	 * viewer that parsed the markdown without preprocessing it.
	 */
	function collectPlaceholders(article) {
		return Array.prototype.slice
			.call(article.querySelectorAll('.tfig-slot[data-figure], img[src^="figure:"]'))
			.map(function (node) {
				var isSlot = node.classList && node.classList.contains('tfig-slot');
				return {
					node: node,
					raw: isSlot ? node.getAttribute('data-figure') : node.getAttribute('src') || '',
					alt: isSlot ? node.getAttribute('data-alt') : node.getAttribute('alt') || '',
					// marked wraps a lone image in a paragraph, and a <figure> inside a
					// <p> is invalid markup the browser will hoist out. Replace the
					// wrapper instead. Slots are block-level already and never wrapped.
					target:
						!isSlot && node.parentElement && node.parentElement.tagName === 'P' && node.parentElement.childNodes.length === 1
							? node.parentElement
							: node,
				};
			});
	}

	function mount(article) {
		if (!article) return Promise.resolve(0);
		var placeholders = collectPlaceholders(article);
		if (!placeholders.length) return Promise.resolve(0);

		return loadManifest().then(function (figures) {
			var lightbox = window.__tfigLightbox;
			if (!lightbox) {
				lightbox = createLightbox();
				document.body.appendChild(lightbox.node);
				window.__tfigLightbox = lightbox;
			}

			var mounted = 0;
			placeholders.forEach(function (slot, i) {
				var index = i + 1;
				var built = mountFigure(slot.raw, slot.alt, figures[slot.raw], index, lightbox);
				if (!built) {
					slot.target.remove();
					return;
				}
				slot.target.replaceWith(built.figure);
				if (built.record && built.record.src && built.kind !== 'live') {
					lightbox.register({
						figureIndex: index,
						alt: built.alt,
						record: built.record,
					});
				}
				mounted += 1;
			});
			return mounted;
		});
	}

	window.tutorialFigures = { mount: mount, preprocess: preprocess };
})();
