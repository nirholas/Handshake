// Shared, rate-limit-aware read layer for the public pump.fun feeds.
//
// Why this module exists: one GET /api/crypto/trending call pulls the coin board
// plus the trade feed for up to 20 coins, and one GET /api/crypto/whales market
// scan pulls 8 more. pump.fun sits behind Cloudflare, which answers a burst that
// size with HTTP 429 ("error code: 1015") for the next several seconds. Both
// endpoints then reported "all upstream sources unavailable" while pump.fun was
// perfectly healthy: three trending calls in a row (5m, 1h, 24h) reliably left
// the last two empty.
//
// Two mechanics fix it, and both belong in one place so every pump.fun reader
// inherits them:
//
//   1. A short shared cache on the raw board and per-coin trade pulls, keyed only
//      by mint + row limit. Trade rows carry their own timestamps and are window
//      agnostic, so the 5m, 1h and 24h rankings all reuse a single fetch, and a
//      second agent polling the same coin pays nothing. A failed fetch is never
//      cached (cacheWrap skips null), so an outage is retried on the next call
//      rather than pinned for the TTL.
//   2. One bounded retry that honours Retry-After on 429/5xx, so a burst that
//      just clips the rate limit recovers inside the same request.
//
// A longer last-known-good copy sits behind the live TTL. When Cloudflare is
// mid-ban there is nothing to retry into, so rather than answer "the feed is
// down" while holding minutes-old real trades, we serve those and mark the
// result stale. Trade rows carry their own timestamps, so a windowed sum built
// from them stays arithmetically honest: an old row simply falls outside the
// window and contributes nothing.
//
// Failure contract, relied on by callers to tell a real outage from a quiet
// market: `null` means the call failed and no last-known-good exists, while
// `{ rows: [], stale: false }` means the upstream answered with no rows.
// Reporting an empty array as "feed down" is what made a brand-new mint with no
// trades look like a pump.fun outage.

import { cacheGet, cacheSet } from './cache.js';

export const PUMP_FRONTEND_BASE =
	process.env.PUMP_FRONTEND_BASE || 'https://frontend-api-v3.pump.fun';
export const PUMP_SWAP_BASE = process.env.PUMP_SWAP_BASE || 'https://swap-api.pump.fun';

const UA = 'three.ws-pump-feed/1';
const DEFAULT_TIMEOUT_MS = Number(process.env.PUMP_FEED_TIMEOUT_MS || 6000);
// Trade rows for a mint are shared by every window and every caller; a short TTL
// keeps the data live while collapsing a burst of identical pulls into one.
const TRADES_TTL_S = Number(process.env.PUMP_FEED_TRADES_TTL_S || 20);
// The market-cap board turns over far more slowly than the trade feed.
const BOARD_TTL_S = Number(process.env.PUMP_FEED_BOARD_TTL_S || 30);
// How long a last-known-good copy stays servable once the live TTL has lapsed.
// Long enough to ride out a Cloudflare rate-limit window, short enough that a
// stale answer is still about the current market.
const TRADES_LKG_TTL_S = Number(process.env.PUMP_FEED_TRADES_LKG_TTL_S || 600);
const BOARD_LKG_TTL_S = Number(process.env.PUMP_FEED_BOARD_LKG_TTL_S || 1800);
// Upper bound on a Retry-After honoured inline. Cloudflare sometimes asks for a
// minute, which is longer than the whole request budget; past this we give up on
// the retry and let the caller degrade.
const MAX_RETRY_WAIT_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Parse Retry-After (delta-seconds or HTTP-date) into a bounded millisecond wait.
// Absent or unparseable → a short fixed backoff, which is what a 1015 needs.
function retryDelayMs(res) {
	const raw = res?.headers?.get?.('retry-after');
	if (raw) {
		const secs = Number(raw);
		if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
		const at = Date.parse(raw);
		if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_WAIT_MS);
	}
	return 400;
}

/**
 * Fetch JSON from a pump.fun feed with one bounded retry on a rate limit or a
 * transient server error. Never throws: a network failure, timeout or bad body
 * is reported as `{ ok: false }`.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
 */
export async function pumpFetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = {}) {
	let attempt = 0;
	let lastStatus = 0;
	for (;;) {
		let res;
		try {
			res = await fetch(url, {
				headers: { accept: 'application/json', 'user-agent': UA },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			return { ok: false, status: 0, body: null };
		}
		lastStatus = res.status;
		if (res.ok) {
			const body = await res.json().catch(() => null);
			if (body == null) return { ok: false, status: res.status, body: null };
			return { ok: true, status: res.status, body };
		}
		const retryable = res.status === 429 || res.status >= 500;
		if (!retryable || attempt >= retries) return { ok: false, status: res.status, body: null };
		await sleep(retryDelayMs(res));
		attempt += 1;
	}
}

/** Pull the trade array out of either accepted swap-api envelope. */
function tradesFrom(body) {
	if (Array.isArray(body)) return body;
	if (Array.isArray(body?.trades)) return body.trades;
	return [];
}

/**
 * Read-through cache with a last-known-good tier. A live hit answers first; a
 * miss fetches and refreshes both tiers; a failed fetch falls back to the
 * last-known-good copy and says so. Cache writes are fire-and-forget: the rows
 * are already in hand and the cache is an optimization, never part of the result.
 *
 * @returns {Promise<{ rows: Array<object>, stale: boolean }|null>}
 */
async function readThroughFeed({ key, ttlSeconds, lkgKey, lkgTtlSeconds, fetchRows }) {
	const hit = await cacheGet(key);
	if (Array.isArray(hit)) return { rows: hit, stale: false };
	const rows = await fetchRows();
	if (Array.isArray(rows)) {
		cacheSet(key, rows, ttlSeconds).catch(() => {});
		cacheSet(lkgKey, rows, lkgTtlSeconds).catch(() => {});
		return { rows, stale: false };
	}
	const lkg = await cacheGet(lkgKey);
	if (Array.isArray(lkg)) return { rows: lkg, stale: true };
	return null;
}

/**
 * Recent trades for one mint, shared across callers and windows for TRADES_TTL_S.
 *
 * @param {string} mint
 * @param {{ limit?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ rows: Array<object>, stale: boolean }|null>} null when the
 *   upstream failed and no last-known-good copy is left
 */
export async function fetchPumpTrades(mint, { limit = 100, timeoutMs } = {}) {
	const rows = Math.max(1, Math.floor(limit));
	return readThroughFeed({
		key: `pump:feed:trades:${mint}:${rows}`,
		ttlSeconds: TRADES_TTL_S,
		lkgKey: `pump:feed:trades:lkg:${mint}:${rows}`,
		lkgTtlSeconds: TRADES_LKG_TTL_S,
		fetchRows: async () => {
			const url = `${PUMP_SWAP_BASE}/v2/coins/${encodeURIComponent(mint)}/trades?limit=${rows}`;
			const { ok, body } = await pumpFetchJson(url, { timeoutMs });
			return ok ? tradesFrom(body) : null;
		},
	});
}

/** Pull the coin array out of either accepted frontend-api envelope. */
function coinsFrom(body) {
	const coins = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : [];
	return coins.filter((c) => c && typeof c.mint === 'string' && c.mint.length >= 32);
}

/**
 * The pump.fun market-cap board, shared across callers for BOARD_TTL_S.
 *
 * @param {{ limit?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ rows: Array<object>, stale: boolean }|null>} raw coin rows,
 *   or null when the upstream failed with no last-known-good copy left
 */
export async function fetchPumpBoard({ limit = 20, timeoutMs } = {}) {
	const rows = Math.max(1, Math.floor(limit));
	return readThroughFeed({
		key: `pump:feed:board:${rows}`,
		ttlSeconds: BOARD_TTL_S,
		lkgKey: `pump:feed:board:lkg:${rows}`,
		lkgTtlSeconds: BOARD_LKG_TTL_S,
		fetchRows: async () => {
			const url = new URL('/coins', PUMP_FRONTEND_BASE);
			url.searchParams.set('offset', '0');
			url.searchParams.set('limit', String(rows));
			url.searchParams.set('sort', 'market_cap');
			url.searchParams.set('order', 'DESC');
			url.searchParams.set('includeNsfw', 'false');
			const { ok, body } = await pumpFetchJson(url.toString(), { timeoutMs });
			return ok ? coinsFrom(body) : null;
		},
	});
}
