// Publisher rights layer for the crypto-news reader.
// ---------------------------------------------------------------------------
// three.ws aggregates ~100 publisher feeds. Aggregation is lawful; republishing
// a publisher's article body under our own canonical URL is not. This module is
// the single place that enforces the line:
//
//   1. TAKEDOWN_IDS / RESTRICTED_* — stories and publishers we must not serve at
//      all, because a rightsholder demanded removal. Their permalinks answer
//      410 Gone (not 404): 410 tells Google the removal is permanent and drops
//      the URL from the index on the next crawl, which is exactly what a DMCA
//      removal requires. They are also kept out of the sitemap and out of
//      ingest, so a suppressed story cannot come back on the next cron run.
//
//   2. excerptParagraphs() — the standing limit for EVERY publisher. The reader
//      shows a bounded lead excerpt plus our own analysis (summary, key points,
//      tickers, market context) and sends the reader to the publisher for the
//      rest. Our analysis is our work; the excerpt is a quotation. The full
//      body is never ours to host.
//
// Rule 2 is the one that matters long-term. Rule 1 only ever cleans up after
// rule 2 was missing.

/**
 * Articles removed at a rightsholder's demand, keyed by the content-addressed
 * 16-hex story id (the same id that appears in /markets/news/<month>/<id>).
 *
 * The Merkle, LLC / NullTX (nulltx.com) — notice received 2026-07-19 via the
 * Google Search Console legal channel, Lumen notice 15710816, Google reference
 * 5-4413000041574-1840887990. 24 URLs, all NullTX-sourced. The claim is that
 * the pages reproduced the titles and substantially the full body text of the
 * corresponding nulltx.com articles. They did: the reader rendered the full
 * extracted body under our own canonical URL.
 */
export const TAKEDOWN_IDS = new Set([
	// 2026-06
	'4bc5221ecb8d937f',
	'b07b96e91727c482',
	'c93631777118720f',
	'ee65119b06ff4c4a',
	// 2026-07
	'18de74ebebef95c1',
	'293837811670f09c',
	'342bc502e9eba7b3',
	'3c999789e42b5496',
	'488bc38883c9bfc1',
	'4a56b53000499242',
	'4b79c1afdb11d4ab',
	'4cbff9aca3645cc0',
	'50c4b19439a0114c',
	'539b630f93ba1f3b',
	'67cd8aa07a33057a',
	'7a47fc153b8404d8',
	'8e46c4bc98bfb5b0',
	'9d13b656fd6e4726',
	'b6dd11575dc5e58c',
	'ba6e29eba690eb27',
	'c061e9c72f986cb8',
	'c0692b0cc3683978',
	'cea75bb729937c2a',
	'e705dc021da87ce5',
]);

/**
 * Publishers withdrawn from the platform entirely. A key here is dropped from
 * ingest (api/_lib/news-sources.js no longer lists it) AND suppressed on read,
 * so records already sitting in the GCS archive or the knowledge base stop
 * resolving even before the purge script has run against them.
 */
export const RESTRICTED_SOURCE_KEYS = new Set(['nulltx']);

/**
 * Host-level backstop for the same publishers. Archive records predate the
 * source-key schema in places, and a record's `source` may be a display name
 * rather than a key — matching the link's hostname catches every copy.
 */
export const RESTRICTED_HOSTS = new Set(['nulltx.com', 'www.nulltx.com']);

/** Display names, for the removal notice shown in place of the story. */
const RESTRICTED_LABELS = { nulltx: 'NullTX' };

function hostOf(link) {
	try {
		return new URL(String(link)).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Is this story suppressed, and why?
 *
 * @param {{id?: string, link?: string, url?: string, source_key?: string, source?: string}} article
 * @returns {{reason: 'takedown'|'restricted_publisher', publisher: string|null} | null}
 */
export function suppression(article) {
	if (!article) return null;
	const id = String(article.id || '').toLowerCase();
	if (id && TAKEDOWN_IDS.has(id)) {
		return { reason: 'takedown', publisher: RESTRICTED_LABELS.nulltx };
	}

	const key = String(article.source_key || '').toLowerCase();
	if (key && RESTRICTED_SOURCE_KEYS.has(key)) {
		return { reason: 'restricted_publisher', publisher: RESTRICTED_LABELS[key] || article.source || null };
	}

	const host = hostOf(article.link || article.url);
	if (host && RESTRICTED_HOSTS.has(host)) {
		return { reason: 'restricted_publisher', publisher: article.source || null };
	}
	return null;
}

/** Convenience boolean for filter chains (sitemap, feeds, archive listings). */
export function isSuppressed(article) {
	return suppression(article) !== null;
}

// ── The standing excerpt limit (applies to every publisher) ──────────────────

/** Hard ceiling on quoted publisher prose shown on a three.ws story page. */
export const EXCERPT_MAX_CHARS = 400;
/** Never quote more than the story's opening beat. */
export const EXCERPT_MAX_PARAGRAPHS = 2;

/**
 * Reduce an extracted body to a lead excerpt we can lawfully quote.
 *
 * Takes whole paragraphs while they fit the character budget; if even the first
 * paragraph overruns, it is cut at the last sentence boundary inside the budget
 * (falling back to a word boundary) so the excerpt never ends mid-word.
 *
 * @param {string[]} paragraphs full extracted body
 * @returns {{paragraphs: string[], truncated: boolean}} bounded excerpt, and
 *   whether anything was withheld (drives the "read the rest at the publisher"
 *   affordance in the reader).
 */
export function excerptParagraphs(paragraphs) {
	const all = (Array.isArray(paragraphs) ? paragraphs : []).map((p) => String(p || '').trim()).filter(Boolean);
	if (!all.length) return { paragraphs: [], truncated: false };

	const out = [];
	let used = 0;
	for (const p of all) {
		if (out.length >= EXCERPT_MAX_PARAGRAPHS) break;
		if (used + p.length > EXCERPT_MAX_CHARS) break;
		out.push(p);
		used += p.length;
	}

	if (!out.length) {
		const first = all[0].slice(0, EXCERPT_MAX_CHARS);
		// Prefer a sentence boundary; fall back to a word boundary.
		const lastStop = Math.max(first.lastIndexOf('. '), first.lastIndexOf('! '), first.lastIndexOf('? '));
		const cut = lastStop > EXCERPT_MAX_CHARS * 0.5 ? first.slice(0, lastStop + 1) : first.slice(0, first.lastIndexOf(' '));
		out.push(`${cut.trim()}…`);
	}

	return { paragraphs: out, truncated: out.length < all.length || used < all.join('').length };
}

/**
 * Single-string form of the same limit, for the `description` field.
 *
 * Publishers that ship content:encoded routinely put the WHOLE article in the
 * RSS description, so an unbounded description is the article body wearing a
 * different field name — in the archive records, the paid archive API, and the
 * crawler-visible story page alike.
 *
 * @param {string} text
 * @returns {string} bounded quotable text (empty in, empty out)
 */
export function excerptText(text) {
	const s = String(text || '').trim();
	if (!s) return '';
	if (s.length <= EXCERPT_MAX_CHARS) return s;
	return excerptParagraphs([s]).paragraphs[0] || s.slice(0, EXCERPT_MAX_CHARS);
}
