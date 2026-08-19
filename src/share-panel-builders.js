/**
 * Pure, side-effect-free helpers for building share/embed snippets.
 * Kept separate from share-panel.js so tests can import them without
 * pulling in the CSS or any DOM-coupled code.
 *
 * @module share-panel-builders
 */

/** @type {{ readonly bg: 'transparent' | 'dark' | 'light', readonly name: boolean, readonly size: 'small' | 'medium' | 'large' }} */
export const DEFAULT_OPTIONS = Object.freeze({
	bg: 'transparent',
	name: true,
	size: 'medium',
});

/** Iframe pixel dimensions per size keyword. */
export const SIZES = Object.freeze({
	small: { width: 320, height: 420 },
	medium: { width: 420, height: 520 },
	large: { width: 520, height: 680 },
});

/**
 * Build the canonical embed URL for an agent with the given options. Default
 * options are omitted from the query string so the canonical URL stays short.
 *
 * @param {{ origin: string, agentId: string, opts?: Partial<typeof DEFAULT_OPTIONS> }} args
 * @returns {string}
 */
export function buildEmbedUrl({ origin, agentId, opts = {} }) {
	const merged = { ...DEFAULT_OPTIONS, ...opts };
	const url = new URL(`${origin}/agents/${agentId}/embed`);
	if (merged.bg !== DEFAULT_OPTIONS.bg) url.searchParams.set('bg', merged.bg);
	if (merged.name !== DEFAULT_OPTIONS.name) url.searchParams.set('name', '0');
	return url.toString();
}

/**
 * Build the iframe embed snippet. Uses the canonical /agent/{id}/embed URL,
 * declares a transparent CSS background so external sites composite cleanly,
 * and lazy-loads to avoid a network hit on hosts that paginate embeds.
 *
 * @param {{ origin: string, agentId: string, opts?: Partial<typeof DEFAULT_OPTIONS> }} args
 * @returns {string}
 */
export function buildIframeSnippet({ origin, agentId, opts = {} }) {
	const merged = { ...DEFAULT_OPTIONS, ...opts };
	const { width, height } = SIZES[merged.size] || SIZES.medium;
	const src = buildEmbedUrl({ origin, agentId, opts: merged });
	const allow = 'autoplay; xr-spatial-tracking; microphone; camera';
	return (
		`<iframe\n` +
		`    src="${src}"\n` +
		`    width="${width}" height="${height}"\n` +
		`    style="border:0;border-radius:12px;background:transparent"\n` +
		`    allow="${allow}"\n` +
		`    loading="lazy"\n` +
		`    referrerpolicy="strict-origin-when-cross-origin"\n` +
		`></iframe>`
	);
}

/**
 * Build the <agent-3d> web-component embed snippet. The bg / name-plate toggles
 * propagate through `background="..."` and `name-plate="off"` attributes which
 * the element observes (see element.js → _applyBackground / _applyNamePlate).
 *
 * @param {{ origin: string, agentId: string, opts?: Partial<typeof DEFAULT_OPTIONS> }} args
 * @returns {string}
 */
export function buildWebComponentSnippet({ origin, agentId, opts = {} }) {
	const merged = { ...DEFAULT_OPTIONS, ...opts };
	const { width, height } = SIZES[merged.size] || SIZES.medium;
	const attrs = [`agent-id="${agentId}"`];
	if (merged.bg !== DEFAULT_OPTIONS.bg) attrs.push(`background="${merged.bg}"`);
	if (merged.name !== DEFAULT_OPTIONS.name) attrs.push(`name-plate="off"`);
	return (
		`<script type="module" src="${origin}/dist-lib/agent-3d.js"><\/script>\n` +
		`<agent-3d ${attrs.join(' ')}\n` +
		`    style="display:block;width:${width}px;height:${height}px"\n` +
		`></agent-3d>`
	);
}
