// Play-surface i18n bridge.
//
// The rest of three.ws ships copy inline in static HTML, annotated with
// `data-i18n`, and /i18n.js swaps it at runtime (see src/i18n.js). /play has no
// static copy at all: every visible string is built in JS, so none of it was
// reachable by the translation layer and the whole world rendered in English
// for all 83 locales.
//
// Two ways to close that here, and both are needed:
//
//   1. Static labels are annotated at build time with `data-i18n` /
//      `data-i18n-attr` on the element, exactly like the HTML pages. The
//      runtime's MutationObserver picks up each subtree as the HUD mounts, so
//      nothing has to call anything. This is the default: prefer it.
//   2. Strings assembled from live data ("Active (3)", "1 online") cannot be a
//      static attribute, so they call `t()` with the English source as the
//      fallback and the values interpolated.
//
// `t()` never throws and never blocks: before /i18n.js has finished loading its
// catalog it returns the English fallback, and `onLocaleChange` lets a panel
// re-render itself when the visitor switches language mid-session.

/**
 * Translate a key, falling back to the English source string.
 * @param {string} key dot-path into the catalog, e.g. 'play.online_count'
 * @param {string} fallback the English source text, with {{vars}} placeholders
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function t(key, fallback, vars) {
	const runtime = globalThis.threewsI18n;
	if (runtime?.t) {
		const hit = runtime.t(key, vars);
		// The runtime echoes the key back on a total miss (no translation in
		// either the active locale or the English catalog). That is a key we have
		// not shipped yet, so use the source string the caller passed instead of
		// printing "play.online_count" at the player.
		if (hit && hit !== key) return hit;
	}
	return interpolate(fallback, vars);
}

function interpolate(str, vars) {
	if (typeof str !== 'string' || !vars) return str;
	return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * Run `fn` whenever the visitor changes language, so panels holding
 * interpolated copy can re-render. Returns an unsubscribe function.
 * @param {() => void} fn
 * @returns {() => void}
 */
export function onLocaleChange(fn) {
	if (typeof fn !== 'function' || typeof window === 'undefined') return () => {};
	const handler = () => fn();
	window.addEventListener('i18n:change', handler);
	return () => window.removeEventListener('i18n:change', handler);
}

/**
 * Translate a subtree that was built after the initial pass. The runtime's own
 * observer already covers anything appended to the document, so this is only
 * needed for a node that is annotated and rendered in the same frame it is
 * measured (the emote wheel's SVG labels).
 * @param {ParentNode} root
 */
export function applyI18n(root) {
	globalThis.threewsI18n?.apply?.(root);
}
