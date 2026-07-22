// Vertex Gemini: the platform's credits-funded LLM reliability anchor.
//
// One shared definition of the rung that api/chat.js proved out (commit
// 2b3d00254, "chat anchor eviction"): Gemini on Vertex AI through its
// OpenAI-compatible endpoint, authenticated with the GCP service account (no
// API key) and billed to the platform's GCP credits. It needs no third-party
// quota and no Model Garden acceptance, which makes it the one rung a fallback
// chain can rely on when every free tier (Groq / OpenRouter / NVIDIA NIM)
// throttles at once and the paid backstops are dead (prod OPENAI_API_KEY 429s
// billing_not_active; the OpenRouter host key must never route to paid models).
//
// Semantics every consumer must preserve (mirroring api/chat.js exactly):
//   • The anchor is appended at the TAIL of the chain: never auto-selected as
//     a primary route, always present as the last-resort rung.
//   • Presence of other provider keys (OPENAI_API_KEY etc.) must never evict
//     it: no chain cap, cooldown, or anon filter may drop the anchor.
//   • Anonymous/keyless callers keep it: it is GCP-credit funded, so it is not
//     a paid-key drain vector (see ANON_PROVIDER_LIST in chat-models.js).
//   • Availability is gated ONLY by GOOGLE_CLOUD_PROJECT (set on every Cloud
//     Run deploy); the OAuth bearer token is minted per request and a token
//     failure falls through the chain like any other provider error.
//
// Env knobs (same as the api/chat.js and api/_lib/llm.js rungs):
//   GOOGLE_CLOUD_PROJECT         : GCP project id (required; gates the rung)
//   GOOGLE_CLOUD_LOCATION_GEMINI : region or "global" (default: "global")
//   VERTEX_GEMINI_MODEL          : model id (default: google/gemini-2.5-flash)

import { getGcpAccessToken } from './gcp-auth.js';

// True when the deployment can serve the anchor at all. Read per call (not at
// module load) so tests and late-injected env both behave.
export function vertexGeminiAvailable() {
	return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

// The anchor's model id. Full Flash by default (platform credits, standing
// owner-approved spend): env-tunable without a code change.
export function vertexGeminiModel() {
	return process.env.VERTEX_GEMINI_MODEL || 'google/gemini-2.5-flash';
}

function vertexGeminiTarget() {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	const location = process.env.GOOGLE_CLOUD_LOCATION_GEMINI || 'global';
	const host =
		location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	return { project, location, host };
}

// OpenAI-compatible base URL (no trailing /chat/completions): for SDK clients
// that append the path themselves (e.g. @ai-sdk/openai's baseURL).
export function vertexGeminiOpenAIBase() {
	const { project, location, host } = vertexGeminiTarget();
	return `https://${host}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;
}

// Full chat-completions URL: for hand-rolled fetch transports.
export function vertexGeminiChatUrl() {
	return `${vertexGeminiOpenAIBase()}/chat/completions`;
}

// Per-request headers: a fresh (cached) GCP OAuth bearer token. May throw when
// no GCP credentials are resolvable; callers treat that like any other provider
// failure and fall through their chain.
export async function vertexGeminiHeaders() {
	const token = await getGcpAccessToken();
	return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

// The raw bearer token, for clients that take an apiKey instead of headers
// (e.g. the AI SDK's createOpenAI). Same failure semantics as the headers.
export async function vertexGeminiAccessToken() {
	return getGcpAccessToken();
}
