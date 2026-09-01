// Shared "trending tokens" fetch + cache: the thin
// { mint, symbol, name, logo, price_usd, usd_market_cap, rank } projection used
// by every free trending consumer: GET /api/pump/trending (home card,
// communities, constellation, dashboard chart picker) and the free
// GET /api/v1/pump/trending. One fetch+cache+fallback path, two doors.
//
// Primary source is Birdeye (BIRDEYE_API_KEY, kept server-side). When Birdeye is
// unconfigured, rate-limited, or down, falls back to pump.fun's public frontend
// feed — same shape — so consumers degrade to live pump.fun data instead of a
// hard error. A short-lived stale cache survives a brief outage on BOTH sources.

import { normalizeGatewayURL } from '../../src/ipfs.js';
import { sql } from './db.js';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const PUMP_FRONTEND_BASE = 'https://frontend-api-v3.pump.fun';

// Process-local cache. Trending shifts slowly; many tabs polling on nav into the
// dashboard would otherwise hammer the upstreams. Warm-starts share this map.
// `storedAt` lets us serve the value as STALE (past its TTL) when every live
// upstream is down — a slowly-changing market feed is far better shown a few
// minutes old than blanked out with a 502 during an upstream blip.
let _cache = { value: null, storedAt: 0, expiresAt: 0, limit: 0 };
const TTL_MS = 30_000;
// Every upstream fetch asks for this many rows regardless of the caller's
// limit, so ONE cache entry serves every consumer. Before this, the cache was
// keyed by the requesting limit: frequent small-limit callers (the home card)
// kept the cache too small for large-limit callers (communities wants 24),
// whose own fetches then burned the rate-limited Birdeye key (free tier is
// ~1 req/s; the burst 429'd and tripped the breaker) and 503'd. Birdeye's
// trending endpoint serves at most 20 rows per call, so a >20 caller gets a
// full feed of 20 rather than an error.
const FETCH_LIMIT = 20;
// How long a cached feed may be served as a stale fallback after every live
// upstream has failed. Bounds how old the market data can get during an outage.
const STALE_MAX_MS = 10 * 60_000;
// Upstream fetch timeout. Trending is a fast feed behind a 30s cache + stale
// fallback, so a long wait buys nothing — fail fast and fall through.
const UPSTREAM_TIMEOUT_MS = 5000;
// Birdeye circuit breaker: after a failure, skip Birdeye entirely for a cooldown
// so an influx during a Birdeye outage stops paying the per-request timeout on
// the way to the pump.fun fallback. Auto-recovers when the cooldown elapses.
const BIRDEYE_COOLDOWN_MS = 60_000;
let _birdeyeCooldownUntil = 0;

// Serve a cached feed past its TTL when live upstreams are down. Returns the
// sliced value while it is within the stale window, else null. A cache holding
// fewer rows than asked still serves: a short trending list beats an outage
// envelope.
function serveStale(limit, now) {
	if (!_cache.value) return null;
	if (now - _cache.storedAt > STALE_MAX_MS) return null;
	return _cache.value.slice(0, limit);
}

// Primary: Birdeye trending feed. Returns null (not throws) on any failure so the
// caller can transparently fall back.
async function fetchBirdeye(limit) {
	if (!BIRDEYE_API_KEY) return null;
	// Circuit open: a recent Birdeye failure put it in cooldown — skip straight to
	// the fallback instead of paying the timeout again.
	if (Date.now() < _birdeyeCooldownUntil) return null;
	const url =
		`https://public-api.birdeye.so/defi/token_trending` +
		`?sort_by=rank&sort_type=asc&offset=0&limit=${limit}`;
	let upstream;
	try {
		upstream = await fetch(url, {
			headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana', accept: 'application/json' },
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
	} catch {
		_birdeyeCooldownUntil = Date.now() + BIRDEYE_COOLDOWN_MS;
		return null;
	}
	if (!upstream.ok) {
		// 429 / 5xx — trip the breaker so the next requests skip the timeout.
		_birdeyeCooldownUntil = Date.now() + BIRDEYE_COOLDOWN_MS;
		return null;
	}
	const payload = await upstream.json().catch(() => null);
	const tokens = payload?.data?.tokens;
	if (!Array.isArray(tokens)) return null;
	const data = tokens
		.map((t) => ({
			mint: t.address,
			symbol: t.symbol || '?',
			name: t.name || t.symbol || '',
			logo: t.logoURI || null,
			price_usd: typeof t.price === 'number' ? t.price : null,
			usd_market_cap: typeof t.marketcap === 'number' ? t.marketcap : null,
			rank: typeof t.rank === 'number' ? t.rank : null,
		}))
		.filter((t) => typeof t.mint === 'string' && t.mint.length >= 32);
	return data.length ? data : null;
}

// Fallback: pump.fun's public frontend feed (no API key). Mapped into the exact
// same shape so every consumer keeps working. pump.fun doesn't expose a clean
// per-token USD price here, so price_usd is left null rather than fabricated.
//
// `sort` picks the feed: 'market_cap' is the trending list, 'created_timestamp'
// the newest launches. Both come back in the same slim shape, plus the creator
// wallet and creation time the frontend feed carries for free (null when a row
// lacks them), which the strategy runtime's token-age metric reads.
async function fetchPumpFun(limit, sort = 'market_cap') {
	const url = new URL('/coins', PUMP_FRONTEND_BASE);
	url.searchParams.set('offset', '0');
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('sort', sort);
	url.searchParams.set('order', 'DESC');
	url.searchParams.set('includeNsfw', 'false');
	let upstream;
	try {
		upstream = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
	} catch {
		return null;
	}
	if (!upstream.ok) return null;
	const body = await upstream.json().catch(() => null);
	const coins = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : null;
	if (!Array.isArray(coins)) return null;
	const data = coins
		.map((c, i) => ({
			mint: c.mint || c.address || '',
			symbol: c.symbol || '?',
			name: c.name || c.symbol || '',
			logo: normalizeGatewayURL(c.image_uri || c.image || '') || null,
			price_usd: null,
			usd_market_cap: typeof c.usd_market_cap === 'number' ? c.usd_market_cap : null,
			creator: typeof c.creator === 'string' && c.creator.length >= 32 ? c.creator : null,
			created_at: typeof c.created_timestamp === 'number' ? c.created_timestamp : null,
			rank: i + 1,
		}))
		.filter((t) => typeof t.mint === 'string' && t.mint.length >= 32);
	return data.length ? data : null;
}

// Last-rung fallback: our own recorder pipeline. pump_coin_intel ingests every
// pump.fun launch continuously (thousands of rows per hour), so when both
// external feeds are down or egress-blocked, the platform's own database still
// knows what is moving. Most-bought coins observed in the last 6 hours, mapped
// to the same slim shape. price_usd and usd_market_cap stay null (the recorder
// stores lamport flows, not USD quotes), the same contract as the pump.fun rung.
async function fetchDbTrending(limit) {
	try {
		const rows = await sql`
			SELECT mint, symbol, name, image_uri
			FROM pump_coin_intel
			WHERE first_seen_at > now() - interval '6 hours'
			ORDER BY buy_volume_lamports DESC NULLS LAST
			LIMIT ${limit}
		`;
		const data = rows
			.map((r, i) => ({
				mint: r.mint || '',
				symbol: r.symbol || '?',
				name: r.name || r.symbol || '',
				logo: normalizeGatewayURL(r.image_uri || '') || null,
				price_usd: null,
				usd_market_cap: null,
				rank: i + 1,
			}))
			.filter((t) => typeof t.mint === 'string' && t.mint.length >= 32);
		return data.length ? data : null;
	} catch {
		return null;
	}
}

/**
 * Get up to `limit` trending tokens (thin projection), cached 30s with a stale
 * fallback across a Birdeye→pump.fun→recorder-DB failover.
 *
 * @param {number} limit
 * @returns {Promise<{ data: object[]|null, stale: boolean }>}
 *   `data: null` only when every live source is down AND no usable stale cache
 *   exists — callers translate that into their own 502/503 envelope.
 */
export async function getTrendingSlim(limit) {
	const now = Date.now();
	if (_cache.value && _cache.expiresAt > now) {
		return { data: _cache.value.slice(0, limit), stale: false };
	}

	// Always fetch the canonical batch, never the caller's limit: one cache
	// entry serves every consumer, and the rate-limited Birdeye key is hit at
	// most once per TTL instead of once per distinct limit.
	const fetchN = Math.max(FETCH_LIMIT, limit);
	let data = await fetchBirdeye(FETCH_LIMIT);
	if (!data) data = await fetchPumpFun(fetchN);
	if (!data) data = await fetchDbTrending(fetchN);
	if (!data) {
		const stale = serveStale(limit, now);
		if (stale) return { data: stale, stale: true };
		// Every rung failed — say so once per miss; this is the moment a lobby
		// endpoint is about to hand back its outage envelope.
		console.warn('[pump-trending] all sources failed (birdeye, pump.fun, recorder db) and no stale cache');
		return { data: null, stale: false };
	}

	_cache = { value: data, storedAt: now, expiresAt: now + TTL_MS, limit: data.length };
	return { data: data.slice(0, limit), stale: false };
}

// ── Newest launches ─────────────────────────────────────────────────────────
// Same contract as trending, for the "most recently launched" feed the strategy
// runtime scans (`scan.kind: 'newTokens'`) and the pump.fun MCP's get_new_tokens
// tool serve. Rungs: pump.fun's public frontend feed sorted by creation time,
// then the recorder database (pump_coin_intel ingests every launch the WS feed
// sees, so it is the freshest thing the platform owns when egress is blocked),
// then the stale cache. New launches churn by the second, so the TTL is short.
let _newCache = { value: null, storedAt: 0, expiresAt: 0, limit: 0 };
const NEW_TTL_MS = 10_000;
const NEW_FETCH_LIMIT = 50;

function serveStaleNew(limit, now) {
	if (!_newCache.value) return null;
	if (now - _newCache.storedAt > STALE_MAX_MS) return null;
	return _newCache.value.slice(0, limit);
}

async function fetchDbNew(limit) {
	try {
		const rows = await sql`
			SELECT mint, symbol, name, image_uri, creator, created_at, first_seen_at
			FROM pump_coin_intel
			WHERE first_seen_at > now() - interval '6 hours'
			ORDER BY first_seen_at DESC
			LIMIT ${limit}
		`;
		const data = rows
			.map((r, i) => {
				const created = r.created_at || r.first_seen_at;
				return {
					mint: r.mint || '',
					symbol: r.symbol || '?',
					name: r.name || r.symbol || '',
					logo: normalizeGatewayURL(r.image_uri || '') || null,
					price_usd: null,
					usd_market_cap: null,
					creator: typeof r.creator === 'string' && r.creator.length >= 32 ? r.creator : null,
					created_at: created ? new Date(created).getTime() : null,
					rank: i + 1,
				};
			})
			.filter((t) => typeof t.mint === 'string' && t.mint.length >= 32);
		return data.length ? data : null;
	} catch {
		return null;
	}
}

/**
 * Get up to `limit` of the most recently launched pump.fun tokens (thin
 * projection plus creator + created_at), cached 10s with a stale fallback across
 * a pump.fun→recorder-DB failover.
 *
 * @param {number} limit
 * @returns {Promise<{ data: object[]|null, stale: boolean }>}
 *   `data: null` only when every live source is down AND no usable stale cache
 *   exists.
 */
export async function getNewSlim(limit) {
	const now = Date.now();
	if (_newCache.value && _newCache.expiresAt > now && _newCache.limit >= limit) {
		return { data: _newCache.value.slice(0, limit), stale: false };
	}
	const fetchN = Math.max(NEW_FETCH_LIMIT, limit);
	let data = await fetchPumpFun(fetchN, 'created_timestamp');
	if (!data) data = await fetchDbNew(fetchN);
	if (!data) {
		const stale = serveStaleNew(limit, now);
		if (stale) return { data: stale, stale: true };
		console.warn('[pump-trending] new-launch sources failed (pump.fun, recorder db) and no stale cache');
		return { data: null, stale: false };
	}
	_newCache = { value: data, storedAt: now, expiresAt: now + NEW_TTL_MS, limit: data.length };
	return { data: data.slice(0, limit), stale: false };
}
