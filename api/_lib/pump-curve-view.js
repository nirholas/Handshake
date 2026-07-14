// Shared bonding-curve view builder for a pump.fun mint.
//
// One RPC + Jupiter-fallback path, two doors: the authenticated dashboard route
// (api/pump/curve.js) and the free GET /api/v1/pump/curve endpoint both call
// getCurveView() and relay its { httpStatus, cacheControl, body } verbatim, so
// behavior (including cache headers) stays byte-identical between the two.
//
// Combines @nirholas/pump-sdk reads via the shared RpcFallback + sdk-bridge
// helpers: bonding curve raw state, current price + market cap, graduation
// progress. A coin can graduate (curve closed or left behind with complete=true)
// yet still trade on its AMM pool — Jupiter is the fallback price source for
// that case, enriched with a market cap since pump.fun mints a fixed 1B supply
// entirely into the curve/pool (FDV == market cap post-graduation).

import { rpcFallbackFromEnv, getBondingCurveState, getTokenPrice, getGraduationProgress } from './solana/index.js';

// Mints that can never carry a pump.fun bonding curve. These are coin-agnostic
// payment-rail / native tokens, listed only so we can *exclude* them from curve
// lookups — never to promote them. (USDC mainnet+devnet, wrapped SOL.)
export const NON_CURVE_MINTS = new Set([
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (mainnet)
	'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // USDC (devnet)
	'So11111111111111111111111111111111111111112', // wrapped SOL
]);

// pump.fun mints a fixed total supply of exactly 1B tokens, the whole of which
// is sold through the curve and then seeded into the AMM pool on graduation. For
// these tokens fully-diluted value therefore equals market cap.
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;

// Every pump.fun mint keypair is ground to end in the literal suffix "pump". A
// mint that does not end in "pump" (or that is a known settlement token) has no
// bonding curve and never will — so we can reject it without touching RPC.
export function isPumpMint(mint) {
	return typeof mint === 'string' && mint.endsWith('pump') && !NON_CURVE_MINTS.has(mint);
}

export function isPlausibleMint(s) {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// Last good curve view per network:mint, kept so an RPC flake degrades the read
// to slightly-old real data instead of an unhandled 500. Same serve-stale tier
// as api/pump/price-history: never fabricated, only ever a body a healthy read
// really produced.
const _lastGood = new Map(); // `${network}:${mint}` → { body, at }
const STALE_MAX_MS = 10 * 60_000;

function rememberGood(network, mint, body) {
	_lastGood.set(`${network}:${mint}`, { body, at: Date.now() });
	if (_lastGood.size > 256) _lastGood.delete(_lastGood.keys().next().value);
}

function recallGood(network, mint) {
	const hit = _lastGood.get(`${network}:${mint}`);
	if (!hit || Date.now() - hit.at > STALE_MAX_MS) return null;
	return hit;
}

async function jupiterPriceFallback(mint) {
	try {
		const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(6000) });
		if (!r.ok) return null;
		const data = await r.json();
		const usd = data?.[mint]?.usdPrice ?? data?.[mint]?.price;
		const n = Number(usd);
		return Number.isFinite(n) && n > 0 ? { priceUsd: n, source: 'jupiter' } : null;
	} catch {
		return null;
	}
}

export function serializeBNs(obj) {
	if (obj == null || typeof obj !== 'object') return obj;
	const out = Array.isArray(obj) ? [] : {};
	for (const [k, v] of Object.entries(obj)) {
		if (
			v &&
			typeof v === 'object' &&
			typeof v.toString === 'function' &&
			(v.constructor?.name === 'BN' || typeof v.toNumber === 'function')
		) {
			out[k] = v.toString();
		} else if (v && typeof v === 'object') {
			out[k] = serializeBNs(v);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/**
 * Build the full curve-view payload for a mint. Returns a discriminated result
 * `{ httpStatus, cacheControl, body }` — callers relay it verbatim via their own
 * `json(res, httpStatus, body, { 'cache-control': cacheControl })` (or without
 * the cache-control header when it's null, letting the secure-by-default
 * no-store apply — matches every error response before this extraction).
 *
 * Caller is expected to have already validated `mint` with isPlausibleMint().
 */
export async function getCurveView({ mint, network = 'mainnet' }) {
	if (!isPumpMint(mint)) {
		// Negative-cacheable so the CDN edge serves repeat probes without hitting
		// the function at all — no cold start, no RPC reads, no warning spam.
		return {
			httpStatus: 404,
			cacheControl: 'public, s-maxage=300, max-age=300',
			body: { error: 'not_a_pump_mint', error_description: 'mint has no pump.fun bonding curve' },
		};
	}

	const rpc = rpcFallbackFromEnv({ network });
	let result;
	try {
		result = await rpc.withFallback(async (connection) => {
			const [curve, price, grad] = await Promise.all([
				getBondingCurveState(connection, mint),
				getTokenPrice(connection, mint),
				getGraduationProgress(connection, mint),
			]);
			return { curve, price, graduation: grad };
		});
	} catch (err) {
		// Every RPC lane failed. That is an upstream outage, not an answer about
		// the coin, so degrade like price-history does: serve the last good view
		// for this mint marked stale, else a well-formed 502 the clients' existing
		// error states already render.
		console.error('[pump-curve-view] all RPC lanes failed', err?.message);
		const stale = recallGood(network, mint);
		if (stale) {
			return {
				httpStatus: 200,
				cacheControl: 'public, max-age=10, s-maxage=10',
				body: { ...stale.body, stale: true, as_of: Math.floor(stale.at / 1000) },
			};
		}
		return {
			httpStatus: 502,
			cacheControl: null,
			body: {
				error: 'upstream_error',
				error_description: 'bonding-curve state is temporarily unavailable for this mint',
			},
		};
	}

	if (!result.curve) {
		// No on-chain bonding curve account. Two cases to disambiguate:
		//   1. Graduated coin — the curve account is closed once a coin migrates
		//      to its AMM pool, but the token still trades with a live DEX price.
		//      Fall back to Jupiter and return a 200 "graduated" view so callers
		//      render the real price instead of a dead 404. (Our own $THREE lives
		//      here post-migration.)
		//   2. A mint that never had a curve — Jupiter has nothing either, so the
		//      404 stands and the client's stop-on-404 path fires as before.
		const graduatedPrice = await jupiterPriceFallback(mint);
		if (graduatedPrice) {
			const marketCapUsd = graduatedPrice.priceUsd * PUMP_TOTAL_SUPPLY;
			const body = {
				mint,
				network,
				curve: null,
				graduated: true,
				price: null,
				graduation: { isGraduated: true, progressBps: 10_000 },
				graduatedPrice: { ...graduatedPrice, marketCapUsd },
			};
			rememberGood(network, mint, body);
			return {
				httpStatus: 200,
				cacheControl: 'public, max-age=15, s-maxage=30, stale-while-revalidate=60',
				body,
			};
		}
		return {
			httpStatus: 404,
			cacheControl: null,
			body: { error: 'no_curve', error_description: 'no bonding curve found for that mint' },
		};
	}

	// Graduated coins have no bonding-curve price. A coin can graduate yet leave
	// its on-chain curve account behind (closed, reserves zeroed, complete=true) —
	// this is exactly the case for our own $THREE. Fall back to Jupiter so callers
	// always get a usable price even after migration to a DEX, and surface the same
	// `graduated: true` + market-cap-enriched `graduatedPrice` shape as the
	// curve-gone path above so every consumer renders graduated coins identically.
	let pricePayload = result.price ? serializeBNs(result.price) : null;
	const curveComplete = Boolean(result.curve?.complete);
	let graduatedPrice = null;
	if (!pricePayload && curveComplete) {
		const jup = await jupiterPriceFallback(mint);
		if (jup) {
			graduatedPrice = { ...jup, marketCapUsd: jup.priceUsd * PUMP_TOTAL_SUPPLY };
		}
	}

	const body = {
		mint,
		network,
		curve: result.curve,
		...(curveComplete ? { graduated: true } : {}),
		price: pricePayload,
		graduation: result.graduation ? serializeBNs(result.graduation) : null,
		...(graduatedPrice ? { graduatedPrice } : {}),
	};
	rememberGood(network, mint, body);
	return {
		httpStatus: 200,
		cacheControl: 'public, max-age=5, s-maxage=10, stale-while-revalidate=30',
		body,
	};
}
