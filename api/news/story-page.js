// GET /markets/news/<YYYY-MM>/<id16>[-slug]  →  /api/news/story-page?month=&id=
// ---------------------------------------------------------------------------
// Server-rendered story page — the indexable permalink for every article in
// the live feed AND the 660k+ historical archive. The query-param reader
// (/markets/news/article?url=…) stays noindex; THIS page is what crawlers and
// link previews get: real <title>/description/canonical/OpenGraph tags,
// NewsArticle JSON-LD, and a crawler-visible article body (headline, byline,
// story summary, ticker links into /coin/:id, market context at publication,
// source attribution) rendered into the same shell the client reader hydrates.
//
// The client module (src/news-article.js) finds the embedded #art-seed JSON,
// keeps the server-rendered content on screen, and upgrades it in place with
// the full extraction + AI analysis from /api/news/article. No JS → a crawler
// still reads a complete, honest page.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { resolveStory, validStoryKey } from '../_lib/news-story.js';
import { storyPath, tickerHref, TICKER_COIN_IDS } from '../../src/shared/news-links.js';

const ORIGIN = env.APP_ORIGIN || 'https://three.ws';
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;

const _pages = new Map(); // `${month}/${id}` → { html, status, expiresAt }
let _shell = null;

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

async function loadShell() {
	if (_shell) return _shell;
	// dist/ in production (the built shell with hashed asset paths); pages/ in
	// a source-only checkout so tests and `node server` before a build still work.
	for (const file of [
		path.join(process.cwd(), 'dist', 'news-article.html'),
		path.join(process.cwd(), 'pages', 'news-article.html'),
	]) {
		try {
			_shell = await readFile(file, 'utf8');
			return _shell;
		} catch {
			// try next
		}
	}
	throw new Error('news-article shell not found (dist/ or pages/)');
}

// Replace the content="…" of every <meta> whose property/name matches `key`,
// tolerating either attribute order. Values are pre-escaped by the caller.
function setMetaContent(html, key, value) {
	return html.replace(/<meta\b[^>]*>/g, (tag) =>
		new RegExp(`(?:property|name)=["']${key}["']`).test(tag)
			? tag.replace(/content=["'][^"']*["']/, () => `content="${value}"`)
			: tag,
	);
}

function fmtDate(iso) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? null
		: d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtUsd(n) {
	if (typeof n !== 'number' || !Number.isFinite(n)) return null;
	return `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
}

function jsonLd(a, canonicalAbs, ogImage) {
	const graph = {
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'NewsArticle',
				headline: a.title,
				datePublished: a.pub_date || undefined,
				image: [a.image || ogImage],
				inLanguage: a.lang === 'zh' ? 'zh' : 'en',
				author: { '@type': 'Organization', name: a.source },
				publisher: { '@type': 'Organization', name: 'three.ws', url: ORIGIN },
				mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalAbs },
				isBasedOn: a.link || undefined,
				description: a.description || undefined,
				about: (a.tickers || []).map((t) => ({ '@type': 'Thing', name: t })),
			},
			{
				'@type': 'BreadcrumbList',
				itemListElement: [
					{ '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
					{ '@type': 'ListItem', position: 2, name: 'Markets', item: `${ORIGIN}/markets` },
					{ '@type': 'ListItem', position: 3, name: 'News', item: `${ORIGIN}/markets/news` },
					{ '@type': 'ListItem', position: 4, name: a.title, item: canonicalAbs },
				],
			},
		],
	};
	return JSON.stringify(graph).replace(/</g, '\\u003c');
}

function marketContextHtml(mc) {
	if (!mc) return '';
	const parts = [];
	if (fmtUsd(mc.btc_price)) parts.push(`BTC ${fmtUsd(mc.btc_price)}`);
	if (fmtUsd(mc.eth_price)) parts.push(`ETH ${fmtUsd(mc.eth_price)}`);
	if (mc.fear_greed_index != null) parts.push(`Fear &amp; Greed ${esc(mc.fear_greed_index)}`);
	if (!parts.length) return '';
	return `<p class="art-provider">Market at publication: ${parts.join(' · ')}</p>`;
}

function crawlerBodyHtml(a) {
	const sentiment = a.sentiment?.label || 'neutral';
	const badgeCls = sentiment.includes('positive') ? 'bullish' : sentiment.includes('negative') ? 'bearish' : '';
	const date = fmtDate(a.pub_date);
	const chips = (a.tickers || [])
		.map((t) => {
			const known = TICKER_COIN_IDS[t];
			return `<a class="nw-chip" href="${esc(tickerHref(t))}" aria-label="${known ? `${esc(t)} price and profile` : `More ${esc(t)} coverage`}">${esc(t)}</a>`;
		})
		.join('');
	return `
		${a.image ? `<div class="art-hero"><img src="${esc(a.image)}" alt="" data-fallback="${esc((a.source || '?').slice(0, 2).toUpperCase())}" /></div>` : ''}
		<h1 class="art-title">${esc(a.title)}</h1>
		<div class="art-byline">
			<span class="src">${esc(a.source)}</span>
			${a.author ? `<span>${esc(a.author)}</span>` : ''}
			${date ? `<time datetime="${esc(a.pub_date)}">${esc(date)}</time>` : ''}
			<span class="art-badge ${badgeCls}">${badgeCls === 'bullish' ? '▲' : badgeCls === 'bearish' ? '▼' : '◆'} ${esc(sentiment.replace('_', ' '))}</span>
		</div>
		${chips ? `<div class="nw-chips" style="margin:0 0 1.25rem">${chips}</div>` : ''}
		<div class="art-summary-card">
			<h2>Story</h2>
			<p>${esc(a.description || a.title)}</p>
			${marketContextHtml(a.market_context)}
		</div>
		<p style="margin:1.75rem 0 0">
			${a.link ? `<a class="art-cta" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Read at ${esc(a.source)}</a>` : ''}
		</p>
		<p style="margin-top:0.75rem"><a class="mkt-more" href="/markets/news">← All crypto news</a> · <a class="mkt-more" href="/markets/archive">Search the archive</a></p>`;
}

/** Pure shell → page transform, exported for tests. */
export function renderStoryHtml(shell, a) {
	const canonical = storyPath(a);
	const canonicalAbs = `${ORIGIN}${canonical}`;
	const description = (a.description || `${a.title} — ${a.source} coverage on the three.ws crypto news reader.`).slice(0, 300);
	const ogFallback = `${ORIGIN}/api/page-og?s=crypto&t=${encodeURIComponent(a.title.slice(0, 80))}&d=${encodeURIComponent(description.slice(0, 160))}&p=${encodeURIComponent(canonical)}`;
	const ogImage = a.image || ogFallback;
	const date = fmtDate(a.pub_date);
	const title = `${a.title} — ${a.source}${date ? `, ${date}` : ''} · three.ws`;

	let html = shell.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`);
	html = setMetaContent(html, 'description', esc(description));
	html = setMetaContent(html, 'robots', 'index, follow');
	html = setMetaContent(html, 'og:title', esc(a.title));
	html = setMetaContent(html, 'og:description', esc(description));
	html = setMetaContent(html, 'og:image', esc(ogImage));
	html = setMetaContent(html, 'og:url', esc(canonicalAbs));
	html = setMetaContent(html, 'og:image:alt', esc(a.title));
	html = setMetaContent(html, 'twitter:title', esc(a.title));
	html = setMetaContent(html, 'twitter:description', esc(description));
	html = setMetaContent(html, 'twitter:image', esc(ogImage));
	html = html.replace(/(<link[^>]*rel="canonical"[^>]*href=")[^"]*(")/, (_, pre, post) => `${pre}${esc(canonicalAbs)}${post}`);
	html = html.replace(
		/<script type="application\/ld\+json">[\s\S]*?<\/script>/,
		() => `<script type="application/ld+json">${jsonLd(a, canonicalAbs, ogImage)}</script>`,
	);
	const articleMeta =
		(a.pub_date ? `\t<meta property="article:published_time" content="${esc(a.pub_date)}">\n` : '') +
		`\t<meta property="article:section" content="${esc(a.category || 'general')}">\n` +
		(a.tickers || []).map((t) => `\t<meta property="article:tag" content="${esc(t)}">`).join('\n');
	html = html.replace('</head>', () => `${articleMeta}\n</head>`);

	// Seed for the client reader (instant paint + the /api/news/article call),
	// then the crawler-visible body it hydrates over.
	const seed = {
		id: a.id,
		url: a.link,
		title: a.title,
		source: a.source,
		image: a.image || null,
		author: a.author || null,
		description: a.description || null,
		pub_date: a.pub_date || null,
		tickers: a.tickers || [],
		sentiment: a.sentiment || null,
		market_context: a.market_context || null,
		canonical,
	};
	html = html.replace(
		/<article id="art-root"[^>]*>[\s\S]*?<\/article>/,
		() =>
			`<script type="application/json" id="art-seed">${JSON.stringify(seed).replace(/</g, '\\u003c')}</script>\n` +
			`\t\t\t<article id="art-root" aria-live="polite">${crawlerBodyHtml(a)}</article>`,
	);
	return html;
}

function notFoundHtml(shell, month, slug) {
	// The slug in the URL is the story's own title words — turn the dead link
	// into a ready-made archive search instead of a dead end.
	const q = String(slug || '').replace(/-/g, ' ').trim();
	const searchHref = q ? `/markets/archive?q=${encodeURIComponent(q)}` : '/markets/archive';
	const body = `
		<h1 class="art-title">Story not found</h1>
		<div class="cv-empty">
			<p><strong>This article isn’t in the ${esc(month || '')} archive.</strong></p>
			<p>It may have been published in a different month, or the link is incomplete.</p>
			<p><a class="arc-btn" href="${esc(searchHref)}">${q ? `Search the archive for “${esc(q)}”` : 'Search the 660k-article archive'}</a>
			<a class="arc-btn ghost" href="/markets/news">Latest crypto news</a></p>
		</div>`;
	return shell
		.replace(/<title>[\s\S]*?<\/title>/, () => `<title>Story not found · Crypto News · three.ws</title>`)
		.replace(/<article id="art-root"[^>]*>[\s\S]*?<\/article>/, () => `<article id="art-root">${body}</article>`);
}

export default wrap(async (req, res) => {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.statusCode = 405;
		res.setHeader('allow', 'GET, HEAD');
		res.end('Method Not Allowed');
		return;
	}
	const params = new URL(req.url, 'http://x').searchParams;
	const month = (params.get('month') || req.query?.month || '').trim();
	const id = (params.get('id') || req.query?.id || '').trim().toLowerCase();

	const shell = await loadShell();
	res.setHeader('content-type', 'text/html; charset=utf-8');

	if (!validStoryKey(month, id)) {
		res.statusCode = 404;
		res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
		res.end(notFoundHtml(shell, month));
		return;
	}

	const key = `${month}/${id}`;
	const hit = _pages.get(key);
	if (hit && hit.expiresAt > Date.now()) {
		res.statusCode = hit.status;
		res.setHeader('cache-control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
		res.end(hit.html);
		return;
	}

	const resolved = await resolveStory(month, id);
	// A resolvable story always has a canonical path; a dated-but-unlinkable
	// record (no id/date after compaction) can't reach here because the route
	// carries both. Missing → an honest 404, cached briefly.
	const canonical = resolved ? storyPath(resolved.article) : null;
	if (canonical && !canonical.startsWith(`/markets/news/${month}/`)) {
		// The story exists but lives in a different month (boundary drift or a
		// revised pub_date) — send crawlers and readers to the canonical URL.
		res.statusCode = 301;
		res.setHeader('location', canonical);
		res.setHeader('cache-control', 'public, max-age=300, s-maxage=3600');
		res.end();
		return;
	}
	const status = canonical ? 200 : 404;
	const html = status === 200 ? renderStoryHtml(shell, resolved.article) : notFoundHtml(shell, month, params.get('slug') || req.query?.slug || '');

	_pages.set(key, { html, status, expiresAt: Date.now() + (status === 200 ? CACHE_TTL_MS : 60_000) });
	if (_pages.size > CACHE_MAX) _pages.delete(_pages.keys().next().value);

	res.statusCode = status;
	res.setHeader(
		'cache-control',
		status === 200 ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' : 'public, max-age=60, s-maxage=300',
	);
	res.end(html);
});
