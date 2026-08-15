// GET /api/v1/pump/whales?limit=1..25[&mint=<mint>][&minSol=<n>]
//
// Free, keyless whale / large-buy detection across pump.fun: the read
// version of the whale-activity oracle that otherwise sits behind the paid
// GET /api/x402/pump-agent-audit ("mode":"whale_activity"). Reports FACTS only
// (which wallets moved how much SOL, and when), no invented "bullish/bearish
// signal + confidence": that decorative framing is dropped here on purpose so
// the agent draws its own conclusion from the same underlying trades the paid
// oracle scores.
//
// The scan lives in api/_lib/pump-whale-scan.js (`scanTokenWhales` /
// `scanMarketWhales`), the SAME shared module behind the free
// GET /api/crypto/whales endpoint and (via the same pump.fun trade shape) the
// paid oracle: one whale-detection implementation, three doors, never a
// fourth copy-paste.
//
//   (omit mint) → top whale WALLETS active across pump.fun's top coins right now
//   ?mint=<m>   → whale BUYS of that specific token (per-transaction rows)

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { isValidSolanaAddress } from '../../_lib/validate.js';
import { scanTokenWhales, scanMarketWhales, WHALE_MIN_SOL_DEFAULT } from '../../_lib/pump-whale-scan.js';

const LIMIT_DEFAULT = 5;
const LIMIT_MAX = 25;

export default defineEndpoint({
	name: 'v1.pump.whales',
	method: 'GET',
	auth: 'public',
	handler: async ({ req, res, query }) => {
		// Dedicated-shared budget with the sibling free pump.fun v1 reads and the
		// /api/crypto/whales door this shares a scan engine with: a market-scope
		// scan fans out to several coins' trade feeds, so this bounds that cost.
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'pump whales is capped at 60 requests/min per IP');

		const mintRaw = typeof query.mint === 'string' ? query.mint.trim() : '';
		if (mintRaw && !isValidSolanaAddress(mintRaw)) {
			fail(400, 'validation_error', '"mint" must be a base58 Solana address');
		}

		let minSol = WHALE_MIN_SOL_DEFAULT;
		if (query.minSol != null && query.minSol !== '') {
			const raw = Number(query.minSol);
			if (!Number.isFinite(raw) || raw <= 0) {
				fail(400, 'validation_error', 'minSol must be a positive number');
			}
			minSol = Math.max(0.1, raw);
		}

		const rawLimit = Number(query.limit);
		const limit = Math.min(
			LIMIT_MAX,
			Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : LIMIT_DEFAULT),
		);

		const result = mintRaw
			? await scanTokenWhales({ mint: mintRaw, minSol, limit })
			: await scanMarketWhales({ minSol, limit });

		// Whale activity turns over fast; a short shared-edge cache collapses
		// bursts of identical polls without making the read stale.
		res.setHeader('cache-control', 'public, s-maxage=15, stale-while-revalidate=45');

		const body = {
			scope: result.scope,
			mint: result.mint,
			// Facts only: the decorative bullish/bearish "signal" the paid oracle
			// and /api/crypto/whales report is deliberately dropped here.
			wallets: result.whales,
			whale_count: result.whaleCount,
			total_sol_moved: result.totalSolMoved,
			min_sol: minSol,
			ts: result.ts,
			source: result.source,
		};
		if (result.degraded) {
			body.note = 'pump.fun feed is temporarily unavailable, returning an empty whale set; retry shortly';
		}
		// The feed was rate-limited and these rows came from the last-known-good
		// pull. Real trades, a few minutes old: say so rather than imply live.
		if (result.stale) body.stale = true;
		return body;
	},
});
