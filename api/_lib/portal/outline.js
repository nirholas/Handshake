// @ts-check
// HTML to SiteOutline: the reading half of Portal.
//
// Portal turns a web page into a walkable place, and a place needs structure
// rather than prose. This module reads a page the way a reader skims it (the
// heading spine, what sits under each heading, where each section points) and
// emits a small, stable description of that structure. Everything downstream
// (the world layout, the GLB export, the SDK) consumes this shape and never
// touches HTML again, which is what keeps the layout a pure function.
//
// Two properties are load-bearing and covered by tests:
//
//   deterministic  the same bytes always produce the same outline, so the same
//                  URL always builds the same world and a share link is stable.
//   bounded        every list is capped and every string is trimmed, so one
//                  pathological page cannot produce a 40 MB world document.

import { parse } from 'node-html-parser';

/** Caps. A page with more than this is summarized, never truncated silently. */
export const LIMITS = Object.freeze({
	sections: 24,
	linksPerSection: 8,
	imagesPerSection: 4,
	summaryChars: 220,
	headingChars: 90,
	titleChars: 120,
	descriptionChars: 300,
});

/** Elements that carry no reader-facing text. */
const DROP = 'script,style,noscript,template,svg,iframe,form,nav,footer,header';

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clamp = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Stable slug for a section id, so a world keeps its ids across rebuilds. */
export function slugify(text, fallback) {
	const base = collapse(text)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return base || fallback;
}

function metaContent(root, names) {
	for (const name of names) {
		const el =
			root.querySelector(`meta[property="${name}"]`) || root.querySelector(`meta[name="${name}"]`);
		const value = collapse(el?.getAttribute('content') || '');
		if (value) return value;
	}
	return '';
}

/** Absolute URL, or null when the href is unusable (mailto:, javascript:, junk). */
export function absolutize(href, base) {
	const raw = String(href || '').trim();
	if (!raw || raw.startsWith('#')) return null;
	try {
		const u = new URL(raw, base);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		u.hash = '';
		return u.toString();
	} catch {
		return null;
	}
}

/** A six-digit hex colour from a CSS colour value, or null. */
export function normalizeColor(value) {
	const raw = collapse(value).toLowerCase();
	let m = /^#([0-9a-f]{3})$/.exec(raw);
	if (m) return `#${m[1][0]}${m[1][0]}${m[1][1]}${m[1][1]}${m[1][2]}${m[1][2]}`;
	m = /^#([0-9a-f]{6})$/.exec(raw);
	if (m) return `#${m[1]}`;
	m = /^rgba?\(\s*(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/.exec(raw);
	if (m) {
		const hex = [1, 2, 3]
			.map((i) => Math.min(255, Number(m[i])).toString(16).padStart(2, '0'))
			.join('');
		return `#${hex}`;
	}
	return null;
}

/**
 * Read one page into a SiteOutline.
 * @param {string} html raw document
 * @param {string} pageUrl the URL it was fetched from (used to resolve links)
 * @returns {import('./types.js').SiteOutline}
 */
export function outlineFromHtml(html, pageUrl) {
	const root = parse(String(html || ''), { blockTextElements: { script: false, style: false } });
	for (const el of root.querySelectorAll(DROP)) el.remove();

	const base = (() => {
		const href = root.querySelector('base[href]')?.getAttribute('href');
		return absolutize(href, pageUrl) || pageUrl;
	})();
	const canonical = absolutize(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), base) || pageUrl;
	const host = new URL(pageUrl).host;

	const title = clamp(
		collapse(metaContent(root, ['og:title', 'twitter:title']) || root.querySelector('title')?.text || host),
		LIMITS.titleChars,
	);
	const description = clamp(
		collapse(metaContent(root, ['og:description', 'description', 'twitter:description'])),
		LIMITS.descriptionChars,
	);
	const siteName = clamp(collapse(metaContent(root, ['og:site_name'])), LIMITS.titleChars) || null;
	const themeColor = normalizeColor(
		root.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '',
	);
	const image = absolutize(metaContent(root, ['og:image', 'twitter:image']), base);
	const icon =
		absolutize(root.querySelector('link[rel~="icon"]')?.getAttribute('href'), base) ||
		absolutize('/favicon.ico', base);
	const lang = collapse(root.querySelector('html')?.getAttribute('lang') || '').slice(0, 12) || 'en';

	const sections = readSections(root, base, host);
	const linkCounts = sections.reduce(
		(acc, s) => {
			for (const l of s.links) acc[l.internal ? 'internal' : 'external'] += 1;
			return acc;
		},
		{ internal: 0, external: 0 },
	);

	return {
		version: 1,
		url: pageUrl,
		canonical,
		host,
		title,
		description,
		siteName,
		themeColor,
		image,
		icon,
		lang,
		sections,
		linkCounts,
		words: sections.reduce((n, s) => n + s.words, 0),
	};
}

/**
 * Walk the document in order, opening a new section at every h1..h3 and
 * attributing the content that follows to it. Content before the first heading
 * becomes the intro section, so a page with no headings still has a place.
 */
function readSections(root, base, host) {
	const body = root.querySelector('body') || root;
	/** @type {any[]} */
	const sections = [];
	let current = null;
	const open = (level, heading) => {
		if (sections.length >= LIMITS.sections) return null;
		const id = slugify(heading, `section-${sections.length + 1}`);
		const unique = sections.some((s) => s.id === id) ? `${id}-${sections.length + 1}` : id;
		current = {
			id: unique,
			level,
			heading: clamp(collapse(heading), LIMITS.headingChars),
			summary: '',
			words: 0,
			paragraphs: 0,
			codeBlocks: 0,
			links: [],
			images: [],
		};
		sections.push(current);
		return current;
	};

	// One ordered pass. `inText` marks that an ancestor already counted this
	// prose, so a <p> nested in a <blockquote> is not counted twice while its
	// links and images are still collected.
	const walk = (node, inText, inPre) => {
		for (const child of node.childNodes || []) {
			if (child.nodeType !== 1) continue;
			const tag = String(child.rawTagName || '').toLowerCase();
			if (/^h[1-3]$/.test(tag)) {
				const text = collapse(child.text);
				if (text) open(Number(tag[1]), text);
				continue;
			}
			if (!current) open(1, clamp(collapse(root.querySelector('title')?.text || host) || host, LIMITS.headingChars));
			if (!current) return;
			const isText = tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'td';
			if (isText && !inText) countText(current, collapse(child.text));
			// <pre><code> is one block, not two: only the outermost counts.
			if (tag === 'pre' || (tag === 'code' && !inPre)) current.codeBlocks += 1;
			if (tag === 'a') collectLink(current, child, base, host);
			if (tag === 'img') collectImage(current, child, base);
			if (child.childNodes?.length && tag !== 'a') walk(child, inText || isText, inPre || tag === 'pre' || tag === 'code');
		}
	};
	walk(body, false, false);

	return sections.filter((s) => s.heading);
}

function countText(section, text) {
	if (!text) return;
	section.paragraphs += 1;
	section.words += text.split(' ').length;
	if (section.summary.length < LIMITS.summaryChars) {
		section.summary = clamp(collapse(`${section.summary} ${text}`), LIMITS.summaryChars);
	}
}

function collectLink(section, el, base, host) {
	if (section.links.length >= LIMITS.linksPerSection) return;
	const href = absolutize(el.getAttribute('href'), base);
	if (!href) return;
	if (section.links.some((l) => l.href === href)) return;
	const text = clamp(collapse(el.text) || new URL(href).pathname, 60);
	section.links.push({ href, text, internal: new URL(href).host === host });
}

function collectImage(section, el, base) {
	if (section.images.length >= LIMITS.imagesPerSection) return;
	const src = absolutize(el.getAttribute('src') || el.getAttribute('data-src'), base);
	if (!src) return;
	if (section.images.some((i) => i.src === src)) return;
	section.images.push({ src, alt: clamp(collapse(el.getAttribute('alt') || ''), 80) });
}
