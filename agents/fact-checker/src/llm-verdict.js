// LLM helpers for the fact-checker using direct Anthropic API calls.
// Model: claude-haiku-4-5-20251001 (cheap + fast for structured extraction).

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 30_000;

function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms),
		),
	]);
}

async function callAnthropic(prompt, maxTokens = 1024) {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		const err = new Error('ANTHROPIC_API_KEY is not configured');
		err.status = 503;
		err.code = 'llm_unavailable';
		throw err;
	}

	const res = await withTimeout(
		fetch(ANTHROPIC_API, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: ANTHROPIC_MODEL,
				max_tokens: maxTokens,
				messages: [{ role: 'user', content: prompt }],
			}),
		}),
		TIMEOUT_MS,
	);

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		const err = new Error(`Anthropic API HTTP ${res.status}: ${body.slice(0, 200)}`);
		err.status = 502;
		err.code = 'llm_error';
		throw err;
	}

	const data = await res.json();
	const text = data?.content?.[0]?.text || '';
	const usage = data?.usage || {};
	return { text, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 };
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

	const { text, inputTokens, outputTokens } = await callAnthropic(prompt, 256);

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

	const { text, inputTokens, outputTokens } = await callAnthropic(prompt, 1024);

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
