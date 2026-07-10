// GET /api/news/article?url=<article url>&title=&source=
// ---------------------------------------------------------------------------
// Rich article detail for the /markets/news reader. Fetches the publisher
// page server-side (SSRF-guarded), extracts the real article text and
// metadata, and layers analysis on top:
//   • paragraphs      extracted plain-text body (up to 8k chars)
//   • summary         LLM summary via the platform chain (Groq → OpenRouter);
//                     falls back to the article's own lead paragraphs
//   • key_points      3–5 takeaways (LLM, or highest-signal sentences)
//   • sentiment       bullish / bearish / neutral
//   • tickers         detected symbols, linkable to /coin/:id
//   • related         live related coverage from the native aggregator
//
// The LLM layer is optional by design — when no provider key is present the
// endpoint still returns the full extracted article with heuristic analysis,
// clearly labelled via analysis_provider.

import { lookup } from 'node:dns/promises';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getNews, findArticle, extractTickers, lexiconSentiment, stripHtml, stripJsonFence } from '../_lib/news.js';
import { llmComplete, llmConfigured } from '../_lib/llm.js';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;

const _cache = new Map(); // url → { value, expiresAt }

// ── SSRF protection (ported from the cryptocurrency.cv article extractor) ───

function isPrivateOrReservedHost(hostname) {
	const host = hostname.toLowerCase();
	if (['localhost', 'metadata.google.internal', 'metadata.google', 'instance-data'].includes(host)) return true;
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const [, a, b] = v4.map(Number);
		if (
			a === 0 || a === 10 || a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168)
		) return true;
	}
	const bare = host.replace(/^\[|\]$/g, '');
	if (bare === '::1' || /^(fc|fd)/i.test(bare) || /^fe[89ab]/i.test(bare)) return true;
	return false;
}

async function assertPublicUrl(urlString) {
	const parsed = new URL(urlString);
	if (!/^https?:$/.test(parsed.protocol)) throw new Error('only http(s) urls are supported');
	if (isPrivateOrReservedHost(parsed.hostname)) throw new Error('url targets a private address');
	// DNS-rebinding guard: resolve and re-check the actual address
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) && !parsed.hostname.includes(':')) {
		const { address } = await lookup(parsed.hostname);
		if (isPrivateOrReservedHost(address)) throw new Error('url resolves to a private address');
	}
}

// ── Extraction ───────────────────────────────────────────────────────────────

function metaContent(html, patterns) {
	for (const name of patterns) {
		const re = new RegExp(
			`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`,
			'i',
		);
		const m = html.match(re);
		if (m) return (m[1] || m[2] || '').trim() || null;
	}
	return null;
}

function extractParagraphs(html) {
	// Prefer semantic containers; fall back to the whole document.
	const scoped =
		html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
		html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
		html;
	const cleaned = scoped
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<(nav|header|footer|aside|form|figure)[\s\S]*?<\/\1>/gi, ' ');
	const paragraphs = [];
	for (const m of cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
		const text = stripHtml(m[1]);
		// skip boilerplate fragments (share prompts, cookie banners, bylines-only)
		if (text.length < 40) continue;
		paragraphs.push(text);
		if (paragraphs.length >= 60) break;
	}
	// Some sites (notably CMS-rendered Chinese outlets) use <div> text blocks.
	if (!paragraphs.length) {
		const text = stripHtml(cleaned);
		if (text.length > 200) {
			for (let i = 0; i < text.length && paragraphs.length < 20; i += 400) {
				paragraphs.push(text.slice(i, i + 400));
			}
		}
	}
	return paragraphs;
}

async function fetchArticle(url) {
	await assertPublicUrl(url);
	const resp = await fetch(url, {
		headers: {
			'user-agent': 'Mozilla/5.0 (compatible; three.ws-news/1.0; +https://three.ws)',
			accept: 'text/html,application/xhtml+xml',
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!resp.ok) throw Object.assign(new Error(`source responded ${resp.status}`), { status: resp.status });
	const contentType = resp.headers.get('content-type') || '';
	if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
		throw new Error(`unsupported content type: ${contentType.split(';')[0] || 'unknown'}`);
	}
	const declared = parseInt(resp.headers.get('content-length') || '0', 10);
	if (declared > MAX_RESPONSE_BYTES) throw new Error('article page too large');
	const html = await resp.text();
	if (html.length > MAX_RESPONSE_BYTES) throw new Error('article page too large');
	return html;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

// The platform LLM chain (api/_lib/llm.js) owns provider order, key discovery,
// failover, and spend tracking. Returns null when no provider is configured or
// every provider fails — the caller then serves the extractive analysis below.
async function llmAnalyze(content, title, source) {
	if (!llmConfigured()) return null;
	try {
		const { text, provider } = await llmComplete({
			system: 'You are a crypto news analyst. Respond only with valid JSON, no markdown fence.',
			user: `Analyze this article. Respond as {"summary": "...2-3 sentence summary...", "key_points": ["...", "..."], "sentiment": "bullish|bearish|neutral"}.\n\nTitle: ${title}\nSource: ${source}\n\n${content.slice(0, 6000)}`,
			maxTokens: 700,
			timeoutMs: 15_000,
			track: { tool: 'news_article' },
		});
		const parsed = JSON.parse(stripJsonFence(text));
		if (!parsed.summary) return null;
		return {
			summary: String(parsed.summary).slice(0, 1200),
			key_points: (Array.isArray(parsed.key_points) ? parsed.key_points : [])
				.map((p) => String(p).slice(0, 300))
				.slice(0, 5),
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
	return { summary, key_points, sentiment, provider: 'heuristic' };
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

	const hit = _cache.get(target);
	if (hit && hit.expiresAt > Date.now()) {
		return json(res, 200, hit.value, {
			'cache-control': 'public, max-age=600, s-maxage=1800, stale-while-revalidate=3600',
		});
	}

	// The publisher's own feed copy — trusted metadata, and (for feeds that
	// ship content:encoded) the full article body. Looked up first so a
	// bot-blocked page fetch still yields real content, never a dead end.
	const feedCopy = await findArticle({ link: target }).catch(() => null);

	let html = null;
	let fetchError = null;
	try {
		html = await fetchArticle(target);
	} catch (err) {
		fetchError = err;
	}

	// extraction ladder: publisher page → publisher feed body → preview
	let paragraphs = html ? extractParagraphs(html) : [];
	let extraction = 'page';
	if (paragraphs.length < 2 && feedCopy?.content_text) {
		paragraphs = feedCopy.content_text
			.split(/(?<=[.!?。])\s+(?=[A-Z0-9"“【「])|\n+/)
			.reduce((acc, sentence) => {
				const last = acc[acc.length - 1];
				if (last && last.length + sentence.length < 420) acc[acc.length - 1] = `${last} ${sentence}`;
				else acc.push(sentence);
				return acc;
			}, [])
			.filter((p) => p.trim().length > 20);
		extraction = 'feed';
	} else if (paragraphs.length < 2) {
		extraction = 'preview';
	}

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
	const analysis = (content.length > 300 ? await llmAnalyze(content, title, source) : null) ||
		heuristicAnalyze(paragraphs.length ? paragraphs : [feedCopy?.description || title], title);

	const tickers = extractTickers(`${title} ${content.slice(0, 2000)} ${feedCopy?.description || ''}`);
	let related = [];
	try {
		const relatedQuery = tickers[0] || title.split(/\s+/).slice(0, 3).join(' ');
		const rel = await getNews({ q: relatedQuery, limit: 7 });
		related = rel.articles.filter((a) => a.link !== target).slice(0, 6);
		if (!related.length) {
			// niche story with no keyword siblings — fall back to the latest
			// headlines from the same category (or the front page)
			const fallback = await getNews({ category: feedCopy?.category, limit: 7 });
			related = fallback.articles.filter((a) => a.link !== target).slice(0, 6);
		}
	} catch {
		related = []; // related rail is optional; the article itself already loaded
	}

	const value = {
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
		extraction, // 'page' | 'feed' | 'preview'
		blocked_reason: extraction === 'preview' && fetchError ? String(fetchError.message || 'fetch failed') : null,
		paragraphs,
		content_chars: content.length,
		tickers,
		summary: analysis.summary,
		key_points: analysis.key_points,
		sentiment: analysis.sentiment,
		analysis_provider: analysis.provider,
		related,
		fetched_at: new Date().toISOString(),
	};

	_cache.set(target, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	if (_cache.size > 256) _cache.delete(_cache.keys().next().value);
	return json(res, 200, value, {
		'cache-control': 'public, max-age=600, s-maxage=1800, stale-while-revalidate=3600',
	});
});
