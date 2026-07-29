// Per-coin failover for the /coin/:id detail page — profile, exchange listings
// and price series.
//
// api/_lib/market-fallbacks.js already covers the LIST-level reads (global
// stats, the ranked table, spot price for the headline assets). The per-coin
// reads stayed single-source CoinGecko, which is why /api/coin/detail,
// /api/coin/tickers and /api/coin/ohlc all 502'd together for hours on
// 2026-07-28: nothing behind them to answer when CoinGecko says no. Removing
// the exhausted demo key stopped the self-inflicted half of that, but the
// keyless public tier is shared per egress IP and Cloud Run's is busy, so the
// throttle recurs on its own. A dead page is not an acceptable response to a
// third-party rate limit.
//
// Sources (all keyless and free, verified live 2026-07-29):
//   CoinPaprika  api.coinpaprika.com  — coin profile + exchange markets
//   DefiLlama    coins.llama.fi       — price series, keyed by CoinGecko id
//
// DefiLlama is the reason the chart fallback is universal rather than
// majors-only: its coins oracle is addressed as `coingecko:<id>`, so no id
// mapping is needed and every coin CoinGecko charts, DefiLlama charts too.
// CoinPaprika uses its own `<symbol>-<name-slug>` ids, so this module resolves
// and caches that mapping — strictly, because serving the WRONG coin's profile
// is worse than serving an error.
//
// Every function here returns the exact shape its CoinGecko-backed caller
// already emits, so the page renders identically no matter which source
// answered. Fields a fallback cannot supply are null/[] — the page already
// degrades gracefully on those (it hides empty sections).

import { fetchFirst, fetchFirstOrNull } from '../../src/shared/failover-fetch.js';
import { cacheGet, cacheSet } from './cache.js';

const PAPRIKA_BASE = 'https://api.coinpaprika.com/v1';
const LLAMA_COINS_BASE = 'https://coins.llama.fi';

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const pos = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};

// ── CoinGecko id → CoinPaprika id ────────────────────────────────────────────
// CoinPaprika ids are `<symbol>-<name-slug>`: bitcoin → btc-bitcoin, solana →
// sol-solana. The slug half is CoinGecko's id for the overwhelming majority of
// listed coins, which makes /v1/search a reliable resolver — but only with a
// strict match. A loose "first result wins" would answer a request for one coin
// with another coin's market cap, and silently wrong data is worse than a 502.

/** Lowercase alphanumeric slug, runs of anything else collapsed to one hyphen. */
export function slugify(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Does this CoinPaprika search hit certainly refer to the CoinGecko id asked
 * for? Accepts only two unambiguous signals: the paprika id's slug half equals
 * the CoinGecko id, or the coin's name slugifies to it. Anything else is a
 * miss.
 * @param {{id?: string, name?: string}} entry  one /v1/search currencies row
 * @param {string} cgId                         CoinGecko coin id
 */
export function paprikaEntryMatches(entry, cgId) {
	const pid = str(entry?.id)?.toLowerCase();
	if (!pid || !cgId) return false;
	const dash = pid.indexOf('-');
	const slug = dash === -1 ? pid : pid.slice(dash + 1);
	return slug === cgId || slugify(entry?.name) === cgId;
}

/**
 * Best CoinPaprika id for a CoinGecko id from a /v1/search payload, or null.
 * Among strict matches, prefer an active coin, then the better market rank
 * (rank 0 means unranked upstream and sorts last).
 * @param {{currencies?: object[]}} raw
 * @param {string} cgId
 */
export function pickPaprikaId(raw, cgId) {
	const matches = (raw?.currencies || []).filter((c) => paprikaEntryMatches(c, cgId));
	if (!matches.length) return null;
	const rank = (c) => (num(c.rank) && num(c.rank) > 0 ? num(c.rank) : Number.MAX_SAFE_INTEGER);
	matches.sort((a, b) => Number(b.is_active !== false) - Number(a.is_active !== false) || rank(a) - rank(b));
	return str(matches[0].id);
}

// The mapping is immutable in practice (a coin's ids don't change), so cache it
// hard: in-memory for the instance and in the shared cache for the fleet. A
// negative result is cached too, briefly — a coin CoinPaprika doesn't list
// shouldn't cost a search round-trip on every request during a CoinGecko
// outage, which is exactly when the fallback path is hot.
const ID_TTL_S = 7 * 86_400;
const ID_MISS_TTL_S = 3600;
const _idMemo = new Map();
const idKey = (cgId) => `paprika:id:${cgId}`;

/**
 * Resolve a CoinGecko coin id to a CoinPaprika coin id, or null when
 * CoinPaprika doesn't list it (or is itself unreachable).
 * @param {string} cgId
 * @returns {Promise<string|null>}
 */
export async function resolvePaprikaId(cgId) {
	const id = String(cgId || '').trim().toLowerCase();
	if (!id) return null;
	if (_idMemo.has(id)) return _idMemo.get(id);
	const cached = await cacheGet(idKey(id)).catch(() => null);
	// '' is the cached negative; a real id is a non-empty string.
	if (typeof cached === 'string') {
		const resolved = cached || null;
		_idMemo.set(id, resolved);
		return resolved;
	}
	const raw = await fetchFirstOrNull(
		[
			{
				name: 'coinpaprika-search',
				url: `${PAPRIKA_BASE}/search/?q=${encodeURIComponent(id)}&c=currencies&limit=20`,
				parse: async (r) => (await r.json()) ?? null,
			},
		],
		{ timeoutMs: 6000, label: `paprika-id:${id}` },
	);
	// Unreachable upstream: don't poison the cache with a negative that would
	// outlive the outage. Only a real answer (hit or genuine miss) is stored.
	if (!raw) return null;
	const pid = pickPaprikaId(raw, id);
	_idMemo.set(id, pid);
	if (_idMemo.size > 2000) _idMemo.clear();
	cacheSet(idKey(id), pid || '', pid ? ID_TTL_S : ID_MISS_TTL_S).catch(() => {});
	return pid;
}

/** Test-only hook: drop the in-memory id memo. */
export function resetPaprikaIdMemo() {
	_idMemo.clear();
}

// ── Coin profile ─────────────────────────────────────────────────────────────
// Normalized to the exact object api/coin/detail.js `shape()` emits.

// links_extended carries the social handles AND their follower counts, which is
// the only place CoinPaprika exposes community stats.
function extendedLinks(coin) {
	const out = new Map();
	for (const link of coin?.links_extended || []) {
		const type = str(link?.type);
		if (type && !out.has(type)) out.set(type, link);
	}
	return out;
}

/** Last non-empty path segment of a URL — the handle in a socials link. */
function handleFromUrl(url) {
	const u = str(url);
	if (!u) return null;
	const path = u.split('?')[0].split('#')[0].replace(/\/+$/, '');
	const seg = path.split('/').pop();
	return seg && !/^https?:$/i.test(seg) && !seg.includes('.') ? seg : null;
}

/**
 * CoinPaprika /v1/coins/:id + /v1/tickers/:id → the /api/coin/detail shape.
 * Both payloads are required: the first carries identity and links, the second
 * the market numbers.
 * @param {object} coin    /v1/coins/:id payload
 * @param {object} ticker  /v1/tickers/:id?quotes=USD payload
 * @param {string} cgId    CoinGecko id to report, so page links stay stable
 */
export function normalizePaprikaDetail(coin, ticker, cgId) {
	if (!coin || typeof coin !== 'object' || !ticker || typeof ticker !== 'object') return null;
	const q = ticker.quotes?.USD;
	if (!q || typeof q !== 'object') return null;
	const price = num(q.price);
	if (price == null) return null; // no headline number → treat as a miss

	const ext = extendedLinks(coin);
	const links = coin.links || {};
	const explorers = (links.explorer || []).filter((u) => str(u)).slice(0, 3);
	const repos = (links.source_code || []).filter((u) => str(u)).slice(0, 3);
	const reddit = ext.get('reddit');
	const twitter = ext.get('twitter');
	const telegram = ext.get('telegram');
	const mcap = num(q.market_cap);

	const community = {
		twitter_followers: num(twitter?.stats?.followers),
		reddit_subscribers: num(reddit?.stats?.subscribers),
		telegram_users: num(telegram?.stats?.members),
	};
	const hasCommunity = Object.values(community).some((v) => v != null && v !== 0);

	return {
		id: cgId,
		symbol: str(coin.symbol)?.toUpperCase() ?? null,
		name: str(coin.name) ?? cgId,
		image: str(coin.logo),
		rank: num(coin.rank) || null,
		categories: (coin.tags || []).map((t) => str(t?.name)).filter(Boolean).slice(0, 6),
		description: str(coin.description)?.slice(0, 3000) ?? '',
		links: {
			homepage: str(links.website?.[0]),
			twitter: handleFromUrl(twitter?.url),
			reddit: str(reddit?.url) || str(links.reddit?.[0]),
			telegram: handleFromUrl(telegram?.url),
			github: str(repos[0]),
			whitepaper: str(coin.whitepaper?.link),
			forum: null,
			chat: null,
			announcement: null,
			repos,
			explorers,
		},
		// CoinPaprika exposes per-chain contract addresses only on search rows,
		// not on the coin object; the page hides the section when it's empty.
		platforms: {},
		market: {
			price,
			market_cap: mcap,
			// No FDV in this feed — deriving it from max_supply × price would be a
			// different number than CoinGecko's, so report absence honestly.
			fdv: null,
			volume_24h: num(q.volume_24h),
			high_24h: null,
			low_24h: null,
			change_24h_abs: null,
			change_pct: {
				h1: num(q.percent_change_1h),
				h24: num(q.percent_change_24h),
				d7: num(q.percent_change_7d),
				d14: null,
				d30: num(q.percent_change_30d),
				d60: null,
				d200: null,
				y1: num(q.percent_change_1y),
			},
			mcap_change_24h_pct: num(q.market_cap_change_24h),
			circulating: num(ticker.circulating_supply),
			total: num(ticker.total_supply),
			max: num(ticker.max_supply),
			ath: num(q.ath_price),
			ath_date: str(q.ath_date),
			ath_change_pct: num(q.percent_from_price_ath),
			atl: null,
			atl_date: null,
		},
		sentiment: { up_pct: null, down_pct: null, watchlist_users: null },
		meta: {
			genesis_date: str(coin.started_at)?.slice(0, 10) ?? null,
			hashing_algorithm: str(coin.hash_algorithm),
			block_time_minutes: null,
			country_origin: null,
		},
		// No developer stats in this feed; the page hides the block on null.
		developer: null,
		community: hasCommunity ? community : null,
		last_updated: str(ticker.last_updated),
	};
}

/**
 * Coin profile from CoinPaprika, in the /api/coin/detail shape. Returns null
 * when CoinPaprika doesn't list the coin or is unreachable — the caller then
 * surfaces CoinGecko's original error rather than inventing one.
 * @param {string} cgId  CoinGecko coin id
 * @returns {Promise<object|null>}
 */
export async function fetchFallbackCoinDetail(cgId) {
	const pid = await resolvePaprikaId(cgId);
	if (!pid) return null;
	const [coin, ticker] = await Promise.all([
		fetchFirstOrNull([{ name: 'coinpaprika-coin', url: `${PAPRIKA_BASE}/coins/${pid}` }], {
			timeoutMs: 8000,
			label: `paprika-coin:${pid}`,
		}),
		fetchFirstOrNull([{ name: 'coinpaprika-ticker', url: `${PAPRIKA_BASE}/tickers/${pid}?quotes=USD` }], {
			timeoutMs: 8000,
			label: `paprika-ticker:${pid}`,
		}),
	]);
	return normalizePaprikaDetail(coin, ticker, cgId);
}

// ── Exchange listings ────────────────────────────────────────────────────────
// Normalized to the row shape api/coin/tickers.js `shapeTicker()` emits.

// CoinPaprika grades a market high/medium/low; the page's badge speaks
// CoinGecko's green/yellow/red.
const TRUST_MAP = { high: 'green', medium: 'yellow', low: 'red' };

/** One CoinPaprika /coins/:id/markets row → one /api/coin/tickers row. */
export function normalizePaprikaMarket(m) {
	const q = m?.quotes?.USD;
	const [rawBase, rawTarget] = String(m?.pair || '').split('/');
	const base = str(rawBase)?.toUpperCase() ?? null;
	const target = str(rawTarget)?.toUpperCase() ?? null;
	const url = str(m?.market_url);
	return {
		exchange: {
			id: str(m?.exchange_id),
			name: str(m?.exchange_name),
			// CoinPaprika serves no exchange logos; the table falls back to a
			// lettermark when this is null.
			logo: null,
		},
		base,
		target,
		pair: base && target ? `${base}/${target}` : str(m?.pair),
		price_usd: num(q?.price),
		volume_usd: num(q?.volume_24h),
		// Neither spread nor ±2% order-book depth is in this feed.
		spread_pct: null,
		depth_up_usd: null,
		depth_down_usd: null,
		trust: TRUST_MAP[str(m?.trust_score)?.toLowerCase()] ?? null,
		// `outlier` is CoinPaprika's flag for a price far off the consensus —
		// the same warning CoinGecko's is_anomaly/is_stale drives.
		stale: Boolean(m?.outlier),
		trade_url: url && /^https?:\/\//i.test(url) ? url : null,
		coin_id: str(m?.base_currency_id),
		target_coin_id: str(m?.quote_currency_id),
		last_traded: str(m?.last_updated),
	};
}

/**
 * Exchange listings from CoinPaprika, in the /api/coin/tickers shape, ordered
 * by 24h USD volume like the CoinGecko query they stand in for. CoinPaprika
 * returns every market in one response, so pagination is applied here.
 * @param {string} cgId
 * @param {{page?: number, perPage?: number}} [opts]
 * @returns {Promise<object[]|null>} null when unavailable
 */
export async function fetchFallbackTickers(cgId, { page = 1, perPage = 100 } = {}) {
	const pid = await resolvePaprikaId(cgId);
	if (!pid) return null;
	const raw = await fetchFirstOrNull(
		[
			{
				name: 'coinpaprika-markets',
				url: `${PAPRIKA_BASE}/coins/${pid}/markets?quotes=USD`,
				parse: async (r) => {
					const body = await r.json();
					return Array.isArray(body) && body.length ? body : null;
				},
			},
		],
		{ timeoutMs: 10_000, label: `paprika-markets:${pid}` },
	);
	if (!raw) return null;
	const rows = raw
		.map(normalizePaprikaMarket)
		.filter((t) => t.exchange.name && t.price_usd != null)
		.sort((a, b) => (b.volume_usd ?? 0) - (a.volume_usd ?? 0));
	const start = (Math.max(1, page) - 1) * perPage;
	return rows.slice(start, start + perPage);
}

// ── Price series ─────────────────────────────────────────────────────────────
// DefiLlama's coins oracle is addressed by CoinGecko id (`coingecko:<id>`), so
// this backs the chart for EVERY coin, not just the majors that
// market-fallbacks.js `fetchExchangeChart` can map to an exchange pair.
// Granularity per window mirrors what CoinGecko returns for the same window,
// so the rendered line has comparable density either way.
const LLAMA_WINDOW = {
	1: { period: '15m', span: 96 },
	7: { period: '2h', span: 84 },
	30: { period: '1d', span: 30 },
	90: { period: '1d', span: 90 },
	365: { period: '1d', span: 365 },
};

/**
 * DefiLlama /chart payload → [[timestamp_ms, price], …] oldest-first.
 * @param {object} raw
 * @param {string} cgId
 */
export function normalizeLlamaChart(raw, cgId) {
	const series = raw?.coins?.[`coingecko:${cgId}`]?.prices;
	if (!Array.isArray(series)) return null;
	const out = series
		.map((p) => [Number(p?.timestamp) * 1000, pos(p?.price)])
		.filter(([t, price]) => Number.isFinite(t) && t > 0 && price != null)
		.sort((a, b) => a[0] - b[0]);
	// A single point draws no line; treat it as no data so the caller can keep
	// looking rather than render a degenerate chart.
	return out.length > 1 ? out : null;
}

/**
 * Price series for any CoinGecko id from DefiLlama. Never throws: it only runs
 * after CoinGecko already failed, and the caller wants that original error if
 * this misses too.
 * @param {string} cgId
 * @param {number} days  1 | 7 | 30 | 90 | 365
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {Promise<Array<[number, number]>|null>}
 */
export async function fetchLlamaChart(cgId, days, now = Date.now()) {
	const win = LLAMA_WINDOW[days];
	if (!win || !cgId) return null;
	const start = Math.floor(now / 1000) - days * 86_400;
	try {
		const { value } = await fetchFirst(
			[
				{
					name: 'llama-chart',
					url:
						`${LLAMA_COINS_BASE}/chart/coingecko:${encodeURIComponent(cgId)}` +
						`?start=${start}&span=${win.span}&period=${win.period}&searchWidth=600`,
					parse: async (r) => normalizeLlamaChart(await r.json(), cgId),
				},
			],
			{ timeoutMs: 10_000, label: `llama-chart:${cgId}` },
		);
		return value;
	} catch {
		return null;
	}
}
