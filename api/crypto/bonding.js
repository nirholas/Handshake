// GET /api/crypto/bonding — free, keyless bonding-curve / graduation status for a
// pump.fun token.
//
// Agent use-case: an agent holding or watching a pump.fun coin needs to know
// exactly where it sits on the bonding curve — % to graduation, SOL in the curve,
// and whether it has already migrated to Raydium / PumpSwap. Timing entries and
// exits around graduation is a core meme-trading move, and this is the one read
// that answers it. Pairs with /api/crypto/launches (discover fresh mints) and
// /api/crypto/whales.
//
// Part of the free Crypto Data API (/api/crypto/*). Plain-handler pattern: no
// account, no key, generous per-IP limit. Real data only — the pump.fun public
// frontend feed via api/_lib/pump-bonding.js.

import { cors, method, wrap, error, json, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getBondingStatus } from '../_lib/pump-bonding.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const mint = (url.searchParams.get('mint') || '').trim();

	if (!mint) {
		return error(
			res,
			400,
			'missing_mint',
			'query param `mint` is required — pass a pump.fun token mint, e.g. ?mint=<base58-mint>',
		);
	}
	if (!MINT_RE.test(mint)) {
		return error(
			res,
			400,
			'invalid_mint',
			'`mint` must be a base58 Solana address (32–44 chars)',
			{ mint },
		);
	}

	const result = await getBondingStatus(mint);
	const ts = new Date().toISOString();

	// Not a pump.fun-indexed mint (never launched on pump.fun, or not a bonding-curve
	// token) — a client error, so 400 with a pointer to discovery.
	if (result.kind === 'not_found') {
		return error(
			res,
			400,
			'not_pumpfun_mint',
			`${mint} is not a pump.fun bonding-curve token — it never launched on pump.fun or isn't indexed. Discover live pump.fun mints at /api/crypto/launches.`,
			{ mint },
		);
	}

	// pump.fun feed temporarily unreachable (network / timeout / 5xx). Never 500 —
	// answer 503 + Retry-After so the agent backs off and retries, per the free-API
	// contract.
	if (result.kind === 'upstream_down') {
		return json(
			res,
			503,
			{
				error: 'upstream_unavailable',
				error_description: 'pump.fun data source is temporarily unreachable — retry shortly',
				mint,
				retry_after: 15,
				ts,
			},
			{ 'cache-control': 'no-store', 'retry-after': '15' },
		);
	}

	const s = result.status;
	return json(
		res,
		200,
		{
			mint,
			onCurve: s.onCurve,
			bondingProgressPct: s.bondingProgressPct,
			solInCurve: s.solInCurve,
			tokensRemaining: s.tokensRemaining,
			marketCapUsd: s.marketCapUsd,
			graduated: s.graduated,
			migratedTo: s.migratedTo,
			ts,
			source: s.source,
		},
		// Bonding-curve state moves fast; short CDN cache + SWR keeps a polling agent
		// responsive without hammering the pump.fun feed.
		{ 'cache-control': 'public, s-maxage=15, stale-while-revalidate=30' },
	);
});
