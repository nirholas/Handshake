// ETH/USD spot with multi-source failover, shared and cached ~60s across the
// whole process — the Robinhood Chain analogue of three.ws's sol-price helper.
//
// Robinhood Chain has ETH gas and its Odyssey bonding curves quote in native
// ETH, so USD conversion of trade/launch magnitudes needs a live ETH price.
// USDG (Paxos Global Dollar) is a dollar stablecoin — treated as $1.00 (its
// on-chain price never departs enough from peg to matter for world animation
// scaling, and no oracle read is worth the latency here).

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_500;

let _cache = { t: 0, price: 0 };
let _inflight = null;

async function fetchJson(url, pick) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
		if (!r.ok) return 0;
		const d = await r.json();
		const n = Number(pick(d));
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	} finally {
		clearTimeout(tid);
	}
}

// Ordered by reliability/latency. First non-zero wins; every source is a plain
// public price endpoint (no key).
const SOURCES = [
	() => fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot', (d) => d?.data?.amount),
	() => fetchJson('https://api.kraken.com/0/public/Ticker?pair=ETHUSD', (d) => d?.result?.XETHZUSD?.c?.[0]),
	() => fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', (d) => d?.ethereum?.usd),
	() => fetchJson('https://coins.llama.fi/prices/current/coingecko:ethereum', (d) => d?.coins?.['coingecko:ethereum']?.price),
];

/**
 * Current ETH/USD, cached ~60s and de-duped across concurrent callers.
 * Returns the last good price if every source is momentarily down, or 0 on a
 * cold start with no reachable source (callers leave USD figures null).
 */
export async function ethPriceUsd() {
	if (Date.now() - _cache.t < CACHE_TTL_MS && _cache.price > 0) return _cache.price;
	if (_inflight) return _inflight;
	_inflight = (async () => {
		for (const src of SOURCES) {
			const p = await src();
			if (p > 0) {
				_cache = { t: Date.now(), price: p };
				return p;
			}
		}
		return _cache.price; // stale-but-good beats zero
	})().finally(() => { _inflight = null; });
	return _inflight;
}

/**
 * Convert a native-quote amount to USD.
 * @param {number} amount  amount in the quote asset's human units
 * @param {'ETH'|'USDG'} symbol  quote asset
 * @param {number} ethUsd  current ETH/USD (from {@link ethPriceUsd})
 */
export function quoteToUsd(amount, symbol, ethUsd) {
	if (!Number.isFinite(amount)) return null;
	if (symbol === 'USDG') return amount; // 1 USDG ≈ $1
	if (ethUsd > 0) return amount * ethUsd;
	return null;
}
