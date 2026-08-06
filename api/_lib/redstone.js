// @ts-check
// RedStone oracle: keyless public REST read of the redstone provider's signed
// price stream (api.redstone.finance). One more independent methodology for
// the price failover chains: RedStone aggregates ~20 exchange sources into a
// signed data point, so it keeps answering through a CoinGecko rate-limit or a
// single-exchange API outage.
//
// Endpoint (verified live 2026-08-05):
//   GET https://api.redstone.finance/prices?symbol=SOL&provider=redstone&limit=1
//   -> [{ symbol: "SOL", value: 73.955, timestamp: 1785974160000, source: {...}, ... }]
// No key, no auth header, sub-second latency. The same endpoint serves any
// listed ticker symbol, which is what makes this a general token rung and not
// a SOL-only one.
//
// A stuck oracle is worse than a missing one: a `timestamp` older than
// MAX_AGE_MS makes the row a MISS (null), so the failover chain moves on to a
// live source instead of valuing anything with a stale print.

const REDSTONE_BASE = 'https://api.redstone.finance';

// RedStone publishes new data points continuously (the live feed updates on a
// seconds cadence); ten minutes of silence means the stream is stuck, not slow.
const MAX_AGE_MS = 10 * 60_000;

/**
 * Extract a positive, fresh USD price for `symbol` from a RedStone /prices
 * payload. Returns null (a failover MISS, not an error) on an empty array, a
 * row for a different symbol, a non-positive value, or a stale timestamp.
 *
 * @param {unknown} rows  parsed JSON body of /prices?symbol=...&limit=1
 * @param {string} symbol requested ticker, e.g. "SOL"
 * @param {number} [now]  epoch ms, injectable for tests
 * @param {number} [maxAgeMs]
 * @returns {number | null}
 */
export function parseRedstonePrice(rows, symbol, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
	if (!Array.isArray(rows)) return null;
	const want = String(symbol || '').toUpperCase();
	for (const row of rows) {
		if (String(row?.symbol || '').toUpperCase() !== want) continue;
		const value = Number(row?.value);
		if (!Number.isFinite(value) || value <= 0) continue;
		const ts = Number(row?.timestamp);
		// A missing/garbled timestamp is treated as stale: freshness is the one
		// guarantee this rung is supposed to add over a cached aggregator.
		if (!Number.isFinite(ts) || Math.abs(now - ts) > maxAgeMs) continue;
		return value;
	}
	return null;
}

/**
 * A failover-fetch provider rung (see src/shared/failover-fetch.js) for any
 * RedStone-listed ticker. Drop it into any `fetchFirst` chain.
 *
 * @param {string} symbol ticker symbol, e.g. "SOL"
 * @param {{ name?: string }} [opts]
 * @returns {{ name: string, url: string, parse: (r: Response) => Promise<number | null> }}
 */
export function redstoneProvider(symbol, { name = 'redstone' } = {}) {
	const sym = String(symbol || '').toUpperCase();
	return {
		name,
		url: `${REDSTONE_BASE}/prices?symbol=${encodeURIComponent(sym)}&provider=redstone&limit=1`,
		parse: async (r) => parseRedstonePrice(await r.json(), sym),
	};
}
