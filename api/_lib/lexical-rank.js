// Lexical fallback ranking.
//
// Semantic search is the platform's primary ranking everywhere it is available,
// but a vector query has a hard dependency the rest of the page does not: the
// query has to be embedded in the SAME space the corpus lives in. When that one
// upstream is down there is no cross-provider failover to reach for, because a
// 1024-dim NIM vector compared against a 768-dim Granite corpus is not a worse
// answer, it is a meaningless one.
//
// So the fallback is a different METHOD rather than a different provider: rank
// the same corpus by term overlap and hand it back explicitly labelled
// `match: 'lexical'` with a null semantic score. That is the pattern
// api/_lib/memory-store.js already established for the same reason (its
// "substring + salience fill" keeps recall working before embeddings backfill),
// generalised here so every semantic surface can degrade the same way instead of
// answering a search page with a 502.
//
// It is deliberately simple and deterministic: no index to build, no dependency
// to add, and nothing about it can fabricate a relevance number that reads like
// a cosine similarity.

// Words carrying no discriminating power. Kept short on purpose: an aggressive
// list would drop meaningful query terms in a domain full of short names.
const STOP_WORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
	'have', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
	'their', 'them', 'they', 'this', 'to', 'was', 'were', 'what', 'when', 'which',
	'who', 'why', 'will', 'with', 'you', 'your',
]);

/**
 * Split text into lowercase word tokens, dropping stop words and single
 * characters. Unicode-aware so non-latin queries tokenize rather than vanish.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
	if (typeof text !== 'string' || !text) return [];
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Overlap score for one document, in [0, 1].
 *
 * The base is the share of DISTINCT query terms the document contains, which
 * keeps a long document from outranking a precise one merely by repeating a
 * word. A document containing the query as a contiguous phrase gets a bounded
 * bonus, because a phrase hit is the strongest lexical evidence available
 * without an index.
 *
 * @param {string[]} queryTokens  pre-tokenized query (tokenize once per search)
 * @param {string} queryRaw       the original query, for the phrase check
 * @param {string} text           document text
 * @returns {number} 0 when nothing matches
 */
export function lexicalScore(queryTokens, queryRaw, text) {
	if (!queryTokens.length || typeof text !== 'string' || !text) return 0;
	const haystack = text.toLowerCase();
	const docTokens = new Set(tokenize(text));
	let hits = 0;
	for (const t of queryTokens) {
		// Prefix match so "avatar" finds "avatars" without a stemmer, which would
		// be a dependency and a source of surprising misses in a name-heavy corpus.
		if (docTokens.has(t) || haystack.includes(t)) hits++;
	}
	if (!hits) return 0;
	const base = hits / queryTokens.length;
	const phrase = queryRaw.trim().length > 2 && haystack.includes(queryRaw.trim().toLowerCase()) ? 0.25 : 0;
	return Math.min(1, base * 0.75 + phrase + (base === 1 ? 0.1 : 0));
}

/**
 * Rank documents by lexical overlap with `query`.
 *
 * Every returned row carries `match: 'lexical'` and `score: null` for the
 * semantic score it does NOT have, alongside the overlap in `lexicalScore`, so
 * no caller can mistake this ordering for a vector one.
 *
 * @param {string} query
 * @param {Array<{id: any, text: string}>} docs
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {number} [opts.minScore=0.15]  drop weak coincidental overlaps
 * @returns {Array<{id: any, score: null, lexicalScore: number, match: 'lexical'}>}
 */
export function rankLexically(query, docs, { limit = 20, minScore = 0.15 } = {}) {
	const q = String(query || '').trim();
	const tokens = tokenize(q);
	if (!tokens.length || !Array.isArray(docs)) return [];
	const scored = [];
	for (const d of docs) {
		const s = lexicalScore(tokens, q, d?.text || '');
		if (s >= minScore) scored.push({ id: d.id, score: null, lexicalScore: Number(s.toFixed(4)), match: 'lexical' });
	}
	scored.sort((a, b) => b.lexicalScore - a.lexicalScore);
	return scored.slice(0, limit);
}
