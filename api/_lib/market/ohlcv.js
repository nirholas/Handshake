// Keyless on-chain OHLCV source for the Granite Oracle, backed by the public
// GeckoTerminal API (https://www.geckoterminal.com/dex-api). No API key, real
// candles, deep history (up to 1000 points) — enough to fill the ≥512-point
// context window the Granite TimeSeries forecaster requires.
//
// Never fabricates candles: any upstream failure throws with the real status so
// the caller surfaces the true cause.

import { createCache } from '../mem-cache.js';

const BASE = 'https://api.geckoterminal.com/api/v2';
const UA = 'three.ws-granite-oracle/1.0';

// Small in-memory cache — GeckoTerminal's free tier is ~30 req/min and candle
// data only changes once per bar, so a short TTL keeps us well under the cap.
// True LRU bounding: the previous Map was trimmed with
// `delete(keys().next().value)`, evicting the oldest INSERTED url rather than
// the least recently used one.
const cache = createCache({ max: 256 }); // url → { value, expiresAt }
const TTL_MS = 20_000;

// Bounded exponential backoff with jitter for transient upstream throttling.
// GeckoTerminal's free tier (~30 req/min) bursts into 429s and occasional 5xx;
// a couple of short, jittered waits clear most of them. Bounded so the total
// added latency (≈0.4s + ≈0.8s worst case, ~1.8s with jitter) never approaches
// the function time budget. 404 and other client errors are NOT retried.
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 1200;
const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// attempt is 0-based: delay grows 400ms, 800ms, … capped, with ±50% jitter so a
// fleet of lambdas throttled together don't all retry on the same beat.
function backoffMs(attempt) {
	const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
	return Math.round(exp * (0.5 + Math.random() * 0.5));
}

async function gecko(path) {
	const url = `${BASE}${path}`;
	const now = Date.now();
	const hit = cache.get(url);
	if (hit && hit.expiresAt > now) return hit.value;

	// Retry transient throttles (429/5xx) with bounded jittered backoff before
	// giving up. Preserves the real status (esp. 429) on the thrown error so the
	// caller maps it to a retryable response instead of a generic 502/500.
	let res;
	let lastStatus = 502;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			res = await fetch(url, {
				headers: { accept: 'application/json', 'user-agent': UA },
				signal: AbortSignal.timeout(12_000),
			});
		} catch (e) {
			throw Object.assign(new Error(`GeckoTerminal unreachable: ${e.message}`), {
				status: 502,
			});
		}
		if (res.ok) break;
		lastStatus = res.status;
		const text = await res.text();
		if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
			await sleep(backoffMs(attempt));
			continue; // retry with backoff
		}
		throw Object.assign(new Error(`GeckoTerminal ${res.status}: ${text.slice(0, 160)}`), {
			status: res.status === 404 ? 404 : res.status === 429 ? 429 : 502,
		});
	}
	if (!res || !res.ok) {
		throw Object.assign(new Error(`GeckoTerminal ${lastStatus}`), {
			status: lastStatus === 404 ? 404 : lastStatus === 429 ? 429 : 502,
		});
	}
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw Object.assign(new Error('GeckoTerminal returned non-JSON'), { status: 502 });
	}
	cache.set(url, { value: json, expiresAt: now + TTL_MS });
	return json;
}

// Strip GeckoTerminal's "network_" id prefix (e.g. "solana_<addr>" → "<addr>").
function bareId(id) {
	if (typeof id !== 'string') return '';
	const i = id.indexOf('_');
	return i >= 0 ? id.slice(i + 1) : id;
}

// pandas-style cadence string the forecast API expects, from a GeckoTerminal
// timeframe + aggregate (e.g. hour/1 → "1h", minute/15 → "15min", day/1 → "1D").
export function freqFor(timeframe, aggregate = 1) {
	const n = Math.max(1, Number(aggregate) || 1);
	if (timeframe === 'minute') return `${n}min`;
	if (timeframe === 'day') return `${n}D`;
	return `${n}h`; // hour
}

// Top (most-liquid) pool for a Solana token mint. Returns the pool address.
export async function topPoolForToken(mint, network = 'solana') {
	const json = await gecko(`/networks/${network}/tokens/${mint}/pools?page=1`);
	const pool = json?.data?.[0];
	if (!pool) throw Object.assign(new Error(`no pools found for token ${mint}`), { status: 404 });
	return pool.attributes?.address || bareId(pool.id);
}

// Trending Solana pools, normalised for the on-screen picker.
export async function trendingPools(network = 'solana', limit = 8) {
	const json = await gecko(`/networks/${network}/trending_pools?page=1`);
	return (json?.data || []).slice(0, limit).map((p) => {
		const a = p.attributes || {};
		return {
			pool: a.address || bareId(p.id),
			name: a.name || 'Unknown',
			baseMint: bareId(p.relationships?.base_token?.data?.id),
			priceUsd: a.base_token_price_usd != null ? Number(a.base_token_price_usd) : null,
			change24h:
				a.price_change_percentage?.h24 != null
					? Number(a.price_change_percentage.h24)
					: null,
		};
	});
}

// Fetch OHLCV candles for a pool, returned oldest → newest (chronological), plus
// the base/quote token metadata GeckoTerminal includes in the same response.
//   timeframe: 'minute' | 'hour' | 'day'   aggregate: bars per candle   limit: ≤1000
export async function fetchOhlcv({
	pool,
	network = 'solana',
	timeframe = 'hour',
	aggregate = 1,
	limit = 1000,
}) {
	if (!pool) throw Object.assign(new Error('pool is required'), { status: 400 });
	const json = await gecko(
		`/networks/${network}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`,
	);
	const list = json?.data?.attributes?.ohlcv_list;
	if (!Array.isArray(list)) {
		throw Object.assign(new Error('GeckoTerminal returned no candles'), { status: 502 });
	}
	// Upstream is newest-first; reverse to chronological and coerce to numbers.
	const candles = list
		.map((row) => ({
			t: Number(row[0]),
			o: Number(row[1]),
			h: Number(row[2]),
			l: Number(row[3]),
			c: Number(row[4]),
			v: Number(row[5] ?? 0),
		}))
		.filter((d) => Number.isFinite(d.t) && Number.isFinite(d.c) && d.c > 0)
		.sort((a, b) => a.t - b.t);

	const meta = json?.meta || {};
	const tokenOf = (m) => (m ? { name: m.name, symbol: m.symbol, address: m.address } : null);

	return {
		candles,
		base: tokenOf(meta.base),
		quote: tokenOf(meta.quote),
		freq: freqFor(timeframe, aggregate),
		timeframe,
		aggregate,
	};
}
