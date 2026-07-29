// Shared fuzzy matching for the command palettes and any other search-as-you-type
// surface, backed by `@leeoniya/ufuzzy` (~7 kB, no dependencies).
//
// The two palettes previously each carried a four-branch scorer:
//
//     exact ? 3 : prefix ? 2 : substring ? 1 : subsequence ? 0.5 : 0
//
// which cannot rank within a tier — every subsequence hit tied at 0.5, so
// "close match" and "barely matches" sorted arbitrarily — and had no typo
// tolerance, no word-boundary bonus, and no match positions, so highlighting
// had to re-scan with a regex and could only mark contiguous runs.
//
// uFuzzy ranks by contiguity, word-boundary starts, and match position, and
// hands back exact ranges for highlighting.

import uFuzzy from '@leeoniya/ufuzzy';

// intraMode 1 = single-error mode: one insertion, substitution, transposition,
// or deletion is tolerated per term, which covers the common typo ("markteplace")
// without degrading into matching everything. uFuzzy deliberately does NOT do
// arbitrary sparse subsequence matching here, and that is the point: the old
// scorer accepted any subsequence and then could not rank the results.
const uf = new uFuzzy({
	intraMode: 1,
	intraIns: 1,
	intraSub: 1,
	intraTrn: 1,
	intraDel: 1,
});

/**
 * Rank `items` against `query`.
 *
 * @template T
 * @param {string} query
 * @param {T[]} items
 * @param {(item: T) => string} getText Searchable text for an item. Join several
 *   fields with a space to make them all matchable.
 * @param {object} [opts]
 * @param {number} [opts.limit] Maximum results to return.
 * @returns {Array<{ item: T, ranges: number[] }>} Best match first. `ranges` is
 *   uFuzzy's flat [start, end, start, end, …] list into the item's text.
 */
export function rank(query, items, getText, { limit } = {}) {
	const q = String(query || '').trim();
	if (!q) return items.map((item) => ({ item, ranges: [] }));
	if (!items.length) return [];

	const haystack = items.map((it) => String(getText(it) ?? ''));
	const idxs = uf.filter(haystack, q);
	if (!idxs || !idxs.length) return [];

	const info = uf.info(idxs, haystack, q);
	const order = uf.sort(info, haystack, q);

	const out = [];
	for (let i = 0; i < order.length; i++) {
		if (limit != null && out.length >= limit) break;
		const infoIdx = order[i];
		out.push({ item: items[info.idx[infoIdx]], ranges: info.ranges[infoIdx] || [] });
	}
	return out;
}

/**
 * Whether `text` matches `query` at all. For call sites that only need a
 * boolean filter rather than an ordering.
 */
export function matches(query, text) {
	const q = String(query || '').trim();
	if (!q) return true;
	const idxs = uf.filter([String(text ?? '')], q);
	return !!(idxs && idxs.length);
}

/**
 * Wrap matched ranges in `<mark>`, HTML-escaping everything else. Uses the
 * ranges uFuzzy already computed, so non-contiguous matches highlight correctly
 * instead of being re-found with a regex.
 *
 * @param {string} text
 * @param {number[]} ranges Flat [start, end, …] pairs, as returned by `rank`.
 * @returns {string} HTML.
 */
export function highlight(text, ranges) {
	const s = String(text ?? '');
	if (!ranges || !ranges.length) return escapeHtml(s);
	let out = '';
	let cursor = 0;
	for (let i = 0; i < ranges.length; i += 2) {
		const start = ranges[i];
		const end = ranges[i + 1];
		out += escapeHtml(s.slice(cursor, start));
		out += `<mark>${escapeHtml(s.slice(start, end))}</mark>`;
		cursor = end;
	}
	return out + escapeHtml(s.slice(cursor));
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
