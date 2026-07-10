// Oracle — live news context from the native three.ws news engine.
//
// Reads a window of recent crypto headlines straight from api/_lib/news.js (the
// same in-process aggregator that serves /api/news/feed — no network hop, no
// third-party dependency) and matches them against a coin's name/symbol/tags.
// When a coin is clearly riding a live headline, the narrative classifier gets
// that context in the LLM prompt so it can write a precise thesis ("rides
// today's Trump tariff announcement") instead of guessing. The virality boost
// applied here is REAL signal: a coin whose ticker appears in a trending
// headline right now has genuine attention behind it.
//
// Two tiers:
//   1. fetchRelevantHeadlines(meta)  — read + filter in one call. Returns the
//      top 3 matching headlines (or [] if none). Used by classifyNarrative().
//   2. fetchTrending()               — tickers trending across those headlines;
//      used by the cron to pre-warm the headline cache before a scoring batch.
//
// Both degrade gracefully: a cold registry, a dead feed, or any exception
// returns the safe fallback so the narrative pipeline never stalls.

import { getNews } from '../news.js';

const CACHE_TTL_MS = 90_000; // 90s — fresh enough for live news, cheap on the engine's own 5-min source cache

/** Module-level news cache so one invocation shares it across coin scorings. */
const _cache = { headlines: null, trending: null, fetchedAt: 0 };

/** Categories of the native registry most relevant to pump.fun culture. */
const CATEGORIES = ['general', 'solana', 'bitcoin', 'defi', 'trading'];

/**
 * Read recent headlines from the native engine, filtered to the categories most
 * relevant to pump.fun launches. Returns array of
 * { title, category, published_at, source, tickers } or [] on failure.
 * Results cached for CACHE_TTL_MS.
 */
async function fetchHeadlines() {
	const now = Date.now();
	if (_cache.headlines && now - _cache.fetchedAt < CACHE_TTL_MS) return _cache.headlines;

	const results = await Promise.allSettled(
		CATEGORIES.map((category) => getNews({ category, limit: 20 })),
	);

	const headlines = [];
	const seen = new Set();
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (r.status !== 'fulfilled') continue;
		for (const item of r.value?.articles || []) {
			const title = String(item?.title || '').trim();
			if (!title || seen.has(title)) continue;
			seen.add(title);
			headlines.push({
				title,
				category: item?.category || CATEGORIES[i],
				published_at: item?.pub_date || null,
				source: item?.source || null,
				tickers: item?.tickers || [],
			});
		}
	}

	if (headlines.length) {
		_cache.headlines = headlines;
		_cache.fetchedAt = now;
	}
	return _cache.headlines || [];
}

/**
 * Trending topics — the tickers appearing most often across the current
 * headline window, most-mentioned first. Returns array of strings.
 */
export async function fetchTrending() {
	if (_cache.trending && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.trending;

	const headlines = await fetchHeadlines();
	const counts = new Map();
	for (const h of headlines) {
		for (const t of h.tickers || []) counts.set(t, (counts.get(t) || 0) + 1);
	}
	const topics = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20)
		.map(([ticker]) => ticker);

	if (topics.length) _cache.trending = topics;
	return _cache.trending || [];
}

// Tokenize a string into lowercase word-level tokens for fuzzy matching.
function tokens(str) {
	return String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
}

// Score how well a headline matches coin metadata. Returns 0–100.
function matchScore(headline, coinTokens) {
	const hTokens = tokens(headline.title);
	let hits = 0;
	for (const ct of coinTokens) {
		if (ct.length < 2) continue;
		for (const ht of hTokens) {
			if (ht === ct || (ct.length >= 4 && ht.includes(ct))) { hits++; break; }
		}
	}
	return hits;
}

/**
 * Return the top matching recent headlines for a coin. Empty array if none match.
 * Threshold: at least 1 token overlap.
 *
 * @param {{ name?: string, symbol?: string, description?: string, tags?: string[] }} meta
 * @param {number} [maxResults=3]
 * @returns {Promise<Array<{title:string, category:string, published_at:string|null}>>}
 */
export async function fetchRelevantHeadlines(meta = {}, maxResults = 3) {
	try {
		const headlines = await fetchHeadlines();
		if (!headlines.length) return [];

		const coinTokens = tokens(`${meta.name || ''} ${meta.symbol || ''} ${(meta.tags || []).join(' ')}`);
		if (!coinTokens.length) return [];

		const scored = headlines
			.map((h) => ({ ...h, _score: matchScore(h, coinTokens) }))
			.filter((h) => h._score > 0)
			.sort((a, b) => b._score - a._score)
			.slice(0, maxResults);

		return scored.map(({ _score: _, ...h }) => h);
	} catch {
		return [];
	}
}

/**
 * Compute a virality bonus (0–30) from live news context.
 * Called inside classifyNarrative to adjust the base LLM-estimated virality.
 *
 * @param {Array<{title:string}>} headlines matching headlines
 * @returns {number}
 */
export function viralityBonus(headlines) {
	if (!headlines.length) return 0;
	// First match: strong bonus. Additional matches add diminishing signal.
	return Math.min(30, headlines.length * 10 + 5);
}
