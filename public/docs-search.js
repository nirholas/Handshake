// three.ws documentation search — BM25 over a static index, entirely in the browser.
//
// The companion to scripts/build-docs-search-index.mjs. That script turns
// docs/**/*.md into an inverted index; this runs queries against it with no
// search service, no API call, and no per-query cost. Once the index is cached
// the whole thing works offline.
//
// Two consumers, one engine:
//   • public/search.js — the Cmd-K palette's "Documentation" category
//   • docs/index.html  — the search field on the docs site itself
//
// Both call ready() (idempotent, fetches once) and then query(). The index is
// ~1.4 MB, so it is fetched only when someone actually searches: nobody pays
// for it by loading a page.
//
// The tokenizer here MUST agree with the builder's. A term the builder folded
// differently is a term the reader can never type, so both sides keep the same
// rules: lowercase, `.`/`-`/`+`/`#` survive inside a token, compounds also index
// their parts (`erc-8004` finds `8004`), and a short stopword list is dropped.

// Attaches to the global as `twsDocsSearch` in every environment: a classic
// <script> in the browser, and an `import`/`require` in the test suite. The
// repo is ESM, so `this` is undefined at module scope here — globalThis is the
// only handle that works on both sides.
(function (root, factory) {
	var api = factory();
	root.twsDocsSearch = api;
	if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
	'use strict';

	var INDEX_URL = '/docs-search-index.json';

	// BM25. b is a touch below the usual 0.75: doc sections vary in length for
	// editorial reasons (a reference table next to a two-paragraph explainer),
	// and punishing the long ones too hard buries the reference pages that most
	// often hold the answer.
	var K1 = 1.2;
	var B = 0.7;

	// A term the query typed in full outranks one it merely prefixes. Applied to
	// the trailing token only, which is the one still being typed.
	var PREFIX_WEIGHT = 0.45;
	var MAX_PREFIX_TERMS = 12;

	// Multipliers for where a term was found. A section whose heading is the
	// query is almost always the intended destination.
	var HEADING_BOOST = 2.2;
	var TITLE_BOOST = 1.5;

	// Typing a heading you have seen must land on that heading. The per-term
	// boost above cannot guarantee it: a short section carries little term
	// frequency, so a long page that merely uses the same common words can win
	// on raw BM25. This fires only when the query and the heading reduce to the
	// SAME token sequence, which is the one case where the intent is unambiguous.
	var EXACT_HEADING_BOOST = 2.6;

	// How hard to favour sections that contain ALL the query's terms over ones
	// that contain one of them repeatedly. Tuned on real queries against this
	// corpus: 1 was too weak to beat a single high-frequency term, 2 started
	// discarding good partial matches when a query included a word we simply do
	// not use.
	var COORD_EXPONENT = 1.5;

	// One document should not be able to fill the result list with five of its
	// own sections when four other documents also answer the question.
	var MAX_PER_DOC = 2;

	var MIN_TOKEN = 2;
	var MAX_TOKEN = 24;
	var JUNK_TOKEN = /^(?:[0-9a-f]{8,}|\d{6,})$/;
	var STOPWORDS = {};
	('a an and are as at be been but by did do does for from had has have how i if in into is it its me my '
		+ 'of on or our so than that the their then there these they this to us was we were what when where which while who will with you your')
		.split(' ')
		.forEach(function (w) {
			STOPWORDS[w] = true;
		});

	var index = null;
	var loading = null;
	var terms = null;
	var status = 'idle';

	function keepToken(token) {
		if (!token || token.length < MIN_TOKEN || token.length > MAX_TOKEN) return false;
		if (STOPWORDS[token]) return false;
		return !JUNK_TOKEN.test(token);
	}

	/** Mirrors tokenize() in scripts/build-docs-search-index.mjs. */
	function tokenize(text) {
		var out = [];
		var raw = String(text).toLowerCase().split(/[^a-z0-9.+#-]+/);
		for (var i = 0; i < raw.length; i++) {
			var token = raw[i].replace(/^[.+#-]+/, '').replace(/[.+#-]+$/, '');
			if (!keepToken(token)) continue;
			out.push(token);
			if (/[.-]/.test(token)) {
				var parts = token.split(/[.-]+/);
				for (var j = 0; j < parts.length; j++) if (keepToken(parts[j])) out.push(parts[j]);
			}
		}
		return out;
	}

	/** Mirrors slugifyHeading() in docs/index.html, which assigns the heading ids. */
	function slugifyHeading(text) {
		return (text || '')
			.trim()
			.toLowerCase()
			.replace(/[^\w\- ]+/g, '')
			.replace(/ /g, '-');
	}

	/** Undo the builder's front coding: "<sharedCountBase36><suffix>". */
	function expandTerms(coded) {
		var out = new Array(coded.length);
		var previous = '';
		for (var i = 0; i < coded.length; i++) {
			var entry = coded[i];
			var shared = parseInt(entry[0], 36);
			var term = previous.slice(0, shared) + entry.slice(1);
			out[i] = term;
			previous = term;
		}
		return out;
	}

	/** First index whose term is >= target, or terms.length. */
	function lowerBound(target) {
		var lo = 0;
		var hi = terms.length;
		while (lo < hi) {
			var mid = (lo + hi) >> 1;
			if (terms[mid] < target) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	function termId(token) {
		var at = lowerBound(token);
		return at < terms.length && terms[at] === token ? at : -1;
	}

	/** Term ids sharing a prefix, most common first (the likeliest completions). */
	function prefixTermIds(prefix) {
		var at = lowerBound(prefix);
		var found = [];
		while (at < terms.length && terms[at].indexOf(prefix) === 0) {
			found.push(at);
			at++;
			// A one- or two-letter prefix can match thousands of terms. Scanning
			// them all would stall a keystroke for nothing, since the ranking only
			// keeps a handful.
			if (found.length > 400) break;
		}
		found.sort(function (a, b) {
			return index.dfs[b] - index.dfs[a];
		});
		return found.slice(0, MAX_PREFIX_TERMS);
	}

	function idf(df) {
		var n = index.sectionCount;
		return Math.log(1 + (n - df + 0.5) / (df + 0.5));
	}

	/** Walk one term's packed postings: gap since previous section id, then tf. */
	function eachPosting(termIndex, visit) {
		var packed = index.postings[termIndex];
		var tfMax = (1 << index.tfBits) - 1;
		var scale = tfMax + 1;
		var sectionId = 0;
		for (var i = 0; i < packed.length; i++) {
			sectionId += Math.floor(packed[i] / scale);
			visit(sectionId, packed[i] % scale);
		}
	}

	function accumulate(scores, coverage, bit, termIndex, weight) {
		var weightedIdf = idf(index.dfs[termIndex]) * weight;
		var avgLen = index.avgLen || 1;
		eachPosting(termIndex, function (sectionId, tf) {
			var len = index.sections[sectionId][2] || 1;
			var norm = tf + K1 * (1 - B + (B * len) / avgLen);
			scores[sectionId] = (scores[sectionId] || 0) + (weightedIdf * (tf * (K1 + 1))) / norm;
			coverage[sectionId] = (coverage[sectionId] || 0) | bit;
		});
	}

	function popcount(mask) {
		var n = 0;
		while (mask) {
			mask &= mask - 1;
			n++;
		}
		return n;
	}

	/**
	 * Rank documentation sections for a query.
	 *
	 * @param {string} text raw query, as typed
	 * @param {number} [limit] maximum results (default 8)
	 * @returns {Array<{slug,docTitle,heading,anchor,snippet,url,score,matched}>}
	 */
	function query(text, limit) {
		if (!index) return [];
		var tokens = tokenize(text);
		if (!tokens.length) return [];
		var max = limit || 8;

		// Duplicates in a query add nothing but cost, and the trailing token is
		// the only one still being typed.
		var unique = [];
		for (var i = 0; i < tokens.length; i++) if (unique.indexOf(tokens[i]) === -1) unique.push(tokens[i]);
		var last = tokens[tokens.length - 1];
		var trailingIsPartial = /[a-z0-9]$/i.test(text);

		// The query reduced to its token sequence, for the exact-heading test below.
		var queryKey = tokens.join(' ');

		var scores = {};
		// Which of the query's terms each section actually contains, as a bitmask.
		// Only the first 31 unique terms get a bit, which no real query reaches.
		var coverage = {};
		var matched = [];
		var scoredTerms = 0;
		for (var t = 0; t < unique.length && t < 31; t++) {
			var token = unique[t];
			var bit = 1 << t;
			var exact = termId(token);
			var hitAny = false;
			if (exact !== -1) {
				accumulate(scores, coverage, bit, exact, 1);
				matched.push(token);
				hitAny = true;
			}
			if (token === last && trailingIsPartial) {
				var expansions = prefixTermIds(token);
				for (var e = 0; e < expansions.length; e++) {
					if (expansions[e] === exact) continue;
					accumulate(scores, coverage, bit, expansions[e], PREFIX_WEIGHT);
					matched.push(terms[expansions[e]]);
					hitAny = true;
				}
			}
			// A term nobody wrote (a typo, a product we do not document) must not
			// count against every section for lacking it.
			if (hitAny) scoredTerms++;
		}

		var ranked = [];
		for (var key in scores) {
			if (!Object.prototype.hasOwnProperty.call(scores, key)) continue;
			var sectionId = +key;
			var section = index.sections[sectionId];
			var doc = index.docs[section[0]];
			var heading = (section[1] || '').toLowerCase();
			var title = (doc[1] || '').toLowerCase();
			// Scaled by the FRACTION of the query the heading carries, not
			// compounded per word. Multiplying once per matched term let a long
			// heading that happens to contain three common query words outrank the
			// page actually about the subject by an order of magnitude.
			var inHeading = 0;
			var inTitle = 0;
			for (var m = 0; m < unique.length; m++) {
				if (heading.indexOf(unique[m]) !== -1) inHeading++;
				else if (title.indexOf(unique[m]) !== -1) inTitle++;
			}
			var of = Math.max(1, scoredTerms);
			var boost = (1 + ((HEADING_BOOST - 1) * inHeading) / of) * (1 + ((TITLE_BOOST - 1) * inTitle) / of);
			// Only headings already holding every query term can be the query, so
			// the tokenize() call runs on a handful of candidates per keystroke
			// rather than on every scored section.
			if (unique.length && inHeading === unique.length && tokenize(section[1] || '').join(' ') === queryKey) {
				boost *= EXACT_HEADING_BOOST;
			}
			// Coordination: a section holding every word of the question beats one
			// holding a single rare word many times. Without this, "fund an agent
			// wallet" is won by whichever page says "fund" most often rather than
			// by the page about funding agent wallets.
			if (scoredTerms > 1) {
				boost *= Math.pow(popcount(coverage[key] || 0) / scoredTerms, COORD_EXPONENT);
			}
			ranked.push({ sectionId: sectionId, docId: section[0], score: scores[key] * boost });
		}
		ranked.sort(function (a, b) {
			return b.score - a.score || a.sectionId - b.sectionId;
		});

		var perDoc = {};
		var seenHeading = {};
		var out = [];
		for (var r = 0; r < ranked.length && out.length < max; r++) {
			var hit = ranked[r];
			var seen = perDoc[hit.docId] || 0;
			if (seen >= MAX_PER_DOC) continue;
			// Long-form docs are also published split into chapters, so the same
			// heading legitimately exists in two places. Both are real
			// destinations, but showing both spends a result slot to say the same
			// sentence twice: keep whichever ranked higher.
			var headingKey = (index.sections[hit.sectionId][1] || '').toLowerCase();
			if (headingKey && seenHeading[headingKey]) continue;
			seenHeading[headingKey] = true;
			perDoc[hit.docId] = seen + 1;
			out.push(result(hit));
		}
		for (var o = 0; o < out.length; o++) out[o].matched = matched;
		return out;
	}

	function result(hit) {
		var section = index.sections[hit.sectionId];
		var doc = index.docs[hit.docId];
		var anchor = slugifyHeading(section[1]);
		return {
			slug: doc[0],
			docTitle: doc[1],
			snippet: doc[2],
			heading: section[1],
			anchor: anchor,
			// The docs reader routes on the hash and reads "#<doc>@<section>" as
			// "load this doc, scroll to that heading" (see currentRoute() in
			// docs/index.html). A section-less hit links to the page head.
			url: '/docs#' + doc[0] + (anchor ? '@' + anchor : ''),
			score: hit.score,
			matched: [],
		};
	}

	/**
	 * Fetch and decode the index. Idempotent: concurrent callers share one
	 * request, and a failure is remembered so a broken deploy does not retry on
	 * every keystroke.
	 *
	 * @returns {Promise<boolean>} true when the index is queryable
	 */
	function ready() {
		if (index) return Promise.resolve(true);
		if (loading) return loading;
		status = 'loading';
		loading = fetch(INDEX_URL, { credentials: 'omit' })
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.json();
			})
			.then(function (json) {
				load(json);
				return true;
			})
			.catch(function () {
				// No index means no docs results, never a broken page: every caller
				// treats false as "this source has nothing to offer".
				status = 'error';
				return false;
			});
		return loading;
	}

	/** Install an already-parsed index. Exposed for tests and for preloading. */
	function load(json) {
		index = json;
		terms = expandTerms(json.terms);
		status = 'ready';
		return true;
	}

	return {
		ready: ready,
		load: load,
		query: query,
		tokenize: tokenize,
		expandTerms: expandTerms,
		slugifyHeading: slugifyHeading,
		get status() {
			return status;
		},
		get size() {
			return index ? { docs: index.docCount, sections: index.sectionCount, terms: terms.length } : null;
		},
	};
});
