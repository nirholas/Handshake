// GET /api/v1/evm/swap-quote - free, keyless EVM swap-quote aggregation.
//
// Read-only price discovery over the keyless provider chain in
// api/_lib/evm/swap-quotes.js (ParaSwap, then KyberSwap, then LI.FI; first
// success wins, each rung fails soft on its own timeout). This endpoint never
// builds, signs, or sends a transaction: it returns the normalized best quote
// and names the provider that served it.
//
//   ?chain=base
//   &sellToken=0x4200000000000000000000000000000000000006   (WETH)
//   &buyToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913    (USDC)
//   &amount=1000000000000000000                              (raw base units)
//
// -> { data: { provider, quote, attempts } }
//
// chain accepts a name (ethereum|base|polygon|arbitrum|optimism|bsc), a common
// alias (eth, matic, arb, op, bnb), or the numeric chain id. The native coin
// quotes via the providers' shared 0xeeee...eeee sentinel address. A quote miss
// on every rung is a 502 `quote_unavailable` naming each rung's failure, never
// a 500. Successful quotes carry a short public cache window: prices move
// block to block, so anything longer serves stale numbers.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { isValidEvmAddress } from '../../_lib/validate.js';
import { getSwapQuote, resolveChain, SUPPORTED_CHAINS } from '../../_lib/evm/swap-quotes.js';

const HIT_CACHE_CONTROL = 'public, max-age=10, s-maxage=10';
const RAW_AMOUNT_RE = /^[0-9]{1,78}$/;

export default defineEndpoint({
	name: 'v1.evm.swap-quote',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		// Dedicated per-IP budget on top of the gateway's shared apiV1 guard:
		// every cache miss fans out to up to three real upstreams, and the last
		// rung (LI.FI) is keyless with its own tight rate limits, so this caps a
		// scripted quote flood before it burns the shared lane.
		const rl = await limits.apiIp(ip, { limit: 30, window: '1 m' });
		if (!rl.success) return rateLimited(res, rl, 'swap quotes are capped at 30 requests/min per IP');

		const chain = resolveChain(typeof query.chain === 'string' ? query.chain : '');
		if (!chain) {
			fail(
				400,
				'validation_error',
				`chain must be one of ${SUPPORTED_CHAINS.join(', ')} (aliases like eth/matic/arb/op/bnb and numeric chain ids work too)`,
			);
		}

		const sellToken = typeof query.sellToken === 'string' ? query.sellToken.trim() : '';
		const buyToken = typeof query.buyToken === 'string' ? query.buyToken.trim() : '';
		if (!isValidEvmAddress(sellToken)) {
			fail(400, 'validation_error', 'sellToken must be a 0x token address (0xeeee...eeee for the native coin)');
		}
		if (!isValidEvmAddress(buyToken)) {
			fail(400, 'validation_error', 'buyToken must be a 0x token address (0xeeee...eeee for the native coin)');
		}
		if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
			fail(400, 'validation_error', 'sellToken and buyToken must differ');
		}

		const amount = typeof query.amount === 'string' ? query.amount.trim() : '';
		if (!RAW_AMOUNT_RE.test(amount) || BigInt(amount) <= 0n) {
			fail(
				400,
				'validation_error',
				'amount must be a positive integer in the sell token\'s RAW base units (e.g. 1000000000000000000 for 1 WETH)',
			);
		}

		let result;
		try {
			result = await getSwapQuote({ chain, sellToken, buyToken, amount });
		} catch (err) {
			const runs = Array.isArray(err?.attempts)
				? err.attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')
				: 'no provider reachable';
			fail(502, 'quote_unavailable', `no provider returned a quote (${runs}) - retry shortly`);
		}

		res.setHeader('cache-control', HIT_CACHE_CONTROL);
		return result;
	},
});
