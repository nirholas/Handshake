// Shared CoinGecko fetch for the global coin pages (/coins, /coin/:id).
//
// One place for the base URL, the optional demo API key, timeouts, and a small
// per-instance memory cache so the three read endpoints (api/coin/detail.js,
// api/coin/ohlc.js, api/coin/markets.js) don't each reimplement them. Works
// key-free; a COINGECKO_API_KEY (demo tier) lifts the public rate limit.
// CDN caching on the endpoints absorbs most traffic — this cache only shields
// the upstream from concurrent cold-instance misses.

import { cacheGet, cacheSet } from './cache.js';
import { recordSource } from './brownout/provenance.js';
import { applyFault, faultFor } from './brownout/chaos.js';
import { createCache } from './mem-cache.js';

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// key → { value, expiresAt, staleUntil }. Entries stay readable past expiresAt
// (up to staleUntil) so a rate-limited or flaky upstream serves last-good data
// instead of cascading into a user-facing 502. CoinGecko's free/demo tiers cap
// at ~30 req/min; broad coin-page crawling saturates that, and without a stale
// buffer every /coin/:id detail call would 502 during the storm.
// Bounded by true LRU rather than a Map trimmed with
// `delete(keys().next().value)`, which dropped the OLDEST INSERTED entry — so a
// continuously-hot coin page could be evicted while colder entries inserted
// after it survived. Freshness is NOT the LRU's `ttl`: entries must stay
// readable past `expiresAt` for the stale buffer below to work, so expiry stays
// an explicit field on the value.
const _cache = createCache({ max: 512 });
// How long past freshness a cached value may still be served on an upstream
// fault. Coin metadata (description, dev/community stats, market cap) tolerates
// minutes of staleness far better than an outage.
const STALE_MS = 30 * 60_000;

// The in-memory stale buffer dies with the instance, so a COLD instance facing
// a throttled upstream still 502s (the July 2026 api-sweep caught /api/coin/
// exchanges doing exactly that). Mirror every good payload into the shared
// cache (Upstash) as a durable last-good copy that any instance can fall back
// to. Long window on purpose: it is only ever read after the live fetch AND
// the memory stale buffer have both failed.
const DURABLE_STALE_S = 6 * 3600;
const durableKey = (path) => `gecko:last-good:${path}`;

async function durableStale(path) {
	try {
		const value = await cacheGet(durableKey(path));
		return value === undefined || value === null ? null : value;
	} catch {
		return null;
	}
}

// ── Demo-key health ──────────────────────────────────────────────────────────
// The demo tier caps at 10,000 calls per MONTH. Once that cap is reached every
// keyed request comes back 429 (error_code 10006) for the rest of the billing
// period — while the SAME request without the key is still served by the
// keyless public tier. So an exhausted key is strictly worse than no key: on
// 2026-07-28 it took every /api/coin/detail, /tickers and /exchange call to a
// 502 for hours because the key was attached to all of them.
//
// Treat the key as a resource that can go bad: when a keyed request is rejected
// for an auth/quota reason, retry the same URL keyless and, if that works, park
// the key for a cooldown so subsequent calls skip it entirely instead of paying
// a wasted round trip. The key is re-probed after the cooldown, so a monthly
// reset (or a key upgrade) heals on its own with no redeploy.
const KEY_COOLDOWN_MS = 15 * 60_000;
// 429 = quota exhausted or throttled; 401/403 = revoked or wrong-tier key.
const KEY_FAULT_STATUSES = new Set([401, 403, 429]);
let _keyBenchedUntil = 0;

/** True when the demo key is currently benched (recently rejected). */
export function isGeckoKeyBenched(now = Date.now()) {
	return _keyBenchedUntil > now;
}

/** Bench the demo key so the next calls go out keyless. Exported for tests. */
export function benchGeckoKey(now = Date.now()) {
	_keyBenchedUntil = now + KEY_COOLDOWN_MS;
}

/** Clear the bench. Test-only hook; production heals via the cooldown. */
export function resetGeckoKeyHealth() {
	_keyBenchedUntil = 0;
}

/**
 * Request headers for a CoinGecko call.
 * @param {boolean} [withKey=true] false forces the keyless public tier.
 */
export function geckoHeaders(withKey = true) {
	const h = { accept: 'application/json', 'user-agent': 'three.ws/1.0' };
	const key = (process.env.COINGECKO_API_KEY || '').trim();
	if (key && withKey && !isGeckoKeyBenched()) h['x-cg-demo-api-key'] = key;
	return h;
}

/** Did this response carry the demo key, and was it rejected for using it? */
function keyWasRejected(headersUsed, status) {
	return Boolean(headersUsed['x-cg-demo-api-key']) && KEY_FAULT_STATUSES.has(status);
}

/**
 * GET a CoinGecko path (must start with '/'), JSON-parsed, memory-cached.
 * Throws an Error with .status = upstream HTTP status on a non-OK response so
 * callers can distinguish 404 (unknown coin) from 429/5xx (upstream trouble).
 */
export async function geckoFetch(path, { ttlMs = 60_000, timeoutMs = 8000 } = {}) {
	const now = Date.now();
	const hit = _cache.get(path);
	if (hit && hit.expiresAt > now) {
		// A cache hit inside its TTL is `cache`, not `live`: the answer is correct
		// and intended, but it did not come off the wire during this request, and a
		// reader deciding how much to trust a number deserves to know which.
		recordSource({ name: 'coingecko', outcome: 'ok', ms: 0, tier: 'cache' });
		return hit.value;
	}
	// A still-usable stale entry lets us ride out a throttled/failing upstream.
	const stale = hit && hit.staleUntil > now ? hit.value : null;

	const url = `${COINGECKO_BASE}${path}`;
	const startedAt = now;
	let resp;
	try {
		const sent = geckoHeaders();
		// CoinGecko's keyless tier is shared per egress IP and throttles constantly,
		// which makes it the single most useful upstream to be able to break on
		// purpose: most of this module exists to survive exactly that.
		const fault = faultFor('coingecko');
		if (fault) {
			const injected = await applyFault(fault, url);
			resp = injected ?? (await fetch(url, { headers: sent, signal: AbortSignal.timeout(timeoutMs) }));
		} else {
			resp = await fetch(url, { headers: sent, signal: AbortSignal.timeout(timeoutMs) });
		}
		// An exhausted/revoked demo key rejects requests the keyless tier would
		// still answer. Bench the key and retry once without it before falling
		// back to stale data — the live payload beats a cached one.
		if (keyWasRejected(sent, resp.status)) {
			benchGeckoKey();
			console.warn(`[coingecko] ${path} → ${resp.status} with demo key; benching key, retrying keyless`);
			const keyless = await fetch(url, {
				headers: geckoHeaders(false),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (keyless.ok) resp = keyless;
		}
	} catch (netErr) {
		// Network failure or timeout — serve stale if we have it, else surface.
		if (stale !== null) {
			console.warn(`[coingecko] ${path} fetch failed (${netErr?.name || 'error'}); serving stale`);
			recordSource({ name: 'coingecko', outcome: 'ok', ms: Date.now() - startedAt, tier: 'stale', detail: 'stale' });
			return stale;
		}
		const durable = await durableStale(path);
		if (durable !== null) {
			console.warn(`[coingecko] ${path} fetch failed (${netErr?.name || 'error'}); serving durable last-good`);
			_cache.set(path, { value: durable, expiresAt: now, staleUntil: now + STALE_MS });
			recordSource({ name: 'coingecko', outcome: 'ok', ms: Date.now() - startedAt, tier: 'stale', detail: 'durable' });
			return durable;
		}
		recordSource({ name: 'coingecko', outcome: 'fail', ms: Date.now() - startedAt, tier: 'live', detail: netErr?.name === 'TimeoutError' ? 'timeout' : 'network' });
		throw netErr;
	}
	if (!resp.ok) {
		// 404 is a genuine "unknown coin" signal callers must see; never mask it
		// with stale data. For throttling (429) or upstream trouble (5xx), a
		// recent value beats an outage — serve it and keep the page alive.
		if (resp.status !== 404 && stale !== null) {
			console.warn(`[coingecko] ${path} → ${resp.status}; serving stale`);
			recordSource({ name: 'coingecko', outcome: 'ok', ms: Date.now() - startedAt, tier: 'stale', detail: resp.status });
			return stale;
		}
		if (resp.status !== 404) {
			// Cold instance, throttled upstream, nothing in memory, the shared
			// last-good copy is the difference between minutes-stale data and a 502.
			const durable = await durableStale(path);
			if (durable !== null) {
				console.warn(`[coingecko] ${path} → ${resp.status}; serving durable last-good`);
				_cache.set(path, { value: durable, expiresAt: now, staleUntil: now + STALE_MS });
				recordSource({ name: 'coingecko', outcome: 'ok', ms: Date.now() - startedAt, tier: 'stale', detail: resp.status });
				return durable;
			}
		}
		recordSource({ name: 'coingecko', outcome: 'fail', ms: Date.now() - startedAt, tier: 'live', detail: resp.status });
		const err = new Error(`CoinGecko ${resp.status} for ${path}`);
		err.status = resp.status;
		throw err;
	}
	const value = await resp.json();
	recordSource({ name: 'coingecko', outcome: 'ok', ms: Date.now() - startedAt, tier: 'live' });
	_cache.set(path, { value, expiresAt: now + ttlMs, staleUntil: now + ttlMs + STALE_MS });
	// Fire-and-forget durable mirror, never let a cache fault fail a live fetch.
	Promise.resolve(cacheSet(durableKey(path), value, DURABLE_STALE_S)).catch(() => {});
	return value;
}

/** CoinGecko coin ids are lowercase slugs: letters, digits, hyphens (a few underscores). */
export function isPlausibleCoinId(s) {
	return typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(s);
}

/** Strip HTML to plain text: tags out, entities decoded, whitespace collapsed per paragraph. */
export function htmlToText(html) {
	if (!html || typeof html !== 'string') return '';
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
