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
 *   CHANGELOG.md                — derived from per-page `added` dates
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
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataFile = resolve(root, 'data/pages.json');
const publicDir = resolve(root, 'public');
const newsRoutesFile = resolve(root, 'data/_generated/news-routes.json');

const data = JSON.parse(readFileSync(dataFile, 'utf8'));
const { site } = data;
const sections = [...data.sections];

// Splice in a "News" section if scripts/build-news.mjs has written its
// routes file. Keeps news entries in the sitemap, llms.txt, and the
// human-readable /sitemap page without requiring manual edits.
if (existsSync(newsRoutesFile)) {
	const newsRoutes = JSON.parse(readFileSync(newsRoutesFile, 'utf8'));
	if (Array.isArray(newsRoutes) && newsRoutes.length) {
		sections.push({
			id: 'news',
			title: 'News',
			description: 'Product launches, integrations, and announcements from three.ws.',
			pages: newsRoutes.map((r) => ({
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
	for (const section of sections) {
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
	lines.push(`# ${site.name} — Complete Page Index`);
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
\t\t\t\t<h2>${escapeHtml(section.title)}</h2>
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

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sitemap · ${escapeHtml(site.name)}</title>
<meta name="description" content="Complete index of every public page on ${escapeHtml(site.name)}." />
<link rel="canonical" href="${escapeHtml(baseUrl)}/sitemap" />
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
\t.sm-topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: 1080px; margin: 0 auto; padding: 16px 24px; }
\t.sm-brand { display: inline-flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; font-weight: 600; font-size: 16px; letter-spacing: -0.02em; }
\t.sm-brand img { width: 24px; height: 24px; border-radius: 5px; }
\t.sm-brand:hover { text-decoration: none; }
</style>
</head>
<body>
\t<header class="sm-topbar">
\t\t<a class="sm-brand" href="/" aria-label="three.ws home"><img class="brand-mark" src="/three.svg" alt="three.ws" width="24" height="24" /><span>three.ws</span></a>
\t\t<div id="nav-container"></div>
\t</header>
\t<main class="sm-wrap">
\t\t<div class="sm-hero">
\t\t\t<h1>Sitemap</h1>
\t\t\t<p>Every public page on ${escapeHtml(site.name)}, grouped by purpose. Looking for the machine-readable versions?</p>
\t\t\t<div class="sm-formats">
\t\t\t\t<a href="/sitemap.xml"><code>sitemap.xml</code> · for search engines</a>
\t\t\t\t<a href="/llms.txt"><code>llms.txt</code> · for AI agents</a>
\t\t\t\t<a href="/llms-full.txt"><code>llms-full.txt</code> · long form</a>
\t\t\t\t<a href="/api/features.json"><code>features.json</code> · machine manifest</a>
\t\t\t\t<a href="/changelog"><code>changelog</code> · what's new</a>
\t\t\t\t<a href="/openapi.json"><code>openapi.json</code> · HTTP API</a>
\t\t\t</div>
\t\t</div>
\t\t<nav class="sm-toc" aria-label="Sections">
${tocHtml}
\t\t</nav>
${sectionHtml}
\t</main>
\t<div id="footer-container"></div>
\t<script type="module" src="/nav.js"></script>
\t<script type="module" src="/footer.js"></script>
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
			})),
		})),
	};
	return JSON.stringify(manifest, null, '\t') + '\n';
}

// ────────────────────────────────────────────────────────────────────────
// CHANGELOG.md — derived from per-page `added` dates, newest first. Pages
// without an `added` date predate tracking and are omitted; every NEW page
// added to pages.json should carry one (the route-audit guard enforces it).
// ────────────────────────────────────────────────────────────────────────
function buildChangelog() {
	const dated = allPages.filter((p) => p.added);
	const byDate = new Map();
	for (const p of dated) {
		if (!byDate.has(p.added)) byDate.set(p.added, []);
		byDate.get(p.added).push(p);
	}
	const dates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : -1));

	const lines = [];
	lines.push('# Changelog');
	lines.push('');
	lines.push('<!-- Generated from data/pages.json by scripts/build-page-index.mjs — DO NOT EDIT BY HAND. -->');
	lines.push('');
	lines.push(`Public feature history for [${site.name}](${baseUrl}), newest first. Feature dates are tracked from 2026-05-25 forward; earlier pages are omitted.`);
	lines.push('');
	if (dates.length === 0) {
		lines.push('_No dated features yet. Add an `"added": "YYYY-MM-DD"` field to a page in data/pages.json to start the log._');
		lines.push('');
	}
	for (const date of dates) {
		lines.push(`## ${date}`);
		lines.push('');
		for (const p of byDate.get(date).sort((a, b) => a.title.localeCompare(b.title))) {
			lines.push(`- **${p.title}** (\`${p.path}\`) — ${p.description}`);
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd() + '\n';
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

const outputs = [
	{ file: resolve(publicDir, 'llms.txt'), content: buildLlmsTxt() },
	{ file: resolve(publicDir, 'llms-full.txt'), content: buildLlmsFull() },
	{ file: resolve(publicDir, 'sitemap/index.html'), content: buildSitemapHtml() },
	{ file: resolve(publicDir, 'features.json'), content: buildFeaturesJson() },
	{ file: resolve(root, 'CHANGELOG.md'), content: buildChangelog() },
];

let wrote = 0;
for (const { file, content } of outputs) {
	const changed = writeIfChanged(file, content);
	if (changed) wrote++;
	const rel = file.slice(root.length + 1);
	console.log(`${changed ? 'wrote ' : 'same  '} ${rel}`);
}
console.log(`\n${allPages.length} pages across ${sections.length} sections — ${wrote}/${outputs.length} files updated.`);
