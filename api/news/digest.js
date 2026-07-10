// GET /api/news/digest
// ---------------------------------------------------------------------------
// The day's crypto news, clustered into narratives instead of a flat list of
// headlines. Reads the live aggregator (38 publisher feeds), groups the last
// N hours of coverage into the handful of stories that actually matter, and
// gives each one a title, a plain-language summary, a market stance, the
// tickers involved, and every source that covered it.
//
// Two clustering engines, both real:
//   • LLM (platform chain — Groq/OpenRouter/NVIDIA free tiers first) reads the
//     headlines and groups them semantically. `engine: "llm"`.
//   • Ticker+token overlap clustering (agglomerative, Jaccard similarity over
//     the title's significant tokens plus detected tickers) when no provider
//     key is configured or the chain fails. `engine: "heuristic"`.
//
// The heuristic path is not a placeholder — it produces genuine clusters from
// the same articles, with an extractive summary drawn from the lead article.
// Nothing is ever fabricated: every narrative cites the real articles it
// clustered, and a narrative with no articles cannot exist.
//
// Params: ?hours=24 (1–72), ?limit=8 narratives (3–12), ?refresh=1 (bypass cache)
// Cached 30 min in-process (LLM calls are the expensive part) + 15 min CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getNews, stripJsonFence, lexiconSentiment } from '../_lib/news.js';
import { llmComplete, llmConfigured } from '../_lib/llm.js';

const CACHE_TTL_MS = 30 * 60_000;
const MAX_ARTICLES_CONSIDERED = 90;

const _cache = new Map(); // `${hours}:${limit}` → { value, expiresAt }

// Words that carry no clustering signal in crypto headlines.
const STOPWORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with',
	'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
	'after', 'over', 'into', 'amid', 'says', 'said', 'new', 'more', 'than', 'has', 'have',
	'will', 'can', 'could', 'may', 'about', 'up', 'down', 'crypto', 'cryptocurrency',
]);

function tokens(title) {
	return new Set(
		String(title)
			.toLowerCase()
			.replace(/[^a-z0-9$ ]/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 2 && !STOPWORDS.has(w)),
	);
}

function jaccard(a, b) {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared / (a.size + b.size - shared);
}

function stanceFrom(articles) {
	// Average the lexicon sentiment across the cluster's coverage.
	const scores = articles.map((a) => a.sentiment?.score ?? 0);
	const mean = scores.reduce((s, v) => s + v, 0) / (scores.length || 1);
	return mean > 0.15 ? 'bullish' : mean < -0.15 ? 'bearish' : 'neutral';
}

function clusterTickers(articles) {
	const counts = new Map();
	for (const a of articles) for (const t of a.tickers || []) counts.set(t, (counts.get(t) || 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
}

function shape(articles) {
	// A narrative's sources are the real articles behind it — always.
	return articles.map((a) => ({
		id: a.id,
		title: a.title,
		link: a.link,
		source: a.source,
		pub_date: a.pub_date,
		image: a.image,
	}));
}

// ── Heuristic engine: agglomerative clustering on title tokens + tickers ─────

function heuristicClusters(articles, limit) {
	const enriched = articles.map((a) => ({
		article: a,
		bag: new Set([...tokens(a.title), ...(a.tickers || []).map((t) => `$${t.toLowerCase()}`)]),
	}));

	const clusters = [];
	for (const item of enriched) {
		let best = null;
		let bestScore = 0;
		for (const c of clusters) {
			const score = jaccard(item.bag, c.bag);
			if (score > bestScore) {
				bestScore = score;
				best = c;
			}
		}
		// 0.28 keeps "Bitcoin ETF inflows hit record" with "Record ETF inflows
		// push Bitcoin higher" while splitting unrelated BTC stories.
		if (best && bestScore >= 0.28) {
			best.items.push(item.article);
			for (const t of item.bag) best.bag.add(t);
		} else {
			clusters.push({ items: [item.article], bag: new Set(item.bag) });
		}
	}

	return clusters
		.sort((a, b) => b.items.length - a.items.length || new Date(b.items[0].pub_date || 0) - new Date(a.items[0].pub_date || 0))
		.slice(0, limit)
		.map((c) => {
			// The most-covered angle leads; its own text is the summary.
			const lead = c.items.slice().sort((x, y) => new Date(y.pub_date || 0) - new Date(x.pub_date || 0))[0];
			const summary =
				lead.description ||
				`${c.items.length} outlet${c.items.length > 1 ? 's' : ''} covering this story, led by ${lead.source}.`;
			return {
				title: lead.title,
				summary,
				stance: stanceFrom(c.items),
				tickers: clusterTickers(c.items),
				coverage: c.items.length,
				articles: shape(c.items),
			};
		});
}

// ── LLM engine: semantic grouping over the headline set ─────────────────────

async function llmClusters(articles, limit) {
	const indexed = articles.map((a, i) => `${i}. [${a.source}] ${a.title}`).join('\n');
	const { text, provider } = await llmComplete({
		system:
			'You are a crypto news editor building a daily digest. You group headlines into distinct stories. Respond only with valid JSON, no markdown fence.',
		user: `Below are ${articles.length} crypto headlines from the last day, each with an index.

Group them into at most ${limit} distinct news stories, ordered by importance. Every story must reference the indices of the headlines it covers. Ignore headlines that don't belong to a significant story rather than forcing them into one.

Respond as:
{"narratives":[{"title":"a clear headline for the story","summary":"2-3 sentences in plain language explaining what happened and why it matters","stance":"bullish|bearish|neutral","indices":[0,4,9]}]}

Headlines:
${indexed}`,
		maxTokens: 2000,
		timeoutMs: 25_000,
		track: { tool: 'news_digest' },
	});

	const parsed = JSON.parse(stripJsonFence(text));
	if (!Array.isArray(parsed?.narratives)) throw new Error('digest: model returned no narratives');

	const out = [];
	for (const n of parsed.narratives) {
		// Every index must resolve to a real article we actually fetched. A
		// hallucinated index is dropped, not rendered.
		const cited = (Array.isArray(n.indices) ? n.indices : [])
			.map((i) => articles[Number(i)])
			.filter(Boolean);
		if (!cited.length) continue;
		out.push({
			title: String(n.title || cited[0].title).slice(0, 200),
			summary: String(n.summary || cited[0].description || '').slice(0, 900),
			stance: ['bullish', 'bearish', 'neutral'].includes(n.stance) ? n.stance : stanceFrom(cited),
			tickers: clusterTickers(cited),
			coverage: cited.length,
			articles: shape(cited),
		});
		if (out.length >= limit) break;
	}
	if (!out.length) throw new Error('digest: no narrative cited a real article');
	return { narratives: out, provider };
}

// ─────────────────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const hours = Math.min(Math.max(1, parseInt(params.get('hours') || '24', 10) || 24), 72);
	const limit = Math.min(Math.max(3, parseInt(params.get('limit') || '8', 10) || 8), 12);
	const refresh = params.get('refresh') === '1';

	const key = `${hours}:${limit}`;
	const hit = _cache.get(key);
	if (!refresh && hit && hit.expiresAt > Date.now()) {
		return json(res, 200, { ...hit.value, cached: true }, {
			'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
		});
	}

	const { articles: all, sources_ok, sources_total } = await getNews({ limit: 400 });
	const cutoff = Date.now() - hours * 3600_000;
	const windowed = all
		.filter((a) => a.pub_date && new Date(a.pub_date).getTime() >= cutoff)
		.slice(0, MAX_ARTICLES_CONSIDERED);

	if (windowed.length < 3) {
		return error(
			res, 503, 'insufficient_coverage',
			`only ${windowed.length} articles published in the last ${hours}h — try a wider window`,
		);
	}

	let narratives;
	let engine;
	let provider = null;
	if (llmConfigured()) {
		try {
			const result = await llmClusters(windowed, limit);
			narratives = result.narratives;
			provider = result.provider;
			engine = 'llm';
		} catch {
			narratives = heuristicClusters(windowed, limit);
			engine = 'heuristic';
		}
	} else {
		narratives = heuristicClusters(windowed, limit);
		engine = 'heuristic';
	}

	// Market mood across the whole window, independent of clustering.
	const mood = stanceFrom(windowed);
	const topTickers = clusterTickers(windowed);

	const value = {
		narratives,
		engine,
		provider,
		window_hours: hours,
		articles_considered: windowed.length,
		sources_live: `${sources_ok}/${sources_total}`,
		mood,
		top_tickers: topTickers,
		generated_at: new Date().toISOString(),
		cached: false,
	};
	_cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	if (_cache.size > 24) _cache.delete(_cache.keys().next().value);

	return json(res, 200, value, {
		'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
	});
});

// Exported for tests — the clustering math is the interesting part.
export const _internal = { heuristicClusters, jaccard, tokens, stanceFrom };
