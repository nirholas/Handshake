// GET /api/v1/robinhood/coins-detail?address=0x… — one Robinhood-chain coin.
//
// Free, keyless. DexScreener (price, market cap, FDV, liquidity, 24h volume,
// txns, price-change windows, age, deepest pool) + Blockscout (holders count,
// supply, recent holders + transfers). Non-security token — no eligibility gate.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import {
	dexPairsForToken,
	blockscoutToken,
	blockscoutHolders,
	blockscoutTransfers,
	BLOCKSCOUT_BASE,
	asOf,
} from '../../_lib/robinhood.js';

const CACHE_CONTROL = 'public, max-age=30, s-maxage=30, stale-while-revalidate=45';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export default defineEndpoint({
	name: 'v1.robinhood.coins-detail',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		const rl = await limits.robinhoodRead(ip);
		if (!rl.success) return rateLimited(res, rl, 'Robinhood Chain data is capped at 60 requests/min per IP');

		const address = String(query.address || '').trim();
		if (!ADDR_RE.test(address)) fail(400, 'validation_error', 'pass ?address=<0x… token address>');

		const [pairs, bsToken, holders, transfers] = await Promise.all([
			dexPairsForToken(address),
			blockscoutToken(address),
			blockscoutHolders(address, 25),
			blockscoutTransfers(address, 25),
		]);

		if (!pairs.length && !bsToken) {
			fail(404, 'not_found', 'no Robinhood-chain market or token record found for that address');
		}

		const best = pairs[0] || null;
		res.setHeader('cache-control', CACHE_CONTROL);
		return {
			address,
			symbol: (best?.baseToken?.symbol || bsToken?.symbol || '').toUpperCase() || null,
			name: best?.baseToken?.name || bsToken?.name || null,
			iconUrl: bsToken?.icon_url || (best?.info?.imageUrl ?? null),
			market: best
				? {
						priceUsd: best.priceUsd != null ? Number(best.priceUsd) : null,
						marketCapUsd: best.marketCap ?? null,
						fdvUsd: best.fdv ?? null,
						liquidityUsd: best.liquidity?.usd ?? null,
						volume24hUsd: best.volume?.h24 ?? null,
						priceChange: best.priceChange || null,
						txns24h: best.txns?.h24 || null,
						pairCreatedAt: best.pairCreatedAt ?? null,
						dexId: best.dexId ?? null,
						pairAddress: best.pairAddress ?? null,
						quoteSymbol: best.quoteToken?.symbol ?? null,
						url: best.url || null,
					}
				: null,
			pools: pairs.map((p) => ({
				dexId: p.dexId,
				pairAddress: p.pairAddress,
				quoteSymbol: p.quoteToken?.symbol ?? null,
				priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
				liquidityUsd: p.liquidity?.usd ?? null,
				volume24hUsd: p.volume?.h24 ?? null,
			})),
			holdersCount: bsToken?.holders_count != null ? Number(bsToken.holders_count) : null,
			totalSupply: bsToken?.total_supply ?? null,
			decimals: bsToken?.decimals != null ? Number(bsToken.decimals) : null,
			holders,
			recentTransfers: transfers,
			links: {
				explorer: `${BLOCKSCOUT_BASE}/token/${address}`,
				dex: best?.url || null,
			},
			source: 'dexscreener + blockscout',
			asOf: asOf(),
		};
	},
});
