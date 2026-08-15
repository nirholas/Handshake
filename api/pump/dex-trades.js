// GET /api/pump/dex-trades?mint=<mint>[&limit=40]
// ------------------------------------------------
// Recent real DEX swaps for a token, sourced from GeckoTerminal's keyless public
// API (same provider already used for price failover in token-market.js).
//
// Why this exists: the PumpPortal trade WS (api/pump/trades-stream.js) only
// streams pump.fun bonding-curve + pump-AMM venues. A coin that graduated to a
// Raydium-style pool — our own $THREE — gets ZERO trades from it, so the "live
// trades" tape sat permanently empty despite ~$280K/24h of real volume. This
// surfaces those swaps as a normalized, pollable feed.
//
// Always 200s with a (possibly empty) trades array — a public tape must never
// error. Edge-cached ~8s so a crowd of viewers collapses onto one upstream poll.

import { cors, json, method, wrap, error } from '../_lib/http.js';

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
// GeckoTerminal is Solana-only-named ("solana", not "mainnet") and has no devnet
// coverage; every graduated mint we surface lives on mainnet.
const GT_NETWORK = 'solana';
const MAX_TRADES = 50;
const POOL_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;
// How long to keep serving the last good trades frame for a mint after upstream
// starts failing. A graduated coin's tape is far better stale-by-a-minute than
// blank, and it lets a crowd of pollers ride the cache through a rate-limit blip.
const TRADES_STALE_MS = 90_000;
// GeckoTerminal's keyless tier is ~30 req/min shared across the whole function.
// When we trip a 429, hammering it again immediately just extends the throttle,
// so we open a short circuit-breaker: until it elapses, skip the upstream call
// entirely and serve cached trades. Kept under the stale window so a real
// recovery is picked up on the first poll after the cooldown.
const RATELIMIT_COOLDOWN_MS = 20_000;

// mint → { pool, at } — the top pool changes rarely, so caching it keeps the
// per-poll cost at a single GeckoTerminal call against a tight keyless limit.
const _poolCache = new Map();
// mint → { trades, pool, at } — last successful trade frame, served stale when
// upstream is unavailable so the live tape never blanks mid-session.
const _tradesCache = new Map();
// Process-wide circuit breaker: epoch ms until which we treat GeckoTerminal as
// rate-limited and skip calls. Shared across mints because the 429 is per-IP.
let _cooldownUntil = 0;

function isPlausibleMint(s) {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

class RateLimitError extends Error {
	constructor() {
		super('GeckoTerminal 429');
		this.code = 'rate_limited';
	}
}

class NotFoundError extends Error {
	constructor() {
		super('GeckoTerminal 404');
		this.code = 'not_found';
	}
}

async function gtFetch(path) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(`${GT_BASE}${path}`, {
			signal: ctrl.signal,
			headers: { accept: 'application/json', 'user-agent': 'three.ws-dex-trades/1' },
		});
		if (r.status === 429) {
			// Open the breaker so sibling invocations stop piling onto the throttle.
			_cooldownUntil = Date.now() + RATELIMIT_COOLDOWN_MS;
			throw new RateLimitError();
		}
		if (r.status === 404) throw new NotFoundError();
		if (!r.ok) throw new Error(`GeckoTerminal ${r.status}`);
		return await r.json();
	} finally {
		clearTimeout(tid);
	}
}

// Resolve the highest-24h-volume pool for a mint (the venue where the tape's
// trades actually happen — for $THREE that's ~98% of volume in one pool).
async function topPool(mint) {
	const hit = _poolCache.get(mint);
	if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit.pool;
	const data = await gtFetch(`/networks/${GT_NETWORK}/tokens/${mint}/pools`);
	const pools = Array.isArray(data?.data) ? data.data : [];
	let best = null;
	let bestVol = -1;
	for (const p of pools) {
		const vol = Number(p?.attributes?.volume_usd?.h24);
		if (Number.isFinite(vol) && vol > bestVol) {
			bestVol = vol;
			best = p;
		}
	}
	// A GeckoTerminal pool id is "<network>_<address>"; the trades path wants the
	// bare on-chain address.
	const id = best?.id || '';
	const pool = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
	if (pool) _poolCache.set(mint, { pool, at: Date.now() });
	return pool || null;
}

/**
 * Normalize one GeckoTerminal trade into the exact shape the $THREE trade tape
 * renders — the same field names the PumpPortal feed emits, so the client stays
 * source-agnostic.
 *
 * GeckoTerminal's `kind` is from the base token's (our mint's) perspective:
 * `buy` = the token was acquired with SOL, `sell` = the reverse. So the SOL leg
 * is the `from` amount on a buy and the `to` amount on a sell.
 *
 * @param {object} t  raw GeckoTerminal trade resource
 * @param {string} mint  the token being tracked
 */
export function normalizeGtTrade(t, mint) {
	const a = t?.attributes || {};
	const isBuy = a.kind === 'buy';
	const tokenAmount = Number(isBuy ? a.to_token_amount : a.from_token_amount);
	const solAmount = Number(isBuy ? a.from_token_amount : a.to_token_amount);
	const usd = Number(a.volume_in_usd);
	const ts = a.block_timestamp ? Math.floor(Date.parse(a.block_timestamp) / 1000) : null;
	return {
		signature: a.tx_hash || null,
		tx_signature: a.tx_hash || null,
		mint,
		trader: a.tx_from_address || null,
		txType: isBuy ? 'buy' : 'sell',
		tx_type: a.kind || null,
		is_buy: isBuy,
		token_amount: Number.isFinite(tokenAmount) ? tokenAmount : null,
		sol_amount: Number.isFinite(solAmount) ? solAmount : null,
		sol_value_usd: Number.isFinite(usd) ? usd : null,
		timestamp: ts,
		source: 'geckoterminal',
	};
}

export default wrap(async (req, res) => {
	// Keyless public tape, same as every sibling pump read (intel, launch-detail,
	// ghost-copy, helius-stats): any origin may consume it. Without `origins: '*'`
	// a cross-origin agent got the response with no allow-origin header and the
	// browser dropped it, for data that needs no account and carries no secret.
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const u = new URL(req.url, 'http://x');
	const mint = (u.searchParams.get('mint') || '').trim();
	const limit = Math.min(MAX_TRADES, Math.max(1, Number(u.searchParams.get('limit')) || 40));

	if (!mint || !isPlausibleMint(mint)) {
		return error(res, 400, 'bad_mint', 'mint query param must be a base58 Solana address');
	}

	// Serve the last good frame for this mint, capped/sorted to the request shape.
	// `stale` flags that the data is from cache rather than a fresh upstream read.
	const serveCached = (stale) => {
		const hit = _tradesCache.get(mint);
		if (!hit) return null;
		return {
			mint,
			pool: hit.pool,
			trades: hit.trades.slice(0, limit),
			...(stale ? { stale: true } : {}),
		};
	};

	// Circuit-breaker open: GeckoTerminal recently 429'd us. Don't add to the
	// throttle — ride the cache. Empty (but 200) if we have nothing cached yet.
	if (Date.now() < _cooldownUntil) {
		const cached = serveCached(true);
		return json(
			res,
			200,
			cached || { mint, pool: null, trades: [], stale: true, error: 'rate_limited' },
			{ 'cache-control': 'public, s-maxage=10' },
		);
	}

	try {
		const pool = await topPool(mint);
		if (!pool) {
			return json(
				res,
				200,
				{ mint, pool: null, trades: [] },
				{ 'cache-control': 'public, s-maxage=30, stale-while-revalidate=120' },
			);
		}
		const data = await gtFetch(`/networks/${GT_NETWORK}/pools/${pool}/trades`);
		const raw = Array.isArray(data?.data) ? data.data : [];
		const trades = raw
			.map((t) => normalizeGtTrade(t, mint))
			.filter((t) => t.signature && t.timestamp)
			.sort((a, b) => b.timestamp - a.timestamp)
			.slice(0, MAX_TRADES);
		_tradesCache.set(mint, { trades, pool, at: Date.now() });
		return json(
			res,
			200,
			{ mint, pool, trades: trades.slice(0, limit) },
			{ 'cache-control': 'public, s-maxage=8, stale-while-revalidate=30' },
		);
	} catch (err) {
		// Never error a public tape. Prefer the last good frame (within the stale
		// window) over a blank one so the tape survives a rate-limit/timeout blip;
		// fall back to empty only when we have nothing cached.
		const isRateLimit = err?.code === 'rate_limited';
		// 404 = token has no listed pools on GeckoTerminal — not an error, just an
		// unlisted coin. Log nothing; the caller gets an empty trades array.
		const isNotFound = err?.code === 'not_found';
		if (!isRateLimit && !isNotFound) console.error('[pump/dex-trades]', err?.message || err);
		if (isNotFound) {
			return json(
				res,
				200,
				{ mint, pool: null, trades: [] },
				{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
			);
		}
		const hit = _tradesCache.get(mint);
		if (hit && Date.now() - hit.at < TRADES_STALE_MS) {
			return json(
				res,
				200,
				{ mint, pool: hit.pool, trades: hit.trades.slice(0, limit), stale: true },
				{ 'cache-control': 'public, s-maxage=10' },
			);
		}
		return json(
			res,
			200,
			{ mint, pool: null, trades: [], error: isRateLimit ? 'rate_limited' : 'upstream_unavailable' },
			{ 'cache-control': 'public, s-maxage=10' },
		);
	}
});
