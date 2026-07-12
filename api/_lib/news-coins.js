// news-coins — resolve the tickers a story mentions into a live market snapshot
// so the reader can render a real price card + sparkline for each coin, deep-
// linked to its /coin/:id profile. Also recorded into the agent knowledge base
// so an agent answering "what happened with SOL" has the price context inline.
//
// Only tickers that map to a known CoinGecko id (src/shared/news-links.js) are
// enriched — an unmapped symbol still renders as a news-search chip, it just
// carries no price card. One batched CoinGecko /coins/markets call covers every
// coin in the story.

import { geckoFetch } from './coingecko.js';
import { TICKER_COIN_IDS } from '../../src/shared/news-links.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {string[]} tickers  detected symbols (e.g. ['BTC','SOL'])
 * @returns {Promise<Array>}  one card per resolvable coin, in the input order,
 *   each: { symbol, id, name, image, price, change_24h, change_7d, market_cap,
 *           volume_24h, rank, sparkline: number[], href }
 */
export async function enrichTickers(tickers) {
	const seen = new Set();
	const ids = [];
	const symById = new Map();
	for (const t of tickers || []) {
		const sym = String(t || '').toUpperCase();
		const id = TICKER_COIN_IDS[sym];
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
		symById.set(id, sym);
		if (ids.length >= 8) break; // a story rarely needs more; keeps the call cheap
	}
	if (!ids.length) return [];

	let rows;
	try {
		rows = await geckoFetch(
			`/coins/markets?vs_currency=usd&ids=${ids.join(',')}&sparkline=true&price_change_percentage=24h,7d&precision=full`,
			{ ttlMs: 120_000 },
		);
	} catch {
		return []; // enrichment is optional — the story still renders without it
	}
	if (!Array.isArray(rows)) return [];

	const byId = new Map(rows.map((r) => [r.id, r]));
	const out = [];
	for (const id of ids) {
		const r = byId.get(id);
		if (!r) continue;
		// Downsample the 7d hourly sparkline (~168 pts) to ~48 for a light payload
		const raw = Array.isArray(r.sparkline_in_7d?.price) ? r.sparkline_in_7d.price : [];
		const step = Math.max(1, Math.ceil(raw.length / 48));
		const sparkline = raw.filter((_, i) => i % step === 0).map((n) => Number(n?.toFixed?.(6) ?? n));
		out.push({
			symbol: symById.get(id),
			id,
			name: r.name || symById.get(id),
			image: r.image || null,
			price: num(r.current_price),
			change_24h: num(r.price_change_percentage_24h_in_currency ?? r.price_change_percentage_24h),
			change_7d: num(r.price_change_percentage_7d_in_currency),
			market_cap: num(r.market_cap),
			volume_24h: num(r.total_volume),
			rank: num(r.market_cap_rank),
			sparkline,
			href: `/coin/${id}`,
		});
	}
	return out;
}
