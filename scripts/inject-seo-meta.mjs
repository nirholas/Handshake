#!/usr/bin/env node
// inject-seo-meta.mjs — idempotently backfill SEO <head> tags on every
// canonical, indexable static page listed in data/pages.json.
//
// For each page it ensures a real <title>, <meta name="description">, an
// absolute <link rel="canonical">, Open Graph + Twitter Card tags, and a
// WebPage/WebSite JSON-LD block. Copy comes from data/pages.json (the single
// source of truth that also feeds the sitemap, llms.txt and the human
// sitemap), so the meta a crawler sees matches the catalog exactly.
//
// It NEVER overwrites a tag a page already has — page bodies are owned by
// other agents; we only fill genuine gaps. The one exception is the social
// share image: pages whose og:image/twitter:image still point at the single
// static /og-image.png are re-pointed at the per-page dynamic OG card
// (/api/page-og) so every shared link previews with its own title, section,
// and description. Custom dynamic OG images (agent/avatar/feature cards) are
// left untouched. Re-running is a no-op once a page is fully covered. Pass
// --write to mutate files; default is a dry-run report.
//
// Route → file resolution uses vercel.json's `routes` table (the real router),
// falling back to conventional file locations.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ORIGIN = 'https://three.ws';
const DEFAULT_OG = `${ORIGIN}/og-image.png`;
// Every value a crawler might currently hold for the legacy shared card. Any of
// these gets upgraded to the page's dynamic /api/page-og image.
const LEGACY_OG = new Set([DEFAULT_OG, '/og-image.png', `${ORIGIN}/og-image.png?v=1`]);
const WRITE = process.argv.includes('--write');

// Per-page dynamic social share image. Copy is carried in the URL so the
// /api/page-og renderer stays a pure, cacheable function of its params and
// always matches this catalog. Mirrors the section accents defined there.
function pageOgUrl(page, sectionId) {
	const q = new URLSearchParams();
	q.set('s', sectionId || 'main');
	q.set('t', page.title || 'three.ws');
	if (page.description) q.set('d', page.description.slice(0, 160));
	q.set('p', page.path || '/');
	return `${ORIGIN}/api/page-og?${q.toString()}`;
}

function htmlEscape(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

async function loadJson(rel) {
	return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
}

// Build an ordered list of {re, dest} from vercel.json routes for resolution.
// Error documents are the router's *fallback*, never a page's canonical file.
// The SPA catch-all (`/(?!_vercel/).*` → `/404.html`) matches every path, so any
// page whose real route is a bare redirect (a `status` entry with no `dest`, e.g.
// /chat → /app) would otherwise resolve here and stamp its canonical, og:url and
// JSON-LD onto public/404.html — telling crawlers the 404 *is* that page.
const ERROR_DOCS = new Set(['/404.html', '/500.html']);

function buildRouter(vercel) {
	const routes = Array.isArray(vercel.routes) ? vercel.routes : [];
	const out = [];
	for (const r of routes) {
		if (!r || typeof r.src !== 'string' || typeof r.dest !== 'string') continue;
		if (r.methods && !r.methods.includes('GET')) continue;
		// Only care about routes that land on a static .html file.
		const destPath = r.dest.split('?')[0];
		if (!destPath.endsWith('.html')) continue;
		if (ERROR_DOCS.has(destPath)) continue;
		let re;
		try {
			re = new RegExp(r.src.startsWith('^') ? r.src : `^${r.src}$`);
		} catch {
			continue;
		}
		out.push({ re, dest: destPath });
	}
	return out;
}

function resolveFile(p, router) {
	// 1) vercel.json router match.
	for (const { re, dest } of router) {
		if (re.test(p)) {
			const rel = dest.replace(/^\//, '');
			for (const base of ['pages', 'public']) {
				const f = path.join(ROOT, base, rel);
				if (existsSync(f)) return f;
			}
		}
	}
	// 2) conventional fallbacks.
	const slug = p.replace(/^\//, '');
	const flat = slug.replace(/\//g, '-');
	const candidates = [
		`pages/${slug}.html`,
		`public/${slug}.html`,
		`public/${slug}/index.html`,
		`pages/${slug}/index.html`,
		`pages/${flat}.html`,
		`public/${flat}.html`,
	];
	if (p === '/') candidates.unshift('pages/home.html', 'public/index.html');
	for (const c of candidates) {
		const f = path.join(ROOT, c);
		if (existsSync(f)) return f;
	}
	return null;
}

// Detect presence of a given meta/link/jsonld in a <head> string.
const has = {
	title: (h) => /<title[\s>]/i.test(h),
	description: (h) => /<meta[^>]+name=["']description["']/i.test(h),
	canonical: (h) => /<link[^>]+rel=["']canonical["']/i.test(h),
	ogTitle: (h) => /<meta[^>]+property=["']og:title["']/i.test(h),
	ogDescription: (h) => /<meta[^>]+property=["']og:description["']/i.test(h),
	ogImage: (h) => /<meta[^>]+property=["']og:image["']/i.test(h),
	ogUrl: (h) => /<meta[^>]+property=["']og:url["']/i.test(h),
	ogType: (h) => /<meta[^>]+property=["']og:type["']/i.test(h),
	ogSiteName: (h) => /<meta[^>]+property=["']og:site_name["']/i.test(h),
	twitterCard: (h) => /<meta[^>]+name=["']twitter:card["']/i.test(h),
	twitterTitle: (h) => /<meta[^>]+name=["']twitter:title["']/i.test(h),
	twitterDescription: (h) => /<meta[^>]+name=["']twitter:description["']/i.test(h),
	twitterImage: (h) => /<meta[^>]+name=["']twitter:image["']/i.test(h),
	twitterSite: (h) => /<meta[^>]+name=["']twitter:site["']/i.test(h),
	ogImageAlt: (h) => /<meta[^>]+property=["']og:image:alt["']/i.test(h),
	ogLocale: (h) => /<meta[^>]+property=["']og:locale["']/i.test(h),
	robots: (h) => /<meta[^>]+name=["']robots["']/i.test(h),
	jsonld: (h) => /<script[^>]+application\/ld\+json/i.test(h),
};

// Pull an existing og:image URL so twitter:image can mirror it.
function existingOgImage(head) {
	const m = head.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
	return m ? m[1] : null;
}

const PAGE_OG_BASE = `${ORIGIN}/api/page-og`;

// Re-point a page's social share image at its own dynamic card. Touches
// og:image / twitter:image whose value is either the legacy static
// /og-image.png OR an out-of-date /api/page-og URL (so a copy change in the
// catalog propagates, and the escaped form self-heals). Custom per-entity OG
// cards (agent/avatar/feature) are left alone. `dynamicOg` must be HTML-escaped.
// Returns the possibly-rewritten html and whether anything changed.
function repointShareImage(html, dynamicOg) {
	let changed = false;
	const next = html.replace(
		/(<meta[^>]+(?:property=["']og:image["']|name=["']twitter:image["'])[^>]+content=["'])([^"']+)(["'][^>]*>)/gi,
		(full, pre, val, post) => {
			const v = val.trim();
			const isLegacy = LEGACY_OG.has(v);
			const isOurCard = v.replace(/&amp;/g, '&').startsWith(`${PAGE_OG_BASE}?`);
			if (!isLegacy && !isOurCard) return full; // bespoke card — leave it
			if (v === dynamicOg) return full; // already current
			changed = true;
			return pre + dynamicOg + post;
		},
	);
	return { html: next, changed };
}

function buildTags(page, head, sectionId) {
	const url = `${ORIGIN}${page.path === '/' ? '/' : page.path}`;
	const title = `${page.title} · three.ws`;
	const desc = page.description || '';
	const dynamicOg = pageOgUrl(page, sectionId);
	// Keep a page's bespoke OG card if it already has one; otherwise the dynamic
	// per-page card. (Legacy static images were already swapped by repoint.)
	const existing = existingOgImage(head);
	const ogImage = existing && !LEGACY_OG.has(existing.trim()) ? existing : dynamicOg;
	const lines = [];
	const indent = '\t';

	if (!has.canonical(head)) lines.push(`<link rel="canonical" href="${url}">`);
	if (!has.robots(head))
		lines.push(
			`<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">`,
		);
	if (!has.ogType(head)) lines.push(`<meta property="og:type" content="website">`);
	if (!has.ogSiteName(head)) lines.push(`<meta property="og:site_name" content="three.ws">`);
	if (!has.ogLocale(head)) lines.push(`<meta property="og:locale" content="en_US">`);
	if (!has.ogTitle(head)) lines.push(`<meta property="og:title" content="${htmlEscape(title)}">`);
	if (!has.ogDescription(head) && desc)
		lines.push(`<meta property="og:description" content="${htmlEscape(desc)}">`);
	if (!has.ogUrl(head)) lines.push(`<meta property="og:url" content="${url}">`);
	if (!has.ogImage(head)) {
		lines.push(`<meta property="og:image" content="${htmlEscape(ogImage)}">`);
		lines.push(`<meta property="og:image:width" content="1200">`);
		lines.push(`<meta property="og:image:height" content="630">`);
		lines.push(`<meta property="og:image:type" content="image/png">`);
	}
	if (!has.ogImageAlt(head))
		lines.push(`<meta property="og:image:alt" content="${htmlEscape(page.title)} — three.ws">`);
	if (!has.twitterCard(head)) lines.push(`<meta name="twitter:card" content="summary_large_image">`);
	if (!has.twitterSite(head)) lines.push(`<meta name="twitter:site" content="@trythreews">`);
	if (!has.twitterTitle(head)) lines.push(`<meta name="twitter:title" content="${htmlEscape(title)}">`);
	if (!has.twitterDescription(head) && desc)
		lines.push(`<meta name="twitter:description" content="${htmlEscape(desc)}">`);
	if (!has.twitterImage(head)) lines.push(`<meta name="twitter:image" content="${htmlEscape(ogImage)}">`);
	if (!has.jsonld(head)) {
		const graph = [
			{
				'@type': 'WebPage',
				name: page.title,
				description: desc || undefined,
				url,
				isPartOf: { '@type': 'WebSite', name: 'three.ws', url: ORIGIN },
				primaryImageOfPage: ogImage,
			},
		];
		// Breadcrumb trail for nested routes (e.g. /docs/start-here) so search
		// results render a path instead of a bare URL.
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
		lines.push(
			`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
		);
	}
	// A bare <meta name="description"> if the page somehow lacks one.
	if (!has.description(head) && desc)
		lines.unshift(`<meta name="description" content="${htmlEscape(desc)}">`);

	return lines.map((l) => indent + l).join('\n');
}

function injectIntoHead(html, tagsBlock) {
	// Insert right before </head>, preserving indentation of that line.
	const idx = html.search(/<\/head>/i);
	if (idx === -1) return null;
	const block = `\n${tagsBlock}\n`;
	return html.slice(0, idx) + block + html.slice(idx);
}

function headOf(html) {
	const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
	return m ? m[1] : html.slice(0, 4000);
}

async function main() {
	const [pages, vercel] = await Promise.all([loadJson('data/pages.json'), loadJson('vercel.json')]);
	const router = buildRouter(vercel);

	// `blog` is owned by inject-blog-seo.mjs (BlogPosting + BreadcrumbList JSON-LD,
	// resolved from the root /blog dir) — don't double-process it here.
	const SKIP_SECTIONS = new Set(['news', 'machine', 'blog']);
	// Agent-instance surfaces (A05 owns the restructure) resolve to shared
	// editor/SPA files that serve many routes — a single static canonical/og:url
	// would be wrong, so we leave their meta to the owning agent.
	const SKIP_PATHS = new Set(['/agent', '/agent/new', '/labs']);
	// `/features/*` landing pages are authored per-page by their owning agent
	// (F02). This injector defines the shared convention they follow; it does
	// not stamp their heads, to avoid double-writing the same tags.
	const skip = (p) => SKIP_PATHS.has(p) || /^\/features\/[^/]+$/.test(p);
	const targets = [];
	for (const s of pages.sections || []) {
		if (SKIP_SECTIONS.has(s.id)) continue;
		for (const p of s.pages || []) {
			if (p.indexable === false || p.auth === 'required') continue;
			if (!p.path || p.path.startsWith('http')) continue;
			if (skip(p.path)) continue;
			targets.push({ page: p, sectionId: s.id });
		}
	}

	let resolved = 0;
	let unresolved = [];
	let changed = 0;
	let repointed = 0;
	let alreadyComplete = 0;
	let sharedShell = 0;
	// Some routes (e.g. /tutorials/*) share one template file. A single static
	// og:image/canonical can't be right for every route, and re-pointing each
	// would thrash the same file, so the first route to land on a file owns its
	// meta and later routes pointing at it are left alone (their per-route OG, if
	// any, is a crawler-rewrite concern, not this static injector's).
	const seenFiles = new Set();

	for (const { page, sectionId } of targets) {
		const file = resolveFile(page.path, router);
		if (!file) {
			unresolved.push(page.path);
			continue;
		}
		if (seenFiles.has(file)) {
			sharedShell++;
			continue;
		}
		seenFiles.add(file);
		resolved++;
		const original = await readFile(file, 'utf8');
		// 1) Upgrade any legacy static share image to this page's dynamic card.
		const dynamicOg = pageOgUrl(page, sectionId);
		const { html, changed: didRepoint } = repointShareImage(original, htmlEscape(dynamicOg));
		// 2) Backfill any missing head tags (computed against the post-repoint head).
		const head = headOf(html);
		const tags = buildTags(page, head, sectionId);
		if (!tags.trim() && !didRepoint) {
			alreadyComplete++;
			continue;
		}
		const relFile = path.relative(ROOT, file);
		console.log(`${page.path}  →  ${relFile}`);
		if (didRepoint) {
			repointed++;
			console.log(`    ~ og:image/twitter:image → /api/page-og`);
		}
		if (tags.trim()) {
			const added = tags
				.trim()
				.split('\n')
				.map((l) => l.trim().match(/(rel|property|name)=["']([^"']+)["']|<(title|script)/i))
				.map((m) => (m ? m[2] || m[3] : '?'))
				.join(', ');
			console.log(`    + ${added}`);
			changed++;
		}
		if (WRITE) {
			let next = html;
			if (tags.trim()) {
				next = injectIntoHead(html, tags);
				if (!next) {
					console.log(`    ! no </head> — skipped`);
					next = html;
				}
			}
			if (next !== original) await writeFile(file, next);
		}
	}

	console.log('\n──────────────────────────────────────────');
	console.log(`targets: ${targets.length}  resolved: ${resolved}  shared-shell: ${sharedShell}  complete-already: ${alreadyComplete}  re-pointed: ${repointed}  ${WRITE ? 'written' : 'would-change'}: ${changed}`);
	if (unresolved.length) console.log(`UNRESOLVED (${unresolved.length}): ${unresolved.join(', ')}`);
	if (!WRITE) console.log('\n(dry-run — pass --write to apply)');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
