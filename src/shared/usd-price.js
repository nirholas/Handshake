/**
 * Client-side SOL/USD price helper — single source of truth for USD equivalents.
 *
 * USDC: treated as exactly $1 (it's a dollar-pegged stablecoin).
 * SOL:  four free, CORS-enabled feeds tried in order via the shared failover-
 *       fetch (Jupiter → CoinGecko → Coinbase → DefiLlama), cached 60 s. No
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
// they work from the browser. Kraken/Bitfinex are omitted here (no CORS header)
// though the server chain uses them.
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
