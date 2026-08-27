// Grounded web search: Vertex Gemini + Google Search grounding.
//
// The platform's first real web-search rung. Every prior "search" surface was
// a workaround: DuckDuckGo instant answers (definitions only), Google Trends
// scraping, ~180 RSS feeds, or the fact-checker's Brave/Tavily/Exa/Serper
// chain whose keys are unset in production. This module gives all of them a
// rung that actually works today, because it rides the same pre-approved GCP
// surface as the chat anchor (see api/_lib/vertex-gemini.js): Gemini on
// Vertex AI with the built-in google_search tool, authenticated with the GCP
// service account (no API key) and billed to platform credits.
//
// Semantics:
//   • Availability is gated ONLY by GOOGLE_CLOUD_PROJECT (set on every Cloud
//     Run deploy). Callers check webSearchAvailable() and treat false as
//     "this rung doesn't exist", exactly like a missing provider key.
//   • A token failure or upstream error throws; callers fall through their
//     chain like any other provider error. No fabricated results, ever.
//   • Results carry the grounding sources Google returned (title + uri). The
//     answer text is Gemini's synthesis over those sources — callers that
//     only want links use `sources`, callers that want an answer use `answer`.
//
// Env knobs (shared with the chat anchor):
//   GOOGLE_CLOUD_PROJECT         : GCP project id (required; gates the rung)
//   GOOGLE_CLOUD_LOCATION_GEMINI : region or "global" (default: "global")
//   VERTEX_GEMINI_MODEL          : model id (default: google/gemini-2.5-flash)

import { getGcpAccessToken } from './gcp-auth.js';
import { isRetryableError } from './resilience.js';
import { vertexGeminiAvailable, vertexGeminiModel, vertexGeminiThinkingBudget } from './vertex-gemini.js';

const FETCH_TIMEOUT_MS = 20_000;
// Visible answer tokens. The reasoning cap is funded separately on top (see the
// generationConfig below), so this is what the caller actually gets back.
const ANSWER_TOKENS = 1024;

export function webSearchAvailable() {
	return vertexGeminiAvailable();
}

// Native generateContent URL (NOT the OpenAI-compat endpoint: grounding tools
// are only accepted on the native API). The catalog id is OpenAI-compat shaped
// ("google/gemini-2.5-flash"); the native path wants the bare model id.
function groundedUrl() {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	const location = process.env.GOOGLE_CLOUD_LOCATION_GEMINI || 'global';
	const host =
		location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	const model = vertexGeminiModel().replace(/^google\//, '');
	return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

function dedupeSources(chunks) {
	const seen = new Set();
	const out = [];
	for (const c of chunks) {
		const uri = c?.web?.uri;
		if (!uri || seen.has(uri)) continue;
		seen.add(uri);
		out.push({
			title: c.web.title || c.web.domain || uri,
			url: uri,
			domain: c.web.domain || null,
		});
	}
	return out;
}

/**
 * Run one grounded search. Returns { answer, sources, queries }:
 *   answer  : Gemini's synthesized answer text (may be '' when the model
 *             answered without grounding text, never fabricated here)
 *   sources : [{ title, url, domain }] deduped grounding chunks, best-first
 *   queries : the search queries Google actually ran (transparency/debug)
 * Throws on unavailability, auth failure, or upstream error — callers treat
 * this like any provider-chain rung failure.
 */
export async function groundedSearch(query, { maxSources = 8, signal } = {}) {
	if (!webSearchAvailable()) throw new Error('web search unavailable: GOOGLE_CLOUD_PROJECT unset');
	const q = String(query || '').trim();
	if (!q) throw new Error('web search: empty query');

	// Grounded search has one provider and no second opinion worth the name: a
	// different engine would answer a different question with different
	// citations. What it can have is a memory. The same query asked twice inside
	// a few minutes deserves the same answer, so a remembered result rides out a
	// Vertex blip instead of turning a search box into a 502.
	//
	// The memory covers AVAILABILITY failures only. A safety block, an empty
	// answer or a 4xx is the model's verdict on this request, and replaying an
	// older answer over it would quietly overturn a decision that was made on
	// purpose. Those still reject, exactly as before.
	const key = `${q.toLowerCase()}::${maxSources}`;
	try {
		const value = await groundedSearchLive(q, { maxSources, signal });
		_searchMemory.set(key, { value, at: Date.now() });
		if (_searchMemory.size > SEARCH_MEMORY_MAX) {
			_searchMemory.delete(_searchMemory.keys().next().value);
		}
		return value;
	} catch (err) {
		if (!isAvailabilityFailure(err)) throw err;
		const hit = _searchMemory.get(key);
		if (!hit || Date.now() - hit.at > SEARCH_MEMORY_MAX_AGE_MS) throw err;
		console.warn(`[web-search] upstream unavailable (${err?.message || err}); serving a remembered answer`);
		return { ...hit.value, stale: true, as_of: new Date(hit.at).toISOString() };
	}
}

const SEARCH_MEMORY_MAX = 500;
const SEARCH_MEMORY_MAX_AGE_MS = 10 * 60_000;
const _searchMemory = new Map();

/**
 * Whether an error means "the provider could not answer right now" as opposed
 * to "the provider answered, and this is the answer". Only the first kind may
 * be papered over with a remembered result.
 */
function isAvailabilityFailure(err) {
	if (isRetryableError(err)) return true;
	const msg = String(err?.message || err);
	return /fetch failed|network|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out/i.test(msg);
}

/** Test seam: forget every remembered answer. */
export function _resetWebSearchMemory() {
	_searchMemory.clear();
}

async function groundedSearchLive(q, { maxSources, signal }) {
	const token = await getGcpAccessToken();
	const think = vertexGeminiThinkingBudget();
	const res = await fetch(groundedUrl(), {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
		body: JSON.stringify({
			contents: [{ role: 'user', parts: [{ text: q }] }],
			tools: [{ googleSearch: {} }],
			generationConfig: {
				temperature: 0.2,
				// Visible-answer budget PLUS the reasoning cap, exactly like the
				// OpenAI-compat anchor's vertexGeminiBudget(). Gemini 2.5 reasons by
				// default and bills those tokens against maxOutputTokens without ever
				// returning them, so a flat 1024 here was spent thinking: the reply
				// carried no text and no groundingChunks, which this function then
				// (correctly) reported as an empty grounded response and /api/web-search
				// surfaced as a 502 on every query. Capping the reasoning and funding
				// it on top is what makes ANSWER_TOKENS mean tokens the caller receives.
				maxOutputTokens: ANSWER_TOKENS + think,
				thinkingConfig: { thinkingBudget: think },
			},
		}),
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 300);
		throw Object.assign(new Error(`web search upstream ${res.status}: ${detail}`), { status: res.status });
	}

	const body = await res.json();
	const candidate = body?.candidates?.[0];
	const answer = (candidate?.content?.parts || [])
		.map((p) => p?.text || '')
		.join('')
		.trim();
	const grounding = candidate?.groundingMetadata || {};
	const sources = dedupeSources(grounding.groundingChunks || []).slice(0, maxSources);
	const queries = Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries : [];

	// A response with neither text nor sources is an upstream failure in
	// disguise (safety block, empty candidate) — surface it as an error so
	// chains fall through instead of caching an empty "success". Name the cause:
	// finishReason separates "MAX_TOKENS" (budget spent on reasoning) from
	// "SAFETY"/"RECITATION" (blocked) from a prompt-level block, and without it
	// every one of these looked identical from the outside: a bare 502 with
	// nothing in the log to act on.
	if (!answer && !sources.length) {
		const finish = candidate?.finishReason || 'none';
		const blocked = body?.promptFeedback?.blockReason || 'none';
		throw new Error(
			`web search: empty grounded response (finishReason=${finish}, promptBlockReason=${blocked}, candidates=${
				body?.candidates?.length ?? 0
			})`,
		);
	}
	return { answer, sources, queries };
}
