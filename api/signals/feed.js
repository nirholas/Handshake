/**
 * GET /api/signals/feed?slug=<slug>&network=mainnet
 *
 * One feed's public detail page: the publisher's verified track record, the
 * feed's proven signal accuracy (hit-rate, avg realized ROI, follower ROI,
 * emit-to-fill latency), pricing, and the recent emission log: every signal with
 * its realized outcome and a link to the on-chain tx that proves it.
 *
 * On a PAID feed the still-OPEN positions are the product, so they come back
 * redacted (no mint, no size, no tx links, `locked: true`) unless the caller is
 * the publisher or an active subscriber (security review L7). Closed signals stay
 * fully visible to everyone: that is the verifiable track record the feed sells
 * itself on. The response is therefore viewer-dependent and must never land in a
 * shared cache for a signed-in reader.
 */

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getFeedDetail } from '../_lib/signal-engine.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { normNetwork } from './_common.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const slug = url.searchParams.get('slug');
	if (!slug) return error(res, 400, 'invalid_slug', 'slug required');
	const network = normNetwork(url.searchParams.get('network'));

	// Identify the reader so a paying subscriber sees what they bought. A failed
	// or absent credential is simply an anonymous read, never an error.
	const session = await getSessionUser(req).catch(() => null);
	const bearer = session ? null : await authenticateBearer(extractBearer(req)).catch(() => null);
	const viewerUserId = session?.id ?? bearer?.userId ?? null;

	const detail = await getFeedDetail({ slug, network, viewerUserId });
	if (!detail) return error(res, 404, 'not_found', 'feed not found');

	// Only the anonymous projection is shareable across readers.
	res.setHeader(
		'cache-control',
		viewerUserId ? 'private, no-store' : 'public, max-age=10, stale-while-revalidate=30',
	);
	return json(res, 200, { feed: detail });
});
