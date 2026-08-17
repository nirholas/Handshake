// Pure view logic for /character-library.
//
// The page module (src/character-library.js) owns the DOM; everything here is a
// function of the manifest rows that GET /api/avatars/library returns, so the
// search, the sort and the three deep links a card offers can be tested without
// a browser. Rows look like:
//
//   { name: 'aj', label: 'Aj', url: '/r2-proxy/.../aj.glb',
//     thumb: '/r2-proxy/.../aj.png', bytes: 5918024, source: 'mixamo' }

/** Display name for a row: the curated label, else the manifest key. */
export function characterName(a) {
	return (a?.label || a?.name || '').trim();
}

/** "34.3 MB" / "812 KB", or an empty string when the manifest omits the size. */
export function formatBytes(n) {
	if (!n) return '';
	const mb = n / 1024 / 1024;
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/**
 * The line under a card's name. A row with no `bytes` used to render as
 * "Mixamo · " with a separator dangling off the end; the separator now only
 * appears when there is a size to separate it from.
 */
export function cardMeta(a) {
	const source = a?.source === 'mixamo' || !a?.source ? 'Mixamo' : String(a.source);
	const size = formatBytes(a?.bytes);
	return size ? `${source} · ${size}` : source;
}

/**
 * The three viewers that accept a raw model URL. Returns null when the row
 * carries no GLB, which is the caller's signal to render no action at all
 * rather than a link to nowhere.
 */
export function viewerLinks(a) {
	const glb = a?.url || '';
	if (!glb) return null;
	const model = encodeURIComponent(glb);
	return {
		preview: `/app#model=${model}`,
		use: `/studio?model=${model}`,
		animate: `/pose?src=${model}&title=${encodeURIComponent(characterName(a))}`,
	};
}

/** Case-insensitive substring match on the display name. */
export function filterCharacters(list, query) {
	const q = String(query || '').trim().toLowerCase();
	if (!q) return [...(list || [])];
	return (list || []).filter((a) => characterName(a).toLowerCase().includes(q));
}

export const SORTS = ['az', 'za', 'largest', 'smallest'];

/** Sort a copy of `list`. An unknown mode sorts A to Z, matching the select's default. */
export function sortCharacters(list, mode) {
	const out = [...(list || [])];
	const byName = (a, b) => characterName(a).toLowerCase().localeCompare(characterName(b).toLowerCase());
	if (mode === 'za') return out.sort((a, b) => -byName(a, b));
	if (mode === 'largest') return out.sort((a, b) => (b?.bytes || 0) - (a?.bytes || 0));
	if (mode === 'smallest') return out.sort((a, b) => (a?.bytes || 0) - (b?.bytes || 0));
	return out.sort(byName);
}

/** The rows a given search + sort should render, in render order. */
export function visibleCharacters(list, { query = '', sort = 'az' } = {}) {
	return sortCharacters(filterCharacters(list, query), sort);
}

/**
 * Which of the page's five states the current data implies. Kept here so the
 * page cannot show "no matches" for an empty library, or an empty library
 * message for a search that simply missed.
 */
export function viewState({ loaded, failed, total, visible }) {
	if (failed) return 'error';
	if (!loaded) return 'loading';
	if (!total) return 'empty';
	if (!visible) return 'empty-search';
	return 'grid';
}
