// GET /api/v1/robinhood/chain — Robinhood Chain (4663) stats.
//
// Free, keyless. Real data: block height + gas (Blockscout), TVL now + 90-day
// history (DefiLlama /chain/robinhood-chain). Cached upstream (15s stats, 120s
// TVL), dedicated per-IP bucket. Robinhood Chain is a permissionless Arbitrum
// Orbit L2 (ETH gas, ~100ms blocks); it has NO native chain token.

import { defineEndpoint } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import {
	blockscoutStats,
	chainTvlCurrent,
	chainTvlHistory,
	publicClient,
	asOf,
} from '../../_lib/robinhood.js';

const CACHE_CONTROL = 'public, max-age=15, s-maxage=15, stale-while-revalidate=30';

export default defineEndpoint({
	name: 'v1.robinhood.chain',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, ip }) => {
		const rl = await limits.robinhoodRead(ip);
		if (!rl.success) return rateLimited(res, rl, 'Robinhood Chain data is capped at 60 requests/min per IP');

		const [stats, tvl, tvlHistory, blockNumber] = await Promise.all([
			blockscoutStats(),
			chainTvlCurrent(),
			chainTvlHistory(),
			publicClient(false)
				.getBlockNumber()
				.then((n) => Number(n))
				.catch(() => null),
		]);

		const gas = stats && !stats.__error ? stats.gas_prices || null : null;
		res.setHeader('cache-control', CACHE_CONTROL);
		return {
			chain: {
				name: 'Robinhood Chain',
				chainId: 4663,
				type: 'Arbitrum Orbit L2',
				gasToken: 'ETH',
				nativeChainToken: null,
				explorer: 'https://robinhoodchain.blockscout.com',
				rpc: 'https://rpc.mainnet.chain.robinhood.com',
			},
			blockHeight: blockNumber ?? (stats?.total_blocks ? Number(stats.total_blocks) : null),
			averageBlockTimeMs: stats && !stats.__error ? stats.average_block_time ?? null : null,
			totalTransactions: stats && !stats.__error ? stats.total_transactions ?? null : null,
			totalAddresses: stats && !stats.__error ? stats.total_addresses ?? null : null,
			gas: gas
				? {
						slow: gas.slow ?? null,
						average: gas.average ?? null,
						fast: gas.fast ?? null,
						unit: 'gwei',
					}
				: null,
			ethPriceUsd: stats && !stats.__error && stats.coin_price ? Number(stats.coin_price) : null,
			tvlUsd: tvl ?? null,
			tvlHistory,
			source: 'blockscout + defillama',
			asOf: asOf(),
		};
	},
});
