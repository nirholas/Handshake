/**
 * Site-context harvester: @three-ws/concierge
 * ============================================
 *
 * The concierge grounds its answers in the page it is embedded on, with no
 * crawler, no index, and no server-side setup: at ask-time it reads the live
 * DOM, title, meta description, headings, nav labels, and the main content , 
 * and ships a bounded snapshot to the answer endpoint. A host can top this up
 * with a `knowledge` string (FAQ, policies, product facts) that is always
 * included ahead of the harvested page text.
 *
 * Pure DOM-in / JSON-out so it is unit-testable with a fake document.
 */

export const MAX_CONTENT_CHARS = 6000;
export const MAX_KNOWLEDGE_CHARS = 8000;

const SKIP_SELECTOR =
	'script,style,noscript,template,svg,iframe,canvas,[aria-hidden="true"],[hidden],[data-concierge-ignore]';

function cleanText(s) {
	return String(s || '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Collect visible text from a root, skipping chrome/noise elements. */
function harvestText(root, budget) {
	if (!root) return '';
	const clone = root.cloneNode(true);
	for (const el of clone.querySelectorAll(SKIP_SELECTOR)) el.remove();
	// The concierge's own UI must never feed back into its context.
	for (const el of clone.querySelectorAll('[data-three-concierge]')) el.remove();
	return cleanText(clone.textContent).slice(0, budget);
}

/**
 * Build the site snapshot for one ask.
 * @param {Document} doc
 * @param {{ knowledge?: string, siteName?: string }} [opts]
 * @returns {{ url: string, title: string, description: string, headings: string[],
 *            nav: string[], content: string, name: string }}
 */
export function harvestSiteContext(doc, opts = {}) {
	if (!doc) return { url: '', title: '', description: '', headings: [], nav: [], content: '', name: '' };

	const title = cleanText(doc.title).slice(0, 200);
	const description = cleanText(
		doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
			doc.querySelector('meta[property="og:description"]')?.getAttribute('content'),
	).slice(0, 500);

	const headings = [...doc.querySelectorAll('h1, h2, h3')]
		.map((h) => cleanText(h.textContent))
		.filter((t) => t && t.length <= 120)
		.slice(0, 24);

	const nav = [...doc.querySelectorAll('nav a, header a')]
		.map((a) => cleanText(a.textContent))
		.filter((t) => t && t.length <= 40);
	const uniqueNav = [...new Set(nav)].slice(0, 24);

	const main =
		doc.querySelector('main') || doc.querySelector('[role="main"]') || doc.querySelector('article') || doc.body;
	const content = harvestText(main, MAX_CONTENT_CHARS);

	const name =
		cleanText(doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')) ||
		(opts.siteName ? cleanText(opts.siteName) : '') ||
		(typeof location !== 'undefined' ? location.hostname : '');

	return {
		url: typeof location !== 'undefined' ? location.href.split('#')[0] : '',
		title,
		description,
		headings,
		nav: uniqueNav,
		content,
		name: name.slice(0, 120),
	};
}

/**
 * Merge host knowledge + harvested page into the `site` payload the
 * /api/concierge endpoint accepts. Knowledge leads (it is curated), the live
 * page fills the remaining budget.
 */
export function buildSitePayload(doc, opts = {}) {
	const ctx = harvestSiteContext(doc, opts);
	const knowledge = cleanText(opts.knowledge).slice(0, MAX_KNOWLEDGE_CHARS);
	let content = ctx.content;
	if (knowledge) {
		const remaining = Math.max(0, MAX_CONTENT_CHARS - Math.min(knowledge.length, MAX_CONTENT_CHARS));
		content = content.slice(0, remaining);
	}
	return {
		url: ctx.url,
		name: ctx.name,
		title: ctx.title,
		description: ctx.description,
		headings: ctx.headings,
		nav: ctx.nav,
		knowledge,
		content,
	};
}
