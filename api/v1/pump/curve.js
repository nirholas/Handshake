// GET /api/v1/pump/curve?mint=<mint>
//
// Free, keyless bonding-curve / graduation status for a pump.fun token:
// registers the free Crypto Data API's bonding-curve reader
// (api/_lib/pump-bonding.js `getBondingStatus`, already live at
// GET /api/crypto/bonding) under the versioned, cataloged /api/v1 surface so
// agents can discover it via GET /api/v1. Same engine, same response shape:
// a thin wrapper, not a fork.
//
// Answers: % to graduation, SOL in the curve, tokens remaining, market cap, and
// whether the coin has already migrated to an AMM (Raydium / PumpSwap).

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { isValidSolanaAddress } from '../../_lib/validate.js';
import { getBondingStatus } from '../../_lib/pump-bonding.js';

export default defineEndpoint({
	name: 'v1.pump.curve',
	method: 'GET',
	auth: 'public',
	handler: async ({ req, res, query }) => {
		const mint = typeof query.mint === 'string' ? query.mint.trim() : '';
		if (!mint) fail(400, 'validation_error', '"mint" query parameter is required');
		if (!isValidSolanaAddress(mint)) {
			fail(400, 'validation_error', '"mint" must be a base58 Solana address');
		}

		// Dedicated-shared budget with the sibling free pump.fun v1 reads and the
		// /api/crypto/bonding door this wraps.
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'pump curve is capped at 60 requests/min per IP');

		const result = await getBondingStatus(mint);

		if (result.kind === 'not_found') {
			fail(
				400,
				'not_pumpfun_mint',
				`${mint} is not a pump.fun bonding-curve token: it never launched on pump.fun or isn't indexed. Discover live pump.fun mints at /api/v1/pump/launches or /api/v1/pump/trending.`,
			);
		}
		if (result.kind === 'upstream_down') {
			fail(503, 'upstream_unavailable', 'pump.fun data source is temporarily unreachable, retry shortly');
		}

		const s = result.status;
		// Bonding-curve state moves fast; short CDN cache + SWR keeps a polling
		// agent responsive without hammering the pump.fun feed.
		res.setHeader('cache-control', 'public, s-maxage=15, stale-while-revalidate=30');
		return {
			mint,
			onCurve: s.onCurve,
			bondingProgressPct: s.bondingProgressPct,
			solInCurve: s.solInCurve,
			tokensRemaining: s.tokensRemaining,
			marketCapUsd: s.marketCapUsd,
			graduated: s.graduated,
			migratedTo: s.migratedTo,
			source: s.source,
		};
	},
});
