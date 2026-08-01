#!/usr/bin/env node
/**
 * Documentation search index builder.
 *
 * The site-wide Cmd-K palette (public/search.js) searches page titles, agents,
 * coins, and skills. It has never searched the documentation itself, so the
 * 450+ markdown files under docs/ were reachable only by knowing their name in
 * advance. Anyone who typed a real question ("how do I fund an agent wallet")
 * got nothing, and the answer was three clicks and a guess away.
 *
 * This builds a static, section-level inverted index over that corpus so the
 * browser can answer those queries locally: no search service, no server round
 * trip, no per-query cost, and it keeps working offline once cached.
 *
 * Design notes worth knowing before editing:
 *
 *   • Sections, not files. A hit on "settle floor" should land on the heading
 *     that discusses it, not the top of a 1,200-line reference. Anchors are
 *     produced with the SAME slug rules docs/index.html applies when it assigns
 *     heading ids, so every emitted anchor resolves in the reader.
 *   • Code fences are skipped. They are a large share of the corpus and their
 *     tokens (variable names, JSON keys, hex) drown prose in the ranking.
 *   • Postings are capped per term (MAX_POSTINGS). The index size is dominated
 *     by a few hundred very common terms; capping those costs almost nothing in
 *     ranking quality, because a query's rare terms are what select the section
 *     and the common terms only nudge the score.
 *   • Output is deterministic — no timestamps — so `--check` can compare the
 *     committed artifact byte-for-byte and fail when docs changed without a
 *     rebuild. A stale index is worse than none: it answers confidently and
 *     sends the reader to a heading that no longer exists.
 *
 * Usage:
 *   node scripts/build-docs-search-index.mjs           # write the index
 *   node scripts/build-docs-search-index.mjs --check   # verify it is current
 */

import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'docs');
const OUT_PATH = join(ROOT, 'public', 'docs-search-index.json');

// Generated aggregates restate the corpus. docs/ALL.md is every other doc
// concatenated; docs/agent-abilities/ABILITIES.md is a rewrite of
// FULL-ARTICLE.md. Indexing them lets one file answer for content it does not
// own, and fills a result list with three copies of the same paragraph.
//
// Detection is by the marker generators already write into their own output
// rather than a curated filename list, so the next generated doc is excluded
// the day it lands instead of the day someone notices.
const GENERATED_MARKER = /^<!--\s*GENERATED\b/im;
const GENERATED_HEAD_LINES = 3;

// Sections split on H1/H2/H3. Splitting only on H1/H2 was measured smaller, but
// it is wrong: docs that use H3 as their entry level (the whole ux-flows atlas)
// collapse into one enormous section that then matches every query and answers
// none of them. Every heading the reader can link to is a heading search can
// land on.
const SECTION_HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

// Below this a "section" is a heading with a sentence fragment under it — a
// stub, a table caption, a see-also. Indexing them adds noise, not answers.
const MIN_SECTION_CHARS = 60;

// One line of context in the result row, stored once per DOCUMENT rather than
// once per section. Per-section snippets measured at 955 KB of a 2.8 MB
// artifact — a third of the download to restate, 4,789 times, something the
// heading already says. Per-document costs 2% of that and still gives every
// result row a second line explaining what the page is.
const SNIPPET_CHARS = 140;

// Per-term posting cap, applied to the highest-tf sections. See the header note.
const MAX_POSTINGS = 20;

// Term frequency is stored packed into the section-id delta (see packPosting).
// Four bits is plenty: BM25 saturates on tf via k1 long before 15 occurrences
// of one term in one section, so clamping there is invisible in the ranking.
const TF_BITS = 4;
const TF_MAX = (1 << TF_BITS) - 1;

const MIN_TOKEN = 2;
const MAX_TOKEN = 24;

// Hex digests and long digit runs (transaction hashes, addresses, block
// numbers) are unique by construction: each one adds a term nobody will ever
// type and that could never disambiguate anything if they did.
const JUNK_TOKEN = /^(?:[0-9a-f]{8,}|\d{6,})$/;

// Deliberately short. An aggressive stopword list breaks real queries in a
// developer corpus ("no code", "off chain", "on chain"), so this covers only
// words that carry no selectivity anywhere.
const STOPWORDS = new Set(
	('a an and are as at be been but by did do does for from had has have how i if in into is it its me my '
		+ 'of on or our so than that the their then there these they this to us was we were what when where which while who will with you your')
		.split(' '),
);

function walkMarkdown(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkMarkdown(full, out);
		} else if (entry.name.endsWith('.md')) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Heading id, matching slugifyHeading() in docs/index.html exactly. If these
 * two ever disagree the anchor silently stops resolving and the reader lands at
 * the top of the page instead of the answer, so the rules are duplicated here
 * verbatim rather than approximated.
 */
export function slugifyHeading(text) {
	return (text || '')
		.trim()
		.toLowerCase()
		.replace(/[^\w\- ]+/g, '')
		.replace(/ /g, '-');
}

/** Markdown inline syntax to the text a reader actually sees. */
export function plainText(md) {
	return md
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[`*_~]+/g, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*>\s?/gm, '')
		.replace(/\|/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Split a markdown document into indexable sections.
 *
 * @param {string} md raw markdown
 * @param {string} fallbackTitle used when the file has no H1
 * @returns {{ title: string, sections: Array<{ heading: string, anchor: string, text: string }> }}
 */
export function splitSections(md, fallbackTitle) {
	// Strip YAML front matter before anything else so its keys never become
	// prose ("description", "sidebar_position").
	let body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

	let title = '';
	const sections = [];
	let current = { heading: '', anchor: '', lines: [] };
	let inFence = false;
	let fenceMarker = '';

	for (const line of body.split(/\r?\n/)) {
		const fence = line.match(/^\s*(```+|~~~+)/);
		if (fence) {
			// Only the marker that opened the fence can close it, so a ```` block
			// containing ``` stays one block instead of splitting into two.
			if (!inFence) {
				inFence = true;
				fenceMarker = fence[1].slice(0, 3);
			} else if (fence[1].startsWith(fenceMarker)) {
				inFence = false;
			}
			continue;
		}
		if (inFence) continue;

		const heading = line.match(SECTION_HEADING);
		if (!heading) {
			current.lines.push(line);
			continue;
		}

		const headingText = plainText(heading[2]);
		if (heading[1] === '#' && !title) {
			title = headingText;
			// The H1 is the document title, not a section of it: its body flows
			// into the first real section rather than starting a titled one.
			current = { heading: '', anchor: '', lines: current.lines };
			continue;
		}
		sections.push(current);
		current = { heading: headingText, anchor: slugifyHeading(headingText), lines: [] };
	}
	sections.push(current);

	return {
		title: title || fallbackTitle,
		sections: sections
			.map((s) => ({ heading: s.heading, anchor: s.anchor, text: plainText(s.lines.join('\n')) }))
			.filter((s) => s.text.length >= MIN_SECTION_CHARS),
	};
}

/**
 * Query and document tokenizer. Shared shape with the runtime in
 * public/docs-search.js — the two must agree or a term indexed here can never
 * be typed there.
 *
 * Keeps `.`, `-`, `+` and `#` inside a token so `x402`, `erc-8004`, `c++` and
 * `next.js` survive, then also emits the parts of a compound so `8004` finds
 * `erc-8004`.
 */
export function tokenize(text) {
	const out = [];
	for (const raw of String(text).toLowerCase().split(/[^a-z0-9.+#-]+/)) {
		const token = raw.replace(/^[.+#-]+/, '').replace(/[.+#-]+$/, '');
		if (!keepToken(token)) continue;
		out.push(token);
		if (/[.-]/.test(token)) {
			for (const part of token.split(/[.-]+/)) {
				if (keepToken(part)) out.push(part);
			}
		}
	}
	return out;
}

function keepToken(token) {
	if (!token || token.length < MIN_TOKEN || token.length > MAX_TOKEN) return false;
	if (STOPWORDS.has(token)) return false;
	return !JUNK_TOKEN.test(token);
}

/**
 * Pack one posting into a single integer: the gap since the previous section id
 * in the high bits, the clamped term frequency in the low bits. JSON stores
 * numbers as text, so halving the count of numbers is a direct, measurable cut
 * to the bytes a reader downloads.
 */
export function packPosting(gap, tf) {
	return gap * (TF_MAX + 1) + Math.min(tf, TF_MAX);
}

/**
 * Front-code a sorted term list: each entry becomes the number of leading
 * characters shared with its predecessor, then the remaining suffix. A sorted
 * technical vocabulary shares long prefixes (`agent`, `agents`, `agentwallet`),
 * so this is close to free to decode and cuts the term block by roughly a
 * third. The shared count is base-36 so it never costs more than one character.
 */
export function frontCode(terms) {
	const out = new Array(terms.length);
	let previous = '';
	for (let i = 0; i < terms.length; i++) {
		const term = terms[i];
		let shared = 0;
		const max = Math.min(previous.length, term.length, 35);
		while (shared < max && previous[shared] === term[shared]) shared++;
		out[i] = shared.toString(36) + term.slice(shared);
		previous = term;
	}
	return out;
}

/** A generator stamps its own output; the marker sits in the first few lines. */
export function isGenerated(md) {
	return GENERATED_MARKER.test(md.split(/\r?\n/, GENERATED_HEAD_LINES).join('\n'));
}

/**
 * Build the index in memory. Exported so the test suite can assert on the real
 * corpus without writing to a worktree other agents are also using.
 *
 * @param {string} [dir] documentation root
 * @returns {object} the artifact that is serialized to public/docs-search-index.json
 */
export function buildIndex(dir = DOCS_DIR) {
	const files = walkMarkdown(dir);
	const skipped = [];
	const docs = [];
	const sections = [];
	// term -> Map<sectionId, tf>
	const posting = new Map();

	for (const file of files) {
		const rel = relative(dir, file).replace(/\\/g, '/');
		const slug = rel.replace(/\.md$/, '');
		const md = readFileSync(file, 'utf8');
		if (isGenerated(md)) {
			skipped.push(slug);
			continue;
		}
		const fallback = slug.split('/').pop().replace(/[-_]+/g, ' ');
		const { title, sections: parsed } = splitSections(md, fallback);
		if (!parsed.length) continue;

		const docId = docs.length;
		// The opening prose of a doc is its own best summary — it is written to
		// tell a reader who just arrived what this page is.
		docs.push([slug, title, parsed[0].text.slice(0, SNIPPET_CHARS)]);

		for (const section of parsed) {
			const sectionId = sections.length;
			// The heading is indexed twice with the body so a section titled "Rate
			// limits" wins the query "rate limits" even when the prose never
			// repeats it.
			const tokens = tokenize(`${section.heading} ${section.heading} ${title} ${section.text}`);
			// The anchor is deliberately NOT stored: it is slugifyHeading(heading),
			// and the reader derives it the same way from the rendered document. A
			// stored copy is a second source of truth that can only ever drift.
			sections.push([docId, section.heading, tokens.length]);
			for (const token of tokens) {
				let byToken = posting.get(token);
				if (!byToken) posting.set(token, (byToken = new Map()));
				byToken.set(sectionId, (byToken.get(sectionId) || 0) + 1);
			}
		}
	}

	const terms = [...posting.keys()].sort();
	const dfs = new Array(terms.length);
	const postings = new Array(terms.length);
	for (let i = 0; i < terms.length; i++) {
		const byToken = posting.get(terms[i]);
		dfs[i] = byToken.size;
		let entries = [...byToken.entries()];
		if (entries.length > MAX_POSTINGS) {
			// Keep the strongest sections for this term, then restore id order so
			// the delta encoding below stays monotonic.
			entries.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
			entries = entries.slice(0, MAX_POSTINGS);
		}
		entries.sort((a, b) => a[0] - b[0]);
		const flat = [];
		let prev = 0;
		for (const [sectionId, tf] of entries) {
			flat.push(packPosting(sectionId - prev, tf));
			prev = sectionId;
		}
		postings[i] = flat;
	}

	const totalTokens = sections.reduce((sum, s) => sum + s[2], 0);

	return {
		v: 1,
		note: 'Generated by scripts/build-docs-search-index.mjs. Do not edit by hand.',
		docCount: docs.length,
		// Named, not just counted: a doc that silently stops being searchable
		// because a generator marker appeared in it should be visible here.
		skippedGenerated: skipped,
		sectionCount: sections.length,
		avgLen: sections.length ? Math.round((totalTokens / sections.length) * 100) / 100 : 0,
		tfBits: TF_BITS,
		// [slug, title, snippet]
		docs,
		// [docId, heading, tokenCount]
		sections,
		// Front-coded, ascending. Decode with the runtime's expandTerms().
		terms: frontCode(terms),
		dfs,
		// Per term, ascending: packPosting(gap since previous section id, tf).
		postings,
	};
}

function serialize(index) {
	return `${JSON.stringify(index)}\n`;
}

// Importing this module must not build or write anything: the test suite pulls
// in buildIndex() and the pure helpers directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
const check = process.argv.includes('--check');
const index = buildIndex();
const output = serialize(index);

if (check) {
	if (!existsSync(OUT_PATH)) {
		console.error('docs-search: public/docs-search-index.json is missing. Run `npm run build:docs-search`.');
		process.exit(1);
	}
	if (readFileSync(OUT_PATH, 'utf8') !== output) {
		console.error('docs-search: the committed index is stale. Run `npm run build:docs-search` and commit the result.');
		process.exit(1);
	}
	console.log(`docs-search: index is current (${index.docCount} docs, ${index.sectionCount} sections).`);
} else {
	// Concurrent agents share this worktree, so a half-written index must never
	// be observable: write beside the target and rename it into place.
	const tmp = `${OUT_PATH}.tmp-${process.pid}`;
	writeFileSync(tmp, output);
	renameSync(tmp, OUT_PATH);
	const kb = Math.round(output.length / 1024);
	console.log(
		`docs-search: ${index.docCount} docs, ${index.sectionCount} sections, ${index.terms.length} terms, ${kb} KB`,
	);
}
}
