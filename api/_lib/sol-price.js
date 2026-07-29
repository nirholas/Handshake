// @ts-check
// Canonical SOL/USD spot price, cached ~60s. Used anywhere a SOL amount needs a
// USD valuation captured at the moment it happens (accounting ledgers, receipts).
//
// The economy ledger records `sol_usd` on every transfer so an accountant reads
// the dollar value as of the transfer instant, not as of report time. This is the
// one shared implementation — see api/_lib/pump-alert-runner.js / pump-launch-feed.js
// for the older inline copies this consolidates.
//
// Seven independent free sources, tried in order (failover-fetch cools a failing
// source for 60s so a CoinGecko rate-limit doesn't tax every valuation with a
// timeout). They all quote the same asset; any disagreement is sub-1% noise.
// Exchange tickers (Kraken/Coinbase/Bitfinex), aggregators (CoinGecko/Jupiter/
// DefiLlama) and an on-chain oracle (DIA) fail independently, so it takes a
// near-total outage to exhaust the chain.

import { fetchFirst } from '../../src/shared/failover-fetch.js';

const TTL_MS = 60_000;
// A 24h delta moves slowly; refreshing it every 60s alongside the spot price
// would spend requests (and CoinGecko rate-limit budget) for no visible gain.
const CHANGE_TTL_MS = 5 * 60_000;
const WSOL = 'So11111111111111111111111111111111111111112';

const asPrice = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};

// Last 24h percentage change. Captured for free whenever CoinGecko is the
// source that answers the price call (it is the only price provider that
// returns the change alongside the spot, and it is tried first); when a
// fallback provider answers, solChange24hPct() refreshes it on its own two-
// source chain. Either way the previous value is kept rather than blanked, the
// same "last good wins" rule the price itself follows.
let _change24h = null;
let _changeAt = 0;

const setChange = (v, now = Date.now()) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	_change24h = n;
	_changeAt = now;
	return n;
};

const PROVIDERS = [
	{
		name: 'coingecko',
		url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true',
		parse: async (r) => {
			const d = await r.json();
			const price = asPrice(d?.solana?.usd);
			if (price != null) setChange(d?.solana?.usd_24h_change);
			return price;
		},
	},
	{
		name: 'jupiter',
		url: `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
		// v3 shape: { [mint]: { usdPrice } }; v2 shape: { data: { [mint]: { price } } }
		parse: async (r) => {
			const d = await r.json();
			return asPrice(d?.[WSOL]?.usdPrice ?? d?.data?.[WSOL]?.price);
		},
	},
	{
		// Kraken, not Binance: Binance geo-blocks US datacenter IPs (Vercel),
		// returning an error body that would make it a permanent dead slot.
		name: 'kraken',
		url: 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD',
		parse: async (r) => asPrice((await r.json())?.result?.SOLUSD?.c?.[0]),
	},
	{
		name: 'coinbase',
		url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
		parse: async (r) => asPrice((await r.json())?.data?.amount),
	},
	{
		// DefiLlama coins oracle — keyless, independent multi-DEX aggregation.
		name: 'llama',
		url: `https://coins.llama.fi/prices/current/solana:${WSOL}`,
		parse: async (r) => asPrice((await r.json())?.coins?.[`solana:${WSOL}`]?.price),
	},
	{
		// DIA on-chain oracle — keyless, a fully separate methodology from the
		// exchange tickers above, so it survives a broad CEX-API outage.
		name: 'dia',
		url: 'https://api.diadata.org/v1/assetQuotation/Solana/0x0000000000000000000000000000000000000000',
		parse: async (r) => asPrice((await r.json())?.Price),
	},
	{
		// Bitfinex public ticker. Bitfinex (unlike Binance) does NOT geo-block US
		// datacenter IPs, so it works from Cloud Run us-central1. Ticker array:
		// index 6 is LAST_PRICE.
		name: 'bitfinex',
		url: 'https://api-pub.bitfinex.com/v2/ticker/tSOLUSD',
		parse: async (r) => {
			const t = await r.json();
			return asPrice(Array.isArray(t) ? t[6] : null);
		},
	},
];

let _price = 0;
let _at = 0;

/**
 * Current SOL price in USD (spot), cached for 60s. Returns the last good value on
 * a fetch failure, or 0 if it has never resolved — callers store 0 as "unpriced"
 * rather than corrupting a valuation with a guess.
 * @param {number} [now]
 * @returns {Promise<number>}
 */
export async function solPriceUsd(now = Date.now()) {
	if (now - _at < TTL_MS && _price > 0) return _price;
	try {
		const { value } = await fetchFirst(PROVIDERS, { timeoutMs: 3000, label: 'sol-price' });
		_price = value;
		_at = now;
	} catch {
		/* keep last good value; 0 until first success */
	}
	return _price || 0;
}

/**
 * The cached price plus the metadata a surface needs to render it honestly:
 * how old it is, whether the last refresh failed (`stale`), and the 24h change
 * when a provider supplied one. Call `solPriceUsd()` first: this is a pure
 * read of the cache, it never fetches.
 *
 * `stale` is true only when a good price is being served past its refresh
 * window, i.e. the refresh failed and the last known value is standing in. A
 * never-resolved price is `{ price: 0, stale: false }` so a page can tell
 * "couldn't refresh" apart from "no price yet".
 *
 * @param {number} [now]
 * @returns {{ price: number, at: number, stale: boolean, change24h: number | null }}
 */
export function solPriceInfo(now = Date.now()) {
	const price = _price || 0;
	return {
		price,
		at: _at,
		stale: price > 0 && now - _at > TTL_MS,
		change24h: _change24h,
	};
}

const CHANGE_PROVIDERS = [
	{
		name: 'coingecko-change',
		url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true',
		parse: async (r) => {
			const c = Number((await r.json())?.solana?.usd_24h_change);
			return Number.isFinite(c) ? c : null;
		},
	},
	{
		// DefiLlama's percentage oracle. Same 24h window, computed from its own
		// price history, so a CoinGecko rate-limit doesn't blank the delta.
		name: 'llama-change',
		url: `https://coins.llama.fi/percentage/solana:${WSOL}?period=24h`,
		parse: async (r) => {
			const c = Number((await r.json())?.coins?.[`solana:${WSOL}`]);
			return Number.isFinite(c) ? c : null;
		},
	},
];

/**
 * SOL's 24h percentage change, cached for 5 minutes (a delta over a 24h window
 * does not need 60s resolution). Free when `solPriceUsd()` already got it from
 * CoinGecko; otherwise one request across CoinGecko → DefiLlama. Returns the
 * last good value when both are down, or null before the first success.
 * @param {number} [now]
 * @returns {Promise<number | null>}
 */
export async function solChange24hPct(now = Date.now()) {
	if (_change24h != null && now - _changeAt < CHANGE_TTL_MS) return _change24h;
	try {
		const { value } = await fetchFirst(CHANGE_PROVIDERS, { timeoutMs: 3000, label: 'sol-change-24h' });
		return setChange(value, now);
	} catch {
		return _change24h;
	}
}
