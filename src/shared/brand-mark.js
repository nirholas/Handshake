// The three.ws mark, in one place.
//
// The glyph was copy-pasted as an inline <svg> string in every surface that
// needed it, which is how a logo ends up subtly different on three pages. It
// lives here now as raw path data plus two renderers:
//
//   the threeMarkSvg() export, an inline <svg> string for DOM chrome (nav, HUD, footers)
//   the threeMarkPath2D() export, a Path2D for <canvas> compositing (share cards, exports)
//
// Both draw the SAME path in the SAME 32x32 viewBox, so a mark stamped onto a
// downloaded PNG is pixel-for-pixel the mark in the page header.

/** The mark's `d` attribute, authored in a 0 0 32 32 viewBox. */
export const THREE_MARK_PATH = 'M11.013 1.011a16 16 0 0 0-3.96 1.39C2.79 4.531.213 8.757.012 13.564c-.16 3.933 1.31 7.62 4.117 10.357l.736.715-.16.46c-.084.249-.13.504-.138.761 0 1.358 1.448 2.218 2.638 1.567.535-.292.879-.748 1.043-1.384.084-.331.092-.462.07-.882-.02-.43-.04-.535-.18-.83-.246-.52-.567-.86-1.087-1.153l-.297-.167.106-.32c.18-.543.79-1.717 1.181-2.276 1.91-2.729 5.066-4.395 8.4-4.434l.43-.005.012-1.19c.006-.654.024-1.19.04-1.19s.252.197.526.438c.71.624 2.296 1.95 2.785 2.328.23.178.41.34.4.36-.01.02-.214.156-.453.303-.926.57-2.265 1.65-3.13 2.524l-.27.273.012 1.064.013 1.064.32.027c1.327.114 2.598.685 3.578 1.607.21.198.39.343.4.323.04-.073.276-1.327.346-1.84.296-2.169-.094-4.317-1.129-6.16l-.19-.34.246-.45c.811-1.485 1.291-3.063 1.456-4.776.04-.42.046-.488.111-.488.111 0 1.327.715 1.94 1.143 2.953 2.057 4.96 5.241 5.579 8.856.21 1.22.234 1.585.234 3.063 0 1.485-.024 1.844-.234 3.064-.811 4.736-4.06 8.732-8.51 10.474-1.04.407-2.504.78-3.578.91l-.32.04v2.395l.41-.046c2.014-.226 4.222-.93 5.98-1.91 4.84-2.688 8.058-7.464 8.696-12.897.105-.892.105-3.063 0-3.956-.638-5.433-3.856-10.21-8.697-12.898C24.083.99 21.875.285 19.86.06 19.322 0 19.27 0 15.752.006c-3.346.006-4.234.02-4.74.105Z';

/** The mark's authoring viewBox size, so callers can scale without guessing. */
export const THREE_MARK_VIEWBOX = 32;

/**
 * Inline SVG string for the mark. Fills with `currentColor`, so the surrounding
 * element's `color` drives it. Decorative by default (`aria-hidden`); pass a
 * label when the mark is the only content of a link or button.
 *
 * @param {{ label?: string, className?: string }} [opts]
 */
export function threeMarkSvg({ label = '', className = '' } = {}) {
	const a11y = label
		? `role="img" aria-label="${label.replace(/"/g, '&quot;')}"`
		: 'aria-hidden="true"';
	const cls = className ? ` class="${className}"` : '';
	return `<svg${cls} viewBox="0 0 ${THREE_MARK_VIEWBOX} ${THREE_MARK_VIEWBOX}" fill="currentColor" xmlns="http://www.w3.org/2000/svg" ${a11y} focusable="false"><path d="${THREE_MARK_PATH}"/></svg>`;
}

/**
 * The mark as a Path2D for canvas compositing. Coordinates stay in the 32x32
 * authoring space; scale and translate with the context transform:
 *
 *   ctx.save();
 *   ctx.translate(x, y);
 *   ctx.scale(size / THREE_MARK_VIEWBOX, size / THREE_MARK_VIEWBOX);
 *   ctx.fill(threeMarkPath2D());
 *   ctx.restore();
 *
 * Returns null where Path2D is unavailable, so callers can skip the mark
 * instead of throwing mid-render.
 */
export function threeMarkPath2D() {
	if (typeof Path2D === 'undefined') return null;
	try {
		return new Path2D(THREE_MARK_PATH);
	} catch {
		return null;
	}
}
