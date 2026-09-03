// @ts-check
// Normalize a DeFiLlama icon URL so it actually resolves.
//
// DeFiLlama serves every icon under https://icons.llamao.fi/icons/<kind>/<slug>,
// but the dimension feeds (fees, revenue, dex volumes) return chain rows whose
// `logo` drops the /icons segment: `https://icons.llamao.fi/chains/rsz_base.jpg`
// 404s, `https://icons.llamao.fi/icons/chains/rsz_base.jpg` is the same image at
// 200. Passed through untouched, that put a broken image behind every chain row
// on /fees and a run of 404s in the console. Protocol rows in the same payload
// already carry the correct /icons form, so this is a targeted repair of the
// upstream inconsistency rather than a rewrite of every URL.
//
//   normalizeLlamaLogo('https://icons.llamao.fi/chains/rsz_base.jpg')
//     -> 'https://icons.llamao.fi/icons/chains/rsz_base.jpg'
//
// Anything that is not a bare icons.llamao.fi URL missing the segment is
// returned exactly as given, so the helper is safe to apply to every logo field
// and stays a no-op once upstream fixes its own feed.

const HOST = 'https://icons.llamao.fi/';

/**
 * @param {unknown} url
 * @returns {string | null} the repaired URL, the original string, or null
 */
export function normalizeLlamaLogo(url) {
	if (typeof url !== 'string' || !url) return null;
	if (!url.startsWith(HOST)) return url;
	const rest = url.slice(HOST.length);
	if (rest.startsWith('icons/')) return url;
	return HOST + 'icons/' + rest;
}
