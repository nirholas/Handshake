// GET /api/bazaar/search?query=weather&type=http&network=eip155:*&maxPrice=100000
//
// Ranked text search over the merged facilitator catalog. Implemented client
// side because none of the public facilitators expose a server-side search
// route: we pull the list, score items against the query terms, and sort.
// `limit` (default 50) caps the returned rows; `total` reports how many the
// query matched before that cut.

import { cors, json, error, wrap, serverError } from '../_lib/http.js';
import {
	allSourcesFailed,
	Bazaar,
	filterByExtension,
	filterByMaxPrice,
	filterByNetwork,
	filterByTag,
	parseAtomicAmount,
	sourceErrorText,
} from '../_lib/x402/bazaar-client.js';

async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const url = new URL(req.url, 'http://x');
	const query = url.searchParams.get('query') || url.searchParams.get('q') || '';
	const type = (url.searchParams.get('type') || 'http').toLowerCase();
	if (type !== 'http' && type !== 'mcp') {
		return error(res, 400, 'bad_request', 'type must be "http" or "mcp"');
	}
	const network = url.searchParams.get('network') || null;
	// Blank means "no cap", as on /api/bazaar/list.
	const maxPrice = (url.searchParams.get('maxPrice') || '').trim() || null;
	// Atomic units, not decimals (see /api/bazaar/list): a malformed cap is a 400.
	if (maxPrice != null && parseAtomicAmount(maxPrice) === null) {
		return error(res, 400, 'bad_request', 'maxPrice must be an atomic integer amount (e.g. 10000 = 0.01 USDC)');
	}
	const asset = url.searchParams.get('asset');
	const extension = url.searchParams.get('extension');
	const tag = url.searchParams.get('tag');
	const maxItems = clampInt(url.searchParams.get('maxItems'), 500, 1, 5000);
	const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
	const facilitatorsCsv = url.searchParams.get('facilitators');
	const facilitators = facilitatorsCsv
		? facilitatorsCsv.split(',').map((s) => s.trim()).filter(Boolean)
		: undefined;

	const baz = new Bazaar({ facilitators });
	let result;
	try {
		result = await baz.search({ query, type, maxItems });
	} catch (e) {
		console.error('[bazaar] facilitator error', e?.message || e);
		return serverError(res, 502, 'facilitator_error', e);
	}

	if (allSourcesFailed(result)) {
		return error(res, 502, 'facilitator_error', sourceErrorText(result));
	}

	let resources = result.resources;
	if (network) resources = filterByNetwork(resources, network);
	if (maxPrice) resources = filterByMaxPrice(resources, maxPrice, asset);
	if (extension) resources = filterByExtension(resources, extension);
	if (tag) resources = filterByTag(resources, tag);

	const total = resources.length;
	if (resources.length > limit) resources = resources.slice(0, limit);

	res.setHeader('cache-control', 'public, max-age=15, stale-while-revalidate=60');
	return json(res, 200, {
		type,
		query,
		count: resources.length,
		total,
		resources,
		sources: result.sources,
		errors: result.errors,
	});
}

// An absent query param arrives as null, and Number(null) is 0, not NaN: the
// unguarded version returned min instead of the fallback, so every default
// here silently collapsed to 1 (one catalog item per facilitator page).
function clampInt(v, fallback, min, max) {
	if (v == null || v === '') return fallback;
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

export default wrap(handler);
