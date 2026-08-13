/**
 * Wallet reputation: the public read API.
 *
 *   GET /api/intel/wallet/<address>?network=mainnet
 *       → one wallet's realized track record from the Smart-Money graph:
 *         realized_score (0..100), win_rate, avg ATH multiple, winners/losers,
 *         labels (smart_money / sybil / fresh / …), and its funder cluster.
 *
 * Computed from real observed buys ⋈ real outcomes by the recompute job
 * (api/cron/smart-money-graph). Public + IP rate-limited, briefly cached. Honest
 * zero-data: `computed:false` means we have no track record for this address yet.
 *
 * Public on-chain address analytics only. Never exposes or stores private keys.
 */

import { cors, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { getWalletReputation } from '../../_lib/smart-money.js';

function normNetwork(v) {
	return v === 'devnet' ? 'devnet' : 'mainnet';
}

// A base58 Solana address is 32–44 chars from the base58 alphabet. We don't need a
// full decode here (the lookup degrades to zero-data on a miss anyway). This just
// rejects obvious garbage before a DB round-trip.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = normNetwork(url.searchParams.get('network'));

	// Vercel injects the [address] segment as a query param; fall back to parsing
	// the path so the endpoint also works when invoked directly in dev.
	let address = url.searchParams.get('address');
	if (!address) {
		const parts = url.pathname.split('/').filter(Boolean);
		address = parts[parts.length - 1];
	}
	address = (address || '').trim();

	if (!BASE58.test(address)) {
		return json(res, 400, { error: 'bad_request', message: 'a valid Solana address is required' });
	}

	const rep = await getWalletReputation(address, network);
	return json(res, 200, rep, {
		'cache-control': 'public, max-age=30, stale-while-revalidate=60',
	});
});
