/**
 * Smart-Money intel — public read API.
 *
 *   GET /api/intel/smart-money?mint=<addr>&network=mainnet
 *       → who reputable is net-buying this coin right now, a 0..100
 *         smart_money_score, the funder clusters in the book, and a sybil_flag
 *         when one cluster dominates.
 *   GET /api/intel/smart-money?wallet=<addr>&network=mainnet
 *       → one wallet's realized reputation card (also served by /api/intel/wallet/:addr)
 *
 * The edge: judge a coin by WHO is buying it, computed from real observed buys ⋈
 * real outcomes (graduated/pumped/rugged + ATH) — not a vanity list. The recompute
 * job (api/cron/smart-money-graph) maintains the graph; this serves it. Public +
 * IP rate-limited, briefly cached. Honest zero-data: `computed:false` means the
 * graph doesn't have enough on-chain history for this coin yet.
 *
 * $THREE is the only coin three.ws promotes — this assesses whatever runtime mint
 * the caller hands it and never names or recommends any token.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSmartMoneyForMint, getWalletReputation } from '../_lib/smart-money.js';

function normNetwork(v) {
	return v === 'devnet' ? 'devnet' : 'mainnet';
}

// Both params are Solana base58 pubkeys (32-44 chars). Rejecting obvious garbage
// here keeps the graph lookup off junk keys and matches /api/intel/wallet/:addr,
// which already 400s rather than echoing whatever the caller sent back at them.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function badRequest(res, message) {
	return json(res, 400, { error: 'bad_request', message });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = normNetwork(url.searchParams.get('network'));
	const wallet = (url.searchParams.get('wallet') || '').trim();
	const mint = (url.searchParams.get('mint') || '').trim();

	if (wallet) {
		if (!BASE58.test(wallet)) return badRequest(res, 'wallet must be a valid Solana address');
		const rep = await getWalletReputation(wallet, network);
		return json(res, 200, rep, {
			'cache-control': 'public, max-age=30, stale-while-revalidate=60',
		});
	}

	if (!mint) {
		return badRequest(res, 'mint or wallet query param required');
	}
	if (!BASE58.test(mint)) {
		return badRequest(res, 'mint must be a valid Solana mint address');
	}

	const result = await getSmartMoneyForMint(mint, network);
	return json(res, 200, result, {
		'cache-control': 'public, max-age=15, stale-while-revalidate=30',
	});
});
