// LLM helpers for the fact-checker.
//
// Routes through the platform's shared provider policy (api/_lib/llm.js):
// Groq and OpenRouter are the funded free defaults; Anthropic is used only when
// the operator brings their own ANTHROPIC_API_KEY. Structured extraction below
// only needs a fast, cheap model, which all three providers satisfy.

import { llmComplete } from '../../../api/_lib/llm.js';

const TIMEOUT_MS = 30_000;

async function callLlm(prompt, maxTokens = 1024) {
	const { text, usage } = await llmComplete({
		user: prompt,
		maxTokens,
		anthropicKey: process.env.ANTHROPIC_API_KEY,
		timeoutMs: TIMEOUT_MS,
	});
	return { text, inputTokens: usage?.input || 0, outputTokens: usage?.output || 0 };
}

/**
 * Generate 3 search queries for the given claim.
 * Returns { queries: string[], tokens: number }
 */
export async function generateSearchQueries(claim) {
	const prompt = `You are a fact-checking assistant. Given the following claim, generate exactly 3 distinct web search queries to find authoritative sources that would verify or refute it.

Claim: "${claim}"

Rules:
- Each query should approach the claim from a different angle (e.g., direct verification, historical context, expert sources).
- Keep queries concise (under 12 words each).
- Do NOT include the word "claim" in queries.
- Output ONLY a valid JSON array of 3 strings. No explanation, no markdown, just the JSON array.

Example output: ["query one", "query two", "query three"]`;

	const { text, inputTokens, outputTokens } = await callLlm(prompt, 256);

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
 * @returns {Promise<{analyses: Array<{excerpt: string, stance: string}>, tokens: number}>}
 */
export async function analyzeResults(claim, results) {
	const numbered = results
		.map(
			(r, i) =>
				`[${i + 1}] Title: ${r.title}\nURL: ${r.url}\nContent: ${r.snippet.slice(0, 500)}`,
		)
		.join('\n\n');

	const prompt = `You are a fact-checking assistant. Given a claim and ${results.length} search result(s), analyze each result.

Claim: "${claim}"

Search results:
${numbered}

For each result (1 through ${results.length}), output:
- excerpt: a 200-character or shorter direct quote or paraphrase from the content that is most relevant to the claim
- stance: one of "supports", "contradicts", or "neutral"
  - "supports" = the source backs the claim
  - "contradicts" = the source refutes the claim
  - "neutral" = the source is tangentially related but neither supports nor contradicts

Output ONLY a valid JSON array with ${results.length} objects, in order, each with fields "excerpt" (string) and "stance" (string).
No markdown, no explanation, just the JSON array.

Example (for 2 results): [{"excerpt":"The tower stands at 330m","stance":"supports"},{"excerpt":"Some unrelated content","stance":"neutral"}]`;

	const { text, inputTokens, outputTokens } = await callLlm(prompt, 1024);

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
