// GET /api/v1/gas: keyless-first EVM gas prices for agents, one call, any chain.
//
// "What should I pay for gas right now?" answered with real next-block data,
// no API key, no wallet. Wraps the shared oracle chain in
// api/_lib/gas-oracles.js: Blocknative → Owlracle → Etherscan V2 (mainnet
// only), each rung keyless-capable and failing soft on its own timeout, so
// one starved guest quota or blocked host never takes the answer down.
//
// GET /api/v1/gas?chain=base           → normalized safe/standard/fast tiers
// GET /api/v1/gas                      → defaults to Ethereum mainnet
// GET /api/v1/gas?chains=1             → list supported chains + their sources
//
// Answers are cached server-side for one block-ish (10s) per chain, which is
// what actually protects the keyless upstream quotas: no matter how many
// clients ask, each chain costs at most ~6 upstream calls a minute.

import { defineEndpoint, fail } from '../_lib/gateway.js';
import { cacheWrap } from '../_lib/cache.js';
import { getGasEstimate, resolveGasChain, listGasChains } from '../_lib/gas-oracles.js';

const CACHE_TTL_SECONDS = 10;

export default defineEndpoint({
	name: 'v1.gas',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query }) => {
		// Discovery: the supported-chain table, derived from the oracle registry
		// so it can never drift from what getGasEstimate actually serves.
		if (query.chains === '1' || query.chains === 'true') {
			res.setHeader('cache-control', 'public, max-age=3600, s-maxage=3600');
			return { chains: listGasChains() };
		}

		const raw = typeof query.chain === 'string' && query.chain.trim() ? query.chain.trim() : 'ethereum';
		const chain = resolveGasChain(raw);
		if (!chain) {
			const supported = listGasChains().map((c) => c.chain).join(', ');
			fail(
				400,
				'unsupported_chain',
				`unknown chain "${raw}": pass a name, alias, or numeric chainId; supported: ${supported}`,
			);
		}

		try {
			const estimate = await cacheWrap(`gas:v1:${chain}`, CACHE_TTL_SECONDS, () =>
				getGasEstimate(chain),
			);
			// Public, cacheable read; set before returning so the gateway's
			// secure-by-default no-store doesn't override it.
			res.setHeader(
				'cache-control',
				`public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=30`,
			);
			return estimate;
		} catch (err) {
			if (err?.code === 'gas_sources_unavailable') {
				fail(
					503,
					'sources_unavailable',
					`every gas oracle serving ${chain} failed (${(err.attempts || [])
						.map((a) => `${a.source}: ${a.error}`)
						.join('; ')}); retry shortly`,
				);
			}
			throw err;
		}
	},
});
