// Per-request <head> rewriting for shared-shell routes.
//
// Most pages get their SEO meta stamped statically at build time by
// scripts/inject-seo-meta.mjs. Routes that share one template file cannot:
// /docs/* (about 230 routes) and /tutorials/* (about 70) all serve the same
// shell, so every one of them told crawlers the same canonical URL, title,
// description and social card as the shell's own route. This module fixes that
// at serve time: when a request path is a catalogued page (data/pages.json)
// but the shell it resolves to carries a different canonical, the head is
// rewritten with the page's own title, description, canonical, Open Graph and
// Twitter tags, and JSON-LD before the response leaves the server.
//
// The title format, the dynamic page-og card params, and the JSON-LD graph
// shape all mirror scripts/inject-seo-meta.mjs, so a crawler cannot tell
// whether a page was stamped at build time or rewritten here.
//
// Safety rules this module holds itself to:
//   - Never fail a page: any error falls back to the untouched shell.
//   - A page whose canonical already matches the request path owns its meta
//     and is never touched (that is every statically stamped page).
//   - Results are cached per path; dist/ is immutable for a deploy's lifetime.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://three.ws';

function htmlEscape(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Cut at the last word boundary inside the cap so the rendered OG card never
// ends mid-word. Mirrors inject-seo-meta.mjs.
function truncateAtWord(s, max) {
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	const space = cut.lastIndexOf(' ');
	return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '');
}

function pageOgUrl(page, sectionId) {
	const q = new URLSearchParams();
	q.set('s', sectionId || 'main');
	q.set('t', page.title || 'three.ws');
	if (page.description) q.set('d', truncateAtWord(page.description, 160));
	q.set('p', page.path || '/');
	return `${ORIGIN}/api/page-og?${q.toString()}`;
}

// path -> { page, sectionId } for every public, indexable catalogued page.
let catalog = null;
function getCatalog() {
	if (catalog) return catalog;
	catalog = new Map();
	try {
		const data = JSON.parse(
			readFileSync(path.resolve(__dirname, '..', 'data', 'pages.json'), 'utf8'),
		);
		for (const s of data.sections || []) {
			for (const p of s.pages || []) {
				if (!p.path || p.path.startsWith('http')) continue;
				if (p.indexable === false || p.auth === 'required') continue;
				catalog.set(p.path, { page: p, sectionId: s.id });
			}
		}
	} catch (err) {
		console.error('[seo-head] failed to load data/pages.json:', err.message);
	}
	return catalog;
}

function normalizePath(pathname) {
	if (!pathname || pathname === '/') return '/';
	const bare = pathname.replace(/\/+$/, '');
	return bare || '/';
}

export function hasSeoRoute(pathname) {
	return getCatalog().has(normalizePath(pathname));
}

/**
 * The canonical URL a catalogued page is required to present. The origin is
 * fixed rather than taken from the request, so a page served from any host
 * (a preview revision, a direct Cloud Run URL) still names its public URL.
 *
 * Exported so scripts/check-pages.mjs can assert the served canonical against
 * the same value this module writes, instead of restating the rule and drifting.
 */
export function canonicalUrlFor(pathname) {
	return `${ORIGIN}${normalizePath(pathname)}`;
}

// Extract the href of an existing <link rel="canonical"> from a head string,
// attribute order agnostic. Returns null when the head has none.
export function canonicalOf(head) {
	const tag = head.match(/<link[^>]*rel=["']canonical["'][^>]*>/i);
	if (!tag) return null;
	const href = tag[0].match(/href=["']([^"']+)["']/i);
	return href ? href[1] : null;
}

// Replace a whole tag matched by `re` with `replacement`, or record it as
// missing so it can be appended before </head>. Rebuilding the entire tag
// keeps the rewrite independent of the shell's attribute order.
function setTag(head, re, replacement, missing) {
	if (re.test(head)) return head.replace(re, () => replacement);
	missing.push(replacement);
	return head;
}

function buildJsonLd(page, url, ogImage) {
	const graph = [
		{
			'@type': 'WebPage',
			name: page.title,
			description: page.description || undefined,
			url,
			isPartOf: { '@type': 'WebSite', name: 'three.ws', url: ORIGIN },
			primaryImageOfPage: ogImage,
		},
	];
	const segs = page.path.split('/').filter(Boolean);
	if (segs.length > 1) {
		const items = [{ name: 'Home', url: `${ORIGIN}/` }];
		let acc = '';
		for (const s of segs) {
			acc += `/${s}`;
			items.push({
				name: s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
				url: `${ORIGIN}${acc}`,
			});
		}
		graph.push({
			'@type': 'BreadcrumbList',
			itemListElement: items.map((it, i) => ({
				'@type': 'ListItem',
				position: i + 1,
				name: it.name,
				item: it.url,
			})),
		});
	}
	const ld = { '@context': 'https://schema.org', '@graph': graph };
	return `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
}

/**
 * Rewrite a shared shell's <head> for the page actually being served, or
 * return null when the shell already carries this page's meta (or the path is
 * not a catalogued public page).
 *
 * @param {string} pathname  Original request path (before any dest rewrite).
 * @param {string} html      The shell HTML as served from dist/.
 * @returns {string|null}
 */
export function rewriteHead(pathname, html) {
	const p = normalizePath(pathname);
	const entry = getCatalog().get(p);
	if (!entry) return null;
	const headMatch = html.match(/<head[^>]*>[\s\S]*?<\/head>/i);
	if (!headMatch) return null;

	const { page, sectionId } = entry;
	const url = canonicalUrlFor(p);
	const shellCanonical = canonicalOf(headMatch[0]);
	// The canonical already names this page: it owns its meta. This is every
	// statically stamped page, and the shell's own route (/docs on docs shell).
	if (shellCanonical === url) return null;

	let head = headMatch[0];
	const fullTitle = `${page.title} · three.ws`;
	const desc = page.description || '';
	const ogImage = pageOgUrl(page, sectionId);
	const missing = [];

	head = setTag(head, /<title[^>]*>[\s\S]*?<\/title>/i, `<title>${htmlEscape(fullTitle)}</title>`, missing);
	head = setTag(head, /<link[^>]*rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${url}" />`, missing);
	if (desc) {
		head = setTag(head, /<meta[^>]*name=["']description["'][^>]*>/i, `<meta name="description" content="${htmlEscape(desc)}" />`, missing);
		head = setTag(head, /<meta[^>]*property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${htmlEscape(desc)}" />`, missing);
		head = setTag(head, /<meta[^>]*name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${htmlEscape(desc)}" />`, missing);
	}
	head = setTag(head, /<meta[^>]*property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${htmlEscape(fullTitle)}" />`, missing);
	head = setTag(head, /<meta[^>]*property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${url}" />`, missing);
	head = setTag(head, /<meta[^>]*property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${htmlEscape(ogImage)}" />`, missing);
	head = setTag(head, /<meta[^>]*property=["']og:image:alt["'][^>]*>/i, `<meta property="og:image:alt" content="${htmlEscape(page.title)} on three.ws" />`, missing);
	head = setTag(head, /<meta[^>]*name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${htmlEscape(fullTitle)}" />`, missing);
	head = setTag(head, /<meta[^>]*name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${htmlEscape(ogImage)}" />`, missing);

	// JSON-LD written for the shell's own route describes the wrong page here.
	// Drop head blocks that reference the shell canonical, keep any others, and
	// add a fresh WebPage + BreadcrumbList for this page.
	if (shellCanonical) {
		head = head.replace(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, (m) =>
			m.includes(shellCanonical) ? '' : m,
		);
	}
	missing.push(buildJsonLd(page, url, ogImage));

	if (missing.length) {
		head = head.replace(/<\/head>/i, () => `${missing.map((t) => `\t${t}`).join('\n')}\n</head>`);
	}

	const start = headMatch.index;
	return html.slice(0, start) + head + html.slice(start + headMatch[0].length);
}

// pathname -> rewritten HTML, or null when the shell should be served as-is.
// dist/ never changes under a running deploy, so entries live forever.
const cache = new Map();

/**
 * Cached rewrite for a request path, reading the shell from `file`. Returns
 * null (serve the static file) on a cache-hit null, any read error, or a
 * shell that already owns its meta.
 */
export function renderSeoHead(pathname, file) {
	const key = normalizePath(pathname);
	if (cache.has(key)) return cache.get(key);
	let out = null;
	try {
		out = rewriteHead(key, readFileSync(file, 'utf8'));
	} catch (err) {
		console.error(`[seo-head] ${key} fell back to the static shell:`, err.message);
	}
	cache.set(key, out);
	return out;
}

export const __test = { rewriteHead, hasSeoRoute, normalizePath, pageOgUrl, buildJsonLd };
