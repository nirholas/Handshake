// Live $THREE price + USD→token quoting.
//
// Price source mirrors the rest of the platform: Jupiter Lite is the primary
// Solana price feed (same source api/_lib/balances.js uses; no key, knows
// pump.fun bonding curves). If Jupiter is down it falls through to the shared
// market module (Birdeye → DexScreener → GeckoTerminal), so a single feed outage
// never blocks a paid quote. A short cache smooths bursts without letting a quote
// drift far from the live market — the quote's own expiry is the hard guard.

import { cacheGet, cacheSet } from '../cache.js';
import { fetchTokenMarketData } from '../market/token-market.js';
import { TOKEN_MINT, TOKEN_DECIMALS, ATOMICS_PER_TOKEN } from './config.js';

import { fetchUpstreamJson } from '../upstream-fetch.js';
const PRICE_TTL_S = 30;
const PRICE_CACHE_KEY = `token:price:${TOKEN_MINT}`;

// Last-known-good price, held far longer than the live cache. When EVERY feed
// (Jupiter + the Birdeye→DexScreener→GeckoTerminal→DefiLlama chain) misses on a single
// request — a momentary simultaneous blip, not a real outage — falling back to a
// recent price keeps a paid quote alive instead of 503-ing the user's action.
// Bounded by STALE_PRICE_MAX_S: beyond that window a pump.fun token can have
// moved enough that pricing a payment off it is worse than failing, so we still
// throw. The quote's own short `exp` remains the hard guard on acting downstream.
const LAST_GOOD_KEY = `token:price:last:${TOKEN_MINT}`;
const LAST_GOOD_TTL_S = 3_600;
const STALE_PRICE_MAX_S = 300;

async function fetchJson(url, opts = {}) {
	// Bounded: a hung feed must throw so the market-data chain below gets its turn.
	return fetchUpstreamJson(url, opts, { name: 'jupiter-price', timeoutMs: 6_000, attempts: 2 });
}

async function jupiterPrice(mint) {
	const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
	const usd = data?.[mint]?.usdPrice ?? data?.[mint]?.price;
	const n = Number(usd);
	return Number.isFinite(n) && n > 0 ? n : null;
}


/**
 * Live USD price of one whole token. Throws 503 price_unavailable when no feed
 * returns a usable number — a paid action must never proceed on a guessed price.
 * @param {{ fresh?: boolean }} [opts]
 * @returns {Promise<{ priceUsd: number, source: string, mint: string, at: string }>}
 */
export async function getTokenPriceUsd({ fresh = false } = {}) {
	if (!fresh) {
		const cached = await cacheGet(PRICE_CACHE_KEY);
		if (cached?.priceUsd) return cached;
	}

	let priceUsd = null;
	let source = null;
	try {
		priceUsd = await jupiterPrice(TOKEN_MINT);
		if (priceUsd) source = 'jupiter';
	} catch (err) {
		console.warn('[token] jupiter price failed:', err?.message);
	}
	if (!priceUsd) {
		// Jupiter down → shared market module: Birdeye → DexScreener → GeckoTerminal
		// → DefiLlama (coins.llama.fi, keyed `solana:<mint>`), each on its own deadline.
		const md = await fetchTokenMarketData(TOKEN_MINT, { fresh }).catch((err) => {
			console.warn('[token] market-data fallback failed:', err?.message);
			return null;
		});
		if (md?.price_usd) {
			priceUsd = md.price_usd;
			source = md.source;
		}
	}
	if (!priceUsd) {
		// Every live feed missed on this one request. Before failing a paid action,
		// fall back to the last-known-good price if it's recent enough to price a
		// payment honestly. `at` is the ISO time it was observed live.
		const lastGood = await cacheGet(LAST_GOOD_KEY).catch(() => null);
		if (lastGood?.priceUsd && lastGood.at) {
			const ageS = (Date.now() - Date.parse(lastGood.at)) / 1000;
			if (Number.isFinite(ageS) && ageS >= 0 && ageS <= STALE_PRICE_MAX_S) {
				console.warn(
					`[token] all live price feeds missed — serving last-known-good (${Math.round(ageS)}s old)`,
				);
				return { ...lastGood, source: `${lastGood.source || 'cache'}-stale`, stale: true };
			}
		}
		throw Object.assign(new Error('live token price unavailable'), {
			status: 503,
			code: 'price_unavailable',
		});
	}

	const value = { priceUsd, source, mint: TOKEN_MINT, at: new Date().toISOString() };
	// Live cache (smooths bursts) + the long-lived last-known-good (outage fallback).
	await cacheSet(PRICE_CACHE_KEY, value, PRICE_TTL_S);
	await cacheSet(LAST_GOOD_KEY, value, LAST_GOOD_TTL_S);
	return value;
}

/**
 * Quote a USD amount as a token amount at the current live price.
 *
 * Pass `price` when the caller already resolved one this request (the
 * /api/token/price display path does): the quote is then computed against the
 * exact price the caller reports back, instead of a second lookup that can
 * land on the other side of the 30s cache boundary and hand the client a
 * `token_amount` that does not match the `price_usd` printed beside it.
 *
 * @param {number} usd  positive USD amount to convert
 * @param {{ price?: { priceUsd: number, source: string, at: string } }} [opts]
 * @returns {Promise<{ usd: number, priceUsd: number, source: string, priceAt: string, tokenAmount: number, atomics: bigint }>}
 */
export async function quoteTokenForUsd(usd, { price } = {}) {
	const usdNum = Number(usd);
	if (!Number.isFinite(usdNum) || usdNum <= 0) {
		throw Object.assign(new Error('usd must be a positive number'), {
			status: 400,
			code: 'bad_request',
		});
	}
	const { priceUsd, source, at } = price ?? (await getTokenPriceUsd());
	const tokenAmount = usdNum / priceUsd;
	// Convert to atomics with BigInt to avoid float drift on large token counts:
	// floor(tokenAmount * 10^decimals). We scale through micro-precision on the
	// USD/price ratio so a sub-cent price still rounds correctly.
	const scaled = Math.round(tokenAmount * Number(ATOMICS_PER_TOKEN));
	// A sub-cent price divides a large USD figure into a token count whose
	// atomics overflow the float64 range (usd 1e300 at $0.0017 scales past
	// Number.MAX_VALUE), and `BigInt(Infinity)` is a RangeError, not a typed
	// failure. Left unguarded that turned a client-supplied `?usd=` into an
	// unhandled 500 with a Sentry capture and an ops alert per hit. Reject it
	// here as the amount error it actually is, alongside the too-small guard.
	if (!Number.isFinite(scaled)) {
		throw Object.assign(new Error('quoted amount exceeds the representable range'), {
			status: 422,
			code: 'amount_too_large',
		});
	}
	const atomics = BigInt(scaled);
	if (atomics <= 0n) {
		throw Object.assign(new Error('quoted amount rounds to zero at current price'), {
			status: 422,
			code: 'amount_too_small',
		});
	}
	return { usd: usdNum, priceUsd, source, priceAt: at, tokenAmount, atomics };
}

/** Decimal token amount (human units) from atomics, for display. */
export function atomicsToTokens(atomics) {
	return Number(BigInt(atomics)) / Number(ATOMICS_PER_TOKEN);
}

export { TOKEN_DECIMALS };
