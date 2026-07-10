// GET /api/pump/price-history?mint=<mint>&interval=15m&from=<unix>&to=<unix>
// --------------------------------------------------------------------------
// OHLCV proxy with automatic fallback chain:
//   1. Birdeye (paid, quota-limited)  — best data quality
//   2. GeckoTerminal (free, no key)   — pool lookup then candles
//   3. The last good candles for this mint+interval, served as `stale: true`
//
// On any upstream failure the next source is tried transparently.
// Never fabricates candles.
//
// Chart clients poll with a live `to` (= now) and a rolling `from`, so a cache
// keyed on the raw timestamps never hits: two polls a second apart are two keys.
// That turned every poll into a fresh GeckoTerminal round-trip, and its free
// tier rate-limits under that load — the observed intermittent 502s on /terminal
// and /trades. The window is therefore snapped to the interval's own candle
// boundary before it is used as a cache key *and* before it is sent upstream:
// candles already land on those boundaries, so the response is identical while
// every poll inside one candle shares a single cache entry.
//
// Response: { data: [ { t, o, h, l, c, v } ], source?: 'birdeye'|'gecko', stale?: true }

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { fetchBirdeyeOhlcv, birdeyeConfigured } from '../_lib/birdeye.js';

const VALID_INTERVALS = new Set([
	'1m',
	'3m',
	'5m',
	'15m',
	'30m',
	'1H',
	'2H',
	'4H',
	'6H',
	'8H',
	'12H',
	'1D',
	'3D',
	'1W',
	'1M',
]);

// Birdeye uses uppercase hour/day codes (1H, 1D). Accept the common lowercase
// forms from the client and normalize so callers don't have to care.
function normalizeInterval(raw) {
	if (!raw) return '15m';
	const map = {
		'1h': '1H',
		'2h': '2H',
		'4h': '4H',
		'6h': '6H',
		'8h': '8H',
		'12h': '12H',
		'1d': '1D',
		'3d': '3D',
		'1w': '1W',
	};
	const v = map[raw] || raw;
	return VALID_INTERVALS.has(v) ? v : '15m';
}

function isPlausibleMint(s) {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// Seconds per candle for each normalized interval — the granularity the request
// window is snapped to. Exported for the unit tests.
const INTERVAL_SECONDS = {
	'1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
	'1H': 3600, '2H': 7200, '4H': 14_400, '6H': 21_600, '8H': 28_800, '12H': 43_200,
	'1D': 86_400, '3D': 259_200, '1W': 604_800, '1M': 2_592_000,
};

export function intervalSeconds(interval) {
	return INTERVAL_SECONDS[interval] ?? 900;
}

// `to` is snapped to this bucket rather than to the candle width: snapping it to
// the candle would drop the still-forming candle and freeze a 5m chart for up to
// five minutes. Aligning it with the fresh-cache TTL instead means every poll in
// one TTL window shares a key (so at most one upstream call per TTL) while the
// live candle stays live.
export const POLL_BUCKET_SECONDS = 30;

// Snap a request window so consecutive polls collapse onto one cache key.
// `from` (a rolling window start) rounds down to the candle boundary — candles
// land there anyway, so the served data is unchanged. `to` rounds down to the
// poll bucket. Both round *down*, so the window never asks for less than the
// caller wanted and never reaches into the future.
export function snapWindow({ interval, from, to }) {
	const step = intervalSeconds(interval);
	const snappedTo = Math.floor(to / POLL_BUCKET_SECONDS) * POLL_BUCKET_SECONDS;
	const snappedFrom = Math.floor(from / step) * step;
	// A window narrower than one candle would snap to zero width; keep one candle.
	return snappedFrom >= snappedTo
		? { from: snappedTo - step, to: snappedTo }
		: { from: snappedFrom, to: snappedTo };
}

// ──────────────────────────────────────────────────────────────────────────────
// GeckoTerminal fallback — completely free, no API key required.
// Step 1: resolve the top liquidity pool for the token.
// Step 2: fetch OHLCV for that pool.
// ──────────────────────────────────────────────────────────────────────────────
const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const GECKO_HEADERS = { accept: 'application/json', 'x-api-version': '20230302' };

// Map our normalized Birdeye intervals to GeckoTerminal (timeframe, aggregate).
function geckoParams(interval) {
	const map = {
		'1m': ['minute', 1],
		'3m': ['minute', 3],
		'5m': ['minute', 5],
		'15m': ['minute', 15],
		'30m': ['minute', 30],
		'1H': ['hour', 1],
		'2H': ['hour', 2],
		'4H': ['hour', 4],
		'6H': ['hour', 6],
		'8H': ['hour', 8],
		'12H': ['hour', 12],
		'1D': ['day', 1],
		'3D': ['day', 3],
		'1W': ['day', 7],
		'1M': ['day', 30],
	};
	return map[interval] || ['minute', 15];
}

// A token's top pool does not change between polls, so resolving it once per
// mint halves the GeckoTerminal calls a chart poll costs — the difference
// between staying inside its free rate limit and tripping it.
const _poolCache = new Map(); // mint → { address, expiresAt }
const POOL_TTL_MS = 10 * 60_000;

// GeckoTerminal answers 429 when the free tier's per-minute budget is spent.
// One short retry rides out a burst rather than failing the whole request.
async function geckoFetch(url, { timeoutMs }) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const resp = await fetch(url, { headers: GECKO_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
		if (resp.status !== 429 || attempt === 1) return resp;
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error('unreachable');
}

// Thrown when the token genuinely has no market to chart — an honest empty
// state, not an upstream outage, so it must never be retried or served stale.
class NoPoolError extends Error {}

async function fetchGeckoPoolAddress(mint) {
	const hit = _poolCache.get(mint);
	if (hit && hit.expiresAt > Date.now()) return hit.address;

	const url = `${GECKO_API}/networks/solana/tokens/${mint}/pools?page=1`;
	const resp = await geckoFetch(url, { timeoutMs: 7000 });
	// 404 = GeckoTerminal has never indexed this token: it has no market, which is
	// an answer, not an outage. Any other non-OK status is a real upstream fault
	// and must bubble so the caller can fall back to stale data.
	if (resp.status === 404) {
		_poolCache.set(mint, { address: null, expiresAt: Date.now() + POOL_TTL_MS });
		return null;
	}
	if (!resp.ok) throw new Error(`GeckoTerminal pools ${resp.status}`);
	const body = await resp.json().catch(() => null);
	const pools = body?.data;
	if (!Array.isArray(pools) || !pools.length) {
		_poolCache.set(mint, { address: null, expiresAt: Date.now() + POOL_TTL_MS });
		return null;
	}
	// Prefer the pool with the most volume (first = highest by GeckoTerminal default ranking).
	const address = pools[0]?.attributes?.address ?? null;
	_poolCache.set(mint, { address, expiresAt: Date.now() + POOL_TTL_MS });
	if (_poolCache.size > 512) _poolCache.delete(_poolCache.keys().next().value);
	return address;
}

async function fetchGeckoOhlcv({ mint, interval, from, to }) {
	const poolAddress = await fetchGeckoPoolAddress(mint);
	if (!poolAddress) throw new NoPoolError('No pool found on GeckoTerminal for this mint');

	const [timeframe, aggregate] = geckoParams(interval);
	// GeckoTerminal returns candles *before* before_timestamp (exclusive, descending).
	// We ask for the maximum (1000) and filter to our window.
	const url =
		`${GECKO_API}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}` +
		`?aggregate=${aggregate}&before_timestamp=${to + 1}&limit=1000&currency=usd&token=base`;

	const resp = await geckoFetch(url, { timeoutMs: 10_000 });
	if (!resp.ok) {
		throw new Error(`GeckoTerminal ${resp.status}`);
	}
	const body = await resp.json().catch(() => null);
	const list = body?.data?.attributes?.ohlcv_list;
	if (!Array.isArray(list)) throw new Error('GeckoTerminal returned unexpected payload');

	// Format: [timestamp_sec, open, high, low, close, volume] — GeckoTerminal returns
	// descending so we reverse and filter to the requested window.
	return list
		.map(([t, o, h, l, c, v]) => ({ t: Number(t), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) }))
		.filter((d) => Number.isFinite(d.t) && Number.isFinite(d.c) && d.t >= from && d.t <= to)
		.sort((a, b) => a.t - b.t);
}

// ──────────────────────────────────────────────────────────────────────────────
// Cache — shared across both sources. Key includes interval + time window.
// ──────────────────────────────────────────────────────────────────────────────
const _cache = new Map(); // key → { value, source, expiresAt }
const TTL_MS = 30_000;

// Last good candles per mint+interval, kept well past the fresh-cache TTL so a
// GeckoTerminal rate-limit spell degrades the chart to slightly-old real data
// instead of a 502 and an empty panel. Never fabricated — only ever a payload
// an upstream really returned.
const _lastGood = new Map(); // `${mint}:${interval}` → { value, source, at }
const STALE_MAX_MS = 15 * 60_000;

function rememberGood(mint, interval, value, source) {
	_lastGood.set(`${mint}:${interval}`, { value, source, at: Date.now() });
	if (_lastGood.size > 256) _lastGood.delete(_lastGood.keys().next().value);
}

function recallGood(mint, interval) {
	const hit = _lastGood.get(`${mint}:${interval}`);
	if (!hit || Date.now() - hit.at > STALE_MAX_MS) return null;
	return hit;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const mint = (params.get('mint') || '').trim();
	if (!isPlausibleMint(mint)) {
		return error(res, 400, 'bad_mint', 'mint must be a base58 Solana address (32–44 chars)');
	}
	const interval = normalizeInterval(params.get('interval'));

	const nowSec = Math.floor(Date.now() / 1000);
	const rawTo = Math.min(nowSec, parseInt(params.get('to') || String(nowSec), 10) || nowSec);
	const defaultFrom = nowSec - 24 * 3600;
	let rawFrom = parseInt(params.get('from') || String(defaultFrom), 10);
	if (!Number.isFinite(rawFrom) || rawFrom <= 0 || rawFrom >= rawTo) rawFrom = defaultFrom;
	if (rawTo - rawFrom > 30 * 86400) rawFrom = rawTo - 30 * 86400;

	// Snap to the candle boundary so consecutive polls share one cache entry.
	const { from, to } = snapWindow({ interval, from: rawFrom, to: rawTo });

	const key = `${mint}:${interval}:${from}:${to}`;
	const now = Date.now();
	const hit = _cache.get(key);
	if (hit && hit.expiresAt > now) {
		return json(
			res,
			200,
			{ data: hit.value, source: hit.source },
			{ 'cache-control': 'public, max-age=15, s-maxage=30' },
		);
	}

	// ── Attempt 1: Birdeye ─────────────────────────────────────────────────────
	if (birdeyeConfigured()) {
		try {
			const data = await fetchBirdeyeOhlcv({ mint, interval, from, to });
			_cache.set(key, { value: data, source: 'birdeye', expiresAt: now + TTL_MS });
			if (_cache.size > 256) _cache.delete(_cache.keys().next().value);
			rememberGood(mint, interval, data, 'birdeye');
			return json(res, 200, { data, source: 'birdeye' }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
		} catch {
			// Fall through to GeckoTerminal.
		}
	}

	// ── Attempt 2: GeckoTerminal (free, no API key) ───────────────────────────
	try {
		const data = await fetchGeckoOhlcv({ mint, interval, from, to });
		_cache.set(key, { value: data, source: 'gecko', expiresAt: now + TTL_MS });
		if (_cache.size > 256) _cache.delete(_cache.keys().next().value);
		rememberGood(mint, interval, data, 'gecko');
		return json(res, 200, { data, source: 'gecko' }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
	} catch (err) {
		// A token with no market has nothing to chart — say so plainly. This is a
		// designed empty state, not an outage, so it is never served from stale.
		if (err instanceof NoPoolError) {
			return error(res, 404, 'no_market', 'No liquidity pool exists for this coin yet, so it has no price history.');
		}
		// Both live sources exhausted — fall through to the stale tier.
	}

	// ── Attempt 3: the last real candles we hold ───────────────────────────────
	const stale = recallGood(mint, interval);
	if (stale) {
		return json(
			res,
			200,
			{ data: stale.value, source: stale.source, stale: true, as_of: Math.floor(stale.at / 1000) },
			{ 'cache-control': 'public, max-age=10, s-maxage=10' },
		);
	}

	return error(res, 502, 'upstream_error', 'Price history is unavailable for this coin right now');
});
