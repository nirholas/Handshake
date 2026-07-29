// LLM helpers for the fact-checker.
//
// Routes through the platform's shared provider policy (api/_lib/llm.js):
// Groq and OpenRouter are the funded free defaults; Anthropic is used only when
// the operator brings their own ANTHROPIC_API_KEY. Structured extraction below
// only needs a fast, cheap model, which all three providers satisfy.

import { llmComplete } from '../../../api/_lib/llm.js';

const TIMEOUT_MS = 30_000;
// Below this there is not enough budget left for even one provider attempt
// (llm.js caps a single attempt at 12s and abandons the chain with <500ms
// remaining), so spending the caller's remaining time on a doomed request is
// strictly worse than degrading immediately.
const MIN_VIABLE_MS = 3_000;

/**
 * One LLM turn, bounded by whatever wall-clock budget the caller still has.
 *
 * Returns `{ text, inputTokens, outputTokens }` on success and
 * `{ text: null, failure: <reason> }` when no provider could answer in budget.
 * It never throws: every caller here has a designed non-LLM fallback, and a
 * thrown provider error would jump over it and fail the whole fact check (the
 * exact defect this shape exists to prevent — a chain-exhaustion 502 on a
 * request that could have returned real sources).
 *
 * @param {string} prompt
 * @param {number} maxTokens
 * @param {number} [budgetMs] wall-clock allowance; defaults to the 30s cap.
 */
async function callLlm(prompt, maxTokens = 1024, budgetMs = TIMEOUT_MS) {
	const timeoutMs = Math.min(TIMEOUT_MS, Math.max(0, budgetMs));
	if (timeoutMs < MIN_VIABLE_MS) {
		return { text: null, failure: `no budget for an llm turn (${Math.round(timeoutMs)}ms left)` };
	}
	try {
		// No anthropicKey here: passing the SERVER's ANTHROPIC_API_KEY would be
		// treated as caller BYOK and jump a paid (and routinely dead) key to the
		// FRONT of the chain, ahead of the free providers. llm.js already appends
		// the server Anthropic key as a tail backstop on its own.
		const { text, usage } = await llmComplete({
			user: prompt,
			maxTokens,
			timeoutMs,
		});
		return { text, inputTokens: usage?.input || 0, outputTokens: usage?.output || 0 };
	} catch (err) {
		return { text: null, failure: err?.message || String(err) };
	}
}

/**
 * Generate 3 search queries for the given claim.
 *
 * @param {string} claim
 * @param {{budgetMs?: number}} [opts]
 * @returns {Promise<{queries: string[], tokens: number, degraded?: string}>}
 *   `degraded` is set when no provider answered and the claim text itself is
 *   being used as the query. Search on the raw claim is a genuinely useful
 *   query, so this path still produces a real, sourced fact check.
 */
export async function generateSearchQueries(claim, opts = {}) {
	const prompt = `You are a fact-checking assistant. Given the following claim, generate exactly 3 distinct web search queries to find authoritative sources that would verify or refute it.

Claim: "${claim}"

Rules:
- Each query should approach the claim from a different angle (e.g., direct verification, historical context, expert sources).
- Keep queries concise (under 12 words each).
- Do NOT include the word "claim" in queries.
- Output ONLY a valid JSON array of 3 strings. No explanation, no markdown, just the JSON array.

Example output: ["query one", "query two", "query three"]`;

	const { text, inputTokens, outputTokens, failure } = await callLlm(prompt, 256, opts.budgetMs);
	if (failure) {
		// No provider answered. The claim itself is a legitimate search query, so
		// the pipeline continues on real evidence instead of failing the request.
		return { queries: [claim], tokens: 0, degraded: `query generation unavailable: ${failure}` };
	}

	let queries;
	try {
		// Extract JSON array from the response, tolerating minor surrounding text.
		const match = text.match(/\[[\s\S]*?\]/);
		if (!match) throw new Error('no array found');
		queries = JSON.parse(match[0]);
		if (!Array.isArray(queries) || queries.length === 0) throw new Error('empty array');
		queries = queries.slice(0, 3).map((q) => String(q).trim()).filter(Boolean);
		if (queries.length === 0) throw new Error('all queries empty after trim');
	} catch (parseErr) {
		// Fallback: split on newlines and use first 3 non-empty lines.
		queries = text
			.split('\n')
			.map((l) => l.replace(/^["'\d.\-\s]+/, '').replace(/["',]+$/, '').trim())
			.filter(Boolean)
			.slice(0, 3);

		if (queries.length === 0) {
			// Last resort: use the claim itself as a query.
			queries = [claim];
		}
	}

	return { queries, tokens: inputTokens + outputTokens };
}

/**
 * For each of the top 5 search results, extract a 200-char excerpt and
 * determine stance. One LLM call for all results.
 *
 * @param {string} claim
 * @param {Array<{url: string, title: string, snippet: string}>} results  Top 5 results.
 * @param {{budgetMs?: number}} [opts]
 * @returns {Promise<{analyses: Array<{excerpt: string, stance: string}>, tokens: number, degraded?: string}>}
 *   `degraded` is set when no provider answered. Every stance falls back to
 *   "neutral", which computeVerdict reads as `insufficient` — an honest "we
 *   could not judge these sources", returned alongside the real sources and
 *   their snippets rather than as an error.
 */
export async function analyzeResults(claim, results, opts = {}) {
	const numbered = results
		.map(
			(r, i) =>
				`[${i + 1}] Title: ${r.title}\nURL: ${r.url}\nContent: ${r.snippet.slice(0, 900)}`,
		)
		.join('\n\n');

	const prompt = `You are a rigorous fact-checker. Given a claim and ${results.length} search result(s), judge each result's stance toward the claim USING ONLY the provided content.

Claim: "${claim}"

Search results:
${numbered}

For each result (1 through ${results.length}), output:
- excerpt: a 200-character or shorter direct quote or paraphrase from the content that is most relevant to the claim
- stance: one of "supports", "contradicts", or "neutral"

Stance rubric — commit to a stance whenever the content addresses the claim's central assertion:
- "supports": the content affirms the claim's central assertion, including via paraphrase or equivalent figures (e.g. claim says 330 m, source says "about 330 metres" or "1,083 ft").
- "contradicts": the content states something INCOMPATIBLE with the claim. A different number, a different record-holder, a different date, or an explicit negation is a contradiction, NOT neutral. If the claim says "the tallest is X" and the source names Y as tallest, that contradicts.
- "neutral": ONLY when the content genuinely does not address the claim's central assertion (same broad topic but silent on the specific fact). Do not use neutral as a low-effort default; check the numbers and named entities first.
- If the claim conjoins several assertions and the content affirms one while refuting another, choose the stance for the assertion the content speaks to most directly (supports if it affirms that part, contradicts if it refutes it).

Output ONLY a valid JSON array with ${results.length} objects, in order, each with fields "excerpt" (string) and "stance" (string).
No markdown, no explanation, just the JSON array.

Example (for 2 results): [{"excerpt":"The tower stands at 330m","stance":"supports"},{"excerpt":"Some unrelated content","stance":"neutral"}]`;

	const { text, inputTokens, outputTokens, failure } = await callLlm(prompt, 1024, opts.budgetMs);
	if (failure) {
		return {
			analyses: results.map(() => ({ excerpt: '', stance: 'neutral' })),
			tokens: 0,
			degraded: `stance extraction unavailable: ${failure}`,
		};
	}

	let analyses;
	try {
		const match = text.match(/\[[\s\S]*?\]/);
		if (!match) throw new Error('no array found');
		analyses = JSON.parse(match[0]);
		if (!Array.isArray(analyses)) throw new Error('not an array');
		// Normalize and pad/trim to match results length.
		analyses = analyses.slice(0, results.length).map((a) => ({
			excerpt: String(a?.excerpt || '').slice(0, 200),
			stance: ['supports', 'contradicts', 'neutral'].includes(a?.stance)
				? a.stance
				: 'neutral',
		}));
		while (analyses.length < results.length) {
			analyses.push({ excerpt: '', stance: 'neutral' });
		}
	} catch {
		// Fallback: mark all neutral.
		analyses = results.map(() => ({ excerpt: '', stance: 'neutral' }));
	}

	return { analyses, tokens: inputTokens + outputTokens };
}
