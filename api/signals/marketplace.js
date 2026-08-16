/**
 * GET /api/signals/marketplace?network=mainnet&sort=edge&limit=60
 *
 * The public signal-feed directory. Every active, public feed is scored by its
 * PROVEN realized edge (hit-rate times realized ROI, confidence-regressed toward
 * the publisher's own verified track-record score until enough signals have
 * closed) and ranked. A thin feed riding one lucky call can never top a deep,
 * consistent one. Open read: no auth, cacheable.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getMarketplace, FEED_SORTS } from '../_lib/signal-engine.js';
import { normNetwork } from './_common.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = normNetwork(url.searchParams.get('network'));
	const sort = FEED_SORTS.has(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'edge';
	const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 60));

	const result = await getMarketplace({ network, sort, limit });
	res.setHeader('cache-control', 'public, max-age=15, stale-while-revalidate=60');
	return json(res, 200, result);
});
