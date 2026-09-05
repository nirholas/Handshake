// Builds the <agent-3d> embed snippet.
//
// The snippet follows docs/embedding.md exactly: a pinned, subresource-integrity
// checked module script plus the element. The version and its SRI hash come from
// the live release manifest (/agent-3d/versions.json) so a snippet pasted today
// keeps working when the library moves on.

import { normalizeOrigin } from './studio.js';

/** The channel used when a pinned release cannot be resolved. */
const FALLBACK_CHANNEL = 'latest';

/**
 * Resolve which library build the snippet should load.
 *
 * @param {string} origin
 * @param {string} channel 'pinned' for the current release plus its SRI hash, or
 *   a channel name such as 'latest', '1', or '1.5'.
 * @returns {Promise<{ channel: string, integrity: string | null }>}
 */
export async function resolveEmbedRelease(origin, channel = 'pinned') {
	const wanted = String(channel || 'pinned').trim() || 'pinned';
	if (wanted !== 'pinned') return { channel: wanted, integrity: null };
	try {
		const url = new URL('/agent-3d/versions.json', normalizeOrigin(origin)).href;
		const res = await fetch(url, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const manifest = await res.json();
		return readRelease(manifest);
	} catch {
		// A snippet that loads the moving channel still works; only the pin is lost.
		return { channel: FALLBACK_CHANNEL, integrity: null };
	}
}

/** Pull the pinned version and its script hash out of the release manifest. */
export function readRelease(manifest) {
	const version = manifest?.latest;
	if (typeof version !== 'string' || !version) {
		return { channel: FALLBACK_CHANNEL, integrity: null };
	}
	const integrity = manifest?.channels?.[version]?.integrity?.['agent-3d.js'];
	return { channel: version, integrity: typeof integrity === 'string' ? integrity : null };
}

/**
 * Render the snippet.
 *
 * @param {object} opts
 * @param {string} opts.src https URL of the GLB to show
 * @param {string} opts.origin site that serves the library
 * @param {string} opts.channel version or channel path segment
 * @param {string | null} [opts.integrity] SRI hash for the pinned build
 * @param {number} [opts.width] CSS pixels
 * @param {number} [opts.height] CSS pixels
 */
export function buildEmbedSnippet({ src, origin, channel, integrity, width = 400, height = 500 }) {
	if (!/^https?:\/\//.test(String(src || ''))) {
		throw new Error('the embed needs an http(s) URL for the model');
	}
	const lib = `${normalizeOrigin(origin)}/agent-3d/${channel}/agent-3d.js`;
	const script = integrity
		? [
				'<script',
				'  type="module"',
				`  src="${lib}"`,
				`  integrity="${integrity}"`,
				'  crossorigin="anonymous"',
				'></script>',
			].join('\n')
		: `<script type="module" src="${lib}"></script>`;
	const element = [
		'<agent-3d',
		`  body="${src}"`,
		`  style="width: ${width}px; height: ${height}px; display: block;"`,
		'></agent-3d>',
	].join('\n');
	return `${script}\n\n${element}\n`;
}

/** The three.ws hosted viewer URL for a model, for "open in browser". */
export function viewerUrl(origin, src) {
	const url = new URL('/viewer', normalizeOrigin(origin));
	url.searchParams.set('src', src);
	return url.href;
}
