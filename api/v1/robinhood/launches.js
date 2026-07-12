// GET /api/v1/robinhood/launches — recent launchpad activity on Robinhood Chain.
//
// Free, keyless. Newest token launches from the NOXA (instant Uniswap v3) and
// The Odyssey (bonding-curve) launchpads, read from Blockscout's decoded-log
// API (TokenLaunched / TokenCreated), then enriched with DexScreener market
// data where a pool already exists. Newest first.

import { defineEndpoint } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { recentLaunches, dexSnapshot, BLOCKSCOUT_BASE, asOf } from '../../_lib/robinhood.js';

const CACHE_CONTROL = 'public, max-age=30, s-maxage=30, stale-while-revalidate=45';

export default defineEndpoint({
	name: 'v1.robinhood.launches',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		const rl = await limits.robinhoodRead(ip);
		if (!rl.success) return rateLimited(res, rl, 'Robinhood Chain data is capped at 60 requests/min per IP');

		const limit = Math.min(60, Math.max(1, Number(query.limit) || 40));
		const launches = await recentLaunches({ limit });
		const dex = await dexSnapshot(launches.map((l) => l.token));

		const enriched = launches.map((l) => {
			const pair = dex[l.token.toLowerCase()] || null;
			return {
				launchpad: l.launchpad,
				type: l.type,
				token: l.token,
				deployer: l.deployer,
				block: l.block,
				txHash: l.txHash,
				timestamp: l.timestamp,
				symbol: pair?.baseToken?.symbol || null,
				name: pair?.baseToken?.name || null,
				priceUsd: pair?.priceUsd != null ? Number(pair.priceUsd) : null,
				marketCapUsd: pair?.marketCap ?? null,
				liquidityUsd: pair?.liquidity?.usd ?? null,
				volume24hUsd: pair?.volume?.h24 ?? null,
				hasMarket: Boolean(pair),
				links: {
					token: `${BLOCKSCOUT_BASE}/token/${l.token}`,
					tx: l.txHash ? `${BLOCKSCOUT_BASE}/tx/${l.txHash}` : null,
				},
			};
		});

		res.setHeader('cache-control', CACHE_CONTROL);
		return {
			launches: enriched,
			count: enriched.length,
			launchpads: [
				{ name: 'NOXA', style: 'instant', url: 'https://fun.noxa.fi' },
				{ name: 'The Odyssey', style: 'bonding-curve', url: 'https://theodyssey.fun' },
			],
			source: 'blockscout (on-chain logs) + dexscreener',
			asOf: asOf(),
		};
	},
});
