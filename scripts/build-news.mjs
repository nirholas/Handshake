#!/usr/bin/env node
// Generate /news/<slug>.html per curated item + /news/index.html listing
// from data/rss/items.json. Pages are written to public/news/ and inherit
// the site's static-asset pipeline (Vite copies public/ → dist/).
//
// Side effect: writes data/_generated/news-routes.json so the sitemap
// builder (scripts/build-page-index.mjs) can include news entries.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCuratedItems, SITE_ORIGIN, NEWS_PATH_PREFIX } from '../api/_lib/rss-feed.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT_DIR = path.join(ROOT, 'public', 'news');
const ROUTES_FILE = path.join(ROOT, 'data', '_generated', 'news-routes.json');

const SITE_NAME = 'three.ws';
const SITE_TAGLINE = 'Give your AI a body.';
const TWITTER_HANDLE = '@trythreews';

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(s) {
	return escapeHtml(s);
}

function escapeJson(s) {
	return JSON.stringify(String(s));
}

function absoluteUrl(url) {
	if (!url) return '';
	if (/^https?:\/\//i.test(url)) return url;
	return `${SITE_ORIGIN}${url.startsWith('/') ? '' : '/'}${url}`;
}

function formatDate(d) {
	return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function pageCss() {
	return `:root {
\t--bg: #0a0a0c;
\t--bg-soft: #131318;
\t--fg: #f5f5f7;
\t--fg-dim: rgba(245,245,247,0.65);
\t--fg-faint: rgba(245,245,247,0.45);
\t--accent: #ffd76a;
\t--accent-2: #ff8f4d;
\t--border: rgba(255,255,255,0.08);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
\tbackground: var(--bg);
\tcolor: var(--fg);
\tfont-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
\tline-height: 1.7;
\tfont-size: 18px;
\t-webkit-font-smoothing: antialiased;
\t-moz-osx-font-smoothing: grayscale;
}
a { color: var(--accent); text-decoration: none; transition: color .15s; }
a:hover { color: var(--accent-2); text-decoration: underline; }
.topbar {
\tdisplay: flex; justify-content: space-between; align-items: center;
\tpadding: 18px 24px; border-bottom: 1px solid var(--border);
\tbackground: rgba(10,10,12,0.85); backdrop-filter: blur(12px);
\tposition: sticky; top: 0; z-index: 10;
}
.topbar a.brand { display: inline-flex; align-items: center; gap: 9px; color: var(--fg); font-weight: 600; letter-spacing: -0.01em; }
.topbar a.brand img.brand-mark { width: 22px; height: 22px; border-radius: 5px; }
.topbar nav { display: flex; gap: 22px; font-size: 15px; }
.topbar nav a { color: var(--fg-dim); }
.topbar nav a:hover { color: var(--accent); text-decoration: none; }
main { max-width: 720px; margin: 0 auto; padding: 64px 24px 96px; }
.eyebrow {
\tdisplay: inline-flex; align-items: center; gap: 8px;
\tfont-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
\tcolor: var(--fg-faint); margin-bottom: 18px;
}
.eyebrow a { color: var(--fg-faint); }
.eyebrow a:hover { color: var(--accent); text-decoration: none; }
h1.title {
\tfont-size: clamp(32px, 5vw, 52px); line-height: 1.1; letter-spacing: -0.02em;
\tmargin: 0 0 24px; font-weight: 700;
\tbackground: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
\t-webkit-background-clip: text; background-clip: text;
\tcolor: transparent;
}
.meta {
\tdisplay: flex; flex-wrap: wrap; gap: 16px;
\tcolor: var(--fg-dim); font-size: 14px;
\tpadding-bottom: 24px; margin-bottom: 32px;
\tborder-bottom: 1px solid var(--border);
}
.meta time { color: var(--fg); }
.meta .author { color: var(--fg); }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.tag { font-size: 12px; padding: 2px 10px; border-radius: 999px;
\tbackground: rgba(255, 215, 106, 0.08); color: var(--accent); border: 1px solid rgba(255, 215, 106, 0.18); }
.hero { margin: 0 0 40px; border-radius: 12px; overflow: hidden;
\tborder: 1px solid var(--border); }
.hero img { width: 100%; height: auto; display: block; }
article { font-size: 18px; line-height: 1.75; }
article p { margin: 0 0 20px; color: var(--fg); }
article a { color: var(--accent); border-bottom: 1px solid rgba(255, 215, 106, 0.3); }
article a:hover { color: var(--accent-2); border-bottom-color: var(--accent-2); }
article h2 { font-size: 28px; margin: 48px 0 18px; letter-spacing: -0.01em; font-weight: 600; }
article h3 { font-size: 22px; margin: 36px 0 14px; font-weight: 600; }
article ul, article ol { padding-left: 24px; margin: 0 0 20px; }
article li { margin: 8px 0; }
article code { background: var(--bg-soft); padding: 2px 6px; border-radius: 4px; font-size: 0.92em; }
article pre { background: var(--bg-soft); padding: 16px; border-radius: 8px; overflow-x: auto; }
article pre code { background: transparent; padding: 0; }
article blockquote { margin: 24px 0; padding: 12px 20px; border-left: 3px solid var(--accent);
\tbackground: rgba(255, 215, 106, 0.04); color: var(--fg-dim); }
article em { color: var(--fg-dim); }
.footer-actions {
\tmargin-top: 56px; padding-top: 32px; border-top: 1px solid var(--border);
\tdisplay: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; align-items: center;
\tfont-size: 14px; color: var(--fg-dim);
}
.footer-actions a.cta {
\tdisplay: inline-flex; align-items: center; gap: 6px;
\tpadding: 10px 18px; border-radius: 999px;
\tbackground: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
\tcolor: #1a1a1f; font-weight: 600; border: none;
}
.footer-actions a.cta:hover { text-decoration: none; opacity: 0.92; }
.site-footer {
\tmax-width: 720px; margin: 0 auto; padding: 32px 24px 48px;
\ttext-align: center; color: var(--fg-faint); font-size: 13px;
\tborder-top: 1px solid var(--border);
}
.site-footer a { color: var(--fg-dim); }
/* Listing page */
.listing { max-width: 800px; margin: 0 auto; padding: 64px 24px 96px; }
.listing-intro h1 { font-size: clamp(36px, 5vw, 56px); margin: 0 0 16px; letter-spacing: -0.02em;
\tbackground: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
\t-webkit-background-clip: text; background-clip: text; color: transparent; }
.listing-intro p { color: var(--fg-dim); font-size: 18px; max-width: 600px; margin: 0 0 32px; }
.listing-intro .subscribe {
\tdisplay: inline-flex; align-items: center; gap: 6px;
\tpadding: 8px 14px; border-radius: 999px;
\tborder: 1px solid var(--border); color: var(--fg);
\tfont-size: 14px; background: var(--bg-soft); margin-bottom: 48px;
}
.listing-intro .subscribe:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
.post-list { list-style: none; padding: 0; margin: 0; }
.post-list li { padding: 24px 0; border-bottom: 1px solid var(--border); }
.post-list li:last-child { border-bottom: none; }
.post-list a.post-link { display: flex; gap: 20px; color: var(--fg); align-items: flex-start; }
.post-list a.post-link:hover { text-decoration: none; }
.post-list a.post-link:hover .post-title { color: var(--accent); }
.post-list .post-thumb { flex-shrink: 0; width: 140px; height: 88px; border-radius: 8px; overflow: hidden; background: var(--bg-soft); border: 1px solid var(--border); }
.post-list .post-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.post-list .post-body { flex: 1; min-width: 0; }
@media (max-width: 600px) {
\t.post-list a.post-link { flex-direction: column; gap: 14px; }
\t.post-list .post-thumb { width: 100%; height: 180px; }
}
.post-date { color: var(--fg-faint); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
.post-title { font-size: 24px; margin: 6px 0 8px; letter-spacing: -0.01em; font-weight: 600; transition: color .15s; }
.post-summary { color: var(--fg-dim); margin: 0 0 8px; font-size: 16px; }
@media (max-width: 600px) {
\tmain { padding: 40px 20px 64px; }
\t.listing { padding: 40px 20px 64px; }
\t.topbar { padding: 14px 18px; }
\tarticle { font-size: 17px; }
}`;
}

function topbarHtml() {
	return `<header class="topbar">
\t<a class="brand" href="/"><img class="brand-mark" src="/three.svg" alt="three.ws" width="24" height="24" />three.ws</a>
\t<nav>
\t\t<a href="/news">News</a>
\t\t<a href="/discover">Discover</a>
\t\t<a href="/marketplace">Marketplace</a>
\t</nav>
</header>`;
}

function siteFooterHtml() {
	return `<footer class="site-footer">
\t<p>&copy; three.ws &middot; <a href="/">Home</a> &middot; <a href="/news">News</a> &middot; <a href="/rss/announcements.xml">RSS</a> &middot; <a href="https://x.com/trythreews" rel="noopener">X</a> &middot; <a href="https://github.com/nirholas/three.ws" rel="noopener">GitHub</a></p>
</footer>`;
}

function jsonLdArticle(item) {
	const ld = {
		'@context': 'https://schema.org',
		'@type': 'NewsArticle',
		headline: item.title,
		datePublished: item.timestamp.toISOString(),
		dateModified: item.timestamp.toISOString(),
		mainEntityOfPage: { '@type': 'WebPage', '@id': item.permalink },
		author: { '@type': 'Organization', name: item.author, url: SITE_ORIGIN },
		publisher: {
			'@type': 'Organization',
			name: SITE_NAME,
			url: SITE_ORIGIN,
			logo: { '@type': 'ImageObject', url: `${SITE_ORIGIN}/3d.png` },
		},
		description: item.summary,
	};
	if (item.image) ld.image = [absoluteUrl(item.image)];
	if (item.tags?.length) ld.keywords = item.tags.join(', ');
	if (item.externalLink) ld.sameAs = [item.externalLink];
	return JSON.stringify(ld, null, 2);
}

function renderArticlePage(item) {
	const ogTitle = item.ogTitle || item.title;
	const ogDescription = item.ogDescription || item.summary;
	const ogImage = absoluteUrl(item.image || '/3d.png');
	const imageAlt = item.imageAlt || item.title;
	const tagsHtml = item.tags?.length
		? `<div class="tag-list">${item.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
		: '';
	const heroDims = item.imageWidth && item.imageHeight ? ` width="${item.imageWidth}" height="${item.imageHeight}"` : '';
	const heroHtml = item.image
		? `<figure class="hero"><img src="${escapeAttr(item.image)}" alt="${escapeAttr(imageAlt)}" loading="eager" fetchpriority="high"${heroDims}/></figure>`
		: '';
	const externalAttribution = item.externalLink
		? `<p><em>Originally shared on <a href="${escapeAttr(item.externalLink)}" rel="noopener">X</a>.</em></p>`
		: '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(item.title)} — ${escapeHtml(SITE_NAME)}</title>
<meta name="description" content="${escapeAttr(item.summary)}"/>
<link rel="canonical" href="${escapeAttr(item.permalink)}"/>
<link rel="alternate" type="application/rss+xml" title="three.ws news" href="${SITE_ORIGIN}/rss/announcements.xml"/>
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="${escapeAttr(SITE_NAME)}"/>
<meta property="og:title" content="${escapeAttr(ogTitle)}"/>
<meta property="og:description" content="${escapeAttr(ogDescription)}"/>
<meta property="og:url" content="${escapeAttr(item.permalink)}"/>
<meta property="og:image" content="${escapeAttr(ogImage)}"/>
${item.imageWidth && item.imageHeight ? `<meta property="og:image:width" content="${item.imageWidth}"/>\n<meta property="og:image:height" content="${item.imageHeight}"/>` : ''}
${item.imageAlt ? `<meta property="og:image:alt" content="${escapeAttr(item.imageAlt)}"/>` : ''}
<meta property="article:published_time" content="${item.timestamp.toISOString()}"/>
${item.tags?.map((t) => `<meta property="article:tag" content="${escapeAttr(t)}"/>`).join('\n') || ''}
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:site" content="${TWITTER_HANDLE}"/>
<meta name="twitter:creator" content="${TWITTER_HANDLE}"/>
<meta name="twitter:title" content="${escapeAttr(ogTitle)}"/>
<meta name="twitter:description" content="${escapeAttr(ogDescription)}"/>
<meta name="twitter:image" content="${escapeAttr(ogImage)}"/>
<script type="application/ld+json">
${jsonLdArticle(item)}
</script>
<style>${pageCss()}</style>
</head>
<body>
${topbarHtml()}
<main>
\t<div class="eyebrow"><a href="/news">News &amp; Announcements</a></div>
\t<h1 class="title">${escapeHtml(item.title)}</h1>
\t<div class="meta">
\t\t<time datetime="${item.timestamp.toISOString()}">${escapeHtml(formatDate(item.timestamp))}</time>
\t\t<span class="author">${escapeHtml(item.author)}</span>
\t\t${tagsHtml}
\t</div>
\t${heroHtml}
\t<article>
${item.bodyHtml}
${externalAttribution}
\t</article>
\t<div class="footer-actions">
\t\t<a href="/news">&larr; All news</a>
\t\t<a class="cta" href="/" >Visit three.ws &rarr;</a>
\t</div>
</main>
${siteFooterHtml()}
</body>
</html>
`;
}

function renderIndexPage(items) {
	const postsHtml = items
		.map((item) => {
			const thumb = item.image
				? `\t\t\t\t<div class="post-thumb"><img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.imageAlt || item.title)}" loading="lazy"/></div>`
				: '';
			return `\t\t<li class="${item.image ? 'has-thumb' : ''}">
\t\t\t<a class="post-link" href="${escapeAttr(NEWS_PATH_PREFIX)}/${escapeAttr(item.slug)}">
${thumb}
\t\t\t\t<div class="post-body">
\t\t\t\t\t<div class="post-date"><time datetime="${item.timestamp.toISOString()}">${escapeHtml(formatDate(item.timestamp))}</time></div>
\t\t\t\t\t<h2 class="post-title">${escapeHtml(item.title)}</h2>
\t\t\t\t\t<p class="post-summary">${escapeHtml(item.summary)}</p>
${item.tags?.length ? `\t\t\t\t\t<div class="tag-list">${item.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
\t\t\t\t</div>
\t\t\t</a>
\t\t</li>`;
		})
		.join('\n');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>News &amp; Announcements — ${escapeHtml(SITE_NAME)}</title>
<meta name="description" content="Product launches, integrations, and announcements from three.ws — 3D AI agent avatars on-chain."/>
<link rel="canonical" href="${SITE_ORIGIN}${NEWS_PATH_PREFIX}/"/>
<link rel="alternate" type="application/rss+xml" title="three.ws news" href="${SITE_ORIGIN}/rss/announcements.xml"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="${escapeAttr(SITE_NAME)}"/>
<meta property="og:title" content="News &amp; Announcements — ${escapeAttr(SITE_NAME)}"/>
<meta property="og:description" content="Product launches, integrations, and announcements from three.ws."/>
<meta property="og:url" content="${SITE_ORIGIN}${NEWS_PATH_PREFIX}/"/>
<meta property="og:image" content="${SITE_ORIGIN}/3d.png"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:site" content="${TWITTER_HANDLE}"/>
<style>${pageCss()}</style>
</head>
<body>
${topbarHtml()}
<section class="listing">
\t<div class="listing-intro">
\t\t<h1>News &amp; Announcements</h1>
\t\t<p>Product launches, integrations, and announcements from three.ws &mdash; 3D AI agent avatars on-chain.</p>
\t\t<a class="subscribe" href="/rss/announcements.xml" rel="alternate" type="application/rss+xml">Subscribe via RSS &rarr;</a>
\t</div>
\t<ul class="post-list">
${postsHtml}
\t</ul>
</section>
${siteFooterHtml()}
</body>
</html>
`;
}

async function ensureDir(dir) {
	await mkdir(dir, { recursive: true });
}

// Write all permalink HTML pages + listing index + sitemap routes file
// from a pre-loaded items array. Exported so the admin handler can
// regenerate output on save without spawning a subprocess.
export async function writeAllPages(items, { outDir = OUT_DIR, routesFile = ROUTES_FILE } = {}) {
	if (!items.length) return { written: 0, routes: 0 };
	await ensureDir(outDir);
	await ensureDir(path.dirname(routesFile));

	let written = 0;
	for (const item of items) {
		const html = renderArticlePage(item);
		await writeFile(path.join(outDir, `${item.slug}.html`), html, 'utf8');
		written++;
	}

	const indexHtml = renderIndexPage(items);
	await writeFile(path.join(outDir, 'index.html'), indexHtml, 'utf8');

	const routes = [
		{
			path: `${NEWS_PATH_PREFIX}/`,
			title: 'News & Announcements',
			description: 'Product launches, integrations, and announcements from three.ws.',
			lastmod: items[0].timestamp.toISOString().slice(0, 10),
			priority: 0.8,
			changefreq: 'weekly',
		},
		...items.map((item) => ({
			path: `${NEWS_PATH_PREFIX}/${item.slug}`,
			title: item.title,
			description: item.summary,
			lastmod: item.timestamp.toISOString().slice(0, 10),
			priority: 0.6,
			changefreq: 'yearly',
		})),
	];
	await writeFile(routesFile, JSON.stringify(routes, null, 2) + '\n', 'utf8');

	return { written, routes: routes.length };
}

export { renderArticlePage, renderIndexPage };

async function main() {
	const items = await loadCuratedItems();
	if (!items.length) {
		console.warn('No curated items found — skipping news page generation.');
		return;
	}
	const { written, routes } = await writeAllPages(items);
	console.log(`Wrote ${written} article page(s) + index to ${OUT_DIR}`);
	console.log(`Wrote ${routes} route(s) to ${ROUTES_FILE}`);
}

// Run main() only when invoked as a script (preserves CLI behavior;
// admin handler imports writeAllPages without triggering this).
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error('[build-news] failed:', err);
		process.exit(1);
	});
}
