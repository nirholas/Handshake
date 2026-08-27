// GET /api/kol/trades?mint=<mint>&limit=<n>
//
// This exact file is what /api/kol/trades resolves to: Vercel filesystem
// precedence (mirrored by server/index.mjs) puts an exact file ahead of a
// sibling [action].js, so the dispatcher never sees this path. Keep the trade
// feed here and nowhere else; a second copy inside api/kol/[action].js is dead
// code that silently drifts from the served one.

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { KOL_WALLETS } from '../../src/kol/wallets.js';
import { fetchKolTrades } from '../../src/kol/trades.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// fetchKolTrades fans out one Helius call per tracked wallet — meter per IP.
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const mint = url.searchParams.get('mint');
	// Clamp at the boundary so a hostile or fat-fingered limit (0, -5, "abc",
	// 1e9) can never reach the provider fan-out as anything but 1..100.
	const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 20));

	if (!mint) return error(res, 400, 'validation_error', 'mint required');
	// A mint that cannot be a Solana address would cost three Helius round trips
	// to prove empty. Reject it here instead.
	if (!BASE58_RE.test(mint))
		return error(res, 400, 'validation_error', 'mint must be a base58 Solana address');

	let result;
	try {
		result = await fetchKolTrades({ mint, limit });
	} catch (err) {
		// No last-good copy either: honest retryable error with a back-off hint.
		if (!err.status || err.status >= 500) res.setHeader('Retry-After', '15');
		return error(
			res,
			err.status || 502,
			err.code || 'provider_unavailable',
			err.message || 'provider error',
		);
	}

	res.setHeader('x-kol-source', result.source || 'unconfigured');
	if (result.stale) res.setHeader('x-kol-stale', '1');
	return json(res, 200, {
		mint,
		trades: result.trades,
		wallets: KOL_WALLETS?.length ?? 0,
		...(result.stale ? { stale: true, as_of: result.as_of } : {}),
	});
});
