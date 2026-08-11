/**
 * GET /api/reputation/market?network=devnet&limit=25
 *
 * The reputation staking market: agents ranked by NET staked conviction, with
 * the current epoch's yield weight and the rate their stakers have actually
 * realized. Every number traces to a signed attestation or an escrowed lamport;
 * nothing here is projected forward.
 *
 * Contract: specs/REPUTATION_STAKING_MARKET.md §8. Walkthrough:
 * docs/reputation-staking-market.md.
 */

import { cors, json, method, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isDbUnavailableError } from '../_lib/db.js';
import { listMarket, MarketError } from '../_lib/reputation-market.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = p.get('network') === 'mainnet' ? 'mainnet' : 'devnet';
	const limit = Math.min(100, Math.max(1, Number(p.get('limit') || 25)));

	try {
		const body = await listMarket({ network, limit });
		return json(res, 200, body, { 'cache-control': 'public, max-age=30, s-maxage=60' });
	} catch (err) {
		if (err instanceof MarketError) return error(res, err.status, err.code, err.message);
		if (isDbUnavailableError(err)) {
			return error(res, 503, 'db_unavailable', 'The market index is temporarily unavailable.');
		}
		throw err;
	}
});
