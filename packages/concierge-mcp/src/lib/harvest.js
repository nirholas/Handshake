// Dependency-free HTML → site snapshot. Extracts the same fields the browser
// widget harvests from a live DOM (title, meta description, headings, nav
// labels, and the main readable text) so concierge_ask can ground an answer in
// any URL without pulling a full HTML parser into an npx-installable server.
//
// This is a pragmatic text extractor, not a spec-complete HTML parser: it
// strips scripts/styles and tags, decodes the common entities, and collapses
// whitespace. Good enough to ground an LLM answer; never used to render.

export const MAX_CONTENT_CHARS = 6000;
const MAX_HEADINGS = 24;
const MAX_NAV = 24;

const ENTITIES = {
	'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

function decode(s) {
	return String(s || '')
		.replace(/&#(\d+);/g, (_, n) => {
			const code = Number(n);
			return Number.isFinite(code) ? String.fromCodePoint(code) : _;
		})
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function collapse(s) {
	return decode(s).replace(/\s+/g, ' ').trim();
}

function stripTags(html) {
	return html.replace(/<[^>]+>/g, ' ');
}

function attr(tag, name) {
	const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
	return m ? m[2] ?? m[3] ?? m[4] ?? '' : '';
}

/**
 * Turn a raw HTML string into the `site` payload /api/concierge accepts.
 * @param {string} html
 * @param {{ url?: string, siteName?: string, knowledge?: string }} [opts]
 */
export function harvestHtml(html, opts = {}) {
	const src = String(html || '');

	// Drop the parts that are never content before extracting anything.
	const cleaned = src
		.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');

	const title = collapse((src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 200);

	let description = '';
	for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = m[0];
		const nameAttr = (attr(tag, 'name') || attr(tag, 'property')).toLowerCase();
		if (nameAttr === 'description' || nameAttr === 'og:description') {
			description = collapse(attr(tag, 'content')).slice(0, 500);
			if (nameAttr === 'description') break; // prefer the plain description
		}
	}

	let siteName = opts.siteName ? collapse(opts.siteName) : '';
	if (!siteName) {
		for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
			if (attr(m[0], 'property').toLowerCase() === 'og:site_name') {
				siteName = collapse(attr(m[0], 'content'));
				break;
			}
		}
	}
	if (!siteName && opts.url) {
		try {
			siteName = new URL(opts.url).hostname.replace(/^www\./, '');
		} catch {
			/* leave blank */
		}
	}

	const headings = [];
	for (const m of cleaned.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
		const t = collapse(stripTags(m[1]));
		if (t && t.length <= 120 && !headings.includes(t)) headings.push(t);
		if (headings.length >= MAX_HEADINGS) break;
	}

	const nav = [];
	const navBlocks = [...cleaned.matchAll(/<(nav|header)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]).join(' ');
	for (const m of navBlocks.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
		const t = collapse(stripTags(m[1]));
		if (t && t.length <= 40 && !nav.includes(t)) nav.push(t);
		if (nav.length >= MAX_NAV) break;
	}

	// Main readable text: prefer <main>/<article>, else the whole body.
	const mainMatch =
		cleaned.match(/<main\b[\s\S]*?<\/main>/i) ||
		cleaned.match(/<article\b[\s\S]*?<\/article>/i) ||
		cleaned.match(/<body\b[\s\S]*?<\/body>/i);
	const content = collapse(stripTags(mainMatch ? mainMatch[0] : cleaned)).slice(0, MAX_CONTENT_CHARS);

	return {
		// The answer endpoint caps site.url at 600 chars; a longer one would 400.
		url: (opts.url || '').slice(0, 600),
		name: siteName.slice(0, 120),
		title,
		description,
		headings,
		nav,
		knowledge: opts.knowledge ? collapse(opts.knowledge).slice(0, 8000) : '',
		content,
	};
}
