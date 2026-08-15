// Escaping helpers shared by every headless-chromium renderer.
//
// The render pages are built by string interpolation, and their inputs
// (a background color, a pose label, a base64 GLB) come from public,
// unauthenticated HTTP handlers. The render page has full network egress from
// the container, so a caller who lands script into it can fetch internal
// endpoints and paint the response into the PNG we hand back. Every renderer
// interpolates through these two functions so no caller has to remember to.

// JSON.stringify alone is not enough to embed a value inside a <script> block:
// it leaves "</script" and the JS line terminators U+2028/U+2029 intact, so a
// caller-supplied string could close the tag and run its own code.
export function scriptJson(value) {
	return JSON.stringify(value === undefined ? null : value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

// The CSS-color grammar the renderers accept, and the only shape allowed to
// reach a <style> block or a THREE.Color(). Anything outside it (a "</style>"
// breakout, a url(), a CSS expression) is rejected at the boundary rather than
// escaped, because no legitimate caller needs it.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgba?|hsla?)\(\s*[0-9a-z.,%\s/+-]{1,64}\)$/i;
const NAMED = /^[a-z]{3,20}$/i;

/**
 * Validate a caller-supplied CSS color.
 *
 * @param {unknown} value
 * @returns {string|null} the trimmed color, or null if it is not a CSS color.
 */
export function safeCssColor(value) {
	if (typeof value !== 'string') return null;
	const v = value.trim();
	if (!v || v.length > 72) return null;
	if (HEX.test(v) || FUNCTIONAL.test(v) || NAMED.test(v)) return v;
	return null;
}
