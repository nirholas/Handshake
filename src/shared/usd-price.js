/**
 * Client-side SOL/USD price helper — single source of truth for USD equivalents.
 *
 * USDC: treated as exactly $1 (it's a dollar-pegged stablecoin).
 * SOL:  five free, CORS-enabled feeds tried in order via the shared failover-
 *       fetch (Jupiter → CoinGecko → Coinbase → DefiLlama → Kraken), cached 60 s. No
 *       single feed is a point of failure — mirrors the server-side
 *       api/_lib/sol-price.js chain, limited here to browser-CORS-safe hosts.
 *
 * Never hardcodes a SOL rate; degrades silently on feed failure so prices
 * in USDC still show "≈ $X" while SOL amounts just show the raw amount.
 */

import { fetchFirst } from './failover-fetch.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_TTL_MS = 60_000;

const asPrice = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};

// Ordered, all keyless and CORS-enabled (Access-Control-Allow-Origin: *), so
// they work from the browser. Bitfinex is omitted here (no CORS header) though
// the server chain uses it; Kraken's public Ticker does send the header.
const SOL_FEEDS = [
	{
		name: 'jupiter',
		url: `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
		parse: async (r) => {
			const d = await r.json();
			return asPrice(d?.[SOL_MINT]?.usdPrice ?? d?.[SOL_MINT]?.price);
		},
	},
	{
		name: 'coingecko',
		url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
		parse: async (r) => asPrice((await r.json())?.solana?.usd),
	},
	{
		name: 'coinbase',
		url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
		parse: async (r) => asPrice((await r.json())?.data?.amount),
	},
	{
		name: 'llama',
		url: `https://coins.llama.fi/prices/current/solana:${SOL_MINT}`,
		parse: async (r) => asPrice((await r.json())?.coins?.[`solana:${SOL_MINT}`]?.price),
	},
	{
		name: 'kraken',
		url: 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD',
		// `c` is [last trade price, lot volume].
		parse: async (r) => asPrice((await r.json())?.result?.SOLUSD?.c?.[0]),
	},
];

let _solPrice = 0;
let _solPriceAt = 0;

/** Fetch (and cache) the live SOL/USD price. Throws if every feed is unavailable. */
export async function getSolPriceUsd() {
	if (Date.now() - _solPriceAt < CACHE_TTL_MS && _solPrice > 0) return _solPrice;
	try {
		const { value } = await fetchFirst(SOL_FEEDS, { timeoutMs: 4000, label: 'sol-price-client' });
		_solPrice = value;
		_solPriceAt = Date.now();
		return _solPrice;
	} catch {
		throw Object.assign(new Error('SOL price unavailable'), { code: 'price_unavailable' });
	}
}

// Per-mint price feeds, all keyless and CORS-enabled, mirroring the server-side
// chain in api/_lib/market/token-market.js. Jupiter knows pump.fun bonding
// curves, DexScreener and GeckoTerminal index the pools directly, so a token
// that is missing from one is usually present in another.
function tokenFeeds(mint) {
	return [
		{
			name: 'jupiter',
			url: `https://lite-api.jup.ag/price/v3?ids=${mint}`,
			parse: async (r) => {
				const d = await r.json();
				return asPrice(d?.[mint]?.usdPrice ?? d?.[mint]?.price);
			},
		},
		{
			name: 'dexscreener',
			url: `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
			parse: async (r) => {
				const pairs = (await r.json())?.pairs;
				if (!Array.isArray(pairs) || !pairs.length) return null;
				// Deepest pool is the honest quote; a thin pool can print anything.
				const best = pairs.reduce((a, b) => ((Number(b?.liquidity?.usd) || 0) > (Number(a?.liquidity?.usd) || 0) ? b : a));
				return asPrice(best?.priceUsd);
			},
		},
		{
			name: 'geckoterminal',
			url: `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`,
			parse: async (r) => asPrice((await r.json())?.data?.attributes?.price_usd),
		},
		{
			name: 'llama',
			url: `https://coins.llama.fi/prices/current/solana:${mint}`,
			parse: async (r) => asPrice((await r.json())?.coins?.[`solana:${mint}`]?.price),
		},
	];
}

const _tokenPrices = new Map(); // mint -> { price, at }

/**
 * Live USD price of one whole SPL token, across four independent feeds.
 * Returns null (never throws, never guesses) when every feed misses, so a
 * caller shows the raw token amount rather than a wrong dollar figure.
 *
 * @param {string} mint
 * @returns {Promise<number|null>}
 */
export async function getTokenPriceUsd(mint) {
	if (!mint) return null;
	if (mint === SOL_MINT) return getSolPriceUsd().catch(() => null);
	const hit = _tokenPrices.get(mint);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.price;
	try {
		const { value } = await fetchFirst(tokenFeeds(mint), { timeoutMs: 4000, label: `token-price:${mint.slice(0, 6)}` });
		_tokenPrices.set(mint, { price: value, at: Date.now() });
		return value;
	} catch {
		// Keep serving the last real price through a blip rather than blanking the
		// estimate; the caller's own copy says the rate is applied at settlement.
		return hit?.price ?? null;
	}
}

// BTC/USD, same shape as the SOL chain. Used by the inscription flow's fee
// estimate, which previously hung on a single un-timed CoinGecko call.
const BTC_FEEDS = [
	{
		name: 'coingecko',
		url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
		parse: async (r) => asPrice((await r.json())?.bitcoin?.usd),
	},
	{
		name: 'coinbase',
		url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
		parse: async (r) => asPrice((await r.json())?.data?.amount),
	},
	{
		name: 'kraken',
		url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
		parse: async (r) => asPrice((await r.json())?.result?.XXBTZUSD?.c?.[0]),
	},
	{
		name: 'llama',
		url: 'https://coins.llama.fi/prices/current/coingecko:bitcoin',
		parse: async (r) => asPrice((await r.json())?.coins?.['coingecko:bitcoin']?.price),
	},
];

// ETH/USD across the same four independent feeds, for the surfaces that price
// a stake or a balance in ether. Previously each caller made its own single
// keyless CoinGecko call, so a throttle there (its free tier is shared per
// egress IP) left USD figures blank next to real ETH amounts.
const ETH_FEEDS = [
	{
		name: 'coingecko',
		url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
		parse: async (r) => asPrice((await r.json())?.ethereum?.usd),
	},
	{
		name: 'coinbase',
		url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
		parse: async (r) => asPrice((await r.json())?.data?.amount),
	},
	{
		name: 'kraken',
		url: 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',
		parse: async (r) => asPrice((await r.json())?.result?.XETHZUSD?.c?.[0]),
	},
	{
		name: 'llama',
		url: 'https://coins.llama.fi/prices/current/coingecko:ethereum',
		parse: async (r) => asPrice((await r.json())?.coins?.['coingecko:ethereum']?.price),
	},
];

let _ethPrice = 0;
let _ethPriceAt = 0;

/**
 * Live ETH/USD across four feeds. Returns null when all of them miss, so a
 * caller hides the fiat estimate rather than printing an invented one.
 *
 * @returns {Promise<number|null>}
 */
export async function getEthPriceUsd() {
	if (Date.now() - _ethPriceAt < CACHE_TTL_MS && _ethPrice > 0) return _ethPrice;
	try {
		const { value } = await fetchFirst(ETH_FEEDS, { timeoutMs: 4000, label: 'eth-price-client' });
		_ethPrice = value;
		_ethPriceAt = Date.now();
		return _ethPrice;
	} catch {
		return _ethPrice > 0 ? _ethPrice : null;
	}
}

let _btcPrice = 0;
let _btcPriceAt = 0;

/**
 * Live BTC/USD across four feeds. Returns null when all of them miss, so a
 * caller can hide a fiat estimate instead of printing a stale or invented one.
 *
 * @returns {Promise<number|null>}
 */
export async function getBtcPriceUsd() {
	if (Date.now() - _btcPriceAt < CACHE_TTL_MS && _btcPrice > 0) return _btcPrice;
	try {
		const { value } = await fetchFirst(BTC_FEEDS, { timeoutMs: 4000, label: 'btc-price-client' });
		_btcPrice = value;
		_btcPriceAt = Date.now();
		return _btcPrice;
	} catch {
		return _btcPrice > 0 ? _btcPrice : null;
	}
}

/** USDC → USD (1:1, pegged stablecoin). */
export function usdcToUsd(amount) {
	return Number(amount);
}

/** SOL → USD using the live feed. Returns null if the feed fails. */
export async function solToUsd(solAmount) {
	try {
		const price = await getSolPriceUsd();
		return Number(solAmount) * price;
	} catch {
		return null;
	}
}

function fmtUsdValue(n) {
	if (!Number.isFinite(n) || n < 0) return '';
	if (n === 0) return '≈ $0.00';
	if (n < 0.0001) return `≈ $${n.toFixed(6).replace(/0+$/, '')}`;
	if (n < 0.01)   return `≈ $${n.toFixed(4)}`;
	if (n < 1)      return `≈ $${n.toFixed(3)}`;
	if (n < 1000)   return `≈ $${n.toFixed(2)}`;
	return `≈ $${Math.round(n).toLocaleString()}`;
}

/** Format a USDC amount as a USD equivalent string (synchronous, no feed needed). */
export function formatUsdcEq(usdcAmount) {
	return fmtUsdValue(usdcToUsd(usdcAmount));
}

/** Format a SOL amount as a USD equivalent string (async, needs live feed). */
export async function formatSolEq(solAmount) {
	const usd = await solToUsd(solAmount);
	return usd !== null ? fmtUsdValue(usd) : '';
}

/**
 * Attach a live USD-equivalent hint to a DOM element.
 *
 * Immediately inserts a `<span class="usd-eq">` next to the element's price
 * text (hidden while loading). Once the price resolves, the span becomes
 * visible with "≈ $X.XX". On feed failure for SOL, the span stays hidden —
 * the original crypto amount is unaffected.
 *
 * @param {Element}  el       Element that holds or follows the price display
 * @param {number}   amount   Crypto amount (human units: USDC or SOL)
 * @param {string}   currency 'USDC' | 'SOL'
 * @returns {HTMLSpanElement}  The injected span (can be discarded)
 */
export function attachUsdEq(el, amount, currency) {
	let span = el.querySelector('.usd-eq');
	if (!span) {
		span = document.createElement('span');
		span.className = 'usd-eq';
		el.appendChild(span);
	}
	span.textContent = '';
	span.hidden = true;

	const cur = (currency || '').toUpperCase();
	if (cur === 'USDC') {
		const eq = formatUsdcEq(amount);
		if (eq) { span.textContent = eq; span.hidden = false; }
	} else if (cur === 'SOL') {
		formatSolEq(amount).then((eq) => {
			if (eq) { span.textContent = eq; span.hidden = false; }
		});
	}
	return span;
}
