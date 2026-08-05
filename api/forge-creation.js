/**
 * Forge creation — a single durable creation, fetched by id for sharing.
 *
 *   GET /api/forge-creation?id=<uuid>   → { enabled, creation }
 *
 * Unlike /api/forge-gallery (which is scoped to the requesting browser's
 * anonymous client key), this is a PUBLIC read: it returns any finished,
 * durably-stored creation by id so a share-link recipient — who never forged
 * the model and has no matching gallery row — can still view it in the full
 * forge UI. The share page (api/forge-share.js) lands real browsers on
 * /forge?share=<id>, and the page fetches this endpoint to open the model.
 *
 * Only finished creations with a durable glb_url are exposed; in-flight or
 * failed rows return { creation: null }. When persistence isn't configured the
 * endpoint returns { enabled: false, creation: null } so the page degrades
 * cleanly instead of showing a broken state.
 *
 * The model detail page (/m/:id) uses two additive params:
 *   ?related=<1..12>  includes a `related` array of suggested models
 *                     (same category first, newest, never the model itself)
 *   ?view=1           counts one page impression (fire-and-forget increment
 *                     of forge_creations.view_count; never blocks the read)
 */

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getPublicCreation, listRelated, recordCreationView, hashClient, forgeStoreEnabled } from './_lib/forge-store.js';
import { isUuid } from './_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	if (!forgeStoreEnabled()) {
		return json(res, 200, { enabled: false, creation: null });
	}

	const url = new URL(req.url, 'http://localhost');
	const id = url.searchParams.get('id');
	if (!id || !isUuid(id)) {
		return json(res, 400, { enabled: true, creation: null, error: 'invalid id' });
	}

	// Optional anonymous browser id (same forge:cid the gallery uses) resolves
	// this browser's own voted-state on the model's like button.
	const rawClient = req.headers['x-forge-client'];
	const clientHeader = Array.isArray(rawClient) ? rawClient[0] : rawClient;
	const voterKey = clientHeader ? hashClient(clientHeader) : null;

	const creation = await getPublicCreation({ id, voterKey });
	if (!creation) {
		return json(res, 404, { enabled: true, creation: null });
	}

	if (url.searchParams.get('view') === '1') {
		// Deliberately not awaited past the increment failing soft: an uncounted
		// view must never break (or slow) the model read.
		recordCreationView({ id }).catch(() => {});
	}

	const relatedParam = Number(url.searchParams.get('related'));
	if (Number.isFinite(relatedParam) && relatedParam > 0) {
		const related = await listRelated({
			id,
			category: creation.model_category,
			limit: relatedParam,
		});
		return json(res, 200, { enabled: true, creation, related });
	}
	return json(res, 200, { enabled: true, creation });
});
