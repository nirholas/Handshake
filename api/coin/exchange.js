// GET /api/coin/exchange?id=<slug>[&days=7|14|30|90|180|365][&view=chart]
// ---------------------------------------------------------------------------
// Rich profile for one exchange — powers the /exchange/:id detail page.
// Proxies CoinGecko `/exchanges/{id}` (profile + first 50 spot tickers) plus
// `/exchanges/{id}/volume_chart` for the BTC-denominated volume history, and
// converts to USD with the live BTC price (same /simple/price feed as
// api/coin/exchanges.js). When the id is a derivatives venue — CoinGecko keeps
// those on a separate namespace — the spot lookup 404s and we fall back to
// `/derivatives/exchanges/{id}` (open interest, perp/futures counts, contract
// tickers; no volume chart exists upstream for these). `?view=chart&days=N`
// returns only { volume_chart, btc_usd } so the page's range toggle is a light
// refetch. Descriptions are sanitized to plain text server-side. Cached
// in-memory via geckoFetch + CDN s-maxage.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch, htmlToText } from '../_lib/coingecko.js';
import { fetchCoinPriceUsdOrNull } from '../_lib/market-fallbacks.js';

const ID_RE = /^[a-z0-9_-]{1,60}$/i;
const DAYS = new Set([1, 7, 14, 30, 90, 180, 365]);
const DETAIL_TTL_MS = 300_000;
const CHART_TTL_MS = 120_000;

// Coerces both numbers and CoinGecko's numeric strings (the derivatives
// endpoints and volume_chart return volumes as strings).
const num = (v) => {
	if (v == null || v === '') return null;
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : null);

// DEX tickers use raw contract addresses as base/target symbols — a 40-char
// hex string wrecks the pair column, so truncate anything address-length.
const truncSymbol = (s) => {
	const v = String(s ?? '');
	return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
};

function shapeSpotTicker(t) {
	return {
		base: str(t.base),
		target: str(t.target),
		pair: `${truncSymbol(t.base)}/${truncSymbol(t.target)}`,
		coin_id: str(t.coin_id),
		target_coin_id: str(t.target_coin_id),
		price_usd: num(t.converted_last?.usd),
		volume_usd: num(t.converted_volume?.usd),
		spread_pct: num(t.bid_ask_spread_percentage),
		trust: str(t.trust_score), // 'green' | 'yellow' | 'red' | null
		stale: !!(t.is_stale || t.is_anomaly),
		trade_url: httpUrl(t.trade_url),
	};
}

function shapeDerivativeTicker(t) {
	return {
		symbol: str(t.symbol),
		price: num(t.last),
		index: num(t.index),
		funding_rate: num(t.funding_rate),
		open_interest_usd: num(t.open_interest_usd),
		volume_24h_usd: num(t.converted_volume?.usd),
		spread: num(t.bid_ask_spread), // ratio, not percent
		expired_at: t.expired_at ?? null,
		trade_url: httpUrl(t.trade_url),
	};
}

function shapeSocials(d) {
	const other = [d.other_url_1, d.other_url_2, d.slack_url]
		.map(httpUrl)
		.filter(Boolean);
	return {
		twitter: str(d.twitter_handle),
		reddit_url: httpUrl(d.reddit_url),
		telegram_url: httpUrl(d.telegram_url),
		facebook_url: httpUrl(d.facebook_url),
		other_urls: other,
	};
}

// CoinGecko's `/exchanges/{id}` detail payload omits the normalized 24h volume
// (only the ranked list carries it), so it is enriched best-effort from the
// same `/exchanges` list the /exchanges page uses — shared geckoFetch cache,
// null when the venue sits outside the top 100.
function shapeSpotDetail(id, d, normalized) {
	const tickers = Array.isArray(d.tickers) ? d.tickers : [];
	return {
		type: 'spot',
		id,
		name: str(d.name) || id,
		image: httpUrl(d.image),
		year_established: num(d.year_established),
		country: str(d.country),
		description: htmlToText(d.description || '').slice(0, 2000),
		url: httpUrl(d.url),
		centralized: typeof d.centralized === 'boolean' ? d.centralized : null,
		trust_score: num(d.trust_score),
		trust_score_rank: num(d.trust_score_rank),
		trade_volume_24h_btc: num(d.trade_volume_24h_btc),
		trade_volume_24h_btc_normalized: normalized,
		socials: shapeSocials(d),
		tickers_count: tickers.length,
		tickers: tickers.slice(0, 50).map(shapeSpotTicker),
	};
}

function shapeDerivativesDetail(id, d) {
	const tickers = Array.isArray(d.tickers) ? d.tickers : [];
	return {
		type: 'derivatives',
		id,
		name: str(d.name) || id,
		image: httpUrl(d.image),
		year_established: num(d.year_established),
		country: str(d.country),
		description: htmlToText(d.description || '').slice(0, 2000),
		url: httpUrl(d.url),
		centralized: null, // upstream doesn't say for derivatives venues
		trust_score: null,
		trust_score_rank: null,
		trade_volume_24h_btc: num(d.trade_volume_24h_btc),
		trade_volume_24h_btc_normalized: null,
		open_interest_btc: num(d.open_interest_btc),
		number_of_perpetual_pairs: num(d.number_of_perpetual_pairs),
		number_of_futures_pairs: num(d.number_of_futures_pairs),
		socials: shapeSocials(d),
		tickers_count: tickers.length,
		tickers: tickers.slice(0, 50).map(shapeDerivativeTicker),
	};
}

// Upstream volume points arrive as [ts_ms, "13421.896…"] — strings.
function shapeVolumeChart(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((p) => [Number(p?.[0]), Number.parseFloat(p?.[1])])
		.filter(([ts, v]) => Number.isFinite(ts) && Number.isFinite(v));
}

// CoinGecko → DefiLlama failover (see api/_lib/market-fallbacks.js); best-effort
// — the client falls back to BTC-only figures if every source is down.
const fetchBtcUsd = () => fetchCoinPriceUsdOrNull('bitcoin');

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const id = (params.get('id') || '').trim().toLowerCase();
	if (!ID_RE.test(id)) {
		return error(res, 400, 'bad_id', 'id must be a CoinGecko exchange id (1–60 chars: letters, digits, _ or -)');
	}
	const daysRaw = Number(params.get('days') || 30);
	const days = DAYS.has(daysRaw) ? daysRaw : 30;
	const view = (params.get('view') || '').trim().toLowerCase();

	const headers = {
		'cache-control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
	};

	// Light refetch for the chart range toggle — no profile, no tickers.
	if (view === 'chart') {
		try {
			const [raw, btcUsd] = await Promise.all([
				geckoFetch(`/exchanges/${id}/volume_chart?days=${days}`, { ttlMs: CHART_TTL_MS }),
				fetchBtcUsd(),
			]);
			return json(res, 200, { volume_chart: shapeVolumeChart(raw), btc_usd: btcUsd }, headers);
		} catch (err) {
			if (err?.status === 404) {
				return error(res, 404, 'not_found', `no volume chart for exchange "${id}"`);
			}
			return error(res, 502, 'upstream_error', 'exchange data is unavailable right now — retry shortly');
		}
	}

	const [detailRes, chartRes, priceRes, listRes] = await Promise.allSettled([
		geckoFetch(`/exchanges/${id}`, { ttlMs: DETAIL_TTL_MS }),
		geckoFetch(`/exchanges/${id}/volume_chart?days=${days}`, { ttlMs: CHART_TTL_MS }),
		fetchBtcUsd(),
		geckoFetch('/exchanges?per_page=100&page=1', { ttlMs: 300_000 }),
	]);
	const btcUsd = priceRes.status === 'fulfilled' ? priceRes.value : null;

	if (detailRes.status === 'fulfilled') {
		const list = listRes.status === 'fulfilled' && Array.isArray(listRes.value) ? listRes.value : [];
		const normalized = num(list.find((e) => e?.id === id)?.trade_volume_24h_btc_normalized);
		return json(res, 200, {
			detail: shapeSpotDetail(id, detailRes.value, normalized),
			volume_chart: chartRes.status === 'fulfilled' ? shapeVolumeChart(chartRes.value) : [],
			btc_usd: btcUsd,
			updated_at: Date.now(),
		}, headers);
	}

	if (detailRes.reason?.status !== 404) {
		return error(res, 502, 'upstream_error', 'exchange data is unavailable right now — retry shortly');
	}

	// Spot lookup 404'd — derivatives venues live on a separate CG namespace.
	try {
		const raw = await geckoFetch(`/derivatives/exchanges/${id}?include_tickers=unexpired`, {
			ttlMs: DETAIL_TTL_MS,
		});
		return json(res, 200, {
			detail: shapeDerivativesDetail(id, raw),
			volume_chart: null, // upstream has no volume history for derivatives venues
			btc_usd: btcUsd,
			updated_at: Date.now(),
		}, headers);
	} catch (err) {
		if (err?.status === 404) {
			return error(res, 404, 'not_found', `no exchange found for "${id}"`);
		}
		return error(res, 502, 'upstream_error', 'exchange data is unavailable right now — retry shortly');
	}
});
