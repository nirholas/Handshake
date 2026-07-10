// GET /api/news/archive
// ---------------------------------------------------------------------------
// The three.ws historical crypto-news archive: 662,047 enriched articles from
// September 2017 onward (CryptoPanic english corpus + Odaily chinese corpus +
// the cryptocurrency.cv live archiver), recovered from the cryptocurrency.cv
// archive and hosted on the platform's own GCS bucket
// (gs://three-ws-news-archive). Largest open crypto-news dataset anywhere;
// every record carries tickers, tags, sentiment, language, and (where
// captured) market context at publication time.
//
// The imported corpus ends 2025-12-03; api/cron/news-archive-append.js extends
// it hourly from the live feed. Never hardcode the end date here — read
// meta/stats.json (last_article_date), which the appender keeps current.
//
// Data layout (public bucket, gzip at rest, transparently decoded):
//   articles/YYYY-MM.jsonl   one enriched article per line
//   meta/stats.json          corpus-wide statistics
//   indexes/by-{date,source,ticker}.json
//
// Modes:
//   ?stats=true              corpus statistics + available month range (free)
//   ?months=true             list of queryable months (free)
//   ?trending=true           top tickers over the newest archived weeks (free)
//   default                  query mode — free daily quota, then x402
//
// Access model (freemium, same shape as api/v1/ai/tts.js):
//   • stats/months/trending are cached + tiny → always free.
//   • Each SEARCH fans out to GCS month files (2–11 MB each, up to 12 per
//     request), so query mode carries a free per-IP daily quota
//     (limits.newsArchiveFreeIp — the funnel and the anti-scrape bound) and
//     falls through to an x402 402 challenge ($0.001 USDC per search,
//     env-overridable via X402_PRICE_NEWS_ARCHIVE) once exhausted. A request
//     arriving with an X-PAYMENT header goes straight to the paid rail.
//
// Query params (query mode):
//   q           full-text (title + description)
//   ticker      e.g. BTC — matches the enriched tickers field
//   source      source_key or source name substring
//   category    enriched category
//   sentiment   positive | negative | neutral
//   lang        en | zh
//   start_date / end_date    YYYY-MM-DD, bounds the month window
//   limit       1–100 (default 50), offset for pagination
//
// Serving model: newest-first month scan with early stop once the requested
// page is filled, capped at MAX_MONTHS_PER_SCAN months per request. Parsed
// months are LRU-cached in compact form so repeat queries are warm. The
// response always reports exactly which months were scanned so the UI can be
// honest about coverage ("narrow the date range to search older years").

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { priceFor } from '../_lib/x402-prices.js';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { declareHttpDiscovery, withService } from '../_lib/x402/bazaar-helpers.js';
import { installAccessControl } from '../_lib/x402/access-control.js';

const GCS_BASE = 'https://storage.googleapis.com/three-ws-news-archive';
const GCS_LIST =
	'https://storage.googleapis.com/storage/v1/b/three-ws-news-archive/o?prefix=articles/&fields=items(name)&maxResults=500';

const MAX_MONTHS_PER_SCAN = 12;
const MONTH_FETCH_CONCURRENCY = 3;
const MONTH_CACHE_MAX = 5;

const ROUTE = '/api/news/archive';
const PRICE_ATOMICS = priceFor('news-archive', '1000'); // $0.001/search (env: X402_PRICE_NEWS_ARCHIVE)
const FREE_SEARCHES_PER_DAY = 60; // keep in sync with limits.newsArchiveFreeIp

// month "YYYY-MM" → compact article records (newest month files are ~2–11 MB
// raw; compact form keeps only serving fields). LRU by Map insertion order.
const monthCache = new Map();
// small metadata caches: { value, expiresAt }
let statsCache = null;
let monthsCache = null;
const META_TTL_MS = 3600_000;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function httpErr(status, code, message) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	return e;
}

function compact(a) {
	return {
		id: a.id,
		title: a.title,
		link: str(a.link) || str(a.canonical_link),
		description: str(a.description) ? a.description.slice(0, 240) : null,
		source: a.source || a.source_key || 'unknown',
		source_key: a.source_key || 'unknown',
		category: a.category || 'general',
		pub_date: a.pub_date || a.first_seen || null,
		tickers: Array.isArray(a.tickers) ? a.tickers.slice(0, 8) : [],
		tags: Array.isArray(a.tags) ? a.tags.slice(0, 6) : [],
		sentiment: a.sentiment ? { label: a.sentiment.label, score: a.sentiment.score } : null,
		lang: a.meta?.language || 'en',
		is_breaking: !!a.meta?.is_breaking,
		market_context: a.market_context
			? {
					btc_price: a.market_context.btc_price ?? null,
					eth_price: a.market_context.eth_price ?? null,
					fear_greed_index: a.market_context.fear_greed_index ?? null,
				}
			: null,
	};
}

async function fetchJson(url, timeoutMs = 15_000) {
	const resp = await fetch(url, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!resp.ok) throw new Error(`archive upstream ${resp.status}`);
	return resp.json();
}

async function getStats() {
	if (statsCache && statsCache.expiresAt > Date.now()) return statsCache.value;
	const value = await fetchJson(`${GCS_BASE}/meta/stats.json`);
	statsCache = { value, expiresAt: Date.now() + META_TTL_MS };
	return value;
}

async function getMonths() {
	if (monthsCache && monthsCache.expiresAt > Date.now()) return monthsCache.value;
	const listing = await fetchJson(GCS_LIST);
	const value = (listing.items || [])
		.map((o) => {
			const m = /^articles\/(\d{4}-\d{2})\.jsonl$/.exec(o.name);
			return m ? m[1] : null;
		})
		.filter(Boolean)
		.sort(); // ascending YYYY-MM
	if (!value.length) throw new Error('archive month listing is empty');
	monthsCache = { value, expiresAt: Date.now() + META_TTL_MS };
	return value;
}

async function loadMonth(month) {
	if (monthCache.has(month)) {
		const records = monthCache.get(month);
		monthCache.delete(month);
		monthCache.set(month, records); // refresh LRU recency
		return records;
	}
	const resp = await fetch(`${GCS_BASE}/articles/${month}.jsonl`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!resp.ok) throw new Error(`month ${month} → ${resp.status}`);
	const text = await resp.text();
	const records = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			records.push(compact(JSON.parse(line)));
		} catch {
			// skip the malformed line, keep the month
		}
	}
	// newest-first inside the month so early-stop pagination is stable
	records.sort((a, b) => new Date(b.pub_date || 0) - new Date(a.pub_date || 0));
	monthCache.set(month, records);
	while (monthCache.size > MONTH_CACHE_MAX) {
		monthCache.delete(monthCache.keys().next().value);
	}
	return records;
}

function buildPredicate({ q, ticker, source, category, sentiment, lang, startDate, endDate }) {
	const needle = q ? q.toLowerCase() : null;
	const tickerUpper = ticker ? ticker.toUpperCase() : null;
	const sourceLower = source ? source.toLowerCase() : null;
	const startIso = startDate ? `${startDate}T00:00:00.000Z` : null;
	const endIso = endDate ? `${endDate}T23:59:59.999Z` : null;
	return (a) => {
		if (tickerUpper && !a.tickers.includes(tickerUpper)) return false;
		if (sourceLower && !a.source_key.toLowerCase().includes(sourceLower) && !a.source.toLowerCase().includes(sourceLower))
			return false;
		if (category && a.category !== category) return false;
		if (lang && a.lang !== lang) return false;
		if (sentiment) {
			const label = a.sentiment?.label || 'neutral';
			if (sentiment === 'positive' && !label.includes('positive')) return false;
			if (sentiment === 'negative' && !label.includes('negative')) return false;
			if (sentiment === 'neutral' && label !== 'neutral') return false;
		}
		if ((startIso || endIso) && !a.pub_date) return false;
		if (startIso && a.pub_date < startIso) return false;
		if (endIso && a.pub_date > endIso) return false;
		if (needle && !`${a.title} ${a.description || ''}`.toLowerCase().includes(needle)) return false;
		return true;
	};
}

// Parse + validate query-mode params. Throws httpErr(400, …) on bad input so
// both lanes reject it cleanly — genuinely bad input must be a 400, never a
// payment prompt.
function parseSearchParams(params) {
	const q = (params.get('q') || '').trim().slice(0, 120) || null;
	const ticker = (params.get('ticker') || '').trim().slice(0, 12) || null;
	const source = (params.get('source') || '').trim().slice(0, 40) || null;
	const category = (params.get('category') || '').trim().toLowerCase() || null;
	const sentiment = (params.get('sentiment') || '').trim().toLowerCase() || null;
	const lang = (params.get('lang') || '').trim().toLowerCase() || null;
	const startDate = (params.get('start_date') || '').trim() || null;
	const endDate = (params.get('end_date') || '').trim() || null;
	const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '50', 10) || 50), 100);
	const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);

	const dateRe = /^\d{4}-\d{2}-\d{2}$/;
	if (startDate && !dateRe.test(startDate)) throw httpErr(400, 'bad_date', 'start_date must be YYYY-MM-DD');
	if (endDate && !dateRe.test(endDate)) throw httpErr(400, 'bad_date', 'end_date must be YYYY-MM-DD');
	if (startDate && endDate && startDate > endDate)
		throw httpErr(400, 'bad_range', 'start_date is after end_date');
	if (sentiment && !['positive', 'negative', 'neutral'].includes(sentiment))
		throw httpErr(400, 'bad_sentiment', 'sentiment must be positive, negative, or neutral');
	if (lang && !['en', 'zh'].includes(lang)) throw httpErr(400, 'bad_lang', 'lang must be en or zh');

	return { q, ticker, source, category, sentiment, lang, startDate, endDate, limit, offset };
}

// Run one archive search (the expensive month scan) and return the response
// body. Shared verbatim by the free lane and the paid rail so both tiers serve
// the SAME engine — the only difference is who paid for the scan.
async function archiveSearch(parsed) {
	const { q, ticker, source, category, sentiment, lang, startDate, endDate, limit, offset } = parsed;
	try {
		const allMonths = await getMonths();
		let window = allMonths;
		if (startDate) window = window.filter((m) => m >= startDate.slice(0, 7));
		if (endDate) window = window.filter((m) => m <= endDate.slice(0, 7));
		if (!window.length) {
			return {
				articles: [], total_scanned_matches: 0, limit, offset,
				has_more: false,
				scanned: { months: [], complete: true },
				hint: 'no archive months inside that date range',
			};
		}
		// newest → oldest
		window = [...window].reverse();

		const matches = buildPredicate({ q, ticker, source, category, sentiment, lang, startDate, endDate });
		const need = offset + limit + 1; // +1 lets hasMore be exact within the scan
		const scannedMonths = [];
		let found = [];
		for (let i = 0; i < window.length && scannedMonths.length < MAX_MONTHS_PER_SCAN; i += MONTH_FETCH_CONCURRENCY) {
			const batch = window.slice(i, Math.min(i + MONTH_FETCH_CONCURRENCY, window.length))
				.slice(0, MAX_MONTHS_PER_SCAN - scannedMonths.length);
			const loaded = await Promise.all(batch.map((m) => loadMonth(m).catch(() => null)));
			for (let b = 0; b < batch.length; b++) {
				if (!loaded[b]) continue; // month failed to load; reported via scanned list
				scannedMonths.push(batch[b]);
				found = found.concat(loaded[b].filter(matches));
			}
			if (found.length >= need) break;
		}

		// Zero months loaded with months available = the archive store is down,
		// not an empty result — surface that instead of a misleading "no matches".
		if (!scannedMonths.length && window.length) {
			throw new Error('no archive months could be loaded');
		}

		found.sort((a, b) => new Date(b.pub_date || 0) - new Date(a.pub_date || 0));
		const monthsRemaining = window.length - scannedMonths.length;
		const body = {
			articles: found.slice(offset, offset + limit),
			total_scanned_matches: found.length,
			limit,
			offset,
			has_more: offset + limit < found.length || monthsRemaining > 0,
			scanned: {
				months: scannedMonths,
				from: scannedMonths[scannedMonths.length - 1] || null,
				to: scannedMonths[0] || null,
				complete: monthsRemaining === 0,
				months_remaining: monthsRemaining,
			},
		};
		if (monthsRemaining > 0) {
			body.hint = `scanned the newest ${scannedMonths.length} months of this range — add start_date/end_date to reach older articles`;
		}
		return body;
	} catch (err) {
		if (err.status) throw err;
		throw httpErr(502, 'archive_unavailable', `news archive is unreachable right now: ${err.message}`);
	}
}

// ── x402 paid rail ───────────────────────────────────────────────────────────

// Uniqueness-first: the first sentence answers "what can I only get here".
const DESCRIPTION =
	'Search the largest open crypto-news archive over x402: 660,000+ enriched articles back to ' +
	'September 2017 (english + chinese corpora, refreshed hourly), queryable by keyword, ticker, ' +
	'source, date range, sentiment, and language — every record carries tickers, tags, sentiment, ' +
	'and (where captured) BTC/ETH price + Fear & Greed at publication. $0.001 USDC per search; a ' +
	`free daily quota (${FREE_SEARCHES_PER_DAY} searches/day per IP) lets you try it before paying. ` +
	'Corpus stats and trending modes are always free.';

const INPUT_EXAMPLE = {
	q: 'bitcoin etf',
	ticker: 'BTC',
	start_date: '2024-01-01',
	end_date: '2024-03-31',
	limit: 50,
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		q: { type: 'string', maxLength: 120, description: 'Full-text query over title + description.' },
		ticker: { type: 'string', maxLength: 12, description: 'Filter by enriched ticker, e.g. BTC.' },
		source: { type: 'string', maxLength: 40, description: 'Source key or name substring, e.g. coindesk, odaily.' },
		category: { type: 'string', description: 'Enriched category.' },
		sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
		lang: { type: 'string', enum: ['en', 'zh'] },
		start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Earliest publish date (archive starts 2017-09-23).' },
		end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Latest publish date.' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
		offset: { type: 'integer', minimum: 0, default: 0 },
	},
};

const OUTPUT_EXAMPLE = {
	articles: [
		{
			id: 'a1b2c3d4e5f60718',
			title: 'Bitcoin ETF sees record inflows',
			link: 'https://example.com/article',
			source: 'CoinDesk',
			category: 'general',
			pub_date: '2024-01-11T14:00:00.000Z',
			tickers: ['BTC'],
			sentiment: { label: 'positive', score: 0.4 },
			lang: 'en',
		},
	],
	total_scanned_matches: 128,
	limit: 50,
	offset: 0,
	has_more: true,
	scanned: { months: ['2024-03', '2024-02', '2024-01'], from: '2024-01', to: '2024-03', complete: true, months_remaining: 0 },
	tier: 'paid',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['articles', 'total_scanned_matches', 'scanned'],
	properties: {
		articles: { type: 'array', items: { type: 'object' } },
		total_scanned_matches: { type: 'integer' },
		limit: { type: 'integer' },
		offset: { type: 'integer' },
		has_more: { type: 'boolean' },
		scanned: {
			type: 'object',
			description: 'Exactly which YYYY-MM months this search covered (newest-first scan).',
		},
		hint: { type: 'string' },
		tier: { type: 'string', enum: ['free', 'paid'] },
	},
};

const BAZAAR = declareHttpDiscovery({
	method: 'GET',
	input: INPUT_EXAMPLE,
	inputSchema: INPUT_SCHEMA,
	output: { example: OUTPUT_EXAMPLE, schema: OUTPUT_SCHEMA },
});

// The x402 paid twin — built once, lazily (constructing it touches env-derived
// pay-to config). Reused for every over-quota / paying request.
let _paid = null;
function paidRail() {
	if (_paid) return _paid;
	_paid = paidEndpoint({
		route: ROUTE,
		method: 'GET',
		priceAtomics: PRICE_ATOMICS,
		networks: ['solana', 'base'],
		description: DESCRIPTION,
		bazaar: BAZAAR,
		service: withService({
			serviceName: 'three.ws Crypto News Archive',
			tags: ['news', 'crypto', 'archive', 'search', 'data'],
		}),
		requiredScope: 'x402:bypass',
		accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
		async handler({ req }) {
			const params = new URL(req.url, 'http://x').searchParams;
			const body = await archiveSearch(parseSearchParams(params));
			return { ...body, tier: 'paid' };
		},
	});
	return _paid;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;

	// ── Free modes: cached, tiny, never metered ───────────────────────────────
	try {
		if (params.get('stats') === 'true') {
			const [stats, months] = await Promise.all([getStats(), getMonths()]);
			return json(
				res, 200,
				{
					stats: {
						total_articles: stats.total_articles,
						total_with_date: stats.total_with_date,
						total_with_url: stats.total_with_url,
						undated_articles: stats.total_articles - stats.total_with_date,
						first_article_date: stats.first_article_date,
						last_article_date: stats.last_article_date,
						languages: ['en', 'zh'],
						top_sources: Object.entries(stats.sources || {})
							.sort((a, b) => b[1] - a[1])
							.slice(0, 30)
							.map(([key, count]) => ({ key, count })),
					},
					months: { first: months[0], last: months[months.length - 1], count: months.length },
					search_access: {
						free_per_day: FREE_SEARCHES_PER_DAY,
						price_usdc: Number(PRICE_ATOMICS) / 1e6,
						protocol: 'x402',
					},
				},
				{ 'cache-control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400' },
			);
		}

		if (params.get('months') === 'true') {
			const months = await getMonths();
			return json(res, 200, { months }, {
				'cache-control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
			});
		}

		if (params.get('trending') === 'true') {
			const months = await getMonths();
			const recent = months.slice(-2);
			const counts = new Map();
			for (const month of recent) {
				for (const a of await loadMonth(month)) {
					for (const t of a.tickers) {
						// the corpus enrichment has occasional junk tickers ("A", "4") —
						// keep them queryable but out of the trending strip
						if (t.length < 2 || /^\d+$/.test(t)) continue;
						counts.set(t, (counts.get(t) || 0) + 1);
					}
				}
			}
			const trending = [...counts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 20)
				.map(([ticker, count]) => ({ ticker, count }));
			return json(res, 200, { trending, window: recent }, {
				'cache-control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
			});
		}
	} catch (err) {
		return error(res, 502, 'archive_unavailable', `news archive is unreachable right now: ${err.message}`);
	}

	// ── Query mode: free daily quota → x402 metered overage ──────────────────
	// A payment header means the caller is on the paid rail already.
	if (req.headers['x-payment'] || req.headers['payment-signature']) {
		return paidRail()(req, res);
	}

	// Validate before the quota check so genuinely bad input is a clean 400
	// rather than a payment prompt (and never burns a free search).
	let parsed;
	try {
		parsed = parseSearchParams(params);
	} catch (e) {
		return error(res, e.status || 400, e.code || 'bad_request', e.message);
	}

	// Free daily quota (per IP). Exhausted → the 402 challenge.
	const quota = await limits.newsArchiveFreeIp(clientIp(req));
	if (!quota.success) return paidRail()(req, res);

	try {
		const body = await archiveSearch(parsed);
		return json(
			res, 200,
			{ ...body, tier: 'free', free_remaining_today: Math.max(0, quota.remaining ?? 0) },
			{ 'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=3600' },
		);
	} catch (e) {
		return error(res, e.status || 502, e.code || 'archive_unavailable', e.message);
	}
});
