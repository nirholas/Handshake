// Real-time news-meme detection for pump.fun coin classification.
//
// Reads top crypto headlines from the native three.ws news engine
// (api/_lib/news.js — the same in-process aggregator behind /api/news/feed),
// caches them for 2 minutes, then fuzzy-matches a coin's name/symbol/description
// against the headlines. Returns the matched headline + confidence so the
// classifier can set is_news_meme=true with real evidence.
//
// Fallback: if the registry is cold and every source is slow, the function
// returns the empty set so the caller degrades to the LLM/heuristic path —
// never blocks the pipeline.

import { getNews } from '../news.js';

const CACHE_TTL_MS = 2 * 60_000; // 2-min freshness — headlines move fast
const MAX_HEADLINES = 40;

let _cache = null;
let _cacheAt = 0;

/**
 * Read + cache the current top crypto headlines.
 * Returns array of { title, summary, url, published_at } or [].
 */
async function getHeadlines() {
	if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;

	try {
		const { articles } = await getNews({ limit: MAX_HEADLINES });
		const headlines = (articles || [])
			.map((a) => ({
				title: String(a.title || ''),
				summary: String(a.description || ''),
				url: String(a.link || ''),
				published_at: a.pub_date || null,
			}))
			.filter((h) => h.title.length > 4);
		if (headlines.length) {
			_cache = headlines;
			_cacheAt = Date.now();
			return _cache;
		}
	} catch { /* fall through to stale cache */ }

	return _cache || []; // stale cache beats nothing
}

// Tokenise to lowercase word stems for matching
function tokens(text) {
	return (text || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length >= 3 && w.length <= 25);
}

// Jaccard-ish overlap between two token sets, ignoring stop words
const STOP = new Set(['the','and','for','has','are','was','its','with','that','this',
	'from','have','been','will','they','were','their','also','about','into',
	'could','coin','token','pump','solana','crypto','blockchain','defi']);

function overlapScore(aToks, bToks) {
	const a = new Set(aToks.filter((t) => !STOP.has(t)));
	const b = new Set(bToks.filter((t) => !STOP.has(t)));
	if (!a.size || !b.size) return 0;
	let hits = 0;
	for (const t of a) { if (b.has(t)) hits++; }
	return hits / Math.min(a.size, b.size);
}

/**
 * Check if a coin's metadata matches a current news headline.
 *
 * @param {{ name, symbol, description }} coin
 * @returns {Promise<{ matched: boolean, headline: string|null, url: string|null, confidence: number }>}
 */
export async function matchNewsHeadline(coin) {
	const fallback = { matched: false, headline: null, url: null, confidence: 0 };
	try {
		const headlines = await getHeadlines();
		if (!headlines.length) return fallback;

		// Build coin token set from all text fields
		const coinText = `${coin.name || ''} ${coin.symbol || ''} ${coin.description || ''}`;
		const coinToks = tokens(coinText);
		if (coinToks.length < 2) return fallback;

		// Also check if the coin name/symbol appears verbatim in a headline
		const coinNameLower = (coin.name || '').toLowerCase();
		const coinSymLower = (coin.symbol || '').toLowerCase().replace(/^\$/, '');

		let bestScore = 0;
		let bestHeadline = null;

		for (const h of headlines) {
			const headlineToks = tokens(`${h.title} ${h.summary}`);
			const headlineFull = `${h.title} ${h.summary}`.toLowerCase();

			// Verbatim match (strongest signal — coin named after the event)
			const verbatim = (coinNameLower.length >= 4 && headlineFull.includes(coinNameLower))
				|| (coinSymLower.length >= 3 && headlineFull.includes(coinSymLower));

			const overlap = overlapScore(coinToks, headlineToks);
			const score = verbatim ? Math.max(0.85, overlap) : overlap;

			if (score > bestScore) {
				bestScore = score;
				bestHeadline = h;
			}
		}

		// Threshold: 0.35 overlap or verbatim match → news meme
		if (bestScore >= 0.35 && bestHeadline) {
			return {
				matched: true,
				headline: bestHeadline.title,
				url: bestHeadline.url || null,
				confidence: Math.min(0.95, bestScore),
			};
		}

		return fallback;
	} catch {
		return fallback;
	}
}

/** Force-refresh the headline cache (called by a periodic background task). */
export async function refreshHeadlines() {
	_cache = null;
	_cacheAt = 0;
	return getHeadlines();
}

/** Cache stats for monitoring. */
export function newsCacheAge() {
	return _cache ? Math.round((Date.now() - _cacheAt) / 1000) : null;
}
