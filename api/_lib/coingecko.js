// Shared CoinGecko fetch for the global coin pages (/coins, /coin/:id).
//
// One place for the base URL, the optional demo API key, timeouts, and a small
// per-instance memory cache so the three read endpoints (api/coin/detail.js,
// api/coin/ohlc.js, api/coin/markets.js) don't each reimplement them. Works
// key-free; a COINGECKO_API_KEY (demo tier) lifts the public rate limit.
// CDN caching on the endpoints absorbs most traffic — this cache only shields
// the upstream from concurrent cold-instance misses.

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// key → { value, expiresAt, staleUntil }. Entries stay readable past expiresAt
// (up to staleUntil) so a rate-limited or flaky upstream serves last-good data
// instead of cascading into a user-facing 502. CoinGecko's free/demo tiers cap
// at ~30 req/min; broad coin-page crawling saturates that, and without a stale
// buffer every /coin/:id detail call would 502 during the storm.
const _cache = new Map();
const MAX_ENTRIES = 512;
// How long past freshness a cached value may still be served on an upstream
// fault. Coin metadata (description, dev/community stats, market cap) tolerates
// minutes of staleness far better than an outage.
const STALE_MS = 30 * 60_000;

function headers() {
	const h = { accept: 'application/json', 'user-agent': 'three.ws/1.0' };
	const key = (process.env.COINGECKO_API_KEY || '').trim();
	if (key) h['x-cg-demo-api-key'] = key;
	return h;
}

/**
 * GET a CoinGecko path (must start with '/'), JSON-parsed, memory-cached.
 * Throws an Error with .status = upstream HTTP status on a non-OK response so
 * callers can distinguish 404 (unknown coin) from 429/5xx (upstream trouble).
 */
export async function geckoFetch(path, { ttlMs = 60_000, timeoutMs = 8000 } = {}) {
	const now = Date.now();
	const hit = _cache.get(path);
	if (hit && hit.expiresAt > now) return hit.value;
	// A still-usable stale entry lets us ride out a throttled/failing upstream.
	const stale = hit && hit.staleUntil > now ? hit.value : null;

	let resp;
	try {
		resp = await fetch(`${COINGECKO_BASE}${path}`, {
			headers: headers(),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (netErr) {
		// Network failure or timeout — serve stale if we have it, else surface.
		if (stale !== null) {
			console.warn(`[coingecko] ${path} fetch failed (${netErr?.name || 'error'}); serving stale`);
			return stale;
		}
		throw netErr;
	}
	if (!resp.ok) {
		// 404 is a genuine "unknown coin" signal callers must see; never mask it
		// with stale data. For throttling (429) or upstream trouble (5xx), a
		// recent value beats an outage — serve it and keep the page alive.
		if (resp.status !== 404 && stale !== null) {
			console.warn(`[coingecko] ${path} → ${resp.status}; serving stale`);
			return stale;
		}
		const err = new Error(`CoinGecko ${resp.status} for ${path}`);
		err.status = resp.status;
		throw err;
	}
	const value = await resp.json();
	_cache.set(path, { value, expiresAt: now + ttlMs, staleUntil: now + ttlMs + STALE_MS });
	if (_cache.size > MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
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
