#!/usr/bin/env node
// inject-blog-seo.mjs — bring every editorial post in /blog up to the same
// structured-data + social-card bar as the rest of three.ws.
//
// The blog posts are hand-authored static HTML (copied to dist/blog by the
// `copy-blog` Vite plugin). Most have a <title>, description, canonical and
// the core Open Graph tags, but were missing three things crawlers reward:
//
//   1. og:image / twitter:image  — without these, X/Slack/Discord/LinkedIn
//      unfurl the post with no card image.
//   2. BlogPosting JSON-LD       — makes the post eligible for Article rich
//      results and feeds Google's "article" understanding.
//   3. BreadcrumbList JSON-LD    — renders Home › Blog › Post breadcrumbs in
//      search results instead of a bare URL.
//
// It is idempotent: it only fills genuine gaps and never overwrites a tag a
// post already has, so it is safe to run on every build. It also upserts each
// discovered post into data/pages.json's `blog` section — the single source of
// truth the sitemap, llms.txt and human sitemap all read from — so newly added
// posts become crawl-discoverable without a second manual edit.
//
// Pass --write to mutate files; default is a dry-run report.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ORIGIN = 'https://three.ws';
const DEFAULT_OG = `${ORIGIN}/og-image.png`;
const BLOG_DIR = path.join(ROOT, 'blog');
const PAGES_JSON = path.join(ROOT, 'data', 'pages.json');
const WRITE = process.argv.includes('--write');

function attr(head, re) {
	const m = head.match(re);
	return m ? m[1].trim() : null;
}

// Read an HTML attribute list into a plain object. Each value is read up to its
// OWN closing quote, which a `content=["']([^"']+)["']` shorthand cannot do: an
// apostrophe inside a double-quoted value ends the capture there and silently
// truncates the copy (a description reading "three.ws is DEXTools" instead of
// "three.ws is DEXTools' Social Boost winner of the week…").
function parseAttrs(source) {
	const attrs = {};
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let m;
	while ((m = re.exec(source))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
	return attrs;
}

// Every `<tagName …>` in `head`, as attribute objects. The body matcher skips
// over quoted spans so a `>` inside an attribute value cannot close the tag early.
function tagAttrs(head, tagName) {
	const re = new RegExp(`<${tagName}\\b((?:"[^"]*"|'[^']*'|[^>])*)>`, 'gi');
	const out = [];
	let m;
	while ((m = re.exec(head))) out.push(parseAttrs(m[1]));
	return out;
}

// The `content` of the first <meta> whose `name` or `property` matches `key`.
function metaContent(head, key) {
	const want = key.toLowerCase();
	for (const a of tagAttrs(head, 'meta')) {
		if ((a.name || a.property || '').toLowerCase() === want) return a.content ?? null;
	}
	return null;
}

// The `href` of the first <link> carrying `rel`.
function linkHref(head, rel) {
	const want = rel.toLowerCase();
	for (const a of tagAttrs(head, 'link')) {
		if ((a.rel || '').toLowerCase() === want) return a.href ?? null;
	}
	return null;
}

// Decode the handful of HTML entities our authored heads use, so JSON-LD
// carries clean text (JSON.stringify re-escapes what it needs).
function decode(s) {
	return String(s)
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&times;/g, '×');
}

function headOf(html) {
	const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
	return m ? m[1] : html.slice(0, 6000);
}

// Pull the publish date from the first <time datetime="…"> or the visible
// `.post-date` chip. Returns an ISO string at noon UTC (date-only sources have
// no time-of-day), or null when neither is present.
function publishDate(html) {
	const dt =
		attr(html, /datetime=["'](\d{4}-\d{2}-\d{2})/i) ||
		attr(html, /class=["']post-date["'][^>]*>\s*(\d{4}-\d{2}-\d{2})/i);
	return dt ? `${dt}T12:00:00.000Z` : null;
}

function metaOf(html, head) {
	const title = decode(attr(head, /<title[^>]*>([\s\S]*?)<\/title>/i) || metaContent(head, 'og:title') || '');
	const description = decode(
		metaContent(head, 'description') || metaContent(head, 'og:description') || '',
	).trim();
	const keywords = decode(metaContent(head, 'keywords') || '').trim();
	const ogImage = metaContent(head, 'og:image')?.trim() || null;
	const canonical = linkHref(head, 'canonical')?.trim() || null;
	return { title, description, keywords, ogImage, canonical };
}

const has = {
	ogImage: (h) => /<meta[^>]+property=["']og:image["']/i.test(h),
	twitterImage: (h) => /<meta[^>]+name=["']twitter:image["']/i.test(h),
	ogType: (h) => /<meta[^>]+property=["']og:type["']/i.test(h),
	jsonld: (h) => /<script[^>]+application\/ld\+json/i.test(h),
	breadcrumb: (h) => /BreadcrumbList/.test(h),
};

function buildTags(post, head) {
	const { url, title, description, keywords, image, datePublished } = post;
	const lines = [];
	const ind = '    '; // blog posts are 4-space indented

	if (!has.ogType(head)) lines.push(`<meta property="og:type" content="article">`);
	if (!has.ogImage(head)) {
		lines.push(`<meta property="og:image" content="${image}">`);
		lines.push(`<meta property="og:image:width" content="1200">`);
		lines.push(`<meta property="og:image:height" content="630">`);
	}
	if (!has.twitterImage(head)) lines.push(`<meta name="twitter:image" content="${image}">`);

	if (!has.jsonld(head)) {
		const ld = {
			'@context': 'https://schema.org',
			'@type': 'BlogPosting',
			headline: title,
			description: description || undefined,
			image,
			datePublished: datePublished || undefined,
			dateModified: datePublished || undefined,
			author: { '@type': 'Organization', name: 'three.ws', url: ORIGIN },
			publisher: {
				'@type': 'Organization',
				name: 'three.ws',
				url: ORIGIN,
				logo: { '@type': 'ImageObject', url: DEFAULT_OG },
			},
			mainEntityOfPage: { '@type': 'WebPage', '@id': url },
			keywords: keywords || undefined,
		};
		lines.push(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);
	}

	if (!has.breadcrumb(head)) {
		const crumbs = {
			'@context': 'https://schema.org',
			'@type': 'BreadcrumbList',
			itemListElement: [
				{ '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
				{ '@type': 'ListItem', position: 2, name: 'Blog', item: `${ORIGIN}/blog` },
				{ '@type': 'ListItem', position: 3, name: title, item: url },
			],
		};
		lines.push(
			`<script type="application/ld+json">${JSON.stringify(crumbs).replace(/</g, '\\u003c')}</script>`,
		);
	}

	return lines.map((l) => ind + l).join('\n');
}

function injectIntoHead(html, block) {
	const idx = html.search(/<\/head>/i);
	if (idx === -1) return null;
	return `${html.slice(0, idx)}${block}\n`.concat(html.slice(idx));
}

async function upsertPagesJson(posts) {
	const raw = await readFile(PAGES_JSON, 'utf8');
	const data = JSON.parse(raw);
	const section = (data.sections || []).find((s) => s.id === 'blog');
	if (!section) return { added: 0, updated: 0, written: false };
	const byPath = new Map(section.pages.map((p) => [p.path, p]));
	let added = 0;
	let updated = 0;
	for (const post of posts) {
		const lastmod = post.datePublished ? post.datePublished.slice(0, 10) : undefined;
		const existing = byPath.get(post.path);
		if (existing) {
			// Refresh description/title/lastmod from the post itself; keep curated priority.
			const next = {
				...existing,
				title: post.title,
				description: post.description || existing.description,
				...(lastmod ? { lastmod } : {}),
			};
			if (JSON.stringify(next) !== JSON.stringify(existing)) {
				Object.assign(existing, next);
				updated++;
			}
		} else {
			const entry = {
				path: post.path,
				title: post.title,
				description: post.description,
				priority: 0.6,
				changefreq: 'monthly',
				...(lastmod ? { lastmod } : {}),
			};
			section.pages.push(entry);
			byPath.set(post.path, entry);
			added++;
		}
	}
	// Keep the index entry first, then posts newest-first by lastmod.
	section.pages.sort((a, b) => {
		if (a.path === '/blog') return -1;
		if (b.path === '/blog') return 1;
		return (b.lastmod || '').localeCompare(a.lastmod || '');
	});
	if ((added || updated) && WRITE) await writeFile(PAGES_JSON, JSON.stringify(data, null, '\t') + '\n');
	return { added, updated, written: Boolean(added || updated) };
}

async function main() {
	const files = (await readdir(BLOG_DIR)).filter((f) => f.endsWith('.html') && f !== 'index.html');
	const posts = [];
	let changed = 0;
	let complete = 0;

	for (const file of files.sort()) {
		const abs = path.join(BLOG_DIR, file);
		const html = await readFile(abs, 'utf8');
		const head = headOf(html);
		const slug = file.replace(/\.html$/, '');
		const m = metaOf(html, head);
		const url = m.canonical || `${ORIGIN}/blog/${slug}`;
		const post = {
			path: `/blog/${slug}`,
			url,
			title: m.title || slug,
			description: m.description,
			keywords: m.keywords,
			image: m.ogImage || DEFAULT_OG,
			datePublished: publishDate(html),
		};
		posts.push(post);

		const tags = buildTags(post, head);
		if (!tags.trim()) {
			complete++;
			continue;
		}
		const added = tags
			.trim()
			.split('\n')
			.map((l) => l.trim().match(/(property|name)=["']([^"']+)["']|BreadcrumbList|BlogPosting|<script/i))
			.map((x) => (x ? x[2] || x[0].replace(/[<"']/g, '') : '?'));
		// Label JSON-LD blocks by their @type for a readable report.
		const label = added.map((a) =>
			a === 'script' ? (tags.includes('BreadcrumbList') ? 'BreadcrumbList' : 'BlogPosting') : a,
		);
		console.log(`/blog/${slug}\n    + ${[...new Set(label)].join(', ')}`);
		changed++;
		if (WRITE) {
			const next = injectIntoHead(html, tags);
			if (next) await writeFile(abs, next);
		}
	}

	const pagesResult = await upsertPagesJson(posts);

	console.log('\n──────────────────────────────────────────');
	console.log(
		`blog posts: ${files.length}  complete-already: ${complete}  ${WRITE ? 'written' : 'would-change'}: ${changed}`,
	);
	console.log(
		`pages.json blog section: +${pagesResult.added} added, ${pagesResult.updated} updated${WRITE ? '' : ' (dry-run)'}`,
	);
	if (!WRITE) console.log('\n(dry-run — pass --write to apply)');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
