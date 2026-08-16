/**
 * Atlas ranking: the pure half of the command palette.
 *
 * Kept DOM-free and in its own module for one reason: ranking is the part that
 * is either right or subtly, invisibly wrong. A palette that puts /docs/x402-buyer
 * above /x402 for the query "x402" is not broken in any way a screenshot shows,
 * it just quietly fails the visitor. So the ranking lives here where
 * tests/atlas.test.js can pin the orderings that matter, and public/atlas.js
 * owns only the UI.
 *
 * Two rankers, because the palette answers two different questions:
 *
 *   rankPages   answers "which route did you mean?". AND over query terms, so every
 *                 term has to land somewhere in the page. Precision beats recall
 *                 across 600 routes; a fuzzy OR turns the list into noise.
 *   rankIntents answers "which task are you trying to do?". Matches curated phrases,
 *                 and floats to the top of the results because a newcomer who
 *                 types "get paid" needs the three-step flow, not the 40 pages
 *                 whose description happens to contain the word "paid".
 */

/** Section weight. Nudges ties toward the surfaces a person can act on. */
const SECTION_WEIGHT = {
	main: 1.15,
	build: 1.15,
	'agent-tools': 1.1,
	crypto: 1.0,
	account: 1.0,
	labs: 0.95,
	learn: 0.9,
	blog: 0.8,
	legal: 0.6,
	machine: 0.6,
};

const WORD_SPLIT = /[^a-z0-9]+/;

export function normalize(text) {
	return String(text || '')
		.toLowerCase()
		.normalize('NFKD')
		// Strip combining marks so "café" matches "cafe".
		.replace(/[\u0300-\u036f]/g, '');
}

export function tokenize(text) {
	return normalize(text).split(WORD_SPLIT).filter(Boolean);
}

/**
 * Score one term against one haystack. Returns 0 when the term is absent.
 * The tiers are ordered by how much a match at that position tells us about
 * intent: the start of a title is a near-certain hit, a hit buried in a
 * description is a hint.
 */
function scoreTerm(term, haystack, weights) {
	const at = haystack.indexOf(term);
	if (at === -1) return 0;
	if (haystack === term) return weights.exact;
	if (at === 0) return weights.prefix;
	// A match at a word boundary ("agent" in "my agent") is worth far more than
	// one inside a word ("gent" in "agents"), which is usually coincidence.
	const before = haystack.charCodeAt(at - 1);
	const isBoundary = !((before >= 97 && before <= 122) || (before >= 48 && before <= 57));
	return isBoundary ? weights.word : weights.loose;
}

const TITLE_W = { exact: 1000, prefix: 620, word: 460, loose: 150 };
const PATH_W = { exact: 900, prefix: 400, word: 300, loose: 90 };
const DESC_W = { exact: 200, prefix: 130, word: 100, loose: 30 };

/**
 * Subsequence fallback for typos and abbreviations: "anmtns" -> "animations",
 * "mktplc" -> "marketplace". Deliberately weak (it can only ever break a tie
 * against a real substring hit) and requires the first character to match, which
 * kills almost all of the false positives a naive subsequence produces.
 */
function subsequenceScore(term, haystack) {
	if (term.length < 3 || haystack[0] !== term[0]) return 0;
	let i = 0;
	let gaps = 0;
	let last = -1;
	for (let h = 0; h < haystack.length && i < term.length; h++) {
		if (haystack[h] === term[i]) {
			if (last >= 0) gaps += h - last - 1;
			last = h;
			i++;
		}
	}
	if (i < term.length) return 0;
	return Math.max(0, 60 - gaps * 4);
}

/**
 * Rank the page tuples from atlas-index.json against a query.
 *
 * @param {string} query
 * @param {Array<[string,string,string,string,number,number]>} pages
 *        [path, title, description, sectionId, priority, flags]
 * @param {{limit?: number}} [opts]
 * @returns {Array<{page: any[], score: number}>}
 */
export function rankPages(query, pages, opts = {}) {
	const terms = tokenize(query);
	if (terms.length === 0) return [];
	const limit = opts.limit ?? 30;
	const whole = normalize(query).trim();
	const out = [];

	for (const page of pages) {
		const title = normalize(page[1]);
		const path = normalize(page[0]);
		const desc = normalize(page[2]);
		let total = 0;
		let matchedAll = true;

		for (const term of terms) {
			const best = Math.max(
				scoreTerm(term, title, TITLE_W),
				scoreTerm(term, path, PATH_W),
				scoreTerm(term, desc, DESC_W),
			);
			if (best > 0) {
				total += best;
				continue;
			}
			const fuzzy = Math.max(subsequenceScore(term, title), subsequenceScore(term, path.slice(1)));
			if (fuzzy > 0) {
				total += fuzzy;
				continue;
			}
			matchedAll = false;
			break;
		}
		if (!matchedAll) continue;

		// Typing the route outright, or the exact title, should never be
		// out-ranked by a longer page that merely contains it.
		if (path === `/${whole}` || path === whole) total += 1400;
		if (title === whole) total += 1200;
		if (title.startsWith(whole)) total += 260;

		// Multi-word queries reward pages that match the phrase in order.
		if (terms.length > 1 && (title.includes(whole) || desc.includes(whole))) total += 320;

		const priority = typeof page[4] === 'number' ? page[4] : 0.5;
		total *= (SECTION_WEIGHT[page[3]] ?? 1) * (0.7 + priority * 0.6);

		out.push({ page, score: total });
	}

	out.sort((a, b) => b.score - a.score || a.page[0].length - b.page[0].length);
	return out.slice(0, limit);
}

/**
 * Rank curated task intents. An intent only surfaces on a real signal: an
 * exact-ish phrase hit, or every query term appearing in one of its phrases.
 * Loose matching here would be worse than no intents at all, because an intent
 * card is visually louder than a page row and pushes real results down.
 *
 * @param {string} query
 * @param {Array<{id:string,title:string,blurb:string,match:string[],steps:any[]}>} intents
 * @returns {Array<{intent:any, score:number}>}
 */
export function rankIntents(query, intents, opts = {}) {
	const whole = normalize(query).trim();
	if (whole.length < 2) return [];
	const terms = tokenize(query);
	const limit = opts.limit ?? 3;
	const out = [];

	for (const intent of intents) {
		let best = 0;
		for (const raw of intent.match || []) {
			const phrase = normalize(raw);
			if (phrase === whole) best = Math.max(best, 5000);
			else if (phrase.startsWith(whole)) best = Math.max(best, 3400 + whole.length * 8);
			else if (whole.startsWith(phrase)) best = Math.max(best, 3000 + phrase.length * 8);
			else if (whole.includes(phrase)) best = Math.max(best, 2200 + phrase.length * 6);
			else if (phrase.includes(whole)) best = Math.max(best, 1600 + whole.length * 6);
		}
		if (best === 0) {
			// Every term present across the phrase set plus the title. Handles
			// "how do i get paid" hitting the "get paid" intent without letting a
			// single incidental word do it.
			const hay = `${normalize(intent.title)} ${(intent.match || []).map(normalize).join(' ')}`;
			if (terms.length >= 2 && terms.every((t) => hay.includes(t))) best = 1200 + terms.length * 60;
		}
		if (best > 0) out.push({ intent, score: best });
	}

	out.sort((a, b) => b.score - a.score);
	return out.slice(0, limit);
}

/**
 * Split `text` into alternating plain/matched runs so the UI can bold what the
 * visitor actually typed. Returns [{t, hit}]. Overlapping term hits are merged,
 * which is why this returns runs rather than a marked-up string.
 */
export function highlight(text, query) {
	const source = String(text || '');
	const hay = normalize(source);
	const terms = [...new Set(tokenize(query))].sort((a, b) => b.length - a.length);
	const marks = new Array(hay.length).fill(false);

	for (const term of terms) {
		let from = 0;
		for (;;) {
			const at = hay.indexOf(term, from);
			if (at === -1) break;
			for (let i = at; i < at + term.length; i++) marks[i] = true;
			from = at + term.length;
		}
	}

	const runs = [];
	let i = 0;
	while (i < source.length) {
		const hit = marks[i] === true;
		let j = i;
		while (j < source.length && (marks[j] === true) === hit) j++;
		runs.push({ t: source.slice(i, j), hit });
		i = j;
	}
	return runs.length ? runs : [{ t: source, hit: false }];
}
