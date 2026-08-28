// Hyperliquid public info API (keyless): perpetual-futures market data from
// the largest perp DEX. One POST endpoint serves every read; this module wraps
// the `metaAndAssetCtxs` snapshot (mark price, funding, open interest, 24h
// notional volume per listed perp) and normalizes it to the exact ticker row
// shape /api/coin/derivatives emits, so it can stand in for CoinGecko's
// derivatives feed when that upstream is down.
//
// Verified reachable from US datacenter IPs (unlike Binance/Bybit/OKX, which
// geo-block them; see the note in api/_lib/sol-price.js). No key, no account.

import { fetchUpstreamJson, lastGood } from './upstream-fetch.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/**
 * POST a query to the Hyperliquid info endpoint.
 * @param {object} body       e.g. { type: 'metaAndAssetCtxs' }
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function hlInfo(body, { timeoutMs = 8000 } = {}) {
	// One venue, no alternative reporting the same contracts, and a throw here
	// empties the derivatives view entirely. So: retry the transient half, and
	// keep the last good answer per query shape to ride out the rest. The body is
	// the cache key because each `type` is a different question.
	const key = `hyperliquid:${JSON.stringify(body).slice(0, 200)}`;
	const { value } = await lastGood(
		key,
		() => fetchUpstreamJson(HL_INFO_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
		}, { name: 'hyperliquid:info', timeoutMs, attempts: 2 }),
		{ maxAgeMs: 10 * 60_000 },
	);
	return value;
}

/**
 * Zip the `metaAndAssetCtxs` response ([meta, assetCtxs], index-aligned) into
 * derivatives ticker rows matching api/coin/derivatives.js:
 *   { market, symbol, index_id, price, change_24h, funding_rate,
 *     open_interest, volume_24h }
 *
 * Unit notes, pinned by tests:
 * - Hyperliquid funding is an HOURLY decimal rate; CoinGecko's derivatives
 *   rows quote the venue's 8h funding as a percentage, so this converts to an
 *   8h-equivalent percent (rate * 8 * 100) to keep the column comparable.
 * - openInterest is in base-asset units; rows carry USD notional, so it is
 *   multiplied by the mark price.
 * - Delisted assets and assets without a positive mark price are dropped.
 *
 * @param {[{ universe: Array<{name:string, isDelisted?:boolean}> }, Array<object>]} payload
 * @returns {Array<object>} rows sorted by 24h volume desc
 */
export function normalizeHyperliquidPerps(payload) {
	const universe = Array.isArray(payload?.[0]?.universe) ? payload[0].universe : [];
	const ctxs = Array.isArray(payload?.[1]) ? payload[1] : [];
	const rows = [];
	for (let i = 0; i < universe.length && i < ctxs.length; i++) {
		const asset = universe[i];
		const ctx = ctxs[i];
		if (!asset?.name || asset.isDelisted) continue;
		const price = num(ctx?.markPx);
		if (!(price > 0)) continue;
		const prevDay = num(ctx?.prevDayPx);
		const funding = num(ctx?.funding);
		const oiCoins = num(ctx?.openInterest);
		rows.push({
			market: 'Hyperliquid',
			symbol: `${asset.name}-USD`,
			index_id: asset.name,
			price,
			change_24h: prevDay > 0 ? ((price / prevDay) - 1) * 100 : null,
			funding_rate: funding != null ? funding * 8 * 100 : null,
			open_interest: oiCoins != null ? oiCoins * price : null,
			volume_24h: num(ctx?.dayNtlVlm),
		});
	}
	return rows.sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0));
}

/**
 * Live Hyperliquid perp tickers in the /api/coin/derivatives row shape.
 * @returns {Promise<Array<object>>}
 * @throws when the API is unreachable or returns an empty universe.
 */
export async function fetchHyperliquidPerps() {
	const payload = await hlInfo({ type: 'metaAndAssetCtxs' });
	const rows = normalizeHyperliquidPerps(payload);
	if (!rows.length) throw new Error('hyperliquid returned no perps');
	return rows;
}
