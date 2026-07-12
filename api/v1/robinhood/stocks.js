// GET /api/v1/robinhood/stocks — the 24/7 tokenized-equity board.
//
// Free, keyless. For every Stock Token in the registry: Chainlink NAV price
// (one on-chain multicall — the anti-fan-out snapshot, not 95 eth_calls), the
// deepest DEX mid price (DexScreener, batched 30 addresses/call), the
// premium/discount between them, uiMultiplier, 24h DEX volume + liquidity.
//
// Legal line: Stock Tokens are tokenized debt securities (issuer: Robinhood
// Assets (Jersey) Ltd), not offered/sold to US persons. Displaying data is
// unrestricted — this endpoint is display-only. The eligibility gate lives on
// any acquisition flow, never here.

import { defineEndpoint } from '../../_lib/gateway.js';
import { rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import {
	stockRegistry,
	chainlinkSnapshot,
	dexSnapshot,
	premiumPct,
	asOf,
} from '../../_lib/robinhood.js';

const CACHE_CONTROL = 'public, max-age=20, s-maxage=20, stale-while-revalidate=40';
const DISCLOSURE =
	'Stock Tokens are tokenized debt securities issued by Robinhood Assets (Jersey) Ltd and may not be offered, sold, or delivered to US persons. Data is display-only.';

export default defineEndpoint({
	name: 'v1.robinhood.stocks',
	method: 'GET',
	auth: 'public',
	handler: async ({ res, query, ip }) => {
		const rl = await limits.robinhoodRead(ip);
		if (!rl.success) return rateLimited(res, rl, 'Robinhood Chain data is capped at 60 requests/min per IP');

		const reg = stockRegistry();
		const addresses = reg.tokens.map((t) => t.address);
		const [nav, dex] = await Promise.all([chainlinkSnapshot(), dexSnapshot(addresses)]);

		let rows = reg.tokens.map((t) => {
			const addrLc = t.address.toLowerCase();
			const feed = nav[addrLc] || null;
			const pair = dex[addrLc] || null;
			const navPrice = feed?.priceUsd ?? null;
			const dexPrice = pair?.priceUsd != null ? Number(pair.priceUsd) : null;
			return {
				symbol: t.symbol,
				name: t.name,
				address: t.address,
				decimals: t.decimals,
				feed: t.feed || null,
				navPriceUsd: navPrice,
				navUpdatedAt: feed?.updatedAt ?? null,
				dexPriceUsd: dexPrice,
				dexId: pair?.dexId ?? null,
				pairAddress: pair?.pairAddress ?? null,
				quoteSymbol: pair?.quoteToken?.symbol ?? null,
				premiumPct: premiumPct(dexPrice, navPrice),
				uiMultiplier: feed?.uiMultiplier ?? t.uiMultiplierAtGeneration ?? null,
				volume24hUsd: pair?.volume?.h24 ?? null,
				liquidityUsd: pair?.liquidity?.usd ?? null,
				priceChange24hPct: pair?.priceChange?.h24 ?? null,
			};
		});

		// Optional filters/sorting for the board.
		const q = String(query.q || '').trim().toLowerCase();
		if (q) rows = rows.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
		const sort = String(query.sort || 'symbol');
		const dir = query.dir === 'asc' ? 1 : -1;
		const key = { volume: 'volume24hUsd', liquidity: 'liquidityUsd', premium: 'premiumPct', price: 'navPriceUsd', symbol: 'symbol' }[sort] || 'symbol';
		rows.sort((a, b) => {
			if (key === 'symbol') return a.symbol.localeCompare(b.symbol) * (query.dir === 'desc' ? -1 : 1);
			return ((b[key] ?? -Infinity) - (a[key] ?? -Infinity)) * dir;
		});

		res.setHeader('cache-control', CACHE_CONTROL);
		return {
			stocks: rows,
			count: rows.length,
			feedCount: reg.feedCount,
			disclosure: DISCLOSURE,
			source: 'chainlink (on-chain) + dexscreener',
			asOf: asOf(),
		};
	},
});
