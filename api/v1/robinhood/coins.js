// GET /api/v1/robinhood/coins — Robinhood Chain memecoin screener.
//
// Free, keyless. Two lenses:
//   ?category=meme|stocks-ecosystem|ecosystem  (default meme)
//   ?sort=market_cap|volume|gainers|losers      (default market_cap)
// Primary source is the CoinGecko category ("Robinhood Chain Meme" /
// "Robinhood Chain Stocks Ecosystem") — real price, market cap, 24h/7d change,
// and a 7-day sparkline per coin. No eligibility restriction: these are
// non-security tokens.

import { defineEndpoint } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { coingeckoCategory, asOf } from '../../_lib/robinhood.js';

const CACHE_CONTROL = 'public, max-age=45, s-maxage=45, stale-while-revalidate=60';
const CATEGORIES = {
	meme: 'robinhood-chain-meme',
	'stocks-ecosystem': 'robinhood-chain-stocks-ecosystem',
	ecosystem: 'robinhood-ecosystem',
};

export default defineEndpoint({
	name: 'v1.robinhood.coins',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		const rl = await limits.robinhoodRead(ip);
		if (!rl.success) return rateLimited(res, rl, 'Robinhood Chain data is capped at 60 requests/min per IP');

		const catKey = CATEGORIES[String(query.category || 'meme')] ? String(query.category || 'meme') : 'meme';
		const sort = String(query.sort || 'market_cap');
		const order = sort === 'volume' ? 'volume_desc' : 'market_cap_desc';
		const raw = await coingeckoCategory(CATEGORIES[catKey], { order, perPage: 100 });

		let coins = raw.map((c) => ({
			id: c.id,
			symbol: (c.symbol || '').toUpperCase(),
			name: c.name,
			image: c.image || null,
			priceUsd: c.current_price ?? null,
			marketCapUsd: c.market_cap ?? null,
			marketCapRank: c.market_cap_rank ?? null,
			volume24hUsd: c.total_volume ?? null,
			priceChange24hPct: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? null,
			priceChange7dPct: c.price_change_percentage_7d_in_currency ?? null,
			sparkline7d: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price : null,
			ath: c.ath ?? null,
			athChangePct: c.ath_change_percentage ?? null,
		}));

		if (sort === 'gainers') coins.sort((a, b) => (b.priceChange24hPct ?? -Infinity) - (a.priceChange24hPct ?? -Infinity));
		else if (sort === 'losers') coins.sort((a, b) => (a.priceChange24hPct ?? Infinity) - (b.priceChange24hPct ?? Infinity));

		res.setHeader('cache-control', CACHE_CONTROL);
		return {
			coins,
			count: coins.length,
			category: catKey,
			categoryLabel: { meme: 'Robinhood Chain Meme', 'stocks-ecosystem': 'Robinhood Chain Stocks Ecosystem', ecosystem: 'Robinhood Ecosystem' }[catKey],
			sort,
			source: 'coingecko',
			asOf: asOf(),
		};
	},
});
