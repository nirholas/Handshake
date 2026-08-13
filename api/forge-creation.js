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
 *
 *   DELETE /api/forge-creation?id=<uuid>  → { deleted: true }
 *
 * Deletion is scoped to the owning browser (the x-forge-client header that
 * scopes the gallery): only the client that forged a creation can delete it.
 * It permanently removes the stored GLB, the stored preview, every recorded
 * source upload (the reference photos an image-to-3D run was conditioned on),
 * and the row itself, so a deleted creation is gone from the gallery, the
 * community showcase, and the share/embed pages alike.
 */

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getPublicCreation, listRelated, recordCreationView, deleteCreation, hashClient, forgeStoreEnabled } from './_lib/forge-store.js';
import { isUuid } from './_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,DELETE,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'DELETE'])) return;

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

	if (req.method === 'DELETE') {
		const rawClient = req.headers['x-forge-client'];
		const clientHeader = Array.isArray(rawClient) ? rawClient[0] : rawClient;
		if (!clientHeader) {
			return json(res, 401, { error: 'missing_client', message: 'x-forge-client header required.' });
		}
		const outcome = await deleteCreation({ id, clientKey: hashClient(clientHeader) });
		if (outcome === 'deleted') return json(res, 200, { deleted: true });
		if (outcome === 'not_found') {
			// Either the id doesn't exist or it belongs to another client; both
			// answer the same so ids can't be probed for existence.
			return json(res, 404, { deleted: false, error: 'not_found' });
		}
		return json(res, 503, {
			deleted: false,
			error: 'delete_failed',
			message: 'Could not delete right now. Nothing was removed; try again shortly.',
		});
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
