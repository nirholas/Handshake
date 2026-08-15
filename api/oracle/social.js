/**
 * Oracle — social signal ingestion.
 *
 *   POST /api/oracle/social
 *   Body: { tweets: XActionsTweet[], network?: string }
 *
 * Accepts a batch of raw tweets (from XActions, a scraper, or any source),
 * extracts coin mentions by $SYMBOL pattern, maps them to known mints in the
 * brain, and upserts oracle_narrative with a social-boosted virality score.
 * The social virality compounds the existing heuristic virality — it never
 * overwrites a higher LLM-derived score.
 *
 * Tweet shape (XActions format):
 *   { id, text, createdAt, url, author:{ username }, metrics:{ views, likes, retweets } }
 *
 * An author in KOL_ACCOUNTS below gets a 1.5× virality multiplier vs an
 * anonymous account.
 *
 * Rate-limited per IP (limits.oracleSocialIp). Auth: optional — unauthenticated
 * calls are accepted so XActions → Oracle works without session overhead.
 */

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql, sqlValues, isDbUnavailableError } from '../_lib/db.js';

const NETWORK = 'mainnet';

// $SYMBOL pattern — captures ticker after $, up to 10 chars, word boundary.
const SYMBOL_RE = /\$([A-Z]{2,10})\b/g;

// KOL accounts that get virality multiplier
const KOL_ACCOUNTS = new Set([
	'nichxbt', 'trythreews',
	// add more as the platform learns which accounts move prices
]);

function viralityFromTweet(t) {
	const views = Number(t.metrics?.views || 0);
	const likes = Number(t.metrics?.likes || 0);
	const rts   = Number(t.metrics?.retweets || 0);
	// Log scale: 10k views ≈ 30 pts, 100k ≈ 50, 1M ≈ 70
	const viewScore = views > 0 ? Math.min(70, Math.log10(views + 1) * 14) : 0;
	// Engagement boost
	const engScore  = Math.min(20, (likes + rts * 2) / Math.max(1, views) * 1000);
	const kol = KOL_ACCOUNTS.has((t.author?.username || '').toLowerCase());
	const base = Math.round(viewScore + engScore);
	return Math.min(100, kol ? base * 1.5 : base);
}

function extractSymbols(text) {
	const out = new Set();
	for (const [, sym] of text.toUpperCase().matchAll(SYMBOL_RE)) out.add(sym);
	return [...out];
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.oracleSocialIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	const tweets = Array.isArray(body?.tweets) ? body.tweets : [];
	const network = body?.network === 'devnet' ? 'devnet' : NETWORK;

	if (!tweets.length) return error(res, 400, 'no_tweets', 'tweets array required');
	if (tweets.length > 500) return error(res, 400, 'too_many', 'max 500 tweets per call');

	// Extract all unique symbols across the batch
	const symbolMap = new Map(); // symbol → { maxVirality, tweetCount }
	for (const t of tweets) {
		if (!t?.text) continue;
		const virality = viralityFromTweet(t);
		for (const sym of extractSymbols(t.text)) {
			const cur = symbolMap.get(sym) || { maxVirality: 0, tweetCount: 0, urls: [] };
			cur.maxVirality = Math.max(cur.maxVirality, virality);
			cur.tweetCount++;
			if (t.url && cur.urls.length < 3) cur.urls.push(t.url);
			symbolMap.set(sym, cur);
		}
	}

	if (!symbolMap.size) {
		return json(res, 200, { ok: true, mints_updated: 0, symbols_found: 0, tweet_count: tweets.length });
	}

	// Look up mints for the mentioned symbols (case-insensitive match in brain)
	const symbols = [...symbolMap.keys()];
	const coinRows = await sql`
		select mint, symbol from pump_coin_intel
		where network = ${network}
		  and upper(symbol) = any(${symbols})
		order by first_seen_at desc
	`.catch((err) => {
		// An empty lookup answers "no known mints matched the mentioned symbols",
		// which tells the caller its batch was useless and should not be retried.
		// During a connectivity failure that discards real social signal for good,
		// so propagate (wrap() → 503 + Retry-After) and let the sender retry; a
		// statement fault still degrades to the documented empty answer.
		if (isDbUnavailableError(err)) throw err;
		return [];
	});

	// Dedupe: keep the most recent mint per symbol
	const mintBySymbol = new Map();
	for (const row of coinRows) {
		const sym = row.symbol.toUpperCase();
		if (!mintBySymbol.has(sym)) mintBySymbol.set(sym, row.mint);
	}

	if (!mintBySymbol.size) {
		return json(res, 200, { ok: true, mints_updated: 0, symbols_found: symbolMap.size, tweet_count: tweets.length, note: 'no known mints matched the mentioned symbols' });
	}

	// Upsert oracle_narrative — virality is additive with existing social signal,
	// capped at 100. Never downgrades an LLM-sourced row.
	const updates = [];
	for (const [sym, data] of symbolMap) {
		const mint = mintBySymbol.get(sym);
		if (!mint) continue;
		updates.push({ mint, network, virality: data.maxVirality, tweetCount: data.tweetCount });
	}

	// Single multi-row upsert instead of one round-trip per symbol — a batch of up
	// to 500 tweets can mention dozens of known mints, and N sequential INSERTs
	// would serialize the whole request behind DB latency. classified_at is bound
	// per row; the ON CONFLICT branch still uses now() for the update path.
	// Not guarded: this write IS the request. A swallowed failure used to answer
	// `ok: true` with `mints_updated: 0` next to a populated `updated` array — a
	// self-contradicting receipt that told the sender its batch had landed when
	// nothing was written. wrap() classifies instead (503 on a connectivity
	// failure, 500 on a statement fault), so the sender knows to retry.
	const rows = updates.map((u) => [u.mint, u.network, u.virality, 0.4, 'heuristic', new Date()]);
	await sql`
		insert into oracle_narrative (mint, network, virality, confidence, source, classified_at)
		values ${sqlValues(rows)}
		on conflict (mint, network) do update set
			virality = case
				when oracle_narrative.source = 'llm' then oracle_narrative.virality
				else least(100, greatest(oracle_narrative.virality, excluded.virality))
			end,
			classified_at = case
				when oracle_narrative.source = 'llm' then oracle_narrative.classified_at
				else now()
			end
	`;

	return json(res, 200, {
		ok: true,
		tweet_count: tweets.length,
		symbols_found: symbolMap.size,
		mints_updated: updates.length,
		updated: updates.map(u => ({ mint: u.mint, virality: u.virality, tweets: u.tweetCount })),
	});
});
