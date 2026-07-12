// GET /api/news/article?url=<article url>&title=&source=
// ---------------------------------------------------------------------------
// Rich article detail for the /markets/news reader. Runs the full extraction
// ladder (publisher page → Jina Reader → publisher feed → preview, in
// api/_lib/article-extract.js), so a Cloudflare-blocked publisher still yields
// the full story instead of a one-line teaser. Layers analysis on top:
//   • paragraphs      extracted plain-text body
//   • summary         LLM summary via the platform chain; falls back to lead
//   • key_points      3–5 takeaways (LLM, or highest-signal sentences)
//   • entities        orgs / people / projects the story is about (LLM)
//   • sentiment       bullish / bearish / neutral
//   • tickers         detected symbols, linkable to /coin/:id
//   • coins           live price + 7d sparkline for each mapped ticker
//   • related         live related coverage from the native aggregator
//
// Every fully-extracted, analyzed story is recorded to the durable news
// knowledge base (api/_lib/news-knowledge-store.js) — the corpus the 3D agents
// read crypto from — which also serves as a cross-instance cache so a story is
// only pulled from the (rate-limited, blockable) publisher once.
//
// The LLM layer is optional by design — when no provider key is present the
// endpoint still returns the full extracted article with heuristic analysis,
// clearly labelled via analysis_provider.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getNews, findArticle, articleId, extractTickers, lexiconSentiment, stripJsonFence, metaContent, stripHtml } from '../_lib/news.js';
import { llmComplete, llmConfigured } from '../_lib/llm.js';
import { extractArticle } from '../_lib/article-extract.js';
import { enrichTickers } from '../_lib/news-coins.js';
import { recordExtraction, getExtraction } from '../_lib/news-knowledge-store.js';

const CACHE_TTL_MS = 30 * 60_000;

const _cache = new Map(); // url → { value, expiresAt }

// ── Analysis ─────────────────────────────────────────────────────────────────

// The platform LLM chain (api/_lib/llm.js) owns provider order, key discovery,
// failover, and spend tracking. Returns null when no provider is configured or
// every provider fails — the caller then serves the extractive analysis below.
async function llmAnalyze(content, title, source) {
	if (!llmConfigured()) return null;
	try {
		const { text, provider } = await llmComplete({
			system: 'You are a crypto news analyst. Respond only with valid JSON, no markdown fence.',
			user: `Analyze this article. Respond as {"summary": "...2-3 sentence summary...", "key_points": ["...", "..."], "sentiment": "bullish|bearish|neutral", "entities": ["organizations, people, and projects the story is about"], "topics": ["1-3 word themes"]}.\n\nTitle: ${title}\nSource: ${source}\n\n${content.slice(0, 6000)}`,
			maxTokens: 800,
			timeoutMs: 15_000,
			track: { tool: 'news_article' },
		});
		const parsed = JSON.parse(stripJsonFence(text));
		if (!parsed.summary) return null;
		const list = (v, n, cap) => (Array.isArray(v) ? v : []).map((p) => String(p).slice(0, cap)).filter(Boolean).slice(0, n);
		return {
			summary: String(parsed.summary).slice(0, 1200),
			key_points: list(parsed.key_points, 5, 300),
			entities: list(parsed.entities, 12, 80),
			topics: list(parsed.topics, 8, 40),
			sentiment: ['bullish', 'bearish', 'neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
			provider,
		};
	} catch {
		return null; // extractive fallback covers it
	}
}

function heuristicAnalyze(paragraphs, title) {
	const lead = paragraphs.slice(0, 3).join(' ');
	const summary = lead.slice(0, 500) + (lead.length > 500 ? '…' : '');
	// Highest-signal sentences: numbers, detected tickers, and early position.
	const sentences = paragraphs
		.join(' ')
		.split(/(?<=[.!?。])\s+/)
		.filter((s) => s.length > 50 && s.length < 320);
	const scored = sentences
		.map((s, i) => {
			let score = 0;
			if (/\d/.test(s)) score += 2;
			if (extractTickers(s).length) score += 2;
			if (/percent|%|\$|million|billion|亿|万/.test(s)) score += 1;
			score += Math.max(0, 2 - i * 0.1);
			return { s, score };
		})
		.sort((a, b) => b.score - a.score);
	const key_points = [];
	for (const { s } of scored) {
		if (key_points.length >= 4) break;
		if (key_points.some((k) => k.slice(0, 60) === s.slice(0, 60))) continue;
		key_points.push(s);
	}
	const lex = lexiconSentiment(`${title} ${lead}`);
	const sentiment = lex.label.includes('positive') ? 'bullish' : lex.label.includes('negative') ? 'bearish' : 'neutral';
	return { summary, key_points, entities: [], topics: [], sentiment, provider: 'heuristic' };
}

// ─────────────────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketFeedIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const rawUrl = (params.get('url') || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
	if (!rawUrl) return error(res, 400, 'bad_url', 'url is required');
	let target;
	try {
		target = new URL(rawUrl).toString();
	} catch {
		return error(res, 400, 'bad_url', 'url is not a valid absolute URL');
	}

	const cacheHeaders = { 'cache-control': 'public, max-age=600, s-maxage=1800, stale-while-revalidate=3600' };

	const hit = _cache.get(target);
	if (hit && hit.expiresAt > Date.now()) return json(res, 200, hit.value, cacheHeaders);

	const id = articleId(target);

	// Durable cache: a prior instance may have already done the expensive full
	// extraction. Reuse it when it carries real body text — never re-hammer a
	// rate-limited publisher for a story we already know in full.
	const stored = await getExtraction(id).catch(() => null);
	if (stored && (stored.extraction === 'page' || stored.extraction === 'reader') && stored.content_chars > 400) {
		_cache.set(target, { value: stored, expiresAt: Date.now() + CACHE_TTL_MS });
		return json(res, 200, stored, cacheHeaders);
	}

	// The publisher's own feed copy — trusted metadata, and (for feeds that
	// ship content:encoded) a fuller body. Looked up first so a bot-blocked
	// page fetch still has a fallback body, never a dead end.
	const feedCopy = await findArticle({ link: target }).catch(() => null);

	// Run the extraction ladder: page → reader → feed → preview.
	const { paragraphs, extraction, blocked_reason, html } = await extractArticle(target, {
		feedContentText: feedCopy?.content_text || null,
	});

	const title =
		(params.get('title') || '').trim().slice(0, 300) ||
		(html && metaContent(html, ['og:title', 'twitter:title'])) ||
		feedCopy?.title ||
		(html && stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')) ||
		'Untitled';
	const source =
		(params.get('source') || '').trim().slice(0, 80) ||
		(html && metaContent(html, ['og:site_name'])) ||
		feedCopy?.source ||
		new URL(target).hostname.replace(/^www\./, '');

	const content = paragraphs.join('\n').slice(0, 8000);
	const analysis =
		(content.length > 300 ? await llmAnalyze(content, title, source) : null) ||
		heuristicAnalyze(paragraphs.length ? paragraphs : [feedCopy?.description || title], title);

	const tickers = extractTickers(`${title} ${content.slice(0, 2000)} ${feedCopy?.description || ''}`);

	// Live market snapshot for the mapped tickers, and related coverage — both
	// optional, fetched together so neither blocks the other.
	const [coins, related] = await Promise.all([
		enrichTickers(tickers).catch(() => []),
		(async () => {
			try {
				const relatedQuery = tickers[0] || title.split(/\s+/).slice(0, 3).join(' ');
				const rel = await getNews({ q: relatedQuery, limit: 7 });
				let out = rel.articles.filter((a) => a.link !== target).slice(0, 6);
				if (!out.length) {
					const fallback = await getNews({ category: feedCopy?.category, limit: 7 });
					out = fallback.articles.filter((a) => a.link !== target).slice(0, 6);
				}
				return out;
			} catch {
				return [];
			}
		})(),
	]);

	const value = {
		id,
		url: target,
		title,
		source,
		image: (html && metaContent(html, ['og:image', 'twitter:image'])) || feedCopy?.image || null,
		author: (html && metaContent(html, ['author', 'article:author', 'twitter:creator'])) || feedCopy?.author || null,
		published_at:
			(html && metaContent(html, ['article:published_time', 'og:article:published_time', 'date'])) ||
			feedCopy?.pub_date ||
			null,
		description:
			(html && metaContent(html, ['og:description', 'description', 'twitter:description'])) ||
			feedCopy?.description ||
			null,
		extraction, // 'page' | 'reader' | 'feed' | 'preview'
		blocked_reason: extraction === 'preview' ? blocked_reason : null,
		paragraphs,
		content_chars: content.length,
		tickers,
		coins,
		summary: analysis.summary,
		key_points: analysis.key_points,
		entities: analysis.entities,
		topics: analysis.topics,
		sentiment: analysis.sentiment,
		analysis_provider: analysis.provider,
		market_context: feedCopy?.market_context || null,
		related,
		fetched_at: new Date().toISOString(),
	};

	_cache.set(target, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	if (_cache.size > 256) _cache.delete(_cache.keys().next().value);

	// Record into the durable knowledge base the 3D agents read from. Fire-and-
	// forget: a persistence hiccup must never fail the reader response.
	recordExtraction(value).catch(() => {});

	return json(res, 200, value, cacheHeaders);
});
