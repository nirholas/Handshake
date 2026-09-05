// GET /api/catalog: one search across every ready-made asset three.ws publishes.
//
// The CC0 object library, the ready-made character library and the motion-clip
// library each already have their own endpoint, and each speaks its own field
// names. This joins all three behind one query so a caller who just wants "a
// wooden chair" does not have to know which of them holds one.
//
//   GET /api/catalog?q=wooden+chair&kind=object&limit=12&offset=0
//     -> { ok, items[], matched, relaxed, facets, next_offset, generated_at }
//
//   GET /api/catalog?id=object:painted_wooden_chair_01
//     -> { ok, item, links, related[], frameworks[], snippets{} }
//
// The detail form returns paste-ready source for the item in every framework
// that applies to it, which is what makes this useful to a build step and not
// only to a browse page: fetch the id, write the snippet, ship.
//
// The same join and the same code generation back the free MCP tools
// (search_catalog / get_catalog_item / get_item_source), so a client that
// speaks HTTP and a client that speaks MCP get identical answers.

import { cors, error, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { KINDS, searchCatalog, getCatalogItem, relatedItems } from './_lib/asset-catalog.js';
import { sourceFor } from './_lib/asset-snippets.js';
import { resolveOrigin } from './_mcp/origin.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 12;

// The manifests behind this change only when a publish job runs, and the
// response carries no caller state, so it is safe to hold at the edge. The
// module-level memo already absorbs most repeat traffic; this stops the rest
// before it reaches an instance.
const CACHE = 'public, s-maxage=300, stale-while-revalidate=3600';

function parseInteger(raw, { fallback, min, max }) {
	if (raw == null || raw === '') return fallback;
	if (!/^\d+$/.test(raw.trim())) return NaN;
	const n = Number(raw.trim());
	if (n < min || n > max) return NaN;
	return n;
}

export default wrap(async (req, res) => {
	// Open CORS: published CC0 and free-to-use manifests with no caller data in
	// them. The assets themselves already load cross-origin from the CDN, so
	// pinning the index to our own origin would only break the integrations that
	// read it.
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const params = url.searchParams;
	const origin = resolveOrigin(req);

	const id = params.get('id');
	if (id) {
		const item = await getCatalogItem(id);
		if (!item) {
			return error(res, 404, 'not_found', `no catalog item with id "${id}"`, {
				hint: 'Search first: GET /api/catalog?q=<term>. Ids look like "object:adjustable_wrench".',
			});
		}
		const { snippets, links, frameworks } = sourceFor(item, origin);
		const related = await relatedItems(item, 6);
		res.setHeader('Cache-Control', CACHE);
		return json(res, 200, { ok: true, item, links, related, frameworks, snippets });
	}

	const kind = params.get('kind');
	if (kind && !KINDS.includes(kind)) {
		return error(res, 400, 'validation_error', `kind must be one of: ${KINDS.join(', ')}`);
	}

	// Cursors are validated before the manifest read: a request that is going to
	// 400 must not pay for storage first, since the answer cannot change based on
	// what comes back.
	const limit = parseInteger(params.get('limit'), { fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
	if (Number.isNaN(limit)) {
		return error(res, 400, 'validation_error', `limit must be a whole number from 1 to ${MAX_LIMIT}`);
	}
	const offset = parseInteger(params.get('offset'), { fallback: 0, min: 0, max: 100_000 });
	if (Number.isNaN(offset)) {
		return error(res, 400, 'validation_error', 'offset must be a whole number from 0 to 100000');
	}

	const result = await searchCatalog({
		q: params.get('q') || undefined,
		kind: kind || undefined,
		category: params.get('category') || undefined,
		tag: params.get('tag') || undefined,
		limit,
		offset,
	});

	res.setHeader('Cache-Control', CACHE);
	return json(res, 200, { ok: true, ...result });
});
