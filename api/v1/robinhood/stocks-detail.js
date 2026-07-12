// GET /api/v1/robinhood/stocks-detail?symbol=AAPL — one Stock Token in depth.
//
// Free, keyless. Chainlink NAV (current + recent round history), all DEX pairs,
// premium/discount, uiMultiplier, holders + recent transfers (Blockscout), feed
// metadata, and contract links. Display-only — carries the eligibility
// disclosure; the acquisition gate lives on the purchase flow, never here.

import { defineEndpoint, fail } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import {
	findStock,
	chainlinkSnapshot,
	dexPairsForToken,
	feedRoundHistory,
	blockscoutToken,
	blockscoutHolders,
	blockscoutTransfers,
	premiumPct,
	BLOCKSCOUT_BASE,
	asOf,
} from '../../_lib/robinhood.js';

const CACHE_CONTROL = 'public, max-age=20, s-maxage=20, stale-while-revalidate=40';
const DISCLOSURE =
	'Stock Tokens are tokenized debt securities issued by Robinhood Assets (Jersey) Ltd and may not be offered, sold, or delivered to US persons. Data is display-only.';

export default defineEndpoint({
	name: 'v1.robinhood.stocks-detail',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		const rl = await limits.robinhoodRead(ip);
		if (!rl.success) return rateLimited(res, rl, 'Robinhood Chain data is capped at 60 requests/min per IP');

		const symbol = String(query.symbol || '').trim();
		if (!symbol) fail(400, 'validation_error', 'pass ?symbol=<ticker>, e.g. ?symbol=AAPL');
		const token = findStock(symbol);
		if (!token) fail(404, 'not_found', `no Robinhood Stock Token with symbol "${symbol}"`);

		const addrLc = token.address.toLowerCase();
		const [snap, pairs, navHistory, bsToken, holders, transfers] = await Promise.all([
			chainlinkSnapshot(),
			dexPairsForToken(token.address),
			token.feed ? feedRoundHistory(token.feed, 24) : Promise.resolve([]),
			blockscoutToken(token.address),
			blockscoutHolders(token.address, 25),
			blockscoutTransfers(token.address, 25),
		]);

		const feed = snap[addrLc] || null;
		const best = pairs[0] || null;
		const navPrice = feed?.priceUsd ?? null;
		const dexPrice = best?.priceUsd != null ? Number(best.priceUsd) : null;

		res.setHeader('cache-control', CACHE_CONTROL);
		return {
			symbol: token.symbol,
			name: token.name,
			address: token.address,
			decimals: token.decimals,
			nav: {
				feed: token.feed || null,
				priceUsd: navPrice,
				updatedAt: feed?.updatedAt ?? null,
				decimals: 8,
				history: navHistory,
			},
			dex: {
				priceUsd: dexPrice,
				premiumPct: premiumPct(dexPrice, navPrice),
				pairs: pairs.map((p) => ({
					dexId: p.dexId,
					pairAddress: p.pairAddress,
					quoteSymbol: p.quoteToken?.symbol ?? null,
					priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
					liquidityUsd: p.liquidity?.usd ?? null,
					volume24hUsd: p.volume?.h24 ?? null,
					priceChange: p.priceChange || null,
					url: p.url || null,
				})),
			},
			uiMultiplier: feed?.uiMultiplier ?? token.uiMultiplierAtGeneration ?? null,
			totalSupply: feed?.totalSupply ?? null,
			holdersCount: bsToken?.holders_count != null ? Number(bsToken.holders_count) : null,
			circulatingMarketCapUsd: bsToken?.circulating_market_cap != null ? Number(bsToken.circulating_market_cap) : null,
			iconUrl: bsToken?.icon_url || null,
			holders,
			recentTransfers: transfers,
			links: {
				explorer: `${BLOCKSCOUT_BASE}/token/${token.address}`,
				feed: token.feed ? `${BLOCKSCOUT_BASE}/address/${token.feed}` : null,
				dex: best?.url || null,
			},
			disclosure: DISCLOSURE,
			source: 'chainlink (on-chain) + dexscreener + blockscout',
			asOf: asOf(),
		};
	},
});
