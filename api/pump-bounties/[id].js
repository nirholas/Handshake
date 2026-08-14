// GET /api/pump-bounties/:id — a single pump.fun GO bounty + its submissions.
//
// `id` is the off-chain task uuid. Fetches the bounty detail and (best-effort)
// its submissions in parallel from the public livestream-api, normalizes, and
// caches briefly. A submissions failure degrades to an empty list rather than
// failing the whole page — the bounty itself is the primary content.

import { cors, json, error, wrap, method } from '../_lib/http.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { isUuid } from '../_lib/validate.js';
import { getBounty, getSubmissions, PumpGoError } from '../_lib/pump-go.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const id = req.query?.id || req.url?.split('/').pop()?.split('?')[0];
	if (!id || !isUuid(id)) return error(res, 400, 'bad_request', 'valid bounty taskId required');

	const cacheKey = `pumpgo:task:${id}`;
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) {
		res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
		return json(res, 200, cached);
	}

	let bounty, submissions;
	try {
		[bounty, submissions] = await Promise.all([
			getBounty(id),
			getSubmissions(id, { limit: 50 }).catch((e) => {
				// Degrading to an empty list is deliberate, but a silent degrade hides a
				// real pump.fun outage behind a page that just looks unpopular. Log it.
				console.warn(`[pump-bounties] submissions for ${id} unavailable: ${e.message}`);
				return { items: [], nextCursor: null };
			}),
		]);
	} catch (e) {
		if (e instanceof PumpGoError) return error(res, e.status, e.code, e.message);
		throw e;
	}
	if (!bounty) return error(res, 404, 'not_found', 'bounty not found');

	const payload = {
		bounty,
		submissions: submissions.items,
		submissionsCursor: submissions.nextCursor,
	};
	await cacheSet(cacheKey, payload, 30).catch(() => {});
	res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
	return json(res, 200, payload);
});
