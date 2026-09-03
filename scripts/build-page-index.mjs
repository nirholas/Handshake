#!/usr/bin/env node
/**
 * Generate every public discovery surface from data/pages.json — the single
 * source of truth for "what exists on three.ws". Edit pages.json; never edit
 * the generated files (they carry a DO-NOT-EDIT banner and get overwritten).
 *
 *   public/llms.txt             — AI-agent index (Jeremy Howard convention)
 *   public/llms-full.txt        — expanded, prose-friendly variant
 *   public/sitemap/index.html   — human-readable site map at /sitemap
 *   public/features.json        — machine manifest served at /api/features.json
 *   CHANGELOG.md                — page launches (`added` dates) merged with
 *                                 curated entries from data/changelog.json
 *   public/changelog.json       — machine-readable changelog feed at /changelog.json
 *   public/changelog.xml        — RSS feed of the same entries at /changelog.xml
 *
 * Note: the crawler sitemap.xml is NO LONGER static. It's served dynamically
 * by /api/sitemap (index) + /api/sitemap/[type] (per-entity), which augments
 * these curated routes with every agent / avatar / widget / profile from the
 * database. The /api/sitemap core route reads this same pages.json so there's
 * still one source of truth for the static portion.
 *
 * Run via `npm run build:pages` or automatically before `vite build`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataFile = resolve(root, 'data/pages.json');
const publicDir = resolve(root, 'public');
const newsRoutesFile = resolve(root, 'data/_generated/news-routes.json');
const newsSourceFile = resolve(root, 'data/rss/items.json');

// Last gate before public output: the house style bans the em-dash and en-dash
// glyphs everywhere, but titles and summaries are hand-authored in
// data/pages.json and data/changelog.json by many hands. Rather than hope every
// author types the right character, normalize on the way out so no generated
// surface (CHANGELOG.md, llms-full.txt, the RSS feed, features.json) can carry
// one. A spaced hyphen is the allowed substitute and never changes the meaning.
// Every rewrite is reported so the underlying data still gets cleaned up.
const dashHits = [];
function plain(value, where) {
	if (typeof value !== 'string' || !/[—–]/.test(value)) return value;
	if (where) dashHits.push(where);
	return value
		.replace(/\s*[—–]\s*/g, ' - ')
		.replace(/ {2,}/g, ' ')
		.trim();
}
// Recursively normalize every string in a parsed data file.
function plainDeep(node, where) {
	if (typeof node === 'string') return plain(node, where);
	if (Array.isArray(node)) return node.map((n) => plainDeep(n, where));
	if (node && typeof node === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(node)) out[k] = plainDeep(v, where);
		return out;
	}
	return node;
}

const data = plainDeep(JSON.parse(readFileSync(dataFile, 'utf8')), 'data/pages.json');
const { site } = data;
const sections = [...data.sections];

// Curated changelog entries — the editorial layer on top of page launches.
// Validated hard: a malformed entry should fail the build, not ship garbage
// to holders.
const changelogFile = resolve(root, 'data/changelog.json');
const CHANGELOG_TAGS = new Set(['feature', 'improvement', 'fix', 'sdk', 'infra', 'docs', 'security']);
const curatedEntries = plainDeep(JSON.parse(readFileSync(changelogFile, 'utf8')).entries, 'data/changelog.json');
for (const e of curatedEntries) {
	const ctx = `data/changelog.json entry "${e.title || '?'}" (${e.date || 'no date'})`;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) throw new Error(`${ctx}: date must be YYYY-MM-DD`);
	if (!e.title || !e.summary) throw new Error(`${ctx}: title and summary are required`);
	if (!Array.isArray(e.tags) || e.tags.length === 0) throw new Error(`${ctx}: at least one tag required`);
	for (const t of e.tags) {
		if (!CHANGELOG_TAGS.has(t)) throw new Error(`${ctx}: unknown tag "${t}" (allowed: ${[...CHANGELOG_TAGS].join(', ')})`);
	}
}

// Splice in the "News" section so news entries appear in the sitemap,
// llms.txt, and the human-readable /sitemap page.
//
// The routes file (data/_generated/news-routes.json) is a gitignored
// artifact produced by scripts/build-news.mjs from data/rss/items.json.
// Running this script standalone (e.g. `npm run build:pages`) in a tree
// where build-news hasn't run leaves that file absent — and a naive
// existsSync skip would then silently emit every export with the entire
// News section stripped out, deleting hundreds of real entries. Treat a
// missing routes file as an out-of-order build and regenerate it from the
// committed source rather than dropping the data on the floor.
if (!existsSync(newsRoutesFile) && existsSync(newsSourceFile)) {
	console.warn('[build-page-index] news-routes.json missing — running build-news.mjs to regenerate it before splicing News.');
	execFileSync('node', [resolve(here, 'build-news.mjs')], { stdio: 'inherit', cwd: root });
}
if (existsSync(newsRoutesFile)) {
	const newsRoutes = plainDeep(JSON.parse(readFileSync(newsRoutesFile, 'utf8')), 'data/rss/items.json');
	// The news index (/news) is already declared by hand in data/pages.json, so
	// splicing the generated route for it verbatim would list the same page
	// twice on /sitemap and emit a duplicate <loc> in every derived export.
	const declared = new Set(sections.flatMap((s) => s.pages.map((p) => p.path)));
	const spliced = newsRoutes.filter((r) => !declared.has(r.path));
	if (Array.isArray(newsRoutes) && spliced.length) {
		sections.push({
			id: 'news',
			title: 'News',
			description: 'Product launches, integrations, and announcements from three.ws.',
			pages: spliced.map((r) => ({
				path: r.path,
				title: r.title,
				description: r.description,
				priority: r.priority,
				changefreq: r.changefreq,
				lastmod: r.lastmod,
			})),
		});
	}
}
const baseUrl = site.url.replace(/\/$/, '');

const allPages = sections.flatMap((s) =>
	s.pages.map((p) => ({ ...p, section: s })),
);

const indexable = (p) =>
	p.indexable !== false && !p.path.startsWith('/.') && !p.path.endsWith('.xml') && !p.path.endsWith('.txt') && !p.path.endsWith('.json');

const escapeHtml = (s) =>
	String(s).replace(/[<>&"]/g, (c) => ({
		'<': '&lt;',
		'>': '&gt;',
		'&': '&amp;',
		'"': '&quot;',
	})[c]);

// ────────────────────────────────────────────────────────────────────────
// llms.txt — concise AI index per https://llmstxt.org/
// ────────────────────────────────────────────────────────────────────────
function buildLlmsTxt() {
	const lines = [];
	lines.push(`# ${site.name}`);
	lines.push('');
	lines.push(`> ${site.description}`);
	lines.push('');
	lines.push(`Tagline: ${site.tagline}`);
	lines.push(`Site: ${baseUrl}`);
	if (site.github) lines.push(`Source: ${site.github}`);
	if (site.contact) lines.push(`Contact: ${site.contact}`);
	lines.push('');
	// The machine-readable section leads, and skips the `indexable` filter its
	// entries all carry (they are excluded from the crawler sitemap, not from
	// agents): an AI reading this file should learn the MCP servers, the x402
	// catalog, and the agent card before the human page list.
	const machine = sections.find((s) => s.id === 'machine');
	if (machine) {
		lines.push('## For AI agents');
		lines.push('');
		lines.push('Machine-readable entry points. Fetch these instead of scraping HTML.');
		lines.push('');
		for (const p of machine.pages) {
			lines.push(`- [${p.title}](${baseUrl}${p.path}): ${p.description}`);
		}
		lines.push('');
	}
	for (const section of sections) {
		if (section.id === 'machine') continue;
		const pages = section.pages.filter(indexable);
		if (!pages.length) continue;
		lines.push(`## ${section.title}`);
		if (section.description) lines.push('');
		if (section.description) lines.push(section.description);
		lines.push('');
		for (const p of pages) {
			lines.push(`- [${p.title}](${baseUrl}${p.path}): ${p.description}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// llms-full.txt — same data, more prose; includes machine-readable section
// ────────────────────────────────────────────────────────────────────────
function buildLlmsFull() {
	const lines = [];
	lines.push(`# ${site.name}: Complete Page Index`);
	lines.push('');
	lines.push(site.description);
	lines.push('');
	lines.push(`Canonical site: ${baseUrl}`);
	lines.push(`Tagline: ${site.tagline}`);
	if (site.github) lines.push(`Source code: ${site.github}`);
	if (site.contact) lines.push(`Contact / social: ${site.contact}`);
	lines.push('');
	lines.push('This file is generated from data/pages.json. It lists every public surface on the site, grouped by section, so AI agents and crawlers can navigate without scraping the home page.');
	lines.push('');
	for (const section of sections) {
		lines.push(`## ${section.title}`);
		lines.push('');
		if (section.description) {
			lines.push(section.description);
			lines.push('');
		}
		for (const p of section.pages) {
			const url = p.path.startsWith('http') ? p.path : baseUrl + p.path;
			lines.push(`### ${p.title}`);
			lines.push('');
			lines.push(`URL: ${url}`);
			if (p.auth === 'required') lines.push('Auth: required (sign-in)');
			if (p.indexable === false) lines.push('Indexable: no (excluded from sitemap)');
			lines.push('');
			lines.push(p.description);
			lines.push('');
		}
	}
	return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// /sitemap HTML page (human-readable)
// ────────────────────────────────────────────────────────────────────────
function buildSitemapHtml() {
	const totalPages = sections.reduce((n, s) => n + s.pages.length, 0);

	// "Newest" strip: the most recently added public pages, so what just
	// shipped is visible without scanning every section. News articles are
	// excluded (they have their own feed and would drown product launches).
	const NEWEST_COUNT = 9;
	const fmtAdded = (iso) =>
		new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
	const newestPages = sections
		.filter((s) => s.id !== 'news')
		.flatMap((s) => s.pages)
		.filter((p) => p.added && p.indexable !== false)
		.sort((a, b) => b.added.localeCompare(a.added))
		.slice(0, NEWEST_COUNT);
	const newestHtml = newestPages
		.map((p) => `\t\t\t\t<li>
\t\t\t\t\t<a href="${escapeHtml(p.path)}">
\t\t\t\t\t\t<span class="sm-new-date">${escapeHtml(fmtAdded(p.added))}</span>
\t\t\t\t\t\t<span class="sm-title">${escapeHtml(p.title)}${p.auth === 'required' ? '<span class="sm-badge sm-badge-auth">sign-in</span>' : ''}</span>
\t\t\t\t\t\t<span class="sm-path">${escapeHtml(p.path)}</span>
\t\t\t\t\t\t<span class="sm-desc">${escapeHtml(p.description)}</span>
\t\t\t\t\t</a>
\t\t\t\t</li>`)
		.join('\n');

	const sectionHtml = sections
		.map((section) => {
			const items = section.pages
				.map((p) => {
					const url = p.path.startsWith('http') ? p.path : p.path;
					const badges = [];
					if (p.auth === 'required') badges.push('<span class="sm-badge sm-badge-auth">sign-in</span>');
					if (p.indexable === false) badges.push('<span class="sm-badge sm-badge-internal">internal</span>');
					return `\t\t\t\t<li>
\t\t\t\t\t<a href="${escapeHtml(url)}">
\t\t\t\t\t\t<span class="sm-title">${escapeHtml(p.title)}${badges.join('')}</span>
\t\t\t\t\t\t<span class="sm-path">${escapeHtml(p.path)}</span>
\t\t\t\t\t\t<span class="sm-desc">${escapeHtml(p.description)}</span>
\t\t\t\t\t</a>
\t\t\t\t</li>`;
				})
				.join('\n');
			return `\t\t<section class="sm-section" id="${escapeHtml(section.id)}">
\t\t\t<header>
\t\t\t\t<h2>${escapeHtml(section.title)}<span class="sm-count" data-count>${section.pages.length}</span></h2>
\t\t\t\t${section.description ? `<p class="sm-section-desc">${escapeHtml(section.description)}</p>` : ''}
\t\t\t</header>
\t\t\t<ul class="sm-list">
${items}
\t\t\t</ul>
\t\t</section>`;
		})
		.join('\n\n');

	const tocHtml = sections
		.map((s) => `\t\t\t<a href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a>`)
		.join('\n');

	// Copy comes from the catalog entry for /sitemap, not a second hardcoded
	// string: this file is regenerated on every run, so any drift from the
	// catalog would be re-applied by scripts/inject-seo-meta.mjs and undone here
	// on the next build, leaving the pair permanently out of sync.
	const sitemapEntry = allPages.find((p) => p.path === '/sitemap');
	const sitemapTitle = sitemapEntry?.title || 'Sitemap';
	const sitemapDescription =
		sitemapEntry?.description || `Complete index of every public page on ${site.name}.`;
	const sitemapOgImage = `${baseUrl}/api/page-og?${new URLSearchParams({
		s: sitemapEntry?.section?.id || 'main',
		t: sitemapTitle,
		d: sitemapDescription,
		p: '/sitemap',
	})}`;
	const sitemapJsonLd = JSON.stringify({
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'WebPage',
				name: sitemapTitle,
				description: sitemapDescription,
				url: `${baseUrl}/sitemap`,
				isPartOf: { '@type': 'WebSite', name: site.name, url: baseUrl },
				primaryImageOfPage: sitemapOgImage,
			},
		],
	}).replace(/</g, '\\u003c');

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(sitemapTitle)} · ${escapeHtml(site.name)}</title>
<meta name="description" content="${escapeHtml(sitemapDescription)}" />
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
<link rel="canonical" href="${escapeHtml(baseUrl)}/sitemap" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${escapeHtml(site.name)}" />
<meta property="og:locale" content="en_US" />
<meta property="og:url" content="${escapeHtml(baseUrl)}/sitemap" />
<meta property="og:title" content="${escapeHtml(sitemapTitle)} · ${escapeHtml(site.name)}" />
<meta property="og:description" content="${escapeHtml(sitemapDescription)}" />
<meta property="og:image" content="${escapeHtml(sitemapOgImage)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:alt" content="${escapeHtml(sitemapTitle)} - ${escapeHtml(site.name)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@trythreews" />
<meta name="twitter:title" content="${escapeHtml(sitemapTitle)} · ${escapeHtml(site.name)}" />
<meta name="twitter:description" content="${escapeHtml(sitemapDescription)}" />
<meta name="twitter:image" content="${escapeHtml(sitemapOgImage)}" />
<script type="application/ld+json">${sitemapJsonLd}</script>
<link rel="alternate" type="application/xml" title="XML sitemap" href="/sitemap.xml" />
<link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt" />
<link rel="stylesheet" href="/nav.css" />
<link rel="stylesheet" href="/footer.css" />
<style>
\t:root { color-scheme: dark; }
\tbody { margin: 0; background: #060611; color: #e7e7f5; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
\t.sm-wrap { max-width: 1080px; margin: 0 auto; padding: 96px 24px 64px; }
\t.sm-hero { margin-bottom: 48px; }
\t.sm-hero h1 { font-size: clamp(34px, 5vw, 56px); margin: 0 0 12px; letter-spacing: -0.02em; }
\t.sm-hero p { color: #b6b6cf; font-size: 17px; max-width: 64ch; margin: 0; line-height: 1.55; }
\t.sm-formats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
\t.sm-formats a { padding: 6px 12px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; color: #d8d8ee; text-decoration: none; font-size: 13px; background: rgba(255,255,255,.02); transition: background .15s, border-color .15s; }
\t.sm-formats a:hover { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.24); }
\t.sm-formats code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9ad4ff; }
\t.sm-filter { position: sticky; top: 12px; z-index: 5; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; background: rgba(9,9,22,.88); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); margin-bottom: 12px; transition: border-color .15s, box-shadow .15s; }
\t.sm-filter:focus-within { border-color: rgba(150,170,255,.45); box-shadow: 0 0 0 3px rgba(120,140,255,.12); }
\t.sm-filter svg { width: 16px; height: 16px; color: #7a85a8; flex-shrink: 0; }
\t.sm-filter input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: #e7e7f5; font: inherit; font-size: 15px; }
\t.sm-filter input::placeholder { color: #5b5b78; }
\t.sm-filter input::-webkit-search-cancel-button { cursor: pointer; }
\t.sm-filter kbd { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px; border: 1px solid rgba(255,255,255,.14); border-radius: 4px; font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #7a85a8; }
\t.sm-filter-count { color: #9b9bb7; font-size: 13px; margin: 0 0 20px; min-height: 18px; padding: 0 4px; }
\t.sm-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 64px 24px; border: 1px dashed rgba(255,255,255,.12); border-radius: 16px; text-align: center; }
\t.sm-empty p { margin: 0; color: #b6b6cf; font-size: 15px; }
\t.sm-empty .sm-empty-hint { color: #7a85a8; font-size: 13px; }
\t.sm-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 6px; }
\t.sm-empty-actions button, .sm-empty-actions a { font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.03); color: #d8d8ee; text-decoration: none; cursor: pointer; transition: background .15s, border-color .15s, color .15s; }
\t.sm-empty-actions button:hover, .sm-empty-actions a:hover { background: rgba(120,140,255,.10); border-color: rgba(150,170,255,.38); color: #fff; }
\t.sm-empty-actions button:active, .sm-empty-actions a:active { transform: translateY(1px); }
\t.sm-empty-actions :focus-visible { outline: 2px solid #9ad4ff; outline-offset: 2px; }
\t.sm-empty kbd { display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border: 1px solid rgba(255,255,255,.14); border-radius: 4px; font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9ad4ff; }
\t.sm-count { display: inline-flex; align-items: center; margin-left: 10px; padding: 2px 9px; border-radius: 999px; background: rgba(255,255,255,.06); color: #9b9bb7; font-size: 12px; font-weight: 600; vertical-align: 3px; }
\t@media (max-width: 640px) { .sm-filter kbd { display: none; } }
\t.sm-toc { display: flex; flex-wrap: wrap; gap: 6px 8px; padding: 14px 16px; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; background: rgba(255,255,255,.02); margin-bottom: 56px; }
\t.sm-toc a { color: #cfd0e8; text-decoration: none; font-size: 13px; padding: 4px 10px; border-radius: 999px; }
\t.sm-toc a:hover { background: rgba(255,255,255,.06); color: #fff; }
\t.sm-section { margin-bottom: 56px; scroll-margin-top: 80px; }
\t.sm-section h2 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
\t.sm-section-desc { color: #9b9bb7; margin: 0 0 18px; font-size: 14px; }
\t.sm-list { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
\t.sm-list li { display: block; }
\t.sm-list a { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; background: rgba(255,255,255,.015); color: inherit; text-decoration: none; transition: background .15s, border-color .15s, transform .15s; }
\t.sm-list a:hover { background: rgba(120,140,255,.06); border-color: rgba(150,170,255,.30); transform: translateY(-1px); }
\t.sm-title { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; }
\t.sm-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #7a85a8; }
\t.sm-desc { color: #b6b6cf; font-size: 13px; line-height: 1.45; }
\t.sm-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
\t.sm-badge-auth { background: rgba(255, 200, 80, .15); color: #ffcf66; }
\t.sm-badge-internal { background: rgba(120,200,255,.12); color: #9ad4ff; }
\t.sm-new { margin-bottom: 56px; }
\t.sm-new h2 { display: flex; align-items: baseline; gap: 12px; font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
\t.sm-new-more { font-size: 13px; font-weight: 500; color: #9ad4ff; text-decoration: none; }
\t.sm-new-more:hover { text-decoration: underline; }
\t.sm-new .sm-list a { border-color: rgba(150,170,255,.18); background: rgba(120,140,255,.04); }
\t.sm-new .sm-list a:hover { border-color: rgba(150,170,255,.40); }
\t.sm-new-date { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #7fd6a2; }
</style>
</head>
<body>
\t<header><div id="nav-container"></div></header>
\t<main class="sm-wrap">
\t\t<div class="sm-hero">
\t\t\t<h1>Sitemap</h1>
\t\t\t<p>All ${totalPages} pages on ${escapeHtml(site.name)}, grouped by purpose. Looking for the machine-readable versions?</p>
\t\t\t<div class="sm-formats">
\t\t\t\t<a href="/sitemap.xml"><code>sitemap.xml</code> · for search engines</a>
\t\t\t\t<a href="/llms.txt"><code>llms.txt</code> · for AI agents</a>
\t\t\t\t<a href="/llms-full.txt"><code>llms-full.txt</code> · long form</a>
\t\t\t\t<a href="/api/features.json"><code>features.json</code> · machine manifest</a>
\t\t\t\t<a href="/changelog"><code>changelog</code> · what's new</a>
\t\t\t\t<a href="/openapi.json"><code>openapi.json</code> · HTTP API</a>
\t\t\t</div>
\t\t</div>
\t\t<div class="sm-filter">
\t\t\t<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
\t\t\t<input id="sm-filter-input" type="search" placeholder="Filter ${totalPages} pages by name, path, or description…" aria-label="Filter pages" autocomplete="off" spellcheck="false" />
\t\t\t<kbd aria-hidden="true">/</kbd>
\t\t</div>
\t\t<p class="sm-filter-count" id="sm-filter-count" role="status" aria-live="polite"></p>
\t\t<section class="sm-new" id="sm-new" aria-labelledby="sm-new-title">
\t\t\t<h2 id="sm-new-title">Newest<a class="sm-new-more" href="/changelog">full changelog &rarr;</a></h2>
\t\t\t<p class="sm-section-desc">The ${newestPages.length} most recently launched pages, straight to the live surface.</p>
\t\t\t<ul class="sm-list">
${newestHtml}
\t\t\t</ul>
\t\t</section>
\t\t<nav class="sm-toc" aria-label="Sections">
${tocHtml}
\t\t</nav>
${sectionHtml}
\t\t<div class="sm-empty" id="sm-empty" hidden>
\t\t\t<p>No pages match &ldquo;<span id="sm-empty-q"></span>&rdquo;.</p>
\t\t\t<p class="sm-empty-hint">Try a shorter word, or search everything: global search covers agents, coins, and skills too.</p>
\t\t\t<div class="sm-empty-actions">
\t\t\t\t<button type="button" id="sm-empty-clear">Clear filter</button>
\t\t\t\t<a id="sm-empty-search" href="/search">Search all of ${escapeHtml(site.name)}</a>
\t\t\t</div>
\t\t</div>
\t</main>
\t<div id="footer-container"></div>
\t<script type="module" src="/nav.js"></script>
\t<script type="module" src="/footer.js"></script>
\t<script>
\t(function () {
\t\tvar input = document.getElementById('sm-filter-input');
\t\tvar countEl = document.getElementById('sm-filter-count');
\t\tvar empty = document.getElementById('sm-empty');
\t\tvar emptyQ = document.getElementById('sm-empty-q');
\t\tvar emptyClear = document.getElementById('sm-empty-clear');
\t\tvar emptySearch = document.getElementById('sm-empty-search');
\t\tvar groups = Array.prototype.map.call(document.querySelectorAll('.sm-section'), function (sec) {
\t\t\treturn {
\t\t\t\tsec: sec,
\t\t\t\ttoc: document.querySelector('.sm-toc a[href="#' + sec.id + '"]'),
\t\t\t\tcount: sec.querySelector('[data-count]'),
\t\t\t\titems: Array.prototype.map.call(sec.querySelectorAll('.sm-list > li'), function (li) {
\t\t\t\t\treturn { li: li, text: li.textContent.toLowerCase() };
\t\t\t\t}),
\t\t\t};
\t\t});
\t\tvar total = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
\t\tcountEl.textContent = total + ' pages \\u00b7 ' + groups.length + ' sections';

\t\tvar newest = document.getElementById('sm-new');

\t\tfunction apply(q) {
\t\t\tq = q.trim().toLowerCase();
\t\t\tif (newest) newest.hidden = !!q;
\t\t\tvar shown = 0;
\t\t\tgroups.forEach(function (g) {
\t\t\t\tvar visible = 0;
\t\t\t\tg.items.forEach(function (it) {
\t\t\t\t\tvar hit = !q || it.text.indexOf(q) !== -1;
\t\t\t\t\tit.li.hidden = !hit;
\t\t\t\t\tif (hit) visible++;
\t\t\t\t});
\t\t\t\tg.sec.hidden = visible === 0;
\t\t\t\tif (g.toc) g.toc.hidden = visible === 0;
\t\t\t\tif (g.count) g.count.textContent = visible;
\t\t\t\tshown += visible;
\t\t\t});
\t\t\tcountEl.textContent = q
\t\t\t\t? shown + ' of ' + total + ' pages match'
\t\t\t\t: total + ' pages \\u00b7 ' + groups.length + ' sections';
\t\t\temptyQ.textContent = q;
\t\t\tempty.hidden = !q || shown > 0;
\t\t\temptySearch.href = q ? '/search?q=' + encodeURIComponent(q) : '/search';
\t\t\tvar url = new URL(location.href);
\t\t\tif (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
\t\t\thistory.replaceState(null, '', url);
\t\t}

\t\tinput.addEventListener('input', function () { apply(input.value); });
\t\temptyClear.addEventListener('click', function () {
\t\t\tinput.value = '';
\t\t\tapply('');
\t\t\tinput.focus();
\t\t});
\t\tinput.addEventListener('keydown', function (e) {
\t\t\tif (e.key === 'Escape' && input.value) {
\t\t\t\te.stopPropagation();
\t\t\t\tinput.value = '';
\t\t\t\tapply('');
\t\t\t}
\t\t});
\t\tdocument.addEventListener('keydown', function (e) {
\t\t\tif (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
\t\t\tvar t = e.target;
\t\t\tif (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
\t\t\te.preventDefault();
\t\t\tinput.focus();
\t\t});

\t\tvar initial = new URLSearchParams(location.search).get('q');
\t\tif (initial) { input.value = initial; apply(initial); }
\t})();
\t</script>
</body>
</html>
`;
}

// ────────────────────────────────────────────────────────────────────────
// features.json — machine manifest served verbatim at /api/features.json.
// Mirrors pages.json plus a generated-at stamp; lets the dashboard, third
// parties, and our own tooling pull a live feature list without scraping.
// ────────────────────────────────────────────────────────────────────────
function buildFeaturesJson() {
	const manifest = {
		generated_at: new Date().toISOString(),
		generated_by: 'scripts/build-page-index.mjs from data/pages.json',
		site,
		sections: sections.map((s) => ({
			id: s.id,
			title: s.title,
			description: s.description || null,
			pages: s.pages.map((p) => ({
				path: p.path,
				title: p.title,
				description: p.description,
				added: p.added || null,
				auth: p.auth || null,
				indexable: p.indexable !== false,
				tags: p.tags || [],
				showcase: p.showcase || false,
			})),
		})),
	};
	return JSON.stringify(manifest, null, '\t') + '\n';
}

// ────────────────────────────────────────────────────────────────────────
// Changelog feed — page launches (per-page `added` dates in pages.json)
// merged with curated entries from data/changelog.json, newest first.
// Three renderings: CHANGELOG.md, public/changelog.json, public/changelog.xml.
// ────────────────────────────────────────────────────────────────────────
function changelogFeed() {
	const launches = allPages
		.filter((p) => p.added)
		.map((p) => ({
			date: p.added,
			type: 'launch',
			title: p.title,
			summary: p.description,
			link: p.path,
			tags: ['launch'],
		}));
	const updates = curatedEntries.map((e) => ({
		date: e.date,
		type: 'update',
		title: e.title,
		summary: e.summary,
		link: e.link || null,
		tags: e.tags,
	}));
	return [...launches, ...updates].sort(
		(a, b) =>
			(a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
			(a.type !== b.type ? (a.type === 'launch' ? -1 : 1) : 0) ||
			a.title.localeCompare(b.title),
	);
}

function buildChangelog() {
	const feed = changelogFeed();
	const byDate = new Map();
	for (const item of feed) {
		if (!byDate.has(item.date)) byDate.set(item.date, []);
		byDate.get(item.date).push(item);
	}

	const lines = [];
	lines.push('# Changelog');
	lines.push('');
	lines.push('<!-- Generated from data/pages.json + data/changelog.json by scripts/build-page-index.mjs. DO NOT EDIT BY HAND. Add updates to data/changelog.json. -->');
	lines.push('');
	lines.push(`Public history for [${site.name}](${baseUrl}), newest first. New pages come from \`added\` dates in data/pages.json; everything else is curated in data/changelog.json. Also available as [JSON](${baseUrl}/changelog.json) and [RSS](${baseUrl}/changelog.xml), live at [${baseUrl.replace(/^https?:\/\//, '')}/changelog](${baseUrl}/changelog).`);
	lines.push('');
	for (const [date, items] of byDate) {
		lines.push(`## ${date}`);
		lines.push('');
		for (const item of items) {
			if (item.type === 'launch') {
				lines.push(`- **${item.title}** (\`${item.link}\`): ${item.summary}`);
			} else {
				lines.push(`- **${item.title}**: ${item.summary}${item.link ? ` (\`${item.link}\`)` : ''} \`[${item.tags.join(', ')}]\``);
			}
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd() + '\n';
}

function buildChangelogJson() {
	return JSON.stringify(
		{
			generated_at: new Date().toISOString(),
			generated_by: 'scripts/build-page-index.mjs from data/pages.json + data/changelog.json',
			site: { name: site.name, url: site.url },
			entries: changelogFeed(),
		},
		null,
		'\t',
	) + '\n';
}

function buildChangelogRss() {
	const feed = changelogFeed();
	const items = feed
		.map((item) => {
			const link = `${baseUrl}${item.link || '/changelog'}`;
			const pubDate = new Date(`${item.date}T12:00:00Z`).toUTCString();
			return [
				'\t\t<item>',
				`\t\t\t<title>${escapeHtml(item.title)}</title>`,
				`\t\t\t<link>${escapeHtml(link)}</link>`,
				`\t\t\t<guid isPermaLink="false">${escapeHtml(`${item.date}:${item.title}`)}</guid>`,
				`\t\t\t<pubDate>${pubDate}</pubDate>`,
				`\t\t\t<category>${escapeHtml(item.type === 'launch' ? 'launch' : item.tags[0])}</category>`,
				`\t\t\t<description>${escapeHtml(item.summary)}</description>`,
				'\t\t</item>',
			].join('\n');
		})
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
\t<channel>
\t\t<title>${escapeHtml(site.name)} changelog</title>
\t\t<link>${baseUrl}/changelog</link>
\t\t<atom:link href="${baseUrl}/changelog.xml" rel="self" type="application/rss+xml"/>
\t\t<description>What's new on ${escapeHtml(site.name)}: features, improvements, and releases, newest first.</description>
\t\t<language>en</language>
${items}
\t</channel>
</rss>
`;
}

// ────────────────────────────────────────────────────────────────────────
// emit
// ────────────────────────────────────────────────────────────────────────
function writeIfChanged(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	let prev = null;
	try { prev = readFileSync(file, 'utf8'); } catch {}
	if (prev === content) return false;
	writeFileSync(file, content);
	return true;
}

// Which public pages carry translated copy — a page is localized once it has any
// data-i18n annotation. The dynamic sitemap (api/sitemap/[type].js) reads this
// list to emit <xhtml:link hreflang> alternates for exactly those routes, so
// hreflang coverage tracks annotation automatically with no second list to keep
// in sync. Path → file uses the same clean-URL conventions the server serves.
//
// All four locations matter. Checking only pages/<slug>.html silently drops the
// 49 annotated pages that live at pages/<slug>/index.html (/openai) or under
// public/ (/cookbook, /gallery, /demos, /pay …): fully translated pages that
// nonetheless told search engines they had no alternates.
export function localizedPageFile(path, exists = existsSync, dir = root) {
	if (!path || path.startsWith('http')) return null;
	const slug = path === '/' ? 'home' : path.replace(/^\/+|\/+$/g, '');
	for (const rel of [
		`pages/${slug}.html`,
		`pages/${slug}/index.html`,
		`public/${slug}.html`,
		`public/${slug}/index.html`,
	]) {
		const file = resolve(dir, rel);
		if (exists(file)) return file;
	}
	return null;
}

function buildLocalizedPages() {
	const paths = [];
	for (const p of allPages) {
		const file = localizedPageFile(p.path);
		if (!file) continue;
		try {
			if (readFileSync(file, 'utf8').includes('data-i18n')) paths.push(p.path);
		} catch {
			// unreadable - treat as not localized
		}
	}
	return JSON.stringify({ generated: true, count: paths.length, paths: paths.sort() }, null, '\t') + '\n';
}

const outputs = [
	{ file: resolve(publicDir, 'locales/localized-pages.json'), content: buildLocalizedPages() },
	{ file: resolve(publicDir, 'llms.txt'), content: buildLlmsTxt() },
	{ file: resolve(publicDir, 'llms-full.txt'), content: buildLlmsFull() },
	{ file: resolve(publicDir, 'sitemap/index.html'), content: buildSitemapHtml() },
	{ file: resolve(publicDir, 'features.json'), content: buildFeaturesJson() },
	{ file: resolve(root, 'CHANGELOG.md'), content: buildChangelog() },
	{ file: resolve(publicDir, 'changelog.json'), content: buildChangelogJson() },
	{ file: resolve(publicDir, 'changelog.xml'), content: buildChangelogRss() },
];

let wrote = 0;
for (const { file, content } of outputs) {
	const changed = writeIfChanged(file, content);
	if (changed) wrote++;
	const rel = file.slice(root.length + 1);
	console.log(`${changed ? 'wrote ' : 'same  '} ${rel}`);
}
console.log(`\n${allPages.length} pages across ${sections.length} sections, ${wrote}/${outputs.length} files updated.`);
if (dashHits.length) {
	const bySource = dashHits.reduce((acc, s) => ((acc[s] = (acc[s] || 0) + 1), acc), {});
	const summary = Object.entries(bySource).map(([s, n]) => `${n} in ${s}`).join(', ');
	console.log(`normalized ${dashHits.length} em/en-dash to a plain hyphen on the way out (${summary}). Fix them at the source so authored copy matches what ships.`);
}
