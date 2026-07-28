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
import { vertexGeminiAvailable, vertexGeminiModel } from './vertex-gemini.js';

const FETCH_TIMEOUT_MS = 20_000;

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

	const token = await getGcpAccessToken();
	const res = await fetch(groundedUrl(), {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
		body: JSON.stringify({
			contents: [{ role: 'user', parts: [{ text: q }] }],
			tools: [{ googleSearch: {} }],
			generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
		}),
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 300);
		throw new Error(`web search upstream ${res.status}: ${detail}`);
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
	// chains fall through instead of caching an empty "success".
	if (!answer && !sources.length) throw new Error('web search: empty grounded response');
	return { answer, sources, queries };
}
