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
import { createCache } from './mem-cache.js';
import { cacheGet, cacheSet } from './cache.js';
import { hasThreeWsMark } from '../../src/solana/vanity/brand.js';
import { fetchUpstreamJson } from './upstream-fetch.js';
import { fetchTokenPriceUsd } from './market/token-market.js';

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

// Cheap, RPC-free pre-filter for "could this address carry a pump.fun bonding
// curve?". It exists to keep a misconfigured (e.g. USDC) mount, or a probe
// sweep, from turning into an RPC read per request. It is not the last word on
// what has a curve. Three shapes qualify, all decided from the address alone:
//
//   1. pump.fun's own launcher grinds every mint to end in the literal suffix
//      "pump".
//   2. three.ws grinds its custodial launches to carry the "3ws" mark as a
//      PREFIX (src/solana/vanity/brand.js) and never the "pump" suffix. Every
//      agent token minted that way therefore lands here, and the suffix test
//      alone used to reject all of them with a 300s-cached `not_a_pump_mint`
//      404: the curve read for our own coins could never succeed.
//   3. Anything on devnet. Nothing grinds a mark on the rehearsal cluster (a
//      launch from the owner's own wallet mints a plain generated address), so
//      an address-shape test there rejects real curves and answers nothing.
//      Devnet traffic is owner rehearsals, not the probe volume the fast-path
//      is defending against.
//
// A known settlement/native token is excluded outright on every cluster: it has
// no curve and never will. A mainnet mint of an unrecognized shape is NOT
// settled here: getCurveView asks the platform's own launch registry before it
// answers, because a coin launched from a user's wallet has no mark to read.
export function isPumpMint(mint, network = 'mainnet') {
	if (typeof mint !== 'string' || NON_CURVE_MINTS.has(mint)) return false;
	if (network === 'devnet') return isPlausibleMint(mint);
	return mint.endsWith('pump') || hasThreeWsMark(mint);
}

export function isPlausibleMint(s) {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// Mints the platform's own launch registry has confirmed, and mints it has
// denied, so an unmarked coin costs at most one DB read per TTL rather than one
// per request. Small and short-lived on purpose: the answer only changes when a
// launch lands, and a fresh launch's first curve read may wait out one TTL at
// worst.
const _registryAnswers = createCache({ max: 512 });
const REGISTRY_TTL_MS = 5 * 60_000;

/**
 * Is this mint a coin three.ws itself launched? Reads pump_agent_mints, the
 * platform's own launch directory: the same table /launches and the agent
 * profile's launch history render from.
 *
 * A launch from the owner's own wallet (/api/agents/tokens/launch-confirm)
 * mints a plain generated address with no brand mark, so the shape fast-path
 * cannot recognize it and this registry is the only authority that can. Any
 * failure (no database configured, a transient error) answers `false`, which
 * degrades to exactly the pre-existing behaviour instead of a 500.
 *
 * @param {string} mint
 * @param {'mainnet'|'devnet'} network
 * @returns {Promise<boolean>}
 */
async function isRegisteredPlatformLaunch(mint, network) {
	const key = `${network}:${mint}`;
	const hit = _registryAnswers.get(key);
	if (hit && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.known;

	let known = false;
	try {
		// Imported lazily: this module is loaded by pure-function tests and by
		// routes that never reach this branch, and api/_lib/db.js throws at import
		// time when DATABASE_URL is unset.
		const { sql } = await import('./db.js');
		const rows = await sql`
			select 1 from pump_agent_mints
			where mint = ${mint} and network = ${network}
			limit 1
		`;
		known = rows.length > 0;
	} catch (err) {
		console.warn('[pump-curve-view] launch-registry lookup unavailable: %s', String(err?.message || err).slice(0, 120));
		return false;
	}
	_registryAnswers.set(key, { known, at: Date.now() });
	return known;
}

// Last good curve view per network:mint, kept so an RPC flake degrades the read
// to slightly-old real data instead of an unhandled 500. Same serve-stale tier
// as api/pump/price-history: never fabricated, only ever a body a healthy read
// really produced.
// Bounded by true LRU: trimming with `delete(keys().next().value)` evicted the
// oldest INSERTED mint, so the most-requested curve could lose its stale copy
// while colder mints kept theirs. Staleness stays an explicit field because the
// entry must remain readable to serve degraded data.
const _lastGood = createCache({ max: 256 }); // `${network}:${mint}` → { body, at }
const STALE_MAX_MS = 10 * 60_000;
// The shared tier outlives a single instance: a cold Cloud Run instance used to
// hold no memory copy at all, so the first read during an RPC outage answered
// 502 no matter how recently a warm sibling had served the same mint.
const SHARED_LKG_TTL_S = 24 * 3600;

function lkgKey(network, mint) {
	return `pump:curve:lkg:${network}:${mint}`;
}

function rememberGood(network, mint, body) {
	const entry = { body, at: Date.now() };
	_lastGood.set(`${network}:${mint}`, entry);
	// Fire-and-forget: cacheSet never rejects, and the response is already in hand.
	cacheSet(lkgKey(network, mint), entry, SHARED_LKG_TTL_S).catch(() => {});
}

async function recallGood(network, mint) {
	const hit = _lastGood.get(`${network}:${mint}`);
	if (hit && Date.now() - hit.at <= STALE_MAX_MS) return hit;
	let shared = null;
	try {
		shared = await cacheGet(lkgKey(network, mint));
	} catch {
		shared = null;
	}
	if (shared && shared.body && typeof shared.at === 'number') return shared;
	return hit || null;
}

async function jupiterPriceFallback(mint) {
	try {
		const data = await fetchUpstreamJson(
			`https://lite-api.jup.ag/price/v3?ids=${mint}`,
			{},
			{ name: 'jupiter:price', timeoutMs: 6000, attempts: 2 },
		);
		const usd = data?.[mint]?.usdPrice ?? data?.[mint]?.price;
		const n = Number(usd);
		if (Number.isFinite(n) && n > 0) return { priceUsd: n, source: 'jupiter' };
		// Jupiter has no price for this mint (or could not answer). The shared
		// market chain covers the mints Jupiter misses, which for a bonding-curve
		// token is most of the interesting ones.
		const alt = Number(await fetchTokenPriceUsd(mint));
		return Number.isFinite(alt) && alt > 0 ? { priceUsd: alt, source: 'market-chain' } : null;
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
	// The shape fast-path answers for pump.fun-ground and three.ws-marked mints
	// without touching anything. An unrecognized mainnet address gets one more
	// question (is it a coin we launched?) before it is refused, because an
	// agent token launched from the owner's own wallet carries no mark at all.
	if (!isPumpMint(mint, network) && !(await isRegisteredPlatformLaunch(mint, network))) {
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
		const stale = await recallGood(network, mint);
		if (stale) {
			return {
				httpStatus: 200,
				cacheControl: 'public, max-age=10, s-maxage=10',
				body: { ...stale.body, stale: true, as_of: new Date(stale.at).toISOString(), as_of_unix: Math.floor(stale.at / 1000) },
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
