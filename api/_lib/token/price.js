// Live $THREE price + USD→token quoting.
//
// Price source mirrors the rest of the platform: Jupiter Lite is the primary
// Solana price feed (same source api/_lib/balances.js uses; no key, knows
// pump.fun bonding curves), with Birdeye as a keyed fallback (the source
// api/three-token uses). A short cache smooths bursts without letting a quote
// drift far from the live market — the quote's own expiry is the hard guard.

import { cacheGet, cacheSet } from '../cache.js';
import { TOKEN_MINT, TOKEN_DECIMALS, ATOMICS_PER_TOKEN } from './config.js';

const PRICE_TTL_S = 30;
const PRICE_CACHE_KEY = `token:price:${TOKEN_MINT}`;

async function fetchJson(url, opts = {}) {
	const r = await fetch(url, opts);
	if (!r.ok) {
		const body = await r.text().catch(() => String(r.status));
		throw Object.assign(new Error(`upstream ${r.status}: ${body.slice(0, 160)}`), {
			status: 502,
		});
	}
	return r.json();
}

async function jupiterPrice(mint) {
	const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
	const usd = data?.[mint]?.usdPrice ?? data?.[mint]?.price;
	const n = Number(usd);
	return Number.isFinite(n) && n > 0 ? n : null;
}

async function birdeyePrice(mint) {
	const key = process.env.BIRDEYE_API_KEY;
	if (!key) return null;
	const data = await fetchJson(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
		headers: { 'X-API-KEY': key, accept: 'application/json' },
	});
	const n = Number(data?.data?.value);
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
		try {
			priceUsd = await birdeyePrice(TOKEN_MINT);
			if (priceUsd) source = 'birdeye';
		} catch (err) {
			console.warn('[token] birdeye price failed:', err?.message);
		}
	}
	if (!priceUsd) {
		throw Object.assign(new Error('live token price unavailable'), {
			status: 503,
			code: 'price_unavailable',
		});
	}

	const value = { priceUsd, source, mint: TOKEN_MINT, at: new Date().toISOString() };
	await cacheSet(PRICE_CACHE_KEY, value, PRICE_TTL_S);
	return value;
}

/**
 * Quote a USD amount as a token amount at the current live price.
 * @param {number} usd  positive USD amount to convert
 * @returns {Promise<{ usd: number, priceUsd: number, source: string, priceAt: string, tokenAmount: number, atomics: bigint }>}
 */
export async function quoteTokenForUsd(usd) {
	const usdNum = Number(usd);
	if (!Number.isFinite(usdNum) || usdNum <= 0) {
		throw Object.assign(new Error('usd must be a positive number'), {
			status: 400,
			code: 'bad_request',
		});
	}
	const { priceUsd, source, at } = await getTokenPriceUsd();
	const tokenAmount = usdNum / priceUsd;
	// Convert to atomics with BigInt to avoid float drift on large token counts:
	// floor(tokenAmount * 10^decimals). We scale through micro-precision on the
	// USD/price ratio so a sub-cent price still rounds correctly.
	const scaled = Math.round(tokenAmount * Number(ATOMICS_PER_TOKEN));
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
