// pump.fun verification status for a single mint.
//
// pump.fun marks a coin as an officially verified project on its own record;
// the badge is the platform's public statement that the coin belongs to the
// project it claims to be. That claim is worth surfacing on our own $THREE
// surfaces (the token page header, the OG card), but ONLY as a live read of
// what pump.fun currently publishes: a badge we hardcode is a badge that keeps
// rendering after the upstream flag flips, which is exactly the failure mode a
// verification badge exists to prevent.
//
// So this module never stores a verdict. It reads the `verified` field off the
// same public coin record `pump-bonding.js` already fetches (frontend-api-v3,
// keyless) and caches it briefly. Three states, all distinct:
//
//   verified: true   pump.fun publishes the badge  → render it
//   verified: false  pump.fun publishes no badge   → render nothing
//   verified: null   upstream down / unknown mint  → render nothing
//
// `false` and `null` render identically today, but a caller that wants to say
// "we could not check" (an ops panel, a monitor) can tell them apart.

import { createCache, cached } from './mem-cache.js';
import { fetchPumpCoin } from './pump-bonding.js';

// Verification changes on a human timescale (a project applies, pump.fun
// grants it), so a 5-minute window costs nothing and keeps a hot token page off
// the upstream on every render.
const TTL_MS = 5 * 60_000;
const _cache = createCache({ max: 128, ttlMs: TTL_MS });

/** Canonical pump.fun coin URL for a mint. */
export const pumpCoinUrl = (mint) => `https://pump.fun/coin/${encodeURIComponent(String(mint || ''))}`;

/**
 * Map a raw pump.fun coin object → verification shape. Pure; no network.
 *
 * A missing `verified` field is `null` (unknown), not `false`: an older cached
 * record or a route that does not carry the field must not be reported as a
 * negative verdict.
 *
 * @param {object|null} coin  Raw pump.fun frontend coin object.
 * @param {string} [mint]     Mint to attribute the result to when `coin` is null.
 * @returns {{ mint: string|null, verified: boolean|null, url: string|null, source: string }}
 */
export function mapVerification(coin, mint = null) {
	const address = coin?.mint || mint || null;
	const raw = coin?.verified;
	const verified = typeof raw === 'boolean' ? raw : null;
	return {
		mint: address,
		verified,
		url: address ? pumpCoinUrl(address) : null,
		source: 'pumpfun',
	};
}

/**
 * Read a mint's pump.fun verification status. Cached for 5 minutes and
 * single-flighted, so concurrent page loads share one upstream call.
 *
 * Never throws: an upstream fault resolves to `verified: null` so a caller can
 * keep rendering the rest of its payload.
 *
 * @param {string} mint
 * @returns {Promise<{ mint: string|null, verified: boolean|null, url: string|null, source: string, checked_at: number }>}
 */
export async function fetchPumpVerification(mint) {
	const key = String(mint || '');
	if (!key) return { ...mapVerification(null), checked_at: Date.now() };
	return cached(_cache, key, async () => {
		const res = await fetchPumpCoin(key).catch(() => ({ kind: 'upstream_down' }));
		const coin = res.kind === 'ok' ? res.coin : null;
		return { ...mapVerification(coin, key), checked_at: Date.now() };
	});
}
