// GCS-backed access to the historical crypto-news archive
// (gs://three-ws-news-archive) — extracted from api/news/archive.js so the
// story pages (api/news/story-page.js) and the news sitemap can read the same
// month files through the same LRU cache instead of re-implementing the store.
//
// Data layout (public bucket, gzip at rest, transparently decoded):
//   articles/YYYY-MM.jsonl   one enriched article per line
//   meta/stats.json          corpus-wide statistics
//   indexes/by-{date,source,ticker}.json
//
// The imported corpus ends 2025-12-03; api/cron/news-archive-append.js extends
// it hourly from the live feed. Never hardcode the end date — read
// meta/stats.json (last_article_date), which the appender keeps current.

import { createCache } from './mem-cache.js';
import { fetchUpstream, fetchUpstreamJson, lastGood } from './upstream-fetch.js';

const GCS_BASE = 'https://storage.googleapis.com/three-ws-news-archive';
const GCS_LIST =
	'https://storage.googleapis.com/storage/v1/b/three-ws-news-archive/o?prefix=articles/&fields=items(name)&maxResults=500';

const MONTH_CACHE_MAX = 5;
const META_TTL_MS = 3600_000;
// The hourly archiver keeps appending to the last two month files; a cached
// copy of those must expire or a long-lived instance never sees new stories
// and their fresh permalinks 404 until restart. Older months are immutable.
const MUTABLE_MONTH_TTL_MS = 10 * 60_000;

// month "YYYY-MM" → { records, expiresAt } (newest month files are ~2-11 MB
// raw; compact form keeps only serving fields). True LRU: the previous trim
// evicted by Map INSERTION order, so with only 5 slots the month being actively
// paged could be discarded while months touched once survived.
const monthCache = createCache({ max: MONTH_CACHE_MAX });
// small metadata caches: { value, expiresAt }
let statsCache = null;
let monthsCache = null;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function compact(a) {
	return {
		id: a.id,
		title: a.title,
		link: str(a.link) || str(a.canonical_link),
		description: str(a.description) ? a.description.slice(0, 240) : null,
		image: str(a.image),
		author: str(a.author),
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

// One bucket, one read, no recovery: a GCS blip took the archive index, the
// month listing and the sitemap down together, and the in-process caches above
// are empty on a cold instance, which is exactly when an outage hurts. A retry
// absorbs the transient, and a last-known-good copy keyed per URL absorbs the
// rest. Archive data is immutable once written, so a remembered copy is not
// merely acceptable here, it is the same answer.
async function fetchJson(url, timeoutMs = 15_000, lastGoodKey = null) {
	const load = () => fetchUpstreamJson(
		url,
		{ headers: { accept: 'application/json' } },
		{ name: 'news-archive', timeoutMs, attempts: 2 },
	);
	if (!lastGoodKey) return load();
	const { value } = await lastGood(lastGoodKey, load, { maxAgeMs: 6 * 60 * 60_000 });
	return value;
}

export async function getStats() {
	if (statsCache && statsCache.expiresAt > Date.now()) return statsCache.value;
	const value = await fetchJson(`${GCS_BASE}/meta/stats.json`, 15_000, 'news-archive:stats');
	statsCache = { value, expiresAt: Date.now() + META_TTL_MS };
	return value;
}

/** Queryable months, ascending YYYY-MM. */
export async function getMonths() {
	if (monthsCache && monthsCache.expiresAt > Date.now()) return monthsCache.value;
	const listing = await fetchJson(GCS_LIST, 15_000, 'news-archive:months');
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

// The archiver still appends to the current and previous month; everything
// older is a sealed, immutable file.
function isMutableMonth(month) {
	const d = new Date();
	const cur = d.toISOString().slice(0, 7);
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() - 1);
	return month === cur || month === d.toISOString().slice(0, 7);
}

/** One month of compact records, newest-first, LRU-cached. */
export async function loadMonth(month) {
	const hit = monthCache.get(month);
	if (hit && hit.expiresAt > Date.now()) {
		monthCache.delete(month);
		monthCache.set(month, hit); // refresh LRU recency
		return hit.records;
	}
	// A sealed month never changes, so its remembered body is byte-identical to
	// the live one; the mutable current month is worth at most a few minutes of
	// staleness against being unreadable altogether.
	const { value: text } = await lastGood(
		`news-archive:month:${month}`,
		async () => {
			const resp = await fetchUpstream(
				`${GCS_BASE}/articles/${month}.jsonl`,
				{},
				{ name: 'news-archive:month', timeoutMs: 30_000, attempts: 2 },
			);
			return resp.text();
		},
		{ maxAgeMs: isMutableMonth(month) ? 10 * 60_000 : 6 * 60 * 60_000 },
	);
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
	monthCache.set(month, {
		records,
		expiresAt: isMutableMonth(month) ? Date.now() + MUTABLE_MONTH_TTL_MS : Infinity,
	});
	return records;
}
