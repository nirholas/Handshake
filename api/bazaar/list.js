// GET /api/bazaar/list?type=http&network=eip155:*&maxPrice=100000&extension=sign-in-with-x&maxItems=500
//
// Proxy over the configured x402 facilitators' /discovery/resources endpoints.
// We merge across facilitators, dedupe by resource (HTTP) or (resource,toolName)
// (MCP), normalize the item shape, and apply the optional filters.

import { cors, json, error, wrap, serverError } from '../_lib/http.js';
import {
	Bazaar,
	filterByExtension,
	filterByMaxPrice,
	filterByNetwork,
	filterByTag,
	parseAtomicAmount,
	sortByPriceAsc,
} from '../_lib/x402/bazaar-client.js';

async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const url = new URL(req.url, 'http://x');
	const type = (url.searchParams.get('type') || 'http').toLowerCase();
	if (type !== 'http' && type !== 'mcp') {
		return error(res, 400, 'bad_request', 'type must be "http" or "mcp"');
	}
	const network = url.searchParams.get('network') || null;
	const maxPrice = url.searchParams.get('maxPrice');
	// Atomic units, not decimals: `maxPrice=0.01` is a user error, and answering
	// 400 beats the SyntaxError BigInt used to throw straight into a 500.
	if (maxPrice != null && parseAtomicAmount(maxPrice) === null) {
		return error(res, 400, 'bad_request', 'maxPrice must be an atomic integer amount (e.g. 10000 = 0.01 USDC)');
	}
	const asset = url.searchParams.get('asset');
	const extension = url.searchParams.get('extension');
	const tag = url.searchParams.get('tag');
	const maxItems = clampInt(url.searchParams.get('maxItems'), 500, 1, 5000);
	const limit = clampInt(url.searchParams.get('limit'), 200, 1, 200);
	const sort = url.searchParams.get('sort'); // "price"
	const facilitatorsCsv = url.searchParams.get('facilitators');
	const facilitators = facilitatorsCsv
		? facilitatorsCsv.split(',').map((s) => s.trim()).filter(Boolean)
		: undefined;

	const baz = new Bazaar({ facilitators });
	let result;
	try {
		result = await baz.list({ type, limit, maxItems });
	} catch (e) {
		console.error('[bazaar] facilitator error', e?.message || e);
		return serverError(res, 502, 'facilitator_error', e);
	}

	let items = result.items;
	if (network) items = filterByNetwork(items, network);
	if (maxPrice) items = filterByMaxPrice(items, maxPrice, asset);
	if (extension) items = filterByExtension(items, extension);
	if (tag) items = filterByTag(items, tag);
	if (sort === 'price') items = sortByPriceAsc(items);

	res.setHeader('cache-control', 'public, max-age=15, stale-while-revalidate=60');
	return json(res, 200, {
		type,
		count: items.length,
		items,
		sources: result.sources,
		errors: result.errors,
	});
}

function clampInt(v, fallback, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

export default wrap(handler);
