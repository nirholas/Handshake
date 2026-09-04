// Protocol / chain / exchange logos come from third-party CDNs (DeFiLlama's
// icons.llamao.fi, exchange logo hosts). Two things go wrong with them, and
// both are visible to every reader:
//
//   1. An icon that upstream renamed or withdrew answers 404. The browser logs
//      "Failed to load resource" before any onerror handler can run, so no
//      amount of client-side recovery keeps the console clean, and the URL
//      cannot be repaired ahead of time because only the CDN knows which icons
//      still exist. On 2026-09-04 one protocol in the top 100 by fee revenue
//      was in that state, and /fees logged seven 404s per load.
//   2. Every reader's IP is handed to the icon host on every table paint.
//
// Routing the icon through the same-origin /api/img proxy fixes both. The proxy
// fetches server-side (SSRF-hardened, CDN-cached, resized to the painted size),
// and `fallback=none` makes a withdrawn icon answer 204 No Content instead of
// the token-art placeholder: the browser logs nothing for a 204, the <img>
// still fires `error` with no bytes, and the surface paints the neutral disc it
// already designs for a logo-less row.
//
// Used by /fees, /defi, /dex-volumes, /chain/:id, /protocol/:slug and
// /exchange/:id, which each own a fallback class of their own.

import { proxiedImageURL } from '../ipfs.js';

/**
 * Same-origin URL for an upstream logo, sized for the box it is painted in.
 *
 * @param {string} url    Upstream logo URL.
 * @param {number} [size] CSS pixels the logo is painted at; the proxy is asked
 *                        for 2x that so it stays crisp on retina displays.
 * @returns {string} A `/api/img?...` URL, or '' when the input is not a usable
 *                   image source, so callers fall through to their own state.
 */
export function upstreamLogoURL(url, size = 0) {
	return proxiedImageURL(url, '', {
		width: size > 0 ? size * 2 : 0,
		fallback: 'none',
	});
}

// Containers already carrying the listener, so a re-render does not stack one
// per sort click.
const wired = new WeakSet();

/**
 * Replace any logo image inside `container` that fails to load with a neutral
 * disc, so a withdrawn upstream icon lands in the surface's designed empty
 * state instead of a broken-image glyph.
 *
 * The `error` event does not bubble, so this listens in the capture phase on
 * the container: one listener covers every row, including rows rendered later.
 * Callers re-render on every sort, so a repeat call on the same container is a
 * no-op rather than a second listener.
 *
 * @param {Element} container      Element whose descendants hold the logos.
 * @param {string} imgSelector     Selector identifying a logo image.
 * @param {string} fallbackClass   Class list for the replacement element.
 * @param {'span'|'div'} [tag]     Element to swap in (match the img's display).
 */
export function swapFailedLogos(container, imgSelector, fallbackClass, tag = 'span') {
	if (!container || wired.has(container)) return;
	wired.add(container);
	container.addEventListener(
		'error',
		(e) => {
			const img = e.target;
			if (!(img instanceof HTMLImageElement) || !img.matches(imgSelector)) return;
			const fallback = document.createElement(tag);
			fallback.className = fallbackClass;
			fallback.setAttribute('aria-hidden', 'true');
			img.replaceWith(fallback);
		},
		true,
	);
}
